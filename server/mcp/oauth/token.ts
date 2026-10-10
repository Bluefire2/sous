/**
 * `POST /oauth/token` (authorization_code and refresh_token, form-urlencoded)
 * and `POST /oauth/revoke` (RFC 7009). Public clients only: no client
 * secret, PKCE S256 on every code. Never reads a cookie.
 *
 * Errors are RFC 6749 JSON with status 400. A Firestore or membership blip
 * is 503, never `invalid_grant`, so a client does not throw away a good
 * refresh token over it.
 */
import { publicOrigin } from '../../env.ts';
import { memberFromIdentity, readBoundedText } from '../../membership.ts';
import { admitTranslateCall } from '../../recipeTranslation.ts';
import {
  ACCESS_TOKEN_TTL_MS,
  OAUTH_TOKEN_LOOKUPS_PER_MINUTE,
  REFRESH_REUSE_GRACE_MS,
  resourceUrl,
  type McpScope,
} from '../config.ts';
import { clientHostOf, noteHandledError, withMcpOAuthLog, type McpOAuthLogEntry } from '../log.ts';
import { parseScopes, scopeString } from '../scopes.ts';
import { parseClientIdUrl } from './clientId.ts';
import { verifyS256 } from './pkce.ts';
import {
  hashSecret,
  redeemAuthCode,
  revokeGrantForToken,
  rotateRefreshToken,
  type Admission,
  type AuthCodeCheck,
  type IssueOutcome,
  type RefreshDecision,
  type StoredAuthCode,
  type StoredToken,
} from './store.ts';

const BODY_LIMIT = 8_192;

/** Whether a code may be exchanged. A used code is `reused` whatever its age: its grant is revoked. */
export function authCodeDecision(
  code: StoredAuthCode | null,
  now: number,
): 'ok' | 'missing' | 'expired' | 'reused' {
  if (code === null) return 'missing';
  if (code.usedAt !== undefined) return 'reused';
  if (code.expiresAt <= now) return 'expired';
  return 'ok';
}

/**
 * Whether a refresh token may be rotated. A rotated token presented again
 * within the grace window is a concurrent refresh (`grace`: refused, nothing
 * revoked). Later it is theft or a replay (`reused`: the grant is revoked).
 */
export function refreshDecision(token: StoredToken | null, now: number): RefreshDecision {
  if (token === null || token.kind !== 'refresh') return 'missing';
  if (token.rotatedAt !== undefined) {
    return now - token.rotatedAt <= REFRESH_REUSE_GRACE_MS ? 'grace' : 'reused';
  }
  if (token.expiresAt <= now) return 'expired';
  return 'ok';
}

function oauthJson(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

export type TokenErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target';

function tokenError(error: TokenErrorCode, description?: string): Response {
  return oauthJson(description === undefined ? { error } : { error, error_description: description }, 400);
}

function unavailable(): Response {
  return oauthJson({ error: 'temporarily_unavailable' }, 503);
}

/** Over the lookup cap: 503, not `invalid_grant`, so a client keeps its tokens and retries. */
function rateLimited(entry: McpOAuthLogEntry): Response {
  entry.outcome = 'rate_limited';
  const res = unavailable();
  res.headers.set('Retry-After', '60');
  return res;
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  const contentType = req.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return null;
  }
  const text = await readBoundedText(req, BODY_LIMIT);
  return text === null ? null : new URLSearchParams(text);
}

export type TokenDependencies = {
  now: () => number;
  /** Whether one more store lookup fits under `OAUTH_TOKEN_LOOKUPS_PER_MINUTE`. */
  admitLookup: (now: number) => boolean;
  origin: () => string;
  admit: (identity: { sub: string; email: string }) => Promise<Admission>;
  redeemCode: (
    codeHash: string,
    check: AuthCodeCheck,
    admit: TokenDependencies['admit'],
    now: number,
  ) => Promise<IssueOutcome>;
  rotate: (
    tokenHash: string,
    input: { clientId: string | null; requested: McpScope[] | null },
    admit: TokenDependencies['admit'],
    now: number,
  ) => Promise<IssueOutcome>;
  revoke: (tokenHash: string, now: number) => Promise<string | undefined>;
};

async function admitIdentity(identity: { sub: string; email: string }): Promise<Admission> {
  const access = await memberFromIdentity(identity);
  return access.kind === 'ok' ? 'ok' : access.kind;
}

const lookupBuckets = new Map<string, number[]>();

/** Test hook: clears the per-instance lookup window. */
export function resetOAuthTokenRateLimitForTest(): void {
  lookupBuckets.clear();
}

const liveDependencies: TokenDependencies = {
  now: () => Date.now(),
  admitLookup: (now) => admitTranslateCall(lookupBuckets, 'all', now, OAUTH_TOKEN_LOOKUPS_PER_MINUTE, 60_000),
  origin: publicOrigin,
  admit: admitIdentity,
  redeemCode: (codeHash, check, admit, now) => redeemAuthCode(codeHash, check, admit, authCodeDecision, now),
  rotate: (tokenHash, input, admit, now) => rotateRefreshToken(tokenHash, input, admit, refreshDecision, now),
  revoke: revokeGrantForToken,
};

