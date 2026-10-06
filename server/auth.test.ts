import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as invites from './invites.ts';
import * as members from './members.ts';
import * as membership from './membership.ts';
import * as store from './store.ts';
import {
  INVITE_COOKIE_NAME,
  OAUTH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  signAuthTx,
  signInviteTx,
  signSession,
  verifyAuthTx,
  verifySession,
} from './session.ts';
import { authCallbackGoogle, authSession, authSignout, authStart } from './auth.ts';

// The fake Google client. `getOauthClient` caches one instance in module
// scope, so the class reads this shared object, which each test resets.
const google = vi.hoisted(() => ({
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1',
  idToken: 'id-token' as string | undefined,
  payload: undefined as Record<string, unknown> | undefined,
  generateAuthUrl: [] as unknown[],
  getToken: [] as unknown[],
  verifyIdToken: [] as unknown[],
  getTokenError: undefined as Error | undefined,
}));

vi.mock('google-auth-library', () => {
  class OAuth2Client {
    generateAuthUrl(options: unknown): string {
      google.generateAuthUrl.push(options);
      return google.authUrl;
    }
    async getToken(options: unknown): Promise<{ tokens: { id_token?: string } }> {
      google.getToken.push(options);
      if (google.getTokenError) throw google.getTokenError;
      return { tokens: { id_token: google.idToken } };
    }
    async verifyIdToken(options: unknown): Promise<{ getPayload: () => unknown }> {
      google.verifyIdToken.push(options);
      return { getPayload: () => google.payload };
    }
  }
  return { OAuth2Client, CodeChallengeMethod: { S256: 'S256', Plain: 'plain' } };
});

vi.mock('./membership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./membership.ts')>();
  return {
    ...actual,
    accessAllows: vi.fn(),
    requireMember: vi.fn(),
    clearMembershipCache: vi.fn(),
  };
});

vi.mock('./invites.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invites.ts')>();
  return { ...actual, redeemInvite: vi.fn() };
});

vi.mock('./members.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./members.ts')>();
  return { ...actual, touchRequestIdentity: vi.fn(async () => {}) };
});

vi.mock('./store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.ts')>();
  return { ...actual, upsertUser: vi.fn(async () => {}) };
});

const ORIGIN = 'https://sous.example';
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const STATE = 'state-abc';
const NONCE = 'nonce-xyz';
const VERIFIER = 'verifier-123';
const SUB = '1234567890';
const EMAIL = 'cook@example.com';
const INVITE_ID = createHash('sha256').update('invite-token').digest('hex');

const accessAllows = vi.mocked(membership.accessAllows);
const requireMember = vi.mocked(membership.requireMember);
const clearMembershipCache = vi.mocked(membership.clearMembershipCache);
const redeemInvite = vi.mocked(invites.redeemInvite);
const touchRequestIdentity = vi.mocked(members.touchRequestIdentity);
const upsertUser = vi.mocked(store.upsertUser);

function goodPayload(): Record<string, unknown> {
  return { sub: SUB, email: EMAIL, email_verified: true, nonce: NONCE, name: 'Cook' };
}

function authTx(overrides: { invite?: string; returnTo?: string } = {}, now = Date.now()): string {
  return signAuthTx(
    {
      state: STATE,
      nonce: NONCE,
      verifier: VERIFIER,
      returnTo: overrides.returnTo ?? '/recipes/abc',
      invite: overrides.invite,
    },
    now,
  );
}

function callback(
  query: Record<string, string>,
  cookies: Record<string, string> = { [OAUTH_COOKIE_NAME]: authTx() },
): Request {
  const url = new URL(`${ORIGIN}/api/auth/callback/google`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const cookie = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
  return new Request(url, { headers: cookie === '' ? {} : { cookie } });
}

const okQuery = { state: STATE, code: 'auth-code' };

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

function cookieNamed(res: Response, name: string): string | undefined {
  return setCookies(res).find((line) => line.startsWith(`${name}=`));
}

/** Every callback answer clears both hop cookies, Secure only on https. */
function expectHopCookiesCleared(res: Response, secure = true): void {
  for (const name of [OAUTH_COOKIE_NAME, INVITE_COOKIE_NAME]) {
    const line = cookieNamed(res, name);
    expect(line, `${name} is cleared`).toBeDefined();
    expect(line).toMatch(new RegExp(`^${name}=;`));
    expect(line).toContain('Max-Age=0');
    expect(line?.includes('Secure')).toBe(secure);
  }
}

function sessionToken(res: Response): string | undefined {
  const line = cookieNamed(res, SESSION_COOKIE_NAME);
  if (line === undefined) return undefined;
  return line.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0];
}

