import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sessionSecret } from './env.ts';

export const SESSION_COOKIE_NAME = 'sous_session';
export const OAUTH_COOKIE_NAME = 'sous_oauth';
export const INVITE_COOKIE_NAME = 'sous_invite';
/**
 * Hop cookie for a shareable collection link (`/c/<token>`). Carries only the
 * link's sha256 id, HMAC-signed, for 10 minutes, and only on `/c` paths so it
 * survives the Google round trip without being sent anywhere else.
 */
export const COLLECTION_LINK_COOKIE_NAME = 'sous_collection_link';
const COLLECTION_LINK_COOKIE_PATH = '/c';
/**
 * Hop cookie for an MCP client's authorization request (`/oauth/authorize` →
 * `/oauth/consent`). Carries the request's parameters and a nonce the consent
 * form posts back, HMAC-signed, for 10 minutes, and only on `/oauth` paths.
 */
export const MCP_AUTHZ_COOKIE_NAME = 'sous_mcp_authz';
const MCP_AUTHZ_COOKIE_PATH = '/oauth';

/**
 * Carries the same token as the cookie, for clients that cannot rely on the
 * browser attaching a `SameSite=Lax` cookie — today only the Chrome extension,
 * which reads the cookie itself and forwards it. Honoured by
 * `readHeaderSession` alone; every other route stays cookie-only.
 */
export const SESSION_HEADER_NAME = 'x-sous-session';

const SESSION_MAX_AGE_SEC = 90 * 24 * 60 * 60;
const OAUTH_MAX_AGE_SEC = 600;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

export interface AuthTxPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  invite?: string;
  iat: number;
  exp: number;
}

export interface InviteTxPayload {
  id: string;
  iat: number;
  exp: number;
}

export interface CollectionLinkTxPayload {
  id: string;
  iat: number;
  exp: number;
}

export interface McpAuthzTx {
  clientId: string;
  redirectUri: string;
  /** Echoed back to the client untouched; absent when the request had none. */
  state?: string;
  codeChallenge: string;
  scopes: string[];
  /** Posted back by the consent form; pins the POST to the page that rendered it. */
  nonce: string;
  /**
   * An OAuth error code found in the request. It is reported to the client
   * only after the consent step verifies `redirectUri` against the client's
   * metadata, so an unverified URI never receives a redirect.
   */
  error?: string;
}

export interface McpAuthzTxPayload extends McpAuthzTx {
  iat: number;
  exp: number;
}

export interface AccessRequestTxPayload {
  sub: string;
  email: string;
  name?: string;
  iat: number;
  exp: number;
}

export type ReadSessionResult =
  | { status: 'ok'; session: SessionPayload }
  | { status: 'absent' }
  | { status: 'unusable' };

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

/** Rejects non-alphabet characters that Node's base64url decoder would ignore. */
function decodeBase64urlStrict(part: string): Buffer | null {
  if (part === '' || /[^A-Za-z0-9_-]/.test(part)) {
    return null;
  }
  const buf = Buffer.from(part, 'base64url');
  if (buf.toString('base64url') !== part) {
    return null;
  }
  return buf;
}

function base64urlDecodeJson(tokenPart: string): unknown | null {
  const buf = decodeBase64urlStrict(tokenPart);
  if (!buf) {
    return null;
  }
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 with the server's `SESSION_SECRET` authenticates a token we
 * issued; it is not password storage, so a slow KDF would be wrong here.
 * CodeQL's `js/insufficient-password-hash` guesses passwords from names
 * (anything containing "oauth" counts), so keep such names off the values
 * passed to the sign/verify functions below.
 */
function hmacSign(payloadPart: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payloadPart).digest();
  return base64urlEncode(sig);
}

