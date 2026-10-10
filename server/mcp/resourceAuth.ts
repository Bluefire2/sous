/**
 * The gate on every `/mcp` request. It reads the bearer from `Authorization`
 * only, never a cookie, and runs on the raw HTTP request before the MCP SDK
 * sees it, so a refusal is always an HTTP 401 or 503, never a 200 tool error.
 *
 * A token works only while it is an unexpired access token, its grant is not
 * revoked (checked on every call, no cache), and the grant's identity passes
 * the same admission decision as a session cookie (`memberFromIdentity`:
 * owners short-circuit, members use the 60 s active-member cache). A removed
 * member's grants go inert and come back if they are re-admitted.
 */
import { memberFromIdentity } from '../membership.ts';
import { ACCESS_TOKEN_PREFIX, type McpScope } from './config.ts';
import {
  effectiveScopes,
  grantNeedsTouch,
  hashSecret,
  readAccessContext,
  touchGrant,
  type Admission,
  type StoredGrant,
  type StoredToken,
} from './oauth/store.ts';
import { noteHandledError } from './log.ts';

export type McpAuthResult =
  | { kind: 'ok'; sub: string; grantId: string; scopes: McpScope[]; clientHost: string }
  /** No usable token. `presented` says whether there was one to refuse. */
  | { kind: 'invalid'; presented: boolean }
  /** A valid token whose member is no longer admitted. */
  | { kind: 'denied' }
  /** The store or the membership read failed: 503, never 401. */
  | { kind: 'unknown' };

/** `Authorization: Bearer <token>`, scheme case-insensitive. Null when absent or malformed. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/** Whether a stored token and its grant allow a call now. Pure. */
export function accessTokenUsable(
  token: StoredToken,
  grant: StoredGrant | null,
  now: number,
): grant is StoredGrant {
  if (token.kind !== 'access' || token.expiresAt <= now) return false;
  if (grant === null || grant.revokedAt !== undefined) return false;
  return effectiveScopes(token, grant).length > 0;
}

export type ResourceAuthDependencies = {
  now: () => number;
  readAccessContext: typeof readAccessContext;
  admit: (identity: { sub: string; email: string }) => Promise<Admission>;
  touchGrant: typeof touchGrant;
};

async function admitIdentity(identity: { sub: string; email: string }): Promise<Admission> {
  const access = await memberFromIdentity(identity);
  return access.kind === 'ok' ? 'ok' : access.kind;
}

export const liveResourceAuthDependencies: ResourceAuthDependencies = {
  now: () => Date.now(),
  readAccessContext,
  admit: admitIdentity,
  touchGrant,
};

export async function authenticateMcp(
  req: Request,
  deps: ResourceAuthDependencies = liveResourceAuthDependencies,
): Promise<McpAuthResult> {
  const raw = bearerToken(req);
  if (raw === null) {
    return { kind: 'invalid', presented: req.headers.has('authorization') };
  }
  // Only Sous access tokens are looked up; anything else is refused unread.
  if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) {
    return { kind: 'invalid', presented: true };
  }
  const now = deps.now();
  let context: Awaited<ReturnType<typeof readAccessContext>>;
  try {
    context = await deps.readAccessContext(hashSecret(raw));
  } catch (err) {
    noteHandledError({}, err);
    return { kind: 'unknown' };
  }
  if (context === null || !accessTokenUsable(context.token, context.grant, now)) {
    return { kind: 'invalid', presented: true };
  }
  const { token, grant } = context;
  const admission = await deps.admit({ sub: token.sub, email: grant.email });
  if (admission !== 'ok') {
    return { kind: admission };
  }
  if (grantNeedsTouch(grant, now)) {
    try {
      await deps.touchGrant(token.sub, grant.id, now);
    } catch (err) {
      // "Last used" is a convenience; the call goes ahead without it.
      noteHandledError({}, err);
    }
  }
  return {
    kind: 'ok',
    sub: token.sub,
    grantId: grant.id,
    scopes: effectiveScopes(token, grant),
    clientHost: grant.clientHost,
  };
}