beforeEach(() => {
  vi.stubEnv('PUBLIC_ORIGIN', ORIGIN);
  vi.stubEnv('AUTH_GOOGLE_ID', CLIENT_ID);
  vi.stubEnv('AUTH_GOOGLE_SECRET', 'client-secret');
  vi.stubEnv('SESSION_SECRET', 'auth-test-secret');
  google.idToken = 'id-token';
  google.payload = goodPayload();
  google.generateAuthUrl.length = 0;
  google.getToken.length = 0;
  google.verifyIdToken.length = 0;
  google.getTokenError = undefined;
  accessAllows.mockReset().mockResolvedValue('member');
  requireMember.mockReset();
  clearMembershipCache.mockReset();
  redeemInvite.mockReset();
  touchRequestIdentity.mockReset().mockResolvedValue(undefined);
  upsertUser.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('authStart', () => {
  it('redirects to Google with PKCE S256 and the three scopes, and signs the transaction', async () => {
    const res = await authStart(new Request(`${ORIGIN}/api/auth/start?returnTo=/settings`));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(google.authUrl);

    const options = google.generateAuthUrl[0] as Record<string, unknown>;
    expect(options.scope).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]);
    expect(options.code_challenge_method).toBe('S256');
    expect(options.include_granted_scopes).toBe(false);

    const oauthLine = cookieNamed(res, OAUTH_COOKIE_NAME);
    const token = oauthLine?.slice(OAUTH_COOKIE_NAME.length + 1).split(';')[0] ?? '';
    const tx = verifyAuthTx(token, Date.now());
    expect(tx?.returnTo).toBe('/settings');
    expect(tx?.state).toBe(options.state);
    expect(tx?.nonce).toBe(options.nonce);
    expect(tx?.invite).toBeUndefined();
    const challenge = createHash('sha256').update(tx?.verifier ?? '').digest('base64url');
    expect(options.code_challenge).toBe(challenge);
    expect(oauthLine).toContain('HttpOnly');
    expect(oauthLine).toContain('Secure');
    expect(cookieNamed(res, INVITE_COOKIE_NAME)).toContain('Max-Age=0');
  });

  it('falls back to / for an open redirect', async () => {
    const res = await authStart(
      new Request(`${ORIGIN}/api/auth/start?returnTo=${encodeURIComponent('//evil.example/x')}`),
    );
    const token = cookieNamed(res, OAUTH_COOKIE_NAME)?.slice(OAUTH_COOKIE_NAME.length + 1).split(';')[0] ?? '';
    expect(verifyAuthTx(token, Date.now())?.returnTo).toBe('/');
  });

  it('carries the invite id only from a valid invite hop cookie', async () => {
    const withInvite = await authStart(
      new Request(`${ORIGIN}/api/auth/start`, {
        headers: { cookie: `${INVITE_COOKIE_NAME}=${signInviteTx({ id: INVITE_ID }, Date.now())}` },
      }),
    );
    const token = cookieNamed(withInvite, OAUTH_COOKIE_NAME)?.slice(OAUTH_COOKIE_NAME.length + 1).split(';')[0] ?? '';
    expect(verifyAuthTx(token, Date.now())?.invite).toBe(INVITE_ID);

    const forged = await authStart(
      new Request(`${ORIGIN}/api/auth/start`, { headers: { cookie: `${INVITE_COOKIE_NAME}=forged.token` } }),
    );
    const forgedToken = cookieNamed(forged, OAUTH_COOKIE_NAME)?.slice(OAUTH_COOKIE_NAME.length + 1).split(';')[0] ?? '';
    expect(verifyAuthTx(forgedToken, Date.now())?.invite).toBeUndefined();
  });

  it('omits Secure on an http origin', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:5173');
    const res = await authStart(new Request('http://localhost:5173/api/auth/start'));
    expect(cookieNamed(res, OAUTH_COOKIE_NAME)).not.toContain('Secure');
  });
});

