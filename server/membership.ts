import { isAllowed } from './allowlist.ts';
import { allowedEmails } from './env.ts';
import { readMember, type MemberRecord } from './members.ts';
import { readHeaderSession, readSession, type ReadSessionResult } from './session.ts';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 500;

const activeMemberCache = new Map<string, number>();

export function clearMembershipCache(sub: string): void {
  activeMemberCache.delete(sub);
}

function trimCacheIfNeeded(): void {
  if (activeMemberCache.size > CACHE_MAX_SIZE) {
    activeMemberCache.clear();
  }
}

export function accessDecision(input: {
  email: string;
  emailVerified: boolean;
  allowedRaw: string;
  member: MemberRecord | null;
}): 'owner' | 'member' | 'denied' {
  if (isAllowed(input.email, input.emailVerified, input.allowedRaw)) {
    return 'owner';
  }
  if (input.emailVerified !== true) {
    return 'denied';
  }
  if (input.member !== null && input.member.status === 'active') {
    return 'member';
  }
  return 'denied';
}

async function readActiveMemberCached(sub: string, now: number): Promise<MemberRecord | null> {
  const cachedUntil = activeMemberCache.get(sub);
  if (cachedUntil !== undefined && now < cachedUntil) {
    return {
      sub,
      status: 'active',
      approvedAt: 1,
      approvedBy: 'cache',
    };
  }

  const member = await readMember(sub);
  if (member !== null && member.status === 'active') {
    activeMemberCache.set(sub, now + CACHE_TTL_MS);
    trimCacheIfNeeded();
    return member;
  }
  activeMemberCache.delete(sub);
  return member;
}

export async function accessAllows(identity: {
  sub: string;
  email: string;
  emailVerified: boolean;
}): Promise<'owner' | 'member' | 'denied' | 'unknown'> {
  try {
    const decision = accessDecision({
      email: identity.email,
      emailVerified: identity.emailVerified,
      allowedRaw: allowedEmails(),
      member: null,
    });
    if (decision === 'owner') {
      return 'owner';
    }
    if (identity.emailVerified !== true) {
      return 'denied';
    }
    const member = await readActiveMemberCached(identity.sub, Date.now());
    const finalDecision = accessDecision({
      email: identity.email,
      emailVerified: identity.emailVerified,
      allowedRaw: allowedEmails(),
      member,
    });
    if (finalDecision === 'member') {
      return 'member';
    }
    return 'denied';
  } catch {
    return 'unknown';
  }
}

export type RequireMemberResult =
  | { kind: 'ok'; sub: string; email: string; isOwner: boolean }
  | { kind: 'denied' }
  | { kind: 'unknown' };

async function memberFromSession(sessionResult: ReadSessionResult): Promise<RequireMemberResult> {
  if (sessionResult.status !== 'ok') {
    return { kind: 'denied' };
  }
  return memberFromIdentity(sessionResult.session);
}

/**
 * The admission decision for an identity that has already been authenticated:
 * a verified session cookie, or a live MCP grant (`server/mcp/resourceAuth.ts`),
 * which carries the `sub` and email of the session that consented. Owners
 * short-circuit before any member read; members go through the 60 s
 * active-member cache. Denied is never mixed with unknown.
 */
