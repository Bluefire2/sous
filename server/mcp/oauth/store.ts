/**
 * Authorization codes, tokens, and grants for MCP clients, in Firestore.
 *
 * - `mcpAuthCodes/{sha256(code)}` (top level): one consent's code, 60 s,
 *   single use.
 * - `mcpTokens/{sha256(token)}` (top level): access (1 h) and refresh (30
 *   days, rotated on every use) tokens.
 * - `users/{sub}/mcpGrants/{grantId}`: what the member allowed, until revoked.
 *
 * Raw codes and tokens are never stored or logged; only their sha256 hashes
 * name documents. Both top-level collections carry `expireAt` (a Timestamp)
 * for a Firestore TTL policy, which is an owner step; every check here also
 * compares the expiry itself, because TTL deletion runs up to a day late.
 *
 * The `read*Doc` parsers and the decisions in `token.ts` are pure; the rest
 * is I/O.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from '@google-cloud/firestore';
import { randomToken } from '../../session.ts';
import { getStoreFirestore } from '../../store.ts';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  GRANT_TOUCH_INTERVAL_MS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  type McpScope,
} from '../config.ts';
import { readStoredScopes } from '../scopes.ts';

export const MCP_AUTH_CODES_COLLECTION = 'mcpAuthCodes';
export const MCP_TOKENS_COLLECTION = 'mcpTokens';
export const MCP_GRANTS_COLLECTION = 'mcpGrants';

export type StoredAuthCode = {
  sub: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpScope[];
  usedAt?: number;
  expiresAt: number;
};

export type StoredToken = {
  kind: 'access' | 'refresh';
  sub: string;
  grantId: string;
  scopes: McpScope[];
  rotatedAt?: number;
  expiresAt: number;
};

export type StoredGrant = {
  id: string;
  clientId: string;
  clientHost: string;
  clientName?: string;
  scopes: McpScope[];
  /** The consenting session's email, for the owner check (as in the session cookie). */
  email: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type TokenPair = { accessToken: string; refreshToken: string; scopes: McpScope[] };

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A Firestore Timestamp, a Date, or a number of milliseconds. */
export function millisOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && value !== null && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function readAuthCodeDoc(raw: Record<string, unknown> | undefined): StoredAuthCode | null {
  if (raw === undefined) return null;
  const expiresAt = millisOf(raw.expireAt);
  if (
    !nonEmptyString(raw.sub) ||
    !nonEmptyString(raw.grantId) ||
    !nonEmptyString(raw.clientId) ||
    !nonEmptyString(raw.redirectUri) ||
    !nonEmptyString(raw.codeChallenge) ||
    expiresAt === undefined
  ) {
    return null;
  }
  const code: StoredAuthCode = {
    sub: raw.sub,
    grantId: raw.grantId,
    clientId: raw.clientId,
    redirectUri: raw.redirectUri,
    codeChallenge: raw.codeChallenge,
    scopes: readStoredScopes(raw.scopes),
    expiresAt,
  };
  const usedAt = millisOf(raw.usedAt);
  if (usedAt !== undefined) code.usedAt = usedAt;
  return code;
}

export function readTokenDoc(raw: Record<string, unknown> | undefined): StoredToken | null {
  if (raw === undefined) return null;
  const expiresAt = millisOf(raw.expireAt);
  if (
    (raw.kind !== 'access' && raw.kind !== 'refresh') ||
    !nonEmptyString(raw.sub) ||
    !nonEmptyString(raw.grantId) ||
    expiresAt === undefined
  ) {
    return null;
  }
  const token: StoredToken = {
    kind: raw.kind,
    sub: raw.sub,
    grantId: raw.grantId,
    scopes: readStoredScopes(raw.scopes),
    expiresAt,
  };
  const rotatedAt = millisOf(raw.rotatedAt);
  if (rotatedAt !== undefined) token.rotatedAt = rotatedAt;
  return token;
}