function issuedResponse(outcome: IssueOutcome, entry: McpOAuthLogEntry): Response {
  if (outcome.clientHost !== undefined) entry.clientHost = outcome.clientHost;
  switch (outcome.kind) {
    case 'ok':
      entry.outcome = 'ok';
      return oauthJson(
        {
          access_token: outcome.tokens.accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_MS / 1000,
          refresh_token: outcome.tokens.refreshToken,
          scope: scopeString(outcome.tokens.scopes),
        },
        200,
      );
    case 'invalid_grant':
      entry.outcome = outcome.reason === 'reused' ? 'reused' : 'invalid_grant';
      return tokenError('invalid_grant');
    case 'invalid_scope':
      entry.outcome = 'invalid_scope';
      return tokenError('invalid_scope');
    case 'unavailable':
      entry.outcome = 'unavailable';
      return unavailable();
  }
}

/** `resource` is optional; when sent it must be this server's `/mcp` (RFC 8707). */
function resourceMismatch(params: URLSearchParams, origin: string): boolean {
  const resources = params.getAll('resource');
  return resources.length > 0 && resources.some((resource) => resource !== resourceUrl(origin));
}

async function exchangeCode(
  params: URLSearchParams,
  deps: TokenDependencies,
  entry: McpOAuthLogEntry,
): Promise<Response> {
  const code = params.get('code');
  const redirectUri = params.get('redirect_uri');
  const clientId = params.get('client_id');
  const verifier = params.get('code_verifier');
  if (!code || !redirectUri || !clientId || !verifier) {
    entry.outcome = 'invalid_request';
    return tokenError('invalid_request', 'code, redirect_uri, client_id and code_verifier are required');
  }
  entry.clientHost = clientHostOf(clientId);
  if (parseClientIdUrl(clientId) === null) {
    entry.outcome = 'invalid_client';
    return tokenError('invalid_client');
  }
  if (resourceMismatch(params, deps.origin())) {
    entry.outcome = 'invalid_target';
    return tokenError('invalid_target');
  }
  const check: AuthCodeCheck = (stored) =>
    stored.clientId === clientId && stored.redirectUri === redirectUri && verifyS256(verifier, stored.codeChallenge)
      ? 'ok'
      : 'mismatch';
  const now = deps.now();
  if (!deps.admitLookup(now)) return rateLimited(entry);
  let outcome: IssueOutcome;
  try {
    outcome = await deps.redeemCode(hashSecret(code), check, deps.admit, now);
  } catch (err) {
    noteHandledError(entry, err);
    entry.outcome = 'unavailable';
    return unavailable();
  }
  return issuedResponse(outcome, entry);
}

async function refresh(
  params: URLSearchParams,
  deps: TokenDependencies,
  entry: McpOAuthLogEntry,
): Promise<Response> {
  const refreshToken = params.get('refresh_token');
  if (!refreshToken) {
    entry.outcome = 'invalid_request';
    return tokenError('invalid_request', 'refresh_token is required');
  }
  const clientId = params.get('client_id');
  if (clientId !== null) entry.clientHost = clientHostOf(clientId);
  if (resourceMismatch(params, deps.origin())) {
    entry.outcome = 'invalid_target';
    return tokenError('invalid_target');
  }
  let requested: McpScope[] | null = null;
  const scope = params.get('scope');
  if (scope !== null) {
    const parsed = parseScopes(scope);
    if (!parsed.ok) {
      entry.outcome = 'invalid_scope';
      return tokenError('invalid_scope');
    }
    requested = parsed.scopes;
  }
  const now = deps.now();
  if (!deps.admitLookup(now)) return rateLimited(entry);
  let outcome: IssueOutcome;
  try {
    outcome = await deps.rotate(hashSecret(refreshToken), { clientId, requested }, deps.admit, now);
  } catch (err) {
    noteHandledError(entry, err);
    entry.outcome = 'unavailable';
    return unavailable();
  }
  return issuedResponse(outcome, entry);
}

export async function handleTokenPost(req: Request, deps: TokenDependencies): Promise<Response> {
  const entry: McpOAuthLogEntry = { step: 'token' };
  return withMcpOAuthLog(entry, async () => {
    const params = await readForm(req);
    if (params === null) {
      entry.outcome = 'invalid_request';
      return tokenError('invalid_request', 'send application/x-www-form-urlencoded');
    }
    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') {
      entry.grantType = 'authorization_code';
      return exchangeCode(params, deps, entry);
    }
    if (grantType === 'refresh_token') {
      entry.grantType = 'refresh_token';
      return refresh(params, deps, entry);
    }
    entry.grantType = 'other';
    entry.outcome = 'unsupported_grant_type';
    return tokenError('unsupported_grant_type');
  });
}

export async function handleRevokePost(req: Request, deps: TokenDependencies): Promise<Response> {
  const entry: McpOAuthLogEntry = { step: 'revoke' };
  return withMcpOAuthLog(entry, async () => {
    const params = await readForm(req);
    if (params === null) {
      entry.outcome = 'invalid_request';
      return tokenError('invalid_request', 'send application/x-www-form-urlencoded');
    }
    const token = params.get('token');
    if (!token) {
      entry.outcome = 'invalid_request';
      return tokenError('invalid_request', 'token is required');
    }
    const now = deps.now();
    if (!deps.admitLookup(now)) return rateLimited(entry);
    try {
      entry.clientHost = await deps.revoke(hashSecret(token), now);
    } catch (err) {
      noteHandledError(entry, err);
      entry.outcome = 'unavailable';
      return unavailable();
    }
    // 200 whether or not the token was known (RFC 7009 §2.2).
    entry.outcome = 'ok';
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  });
}

export const oauthTokenPost = (req: Request) => handleTokenPost(req, liveDependencies);
export const oauthRevokePost = (req: Request) => handleRevokePost(req, liveDependencies);
