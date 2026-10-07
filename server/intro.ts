/**
 * `GET /api/intro` and `POST /api/intro/seen`: whether this member has closed
 * the new-member intro (`docs/plans/new-member-intro.md`). The answer is the
 * optional `introSeenAt` field on `users/{sub}`, so it holds on every device.
 *
 * Membership is decided here with `requireMember`, and the `sub` comes only
 * from the session. Neither route reads a body or writes a log line of its
 * own. A store failure is 503, never a 500, and the original error never
 * escapes (the dispatcher in `scripts/server.ts` logs whatever does).
 *
 * The client asks only when the member has no recipes of their own, once per
 * page load, so existing members never cause a read.
 */
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
  storeUnavailable,
  type RequireMemberResult,
} from './membership.ts';
import { markIntroSeen, readIntroSeen } from './store.ts';

export type IntroDependencies = {
  requireMember: (req: Request) => Promise<RequireMemberResult>;
  readSeen: (sub: string) => Promise<boolean>;
  markSeen: (sub: string, profile: { email: string }, now: number) => Promise<void>;
  now: () => number;
};

const defaultDependencies: IntroDependencies = {
  requireMember,
  readSeen: readIntroSeen,
  markSeen: markIntroSeen,
  now: Date.now,
};

/** The store's gRPC code, if any; never the message, which can quote the request. */
function errorCode(err: unknown): number | string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

export async function handleIntroGet(
  req: Request,
  dependencies: IntroDependencies,
): Promise<Response> {
  const access = await dependencies.requireMember(req);
  if (access.kind === 'denied') return membershipUnauthorized();
  if (access.kind === 'unknown') return membershipUnavailable();
  let seen: boolean;
  try {
    seen = await dependencies.readSeen(access.sub);
  } catch (err) {
    console.error('introGet store error:', errorCode(err));
    return storeUnavailable();
  }
  return Response.json({ seen }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function handleIntroSeenPost(
  req: Request,
  dependencies: IntroDependencies,
): Promise<Response> {
  const access = await dependencies.requireMember(req);
  if (access.kind === 'denied') return membershipUnauthorized();
  if (access.kind === 'unknown') return membershipUnavailable();
  try {
    await dependencies.markSeen(access.sub, { email: access.email }, dependencies.now());
  } catch (err) {
    console.error('introSeenPost store error:', errorCode(err));
    return storeUnavailable();
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export function introGet(req: Request): Promise<Response> {
  return handleIntroGet(req, defaultDependencies);
}

export function introSeenPost(req: Request): Promise<Response> {
  return handleIntroSeenPost(req, defaultDependencies);
}