export function readGrantDoc(id: string, raw: Record<string, unknown> | undefined): StoredGrant | null {
  if (raw === undefined) return null;
  const createdAt = millisOf(raw.createdAt);
  if (!nonEmptyString(raw.clientId) || !nonEmptyString(raw.clientHost) || typeof raw.email !== 'string' || createdAt === undefined) {
    return null;
  }
  const grant: StoredGrant = {
    id,
    clientId: raw.clientId,
    clientHost: raw.clientHost,
    scopes: readStoredScopes(raw.scopes),
    email: raw.email,
    createdAt,
  };
  if (nonEmptyString(raw.clientName)) grant.clientName = raw.clientName;
  const lastUsedAt = millisOf(raw.lastUsedAt);
  if (lastUsedAt !== undefined) grant.lastUsedAt = lastUsedAt;
  const revokedAt = millisOf(raw.revokedAt);
  if (revokedAt !== undefined) grant.revokedAt = revokedAt;
  return grant;
}

/** The scopes a token may use: its own, narrowed to what its grant still allows. */
export function effectiveScopes(token: StoredToken, grant: StoredGrant): McpScope[] {
  return token.scopes.filter((scope) => grant.scopes.includes(scope));
}

export function grantNeedsTouch(grant: StoredGrant, now: number): boolean {
  return grant.lastUsedAt === undefined || now - grant.lastUsedAt >= GRANT_TOUCH_INTERVAL_MS;
}

function db() {
  return getStoreFirestore();
}

function codeRef(codeHash: string) {
  return db().collection(MCP_AUTH_CODES_COLLECTION).doc(codeHash);
}

function tokenRef(tokenHash: string) {
  return db().collection(MCP_TOKENS_COLLECTION).doc(tokenHash);
}

function grantsCol(sub: string) {
  return db().collection('users').doc(sub).collection(MCP_GRANTS_COLLECTION);
}

function grantRef(sub: string, grantId: string) {
  return grantsCol(sub).doc(grantId);
}

function snapData(snap: { exists: boolean; data(): unknown }): Record<string, unknown> | undefined {
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
}

/** Creates a new access and refresh token for a grant inside `tx`. Returns the raw tokens once. */
function issueTokenPair(
  tx: Transaction,
  input: { sub: string; grantId: string; scopes: McpScope[] },
  now: number,
): TokenPair {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  tx.create(tokenRef(hashSecret(accessToken)), {
    kind: 'access',
    sub: input.sub,
    grantId: input.grantId,
    scopes: input.scopes,
    createdAt: now,
    expireAt: new Date(now + ACCESS_TOKEN_TTL_MS),
  });
  tx.create(tokenRef(hashSecret(refreshToken)), {
    kind: 'refresh',
    sub: input.sub,
    grantId: input.grantId,
    scopes: input.scopes,
    createdAt: now,
    expireAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  });
  return { accessToken, refreshToken, scopes: input.scopes };
}

/**
 * Consent: in one transaction, delete every grant this member already has for
 * this client (live or revoked), create the new grant, and create its
 * authorization code. Returns the raw code once. Deleting rather than marking
 * the old grants revoked keeps this query to about one row however often an
 * app reconnects; a token whose grant is gone is refused like a revoked one.
 *
 * `codeNow` is the clock the code's 60 s expiry is measured from. It defaults
 * to `now` (the grant's `createdAt`). Test mode passes a later clock so a
 * backdated grant can still be redeemed.
 */
export async function createGrantWithCode(
  input: {
    sub: string;
    email: string;
    clientId: string;
    clientHost: string;
    clientName?: string;
    scopes: McpScope[];
    redirectUri: string;
    codeChallenge: string;
  },
  now: number,
  codeNow = now,
): Promise<{ code: string; grantId: string }> {
  const grantId = randomUUID();
  const code = randomToken(32);
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(grantsCol(input.sub).where('clientId', '==', input.clientId));
    for (const doc of existing.docs) tx.delete(doc.ref);
    const grant: Record<string, unknown> = {
      clientId: input.clientId,
      clientHost: input.clientHost,
      scopes: input.scopes,
      email: input.email,
      createdAt: now,
    };
    if (input.clientName !== undefined) grant.clientName = input.clientName;
    tx.create(grantRef(input.sub, grantId), grant);
    tx.create(codeRef(hashSecret(code)), {
      sub: input.sub,
      grantId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      expireAt: new Date(codeNow + AUTH_CODE_TTL_MS),
    });
  });
  return { code, grantId };
}