function hmacVerify(payloadPart: string, sigPart: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  const actual = decodeBase64urlStrict(sigPart);
  if (!actual || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function splitToken(token: string): { payload: string; signature: string } | null {
  if (typeof token !== 'string') {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot === -1) {
    return null;
  }
  if (token.indexOf('.', dot + 1) !== -1) {
    return null;
  }
  return { payload: token.slice(0, dot), signature: token.slice(dot + 1) };
}

export function signSession(
  user: { sub: string; email: string },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + NINETY_DAYS_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({ v: 1, sub: user.sub, email: user.email, iat, exp }),
  );
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifySession(token: string, now: number): SessionPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 1) {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string') {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  return { sub: row.sub, email: row.email, iat: row.iat, exp: row.exp };
}

const INVITE_ID_RE = /^[a-f0-9]{64}$/;

export function isInviteId(raw: string): boolean {
  return INVITE_ID_RE.test(raw);
}

/** The Google sign-in transaction carried in the `sous_oauth` cookie. */
export function signAuthTx(
  tx: {
    state: string;
    nonce: string;
    verifier: string;
    returnTo: string;
    invite?: string;
  },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payload: Record<string, unknown> = {
    v: 'oauth',
    state: tx.state,
    nonce: tx.nonce,
    verifier: tx.verifier,
    returnTo: tx.returnTo,
    iat,
    exp,
  };
  if (tx.invite !== undefined) {
    if (!isInviteId(tx.invite)) {
      throw new Error('oauth invite id is not a sha256 hex digest');
    }
    payload.invite = tx.invite;
  }
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyAuthTx(token: string, now: number): AuthTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    state?: unknown;
    nonce?: unknown;
    verifier?: unknown;
    returnTo?: unknown;
    invite?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'oauth') {
    return null;
  }
  if (
    typeof row.state !== 'string' ||
    typeof row.nonce !== 'string' ||
    typeof row.verifier !== 'string' ||
    typeof row.returnTo !== 'string'
  ) {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  const out: AuthTxPayload = {
    state: row.state,
    nonce: row.nonce,
    verifier: row.verifier,
    returnTo: row.returnTo,
    iat: row.iat,
    exp: row.exp,
  };
  if (typeof row.invite === 'string' && isInviteId(row.invite)) {
    out.invite = row.invite;
  }
  return out;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) {
      continue;
    }
    return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function oauthCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${OAUTH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedOauthCookie(options: { secure: boolean }): string {
  const parts = [
    `${OAUTH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function signInviteTx(tx: { id: string }, now: number): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  if (!isInviteId(tx.id)) {
    throw new Error('invite id is not a sha256 hex digest');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({ v: 'invite', id: tx.id, iat, exp }),
  );
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyInviteTx(token: string, now: number): InviteTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    id?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'invite') {
    return null;
  }
  if (typeof row.id !== 'string' || !isInviteId(row.id)) {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  return { id: row.id, iat: row.iat, exp: row.exp };
}

export function inviteCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedInviteCookie(options: { secure: boolean }): string {
  const parts = [
    `${INVITE_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function signCollectionLinkTx(tx: { id: string }, now: number): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  if (!isInviteId(tx.id)) {
    throw new Error('collection link id is not a sha256 hex digest');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payloadPart = base64urlEncode(
    JSON.stringify({ v: 'clink', id: tx.id, iat, exp }),
  );
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyCollectionLinkTx(
  token: string,
  now: number,
): CollectionLinkTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    id?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'clink') {
    return null;
  }
  if (typeof row.id !== 'string' || !isInviteId(row.id)) {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  return { id: row.id, iat: row.iat, exp: row.exp };
}

export function collectionLinkCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${COLLECTION_LINK_COOKIE_NAME}=${token}`,
    'HttpOnly',
    `Path=${COLLECTION_LINK_COOKIE_PATH}`,
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedCollectionLinkCookie(options: { secure: boolean }): string {
  const parts = [
    `${COLLECTION_LINK_COOKIE_NAME}=`,
    'HttpOnly',
    `Path=${COLLECTION_LINK_COOKIE_PATH}`,
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** The MCP authorization request carried in the `sous_mcp_authz` cookie (`v: 'mcpauthz'`). */
export function signMcpAuthzTx(tx: McpAuthzTx, now: number): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payload: Record<string, unknown> = {
    v: 'mcpauthz',
    clientId: tx.clientId,
    redirectUri: tx.redirectUri,
    codeChallenge: tx.codeChallenge,
    scopes: tx.scopes,
    nonce: tx.nonce,
    iat,
    exp,
  };
  if (tx.state !== undefined) {
    payload.state = tx.state;
  }
  if (tx.error !== undefined) {
    payload.error = tx.error;
  }
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyMcpAuthzTx(token: string, now: number): McpAuthzTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    clientId?: unknown;
    redirectUri?: unknown;
    state?: unknown;
    codeChallenge?: unknown;
    scopes?: unknown;
    nonce?: unknown;
    error?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'mcpauthz') {
    return null;
  }
  if (
    typeof row.clientId !== 'string' ||
    typeof row.redirectUri !== 'string' ||
    typeof row.codeChallenge !== 'string' ||
    typeof row.nonce !== 'string' ||
    row.nonce === ''
  ) {
    return null;
  }
  if (!Array.isArray(row.scopes) || !row.scopes.every((s) => typeof s === 'string')) {
    return null;
  }
  if (row.state !== undefined && typeof row.state !== 'string') {
    return null;
  }
  if (row.error !== undefined && typeof row.error !== 'string') {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  const out: McpAuthzTxPayload = {
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    scopes: row.scopes as string[],
    nonce: row.nonce,
    iat: row.iat,
    exp: row.exp,
  };
  if (typeof row.state === 'string') {
    out.state = row.state;
  }
  if (typeof row.error === 'string') {
    out.error = row.error;
  }
  return out;
}

export function mcpAuthzCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${MCP_AUTHZ_COOKIE_NAME}=${token}`,
    'HttpOnly',
    `Path=${MCP_AUTHZ_COOKIE_PATH}`,
    'SameSite=Lax',
    `Max-Age=${OAUTH_MAX_AGE_SEC}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearedMcpAuthzCookie(options: { secure: boolean }): string {
  const parts = [
    `${MCP_AUTHZ_COOKIE_NAME}=`,
    'HttpOnly',
    `Path=${MCP_AUTHZ_COOKIE_PATH}`,
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Cryptographic validation only — not an authorization decision.
 * Call `requireMember` (cookie) or `requireHeaderMember` (header).
 * A null token is absent before the secret is consulted, so a missing
 * credential stays absent even when `SESSION_SECRET` is unset.
 */
function sessionFromToken(token: string | null): ReadSessionResult {
  if (token === null) {
    return { status: 'absent' };
  }
  const secret = sessionSecret();
  if (!secret) {
    return { status: 'unusable' };
  }
  const session = verifySession(token, Date.now());
  if (!session) {
    return { status: 'unusable' };
  }
  return { status: 'ok', session };
}

/** Cryptographic cookie validation only — not an authorization decision; call `requireMember`. */
export function readSession(req: Request): ReadSessionResult {
  return sessionFromToken(readCookie(req, SESSION_COOKIE_NAME));
}

export function signAccessRequestTx(
  identity: { sub: string; email: string; name?: string },
  now: number,
): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const iat = now;
  const exp = now + TEN_MINUTES_MS;
  const payload: Record<string, unknown> = {
    v: 'accessreq',
    sub: identity.sub,
    email: identity.email,
    iat,
    exp,
  };
  if (identity.name !== undefined) {
    payload.name = identity.name;
  }
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(payloadPart, secret);
  return `${payloadPart}.${signature}`;
}

export function verifyAccessRequestTx(
  token: string,
  now: number,
): AccessRequestTxPayload | null {
  const secret = sessionSecret();
  if (!secret) {
    return null;
  }
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  if (!hmacVerify(parts.payload, parts.signature, secret)) {
    return null;
  }
  const parsed = base64urlDecodeJson(parts.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    name?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 'accessreq') {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string' || row.email === '') {
    return null;
  }
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number') {
    return null;
  }
  if (row.exp <= now) {
    return null;
  }
  const out: AccessRequestTxPayload = {
    sub: row.sub,
    email: row.email,
    iat: row.iat,
    exp: row.exp,
  };
  if (typeof row.name === 'string' && row.name !== '') {
    out.name = row.name;
  }
  return out;
}

/**
 * Header only, with no cookie fallback: the extension always has the token in
 * hand, and a fallback would give this route two different auth stories.
 */
export function readHeaderSession(req: Request): ReadSessionResult {
  const raw = req.headers.get(SESSION_HEADER_NAME)?.trim();
  return sessionFromToken(raw === undefined || raw === '' ? null : raw);
}

export function sessionFromHeader(req: Request): SessionPayload | null {
  const result = readHeaderSession(req);
  if (result.status === 'ok') {
    return result.session;
  }
  return null;
}

export function shouldRefresh(session: SessionPayload, now: number): boolean {
  return now - session.iat > REFRESH_AFTER_MS;
}

const C0_OR_DEL_OR_BACKSLASH = /[\u0000-\u001F\u007F\\]/;
const ENCODED_BACKSLASH = /%5[cC]/;

export function safeReturnTo(raw: string | null | undefined, origin: string): string {
  if (raw === null || raw === undefined || raw === '') {
    return '/';
  }
  if (C0_OR_DEL_OR_BACKSLASH.test(raw) || ENCODED_BACKSLASH.test(raw)) {
    return '/';
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return '/';
  }
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return '/';
  }
  if (resolved.origin !== base.origin) {
    return '/';
  }
  if (!resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) {
    return '/';
  }
  return `${resolved.pathname}${resolved.search}`;
}

export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}
