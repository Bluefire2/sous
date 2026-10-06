/**
 * AGENTS.md: the inline session gate in `api/chat.ts` (the Vercel copy) "must
 * stay in sync with `server/session.ts` and `server/allowlist.ts`". This
 * runs both on one table of requests and fails when either copy changes
 * alone. The server side is `readSession` plus the owner allowlist, which is
 * the decision Vercel makes (it has no Firestore member tier).
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionSub } from '../api/chat.ts';
import { isAllowed } from '../server/allowlist.ts';
import {
  SESSION_COOKIE_NAME,
  readSession,
  signAccessRequestTx,
  signAuthTx,
  signInviteTx,
  signSession,
} from '../server/session.ts';

const SECRET = 'parity-test-secret';
const NOW = Date.now();
const INVITE_ID = 'a'.repeat(64);

function serverGate(req: Request): string | null {
  const result = readSession(req);
  if (result.status !== 'ok') return null;
  return isAllowed(result.session.email, true, process.env.ALLOWED_EMAILS ?? '') ? result.session.sub : null;
}

/** A token signed by hand, for payloads `signSession` never writes. */
function handSigned(payload: unknown, secret = SECRET): string {
  return signedPart(Buffer.from(JSON.stringify(payload)).toString('base64url'), secret);
}

/** A correctly signed token around any payload part, so a row reaches the payload checks. */
function signedPart(part: string, secret = SECRET): string {
  return `${part}.${createHmac('sha256', secret).update(part).digest('base64url')}`;
}

function request(token: string | null, extraCookies = ''): Request {
  const cookies = [extraCookies, token === null ? '' : `${SESSION_COOKIE_NAME}=${token}`]
    .filter((part) => part !== '')
    .join('; ');
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: cookies === '' ? {} : { cookie: cookies },
  });
}

const valid = { v: 1, sub: 'sub-1', email: 'Owner@Example.com', iat: NOW, exp: NOW + 60_000 };

type Row = {
  label: string;
  allowed?: string;
  secret?: string;
  /** Built inside the test, after the env is set: signers read SESSION_SECRET. */
  req: () => Request;
  /** The sub both copies must return, or null. */
  want: string | null;
  /** The clock for this row, for the expiry boundary. */
  at?: number;
};

const ROWS: Row[] = [
  { label: 'a session token for an allowed address', req: () => request(signSession({ sub: 'sub-1', email: 'owner@example.com' }, NOW)), want: 'sub-1' },
  { label: 'an address in another case', req: () => request(signSession({ sub: 'sub-1', email: 'OWNER@example.COM' }, NOW)), want: 'sub-1' },
  { label: 'an allowlist with spaces and empty entries', allowed: ' , owner@example.com ,,', req: () => request(signSession({ sub: 'sub-1', email: 'owner@example.com' }, NOW)), want: 'sub-1' },
  { label: 'an address not in the allowlist', req: () => request(signSession({ sub: 'sub-2', email: 'member@example.com' }, NOW)), want: null },
  { label: 'a blank allowlist', allowed: '   ', req: () => request(signSession({ sub: 'sub-1', email: 'owner@example.com' }, NOW)), want: null },
  { label: 'a blank SESSION_SECRET', secret: ' ', req: () => request(handSigned(valid, ' ')), want: null },
  { label: 'no cookie', req: () => request(null), want: null },
  { label: 'the token after another cookie', req: () => request(signSession({ sub: 'sub-1', email: 'owner@example.com' }, NOW), 'theme=dark'), want: 'sub-1' },
  { label: 'a hand-signed payload of the same shape', req: () => request(handSigned(valid)), want: 'sub-1' },
  { label: 'an expired token', req: () => request(handSigned({ ...valid, exp: NOW - 1 })), want: null },
  { label: 'a token whose exp is exactly now', at: NOW, req: () => request(handSigned({ ...valid, exp: NOW })), want: null },
  { label: 'a token with a millisecond left', at: NOW, req: () => request(handSigned({ ...valid, exp: NOW + 1 })), want: 'sub-1' },
  { label: 'version 2', req: () => request(handSigned({ ...valid, v: 2 })), want: null },
  { label: 'version "1" as a string', req: () => request(handSigned({ ...valid, v: '1' })), want: null },
  { label: 'an empty sub', req: () => request(handSigned({ ...valid, sub: '' })), want: null },
  { label: 'a numeric sub', req: () => request(handSigned({ ...valid, sub: 7 })), want: null },
  { label: 'a missing email', req: () => request(handSigned({ ...valid, email: undefined })), want: null },
  { label: 'a string exp', req: () => request(handSigned({ ...valid, exp: String(NOW + 60_000) })), want: null },
  { label: 'a token with no iat', req: () => request(handSigned({ ...valid, iat: undefined })), want: null },
  { label: 'a string iat', req: () => request(handSigned({ ...valid, iat: String(NOW) })), want: null },
  { label: 'another secret', req: () => request(handSigned(valid, 'other-secret')), want: null },
  { label: 'a tampered payload', req: () => request(handSigned(valid).replace(/^./, (c) => (c === 'e' ? 'f' : 'e'))), want: null },
  { label: 'a signature with a stray character', req: () => request(`${handSigned(valid)}=`), want: null },
  { label: 'three parts', req: () => request(`${handSigned(valid)}.extra`), want: null },
  { label: 'no signature', req: () => request(handSigned(valid).split('.')[0]), want: null },
  { label: 'a signed payload that is not JSON', req: () => request(signedPart(Buffer.from('{').toString('base64url'))), want: null },
  { label: 'a signed payload that is not an object', req: () => request(signedPart(Buffer.from('7').toString('base64url'))), want: null },
  { label: 'a signed payload part that is not canonical base64url', req: () => request(signedPart(`${Buffer.from(JSON.stringify(valid)).toString('base64url')}A`)), want: null },
  { label: 'an oauth transaction token', req: () => request(signAuthTx({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/' }, NOW)), want: null },
  { label: 'an invite hop token', req: () => request(signInviteTx({ id: INVITE_ID }, NOW)), want: null },
  { label: 'an access-request token for an allowed address', req: () => request(signAccessRequestTx({ sub: 'sub-1', email: 'owner@example.com' }, NOW)), want: null },
];

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('api/chat.ts sessionSub agrees with server/session.ts and server/allowlist.ts', () => {
  for (const row of ROWS) {
    it(row.label, () => {
      if (row.allowed !== undefined) vi.stubEnv('ALLOWED_EMAILS', row.allowed);
      if (row.at !== undefined) {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(row.at);
      }
      // Sign with the real secret, then switch, so a blank secret sees a real token.
      const req = row.req();
      if (row.secret !== undefined) vi.stubEnv('SESSION_SECRET', row.secret);
      expect(serverGate(req.clone())).toBe(row.want);
      expect(sessionSub(req)).toBe(row.want);
    });
  }
});