export type Admission = 'ok' | 'denied' | 'unknown';

export type IssueOutcome =
  | { kind: 'ok'; tokens: TokenPair; sub: string; grantId: string; clientHost: string }
  | { kind: 'invalid_grant'; reason: string; clientHost?: string }
  | { kind: 'invalid_scope'; clientHost?: string }
  | { kind: 'unavailable'; clientHost?: string };

export type AuthCodeCheck = (code: StoredAuthCode) => 'ok' | 'mismatch';

/**
 * Exchanges an authorization code. Reuse of a used code revokes its grant.
 * `check` compares the client, the redirect URI, and PKCE; `admit` runs the
 * membership decision on the grant's identity. Nothing is written unless the
 * exchange succeeds, except the revocation on reuse.
 */
export async function redeemAuthCode(
  codeHash: string,
  check: AuthCodeCheck,
  admit: (identity: { sub: string; email: string }) => Promise<Admission>,
  decide: (code: StoredAuthCode | null, now: number) => 'ok' | 'missing' | 'expired' | 'reused',
  now: number,
): Promise<IssueOutcome> {
  return db().runTransaction(async (tx): Promise<IssueOutcome> => {
    const code = readAuthCodeDoc(snapData(await tx.get(codeRef(codeHash))));
    const decision = decide(code, now);
    if (decision !== 'ok' || code === null) {
      if (decision === 'reused' && code !== null) {
        const ref = grantRef(code.sub, code.grantId);
        const grant = readGrantDoc(code.grantId, snapData(await tx.get(ref)));
        if (grant !== null && grant.revokedAt === undefined) {
          tx.update(ref, { revokedAt: now });
        }
        return { kind: 'invalid_grant', reason: 'reused', clientHost: grant?.clientHost };
      }
      return { kind: 'invalid_grant', reason: decision };
    }
    const ref = grantRef(code.sub, code.grantId);
    const grant = readGrantDoc(code.grantId, snapData(await tx.get(ref)));
    if (check(code) !== 'ok') {
      return { kind: 'invalid_grant', reason: 'mismatch', clientHost: grant?.clientHost };
    }
    if (grant === null || grant.revokedAt !== undefined) {
      return { kind: 'invalid_grant', reason: 'revoked', clientHost: grant?.clientHost };
    }
    const admission = await admit({ sub: code.sub, email: grant.email });
    if (admission === 'unknown') {
      return { kind: 'unavailable', clientHost: grant.clientHost };
    }
    if (admission === 'denied') {
      return { kind: 'invalid_grant', reason: 'denied', clientHost: grant.clientHost };
    }
    tx.update(codeRef(codeHash), { usedAt: now });
    tx.update(ref, { lastUsedAt: now });
    const scopes = code.scopes.filter((scope) => grant.scopes.includes(scope));
    const tokens = issueTokenPair(tx, { sub: code.sub, grantId: code.grantId, scopes }, now);
    return { kind: 'ok', tokens, sub: code.sub, grantId: code.grantId, clientHost: grant.clientHost };
  });
}

export type RefreshDecision = 'ok' | 'missing' | 'expired' | 'grace' | 'reused';

/**
 * Rotates a refresh token: marks the old one `rotatedAt` and issues a new
 * pair. `decide` is `refreshDecision` from `token.ts`; a late reuse of a
 * rotated token revokes the grant. `requested` may narrow the scopes, never
 * widen them. `clientId`, when sent, must be the grant's.
 */