describe('authCallbackGoogle refusals', () => {
  const cases: [string, () => Request][] = [
    ['no transaction cookie', () => callback(okQuery, {})],
    ['a tampered transaction', () => callback(okQuery, { [OAUTH_COOKIE_NAME]: `${authTx()}x` })],
    ['an expired transaction', () => callback(okQuery, { [OAUTH_COOKIE_NAME]: authTx({}, Date.now() - 11 * 60_000) })],
    ['no state', () => callback({ code: 'auth-code' })],
    ['a different state', () => callback({ state: 'state-abd', code: 'auth-code' })],
    ['a state of another length', () => callback({ state: `${STATE}-longer`, code: 'auth-code' })],
    ['no code', () => callback({ state: STATE })],
    ['an empty code', () => callback({ state: STATE, code: '' })],
  ];
  for (const [label, makeRequest] of cases) {
    it(`answers 400 for ${label}, without asking Google for a token`, async () => {
      const res = await authCallbackGoogle(makeRequest());
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Sign-in failed');
      expectHopCookiesCleared(res);
      expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
      expect(google.getToken).toEqual([]);
      expect(accessAllows).not.toHaveBeenCalled();
    });
  }

  const tokenCases: [string, () => void][] = [
    ['no id_token', () => (google.idToken = undefined)],
    ['no payload', () => (google.payload = undefined)],
    ['a nonce mismatch', () => (google.payload = { ...goodPayload(), nonce: 'other' })],
    ['an empty sub', () => (google.payload = { ...goodPayload(), sub: '' })],
    ['an unverified email', () => (google.payload = { ...goodPayload(), email_verified: false })],
    ['a missing email', () => (google.payload = { ...goodPayload(), email: undefined })],
    ['a token exchange that throws', () => (google.getTokenError = new Error('invalid_grant'))],
  ];
  for (const [label, arrange] of tokenCases) {
    it(`answers 400 for ${label}, without an access decision`, async () => {
      arrange();
      const res = await authCallbackGoogle(callback(okQuery));
      expect(res.status).toBe(400);
      expectHopCookiesCleared(res);
      expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
      expect(accessAllows).not.toHaveBeenCalled();
    });
  }

  it('sends a cancelled consent back to Settings', async () => {
    const res = await authCallbackGoogle(callback({ error: 'access_denied' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/settings?signin=cancelled`);
    expectHopCookiesCleared(res);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe('authCallbackGoogle access decisions', () => {
  it('exchanges the code with the transaction verifier and checks the audience', async () => {
    await authCallbackGoogle(callback(okQuery));
    expect(google.getToken).toEqual([{ code: 'auth-code', codeVerifier: VERIFIER }]);
    expect(google.verifyIdToken).toEqual([{ idToken: 'id-token', audience: CLIENT_ID }]);
    expect(accessAllows).toHaveBeenCalledWith({ sub: SUB, email: EMAIL, emailVerified: true });
  });

  it('signs a member in and returns them where they started', async () => {
    const res = await authCallbackGoogle(callback(okQuery));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/recipes/abc`);
    expectHopCookiesCleared(res);
    const session = verifySession(sessionToken(res) ?? '', Date.now());
    expect(session).toMatchObject({ sub: SUB, email: EMAIL });
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toContain('Secure');
    expect(upsertUser).toHaveBeenCalledWith(SUB, { email: EMAIL, name: 'Cook' });
    expect(touchRequestIdentity).toHaveBeenCalledWith(SUB, { sub: SUB, email: EMAIL, name: 'Cook' });
  });

  it('signs an owner in without touching an access request', async () => {
    accessAllows.mockResolvedValue('owner');
    const res = await authCallbackGoogle(callback(okQuery));
    expect(res.status).toBe(302);
    expect(sessionToken(res)).toBeDefined();
    expect(touchRequestIdentity).not.toHaveBeenCalled();
  });

  it('still signs in when the profile write fails', async () => {
    upsertUser.mockRejectedValue(new Error('firestore down'));
    const res = await authCallbackGoogle(callback(okQuery));
    expect(res.status).toBe(302);
    expect(sessionToken(res)).toBeDefined();
  });

  it('answers 503 HTML, not a refusal, when membership is unknown', async () => {
    accessAllows.mockResolvedValue('unknown');
    const res = await authCallbackGoogle(callback(okQuery));
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expectHopCookiesCleared(res);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('refuses a stranger with the invitation-only page and no session', async () => {
    accessAllows.mockResolvedValue('denied');
    const res = await authCallbackGoogle(callback(okQuery));
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain(EMAIL);
    expectHopCookiesCleared(res);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(touchRequestIdentity).toHaveBeenCalledWith(SUB, { sub: SUB, email: EMAIL, name: 'Cook' });
    expect(redeemInvite).not.toHaveBeenCalled();
    expect(upsertUser).not.toHaveBeenCalled();
    // No email or sub on the refusal line.
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(SUB);
  });

  it('admits a stranger who redeems an invite and clears their cached denial', async () => {
    accessAllows.mockResolvedValue('denied');
    redeemInvite.mockResolvedValue({ kind: 'ok' } as Awaited<ReturnType<typeof invites.redeemInvite>>);
    const res = await authCallbackGoogle(
      callback(okQuery, { [OAUTH_COOKIE_NAME]: authTx({ invite: INVITE_ID }) }),
    );
    expect(redeemInvite).toHaveBeenCalledWith(INVITE_ID, { sub: SUB, email: EMAIL, name: 'Cook' }, expect.any(Number));
    expect(clearMembershipCache).toHaveBeenCalledWith(SUB);
    expect(res.status).toBe(302);
    expect(verifySession(sessionToken(res) ?? '', Date.now())?.sub).toBe(SUB);
    expectHopCookiesCleared(res);
  });

  it('refuses a stranger whose invite is dead', async () => {
    accessAllows.mockResolvedValue('denied');
    redeemInvite.mockResolvedValue({ kind: 'refusal', reason: 'used' });
    const res = await authCallbackGoogle(
      callback(okQuery, { [OAUTH_COOKIE_NAME]: authTx({ invite: INVITE_ID }) }),
    );
    expect(res.status).toBe(403);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(clearMembershipCache).not.toHaveBeenCalled();
  });

  it('answers 503 when the redeem throws, and signs no one in', async () => {
    accessAllows.mockResolvedValue('denied');
    redeemInvite.mockRejectedValue(new Error('transaction aborted'));
    const res = await authCallbackGoogle(
      callback(okQuery, { [OAUTH_COOKIE_NAME]: authTx({ invite: INVITE_ID }) }),
    );
    expect(res.status).toBe(503);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toBeUndefined();
    expectHopCookiesCleared(res);
  });

  it('does not redeem for someone already admitted', async () => {
    const res = await authCallbackGoogle(
      callback(okQuery, { [OAUTH_COOKIE_NAME]: authTx({ invite: INVITE_ID }) }),
    );
    expect(res.status).toBe(302);
    expect(redeemInvite).not.toHaveBeenCalled();
  });

  it('omits Secure on every cookie for an http origin', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:5173');
    const res = await authCallbackGoogle(callback(okQuery));
    expectHopCookiesCleared(res, false);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).not.toContain('Secure');
    expect(res.headers.get('Location')).toBe('http://localhost:5173/recipes/abc');
  });
});

describe('authSession', () => {
  function sessionRequest(token?: string): Request {
    return new Request(`${ORIGIN}/api/auth/session`, {
      headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
  }

  it('is a signed-out user without a cookie, and sets nothing', async () => {
    const res = await authSession(sessionRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(setCookies(res)).toEqual([]);
    expect(requireMember).not.toHaveBeenCalled();
  });

  it('clears an unusable cookie without a membership read', async () => {
    const res = await authSession(sessionRequest('garbage'));
    expect(await res.json()).toEqual({ user: null });
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toContain('Max-Age=0');
    expect(requireMember).not.toHaveBeenCalled();
  });

  it('clears the cookie of someone no longer admitted', async () => {
    requireMember.mockResolvedValue({ kind: 'denied' });
    const res = await authSession(sessionRequest(signSession({ sub: SUB, email: EMAIL }, Date.now())));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toContain('Max-Age=0');
  });

  it('answers 503 and keeps the cookie when membership is unknown', async () => {
    requireMember.mockResolvedValue({ kind: 'unknown' });
    const res = await authSession(sessionRequest(signSession({ sub: SUB, email: EMAIL }, Date.now())));
    expect(res.status).toBe(503);
    expect(setCookies(res)).toEqual([]);
  });

  it('returns the member, refreshing the cookie only after a day', async () => {
    requireMember.mockResolvedValue({ kind: 'ok', sub: SUB, email: EMAIL, isOwner: true });
    const fresh = await authSession(sessionRequest(signSession({ sub: SUB, email: EMAIL }, Date.now())));
    expect(await fresh.json()).toEqual({ user: { sub: SUB, email: EMAIL, isOwner: true } });
    expect(setCookies(fresh)).toEqual([]);

    const old = await authSession(
      sessionRequest(signSession({ sub: SUB, email: EMAIL }, Date.now() - 2 * 24 * 60 * 60 * 1000)),
    );
    const refreshed = verifySession(sessionToken(old) ?? '', Date.now());
    expect(refreshed?.sub).toBe(SUB);
    expect(refreshed?.iat).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('authSignout', () => {
  it('answers 204 and clears the session cookie', async () => {
    const res = await authSignout(new Request(`${ORIGIN}/api/auth/signout`, { method: 'POST' }));
    expect(res.status).toBe(204);
    expect(cookieNamed(res, SESSION_COOKIE_NAME)).toMatch(/^sous_session=;.*Max-Age=0.*Secure$/);
  });
});