export async function memberFromIdentity(identity: {
  sub: string;
  email: string;
}): Promise<RequireMemberResult> {
  const { sub, email } = identity;
  const allowedRaw = allowedEmails();
  const ownerCheck = accessDecision({
    email,
    emailVerified: true,
    allowedRaw,
    member: null,
  });
  if (ownerCheck === 'owner') {
    return { kind: 'ok', sub, email, isOwner: true };
  }

  try {
    const now = Date.now();
    const member = await readActiveMemberCached(sub, now);
    const decision = accessDecision({
      email,
      emailVerified: true,
      allowedRaw,
      member,
    });
    if (decision === 'member') {
      return { kind: 'ok', sub, email, isOwner: false };
    }
    return { kind: 'denied' };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function requireMember(req: Request): Promise<RequireMemberResult> {
  return memberFromSession(readSession(req));
}

export type VisitorMembership =
  | { kind: 'signedOut' }
  | { kind: 'denied'; sub: string; email: string }
  | { kind: 'unknown' }
  | { kind: 'ok'; sub: string; email: string; isOwner: boolean };

/**
 * `requireMember` for server HTML pages that treat "no usable cookie" (sign
 * in) differently from "signed in but not admitted" (invitation-only page).
 * The admission decision is exactly `requireMember`'s.
 */
export async function visitorMembership(req: Request): Promise<VisitorMembership> {
  const sessionResult = readSession(req);
  if (sessionResult.status !== 'ok') {
    return { kind: 'signedOut' };
  }
  const access = await memberFromSession(sessionResult);
  if (access.kind === 'denied') {
    return { kind: 'denied', sub: sessionResult.session.sub, email: sessionResult.session.email };
  }
  return access;
}

/** Same decision as `requireMember`, from `X-Sous-Session` only. No cookie fallback. */
export async function requireHeaderMember(req: Request): Promise<RequireMemberResult> {
  return memberFromSession(readHeaderSession(req));
}

export type RequireOwnerResult =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; sub: string; email: string };

export function requireOwner(req: Request): RequireOwnerResult {
  const sessionResult = readSession(req);
  if (sessionResult.status === 'absent') {
    return { kind: 'unauthenticated' };
  }
  if (sessionResult.status !== 'ok') {
    return { kind: 'unauthenticated' };
  }
  if (!isAllowed(sessionResult.session.email, true, allowedEmails())) {
    return { kind: 'forbidden' };
  }
  return {
    kind: 'ok',
    sub: sessionResult.session.sub,
    email: sessionResult.session.email,
  };
}

export function membershipUnauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function membershipUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'Membership unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function storeUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'Store unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * `readBoundedText` throws this when the request body fails partway. In the
 * server the body is `Readable.toWeb(nodeReq)`, which errors when the client
 * closes the connection mid-upload (Node's `Error('aborted')`, ECONNRESET):
 * the client's doing, not a server failure. The message is fixed and the
 * original error is not kept, so it is safe to log.
 */
export class RequestBodyError extends Error {
  constructor() {
    super('Request body could not be read');
    this.name = 'RequestBodyError';
  }
}

/**
 * The body as text, or null when it is longer than `limit` bytes. Throws
 * `RequestBodyError` when the body fails. Past the limit it stops reading and
 * releases the body without cancelling it: in the server, cancelling
 * `Readable.toWeb(nodeReq)` aborts the request, and Node closes the connection
 * under the arriving upload, so a client still uploading usually sees a reset
 * instead of the 413. The dispatcher (`dispatchFetch` in
 * `scripts/server.ts`) drops what is left, within a bound, before it answers.
 * Nothing past the limit is kept here.
 */
export async function readBoundedText(req: Request, limit: number): Promise<string | null> {
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > limit) {
      return null;
    }
  }

  if (req.body === null) {
    return '';
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new RequestBodyError();
    });
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        reader.releaseLock();
        return null;
      }
      chunks.push(value);
    }
  }

  let combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(combined);
}

export type MembershipHandlerContext = { authorizedSub: string };

export function withMembership(
  handler: (req: Request, ctx: MembershipHandlerContext) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const access = await requireMember(req);
    if (access.kind === 'denied') {
      return membershipUnauthorized();
    }
    if (access.kind === 'unknown') {
      return membershipUnavailable();
    }
    return handler(req, { authorizedSub: access.sub });
  };
}

/** Test hook: membership cache lookup with injected clock. */
export async function lookupMemberForTest(
  sub: string,
  now: number,
): Promise<MemberRecord | null> {
  return readActiveMemberCached(sub, now);
}

export function cacheSizeForTest(): number {
  return activeMemberCache.size;
}