export async function rotateRefreshToken(
  tokenHash: string,
  input: { clientId: string | null; requested: McpScope[] | null },
  admit: (identity: { sub: string; email: string }) => Promise<Admission>,
  decide: (token: StoredToken | null, now: number) => RefreshDecision,
  now: number,
): Promise<IssueOutcome> {
  return db().runTransaction(async (tx): Promise<IssueOutcome> => {
    const token = readTokenDoc(snapData(await tx.get(tokenRef(tokenHash))));
    const decision = decide(token, now);
    if (token === null || decision === 'missing' || decision === 'expired') {
      return { kind: 'invalid_grant', reason: decision };
    }
    const ref = grantRef(token.sub, token.grantId);
    const grant = readGrantDoc(token.grantId, snapData(await tx.get(ref)));
    if (decision === 'grace') {
      return { kind: 'invalid_grant', reason: 'grace', clientHost: grant?.clientHost };
    }
    if (decision === 'reused') {
      if (grant !== null && grant.revokedAt === undefined) {
        tx.update(ref, { revokedAt: now });
      }
      return { kind: 'invalid_grant', reason: 'reused', clientHost: grant?.clientHost };
    }
    if (grant === null || grant.revokedAt !== undefined) {
      return { kind: 'invalid_grant', reason: 'revoked', clientHost: grant?.clientHost };
    }
    if (input.clientId !== null && input.clientId !== grant.clientId) {
      return { kind: 'invalid_grant', reason: 'mismatch', clientHost: grant.clientHost };
    }
    const allowed = effectiveScopes(token, grant);
    const scopes = input.requested ?? allowed;
    if (scopes.length === 0 || !scopes.every((scope) => allowed.includes(scope))) {
      return { kind: 'invalid_scope', clientHost: grant.clientHost };
    }
    const admission = await admit({ sub: token.sub, email: grant.email });
    if (admission === 'unknown') {
      return { kind: 'unavailable', clientHost: grant.clientHost };
    }
    if (admission === 'denied') {
      return { kind: 'invalid_grant', reason: 'denied', clientHost: grant.clientHost };
    }
    tx.update(tokenRef(tokenHash), { rotatedAt: now });
    if (grantNeedsTouch(grant, now)) {
      tx.update(ref, { lastUsedAt: now });
    }
    const tokens = issueTokenPair(tx, { sub: token.sub, grantId: token.grantId, scopes }, now);
    return { kind: 'ok', tokens, sub: token.sub, grantId: token.grantId, clientHost: grant.clientHost };
  });
}

/**
 * RFC 7009: revokes the grant the token belongs to, whichever kind it is.
 * Unknown tokens are not an error. Returns the client's host for the log.
 */
export async function revokeGrantForToken(tokenHash: string, now: number): Promise<string | undefined> {
  return db().runTransaction(async (tx) => {
    const token = readTokenDoc(snapData(await tx.get(tokenRef(tokenHash))));
    if (token === null) return undefined;
    const ref = grantRef(token.sub, token.grantId);
    const grant = readGrantDoc(token.grantId, snapData(await tx.get(ref)));
    if (grant !== null && grant.revokedAt === undefined) {
      tx.update(ref, { revokedAt: now });
    }
    return grant?.clientHost;
  });
}

/**
 * The token and its grant for one `/mcp` call. Two reads: the grant's path
 * needs the `sub` and grant id that only the token document holds.
 */
export async function readAccessContext(
  tokenHash: string,
): Promise<{ token: StoredToken; grant: StoredGrant | null } | null> {
  const token = readTokenDoc(snapData(await tokenRef(tokenHash).get()));
  if (token === null) return null;
  const grant = readGrantDoc(token.grantId, snapData(await grantRef(token.sub, token.grantId).get()));
  return { token, grant };
}

export async function touchGrant(sub: string, grantId: string, now: number): Promise<void> {
  await grantRef(sub, grantId).update({ lastUsedAt: now });
}

/** Live grants for Settings, newest first. */
export async function listLiveGrants(sub: string): Promise<StoredGrant[]> {
  const snap = await grantsCol(sub).get();
  const grants: StoredGrant[] = [];
  for (const doc of snap.docs) {
    const grant = readGrantDoc(doc.id, doc.data() as Record<string, unknown>);
    if (grant !== null && grant.revokedAt === undefined) grants.push(grant);
  }
  return grants.sort((a, b) => b.createdAt - a.createdAt);
}

/** Settings → Disconnect. Its tokens stop working on the very next call. */
export async function revokeGrant(sub: string, grantId: string, now: number): Promise<'revoked' | 'missing'> {
  return db().runTransaction(async (tx) => {
    const ref = grantRef(sub, grantId);
    const grant = readGrantDoc(grantId, snapData(await tx.get(ref)));
    if (grant === null || grant.revokedAt !== undefined) return 'missing';
    tx.update(ref, { revokedAt: now });
    return 'revoked';
  });
}
