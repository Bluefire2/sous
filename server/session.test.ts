import { beforeEach, describe, expect, it } from 'vitest';
import {
  COLLECTION_LINK_COOKIE_NAME,
  INVITE_COOKIE_NAME,
  MCP_AUTHZ_COOKIE_NAME,
  OAUTH_COOKIE_NAME,
  clearedCollectionLinkCookie,
  clearedMcpAuthzCookie,
  clearedSessionCookie,
  collectionLinkCookie,
  inviteCookie,
  mcpAuthzCookie,
  oauthCookie,
  readCookie,
  readHeaderSession,
  readSession,
  safeReturnTo,
  sessionCookie,
  sessionFromHeader,
  signAccessRequestTx,
  signAuthTx,
  signCollectionLinkTx,
  signInviteTx,
  signMcpAuthzTx,
  signSession,
  verifyAccessRequestTx,
  verifyAuthTx,
  verifyCollectionLinkTx,
  verifyInviteTx,
  verifyMcpAuthzTx,
  verifySession,
} from './session.ts';

const ORIGIN = 'http://localhost:5173';
function nowMs(): number {
  return Date.now();
}

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
});

describe('signSession / verifySession', () => {
  it('round-trips sub and email', () => {
    const now = nowMs();
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, now);
    const session = verifySession(token, now);
    expect(session).toEqual({
      sub: 'sub-1',
      email: 'allowed@example.com',
      iat: now,
      exp: now + 90 * 24 * 60 * 60 * 1000,
    });
  });

  it('rejects a tampered payload', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    expect(verifySession(`${p}x.${s}`, nowMs())).toBeNull();
  });

  it('rejects a signature with extra non-alphabet characters', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    expect(verifySession(`${p}.${s}!`, nowMs())).toBeNull();
  });

  it('rejects a signature from a different secret', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    process.env.SESSION_SECRET = 'other-secret';
    expect(verifySession(token, nowMs())).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    expect(verifySession(token, nowMs() + 100 * 24 * 3600 * 1000)).toBeNull();
  });

  it('rejects wrong version and malformed tokens', () => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.v = 2;
    const bad = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(verifySession(bad, nowMs())).toBeNull();
    expect(verifySession('', nowMs())).toBeNull();
    expect(verifySession('a', nowMs())).toBeNull();
    expect(verifySession('a.b.c', nowMs())).toBeNull();
  });
});

describe('readSession', () => {
  it('is absent without a cookie header', () => {
    const req = new Request('http://localhost/');
    expect(readSession(req)).toEqual({ status: 'absent' });
  });

  it('is unusable for garbage cookie', () => {
    const req = new Request('http://localhost/', {
      headers: { cookie: 'sous_session=garbage.garbage' },
    });
    expect(readSession(req)).toEqual({ status: 'unusable' });
  });

  it('is ok for any valid cookie — membership is enforced by requireMember', () => {
    const token = signSession({ sub: 'sub-1', email: 'not@listed.com' }, nowMs());
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    const result = readSession(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.email).toBe('not@listed.com');
    }
  });

  it('is ok for a valid allowlisted cookie', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    const result = readSession(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.sub).toBe('sub-1');
    }
  });

  it('treats blank SESSION_SECRET as unusable when a cookie is present', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    process.env.SESSION_SECRET = '';
    const req = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    expect(readSession(req)).toEqual({ status: 'unusable' });
  });

  it('is absent when secret is blank and no cookie', () => {
    process.env.SESSION_SECRET = '';
    const req = new Request('http://localhost/');
    expect(readSession(req)).toEqual({ status: 'absent' });
  });
});

describe('readHeaderSession', () => {
  function withHeader(value: string): Request {
    return new Request('http://localhost/', {
      headers: { 'x-sous-session': value },
    });
  }

  it('accepts a valid token from the header', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const result = readHeaderSession(withHeader(token));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.sub).toBe('sub-1');
    }
    expect(sessionFromHeader(withHeader(token))?.sub).toBe('sub-1');
  });

  it('treats a missing, blank, or whitespace header as absent', () => {
    expect(readHeaderSession(new Request('http://localhost/'))).toEqual({
      status: 'absent',
    });
    expect(readHeaderSession(withHeader(''))).toEqual({ status: 'absent' });
    expect(readHeaderSession(withHeader('   '))).toEqual({ status: 'absent' });
  });

  it('rejects a tampered header token', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const [payload, signature] = token.split('.');
    expect(readHeaderSession(withHeader(`${payload}x.${signature}`))).toEqual({
      status: 'unusable',
    });
    expect(sessionFromHeader(withHeader(`${payload}x.${signature}`))).toBeNull();
  });

  it('is ok for any valid header token — membership is enforced by requireHeaderMember', () => {
    const token = signSession({ sub: 'sub-1', email: 'removed@example.com' }, nowMs());
    const result = readHeaderSession(withHeader(token));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.session.email).toBe('removed@example.com');
    }
  });

  it('ignores the cookie, and the cookie path ignores the header', () => {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, nowMs());
    const cookieOnly = new Request('http://localhost/', {
      headers: { cookie: `sous_session=${token}` },
    });
    expect(readHeaderSession(cookieOnly)).toEqual({ status: 'absent' });
    expect(readSession(withHeader(token))).toEqual({ status: 'absent' });
  });
});

describe('readCookie', () => {
  it('parses absent, single, multiple, and values with equals', () => {
    expect(readCookie(new Request('http://x/'), 'a')).toBeNull();
    expect(
      readCookie(new Request('http://x/', { headers: { cookie: 'a=1' } }), 'a'),
    ).toBe('1');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: 'a=1; b=2; c=3' } }),
        'b',
      ),
    ).toBe('2');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: ' a=1 ; b=2 ' } }),
        'a',
      ),
    ).toBe('1');
    expect(
      readCookie(
        new Request('http://x/', { headers: { cookie: 'sig=abc=def=' } }),
        'sig',
      ),
    ).toBe('abc=def=');
  });
});

describe('sessionCookie', () => {
  it('includes HttpOnly, SameSite=Lax, Path=/, and Secure when asked', () => {
    const withSecure = sessionCookie('tok', { secure: true });
    expect(withSecure).toContain('HttpOnly');
    expect(withSecure).toContain('SameSite=Lax');
    expect(withSecure).toContain('Path=/');
    expect(withSecure).toContain('Secure');
    const plain = sessionCookie('tok', { secure: false });
    expect(plain).not.toContain('Secure');
    expect(clearedSessionCookie({ secure: false })).toContain('Max-Age=0');
    expect(oauthCookie('tok', { secure: true })).toContain('Max-Age=600');
  });
});

describe('safeReturnTo', () => {
  it('keeps /settings and rejects open redirects', () => {
    expect(safeReturnTo('/settings', ORIGIN)).toBe('/settings');
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '/%5Cevil.example',
      '/%5cevil.example',
      'https://evil.example/',
      '/path\\nasty',
      '/\n',
    ]) {
      expect(safeReturnTo(bad, ORIGIN)).toBe('/');
    }
  });
});

describe('signAccessRequestTx / verifyAccessRequestTx', () => {
  it('round-trips access request identity', () => {
    const now = nowMs();
    const token = signAccessRequestTx(
      { sub: 'sub-a', email: 'a@example.com', name: 'A' },
      now,
    );
    expect(verifyAccessRequestTx(token, now)).toEqual({
      sub: 'sub-a',
      email: 'a@example.com',
      name: 'A',
      iat: now,
      exp: now + 10 * 60 * 1000,
    });
  });

  it('rejects expired tokens', () => {
    const now = nowMs();
    const token = signAccessRequestTx({ sub: 'sub-a', email: 'a@example.com' }, now);
    expect(verifyAccessRequestTx(token, now + 11 * 60 * 1000)).toBeNull();
  });

  it('rejects session, oauth, and invite tokens', () => {
    const now = nowMs();
    const sessionToken = signSession({ sub: 'sub-a', email: 'a@example.com' }, now);
    const authTxToken = signAuthTx(
      { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' },
      now,
    );
    const inviteToken = signInviteTx(
      { id: 'a'.repeat(64) },
      now,
    );
    expect(verifyAccessRequestTx(sessionToken, now)).toBeNull();
    expect(verifyAccessRequestTx(authTxToken, now)).toBeNull();
    expect(verifyAccessRequestTx(inviteToken, now)).toBeNull();
  });
});

describe('verifySession rejects accessreq tokens', () => {
  it('returns null for accessreq family', () => {
    const now = nowMs();
    const token = signAccessRequestTx({ sub: 'sub-a', email: 'a@example.com' }, now);
    expect(verifySession(token, now)).toBeNull();
  });
});

describe('signAuthTx / verifyAuthTx', () => {
  it('round-trips oauth transaction fields', () => {
    const token = signAuthTx(
      { state: 'st', nonce: 'no', verifier: 'ver', returnTo: '/settings' },
      nowMs(),
    );
    expect(verifyAuthTx(token, nowMs())).toMatchObject({
      state: 'st',
      nonce: 'no',
      verifier: 'ver',
      returnTo: '/settings',
    });
    expect(verifyAuthTx(token, nowMs())?.invite).toBeUndefined();
  });

  it('round-trips an optional invite hash', () => {
    const invite = 'ab'.repeat(32);
    const token = signAuthTx(
      { state: 'st', nonce: 'no', verifier: 'ver', returnTo: '/', invite },
      nowMs(),
    );
    expect(verifyAuthTx(token, nowMs())).toMatchObject({ invite });
  });

  // Minted by the function before its rename (signOauthTx on main), with this
  // file's SESSION_SECRET. A `sous_oauth` cookie in flight across a deploy
  // must keep verifying, so the signed bytes must not change.
  it('signs and verifies byte-identical tokens to the pre-rename format', () => {
    const iat = 1_750_000_000_000;
    const plain =
      'eyJ2Ijoib2F1dGgiLCJzdGF0ZSI6InN0Iiwibm9uY2UiOiJubyIsInZlcmlmaWVyIjoidmVyIiwicmV0dXJuVG8iOiIvc2V0dGluZ3MiLCJpYXQiOjE3NTAwMDAwMDAwMDAsImV4cCI6MTc1MDAwMDYwMDAwMH0.YJmFBzzyW99EgpEfvd1ZLDcrAuDe_Kvvk4_x3PTuLPM';
    const withInvite =
      'eyJ2Ijoib2F1dGgiLCJzdGF0ZSI6InN0Iiwibm9uY2UiOiJubyIsInZlcmlmaWVyIjoidmVyIiwicmV0dXJuVG8iOiIvIiwiaWF0IjoxNzUwMDAwMDAwMDAwLCJleHAiOjE3NTAwMDA2MDAwMDAsImludml0ZSI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIifQ.Zhe93qniCIeSSvED4iyU2LSX04IycJyAJuOyYdCR8ec';
    const invite = 'ab'.repeat(32);
    expect(
      signAuthTx({ state: 'st', nonce: 'no', verifier: 'ver', returnTo: '/settings' }, iat),
    ).toBe(plain);
    expect(
      signAuthTx({ state: 'st', nonce: 'no', verifier: 'ver', returnTo: '/', invite }, iat),
    ).toBe(withInvite);
    expect(verifyAuthTx(plain, iat)).toEqual({
      state: 'st',
      nonce: 'no',
      verifier: 'ver',
      returnTo: '/settings',
      iat,
      exp: iat + 10 * 60 * 1000,
    });
    expect(verifyAuthTx(withInvite, iat)).toEqual({
      state: 'st',
      nonce: 'no',
      verifier: 'ver',
      returnTo: '/',
      invite,
      iat,
      exp: iat + 10 * 60 * 1000,
    });
  });

  it('rejects invite, session, and accessreq tokens', () => {
    const now = nowMs();
    const inviteToken = signInviteTx({ id: 'b'.repeat(64) }, now);
    const sessionToken = signSession({ sub: 's', email: 'a@b.c' }, now);
    const accessreq = signAccessRequestTx({ sub: 's', email: 'a@b.c' }, now);
    expect(verifyAuthTx(inviteToken, now)).toBeNull();
    expect(verifyAuthTx(sessionToken, now)).toBeNull();
    expect(verifyAuthTx(accessreq, now)).toBeNull();
  });
});

describe('signInviteTx / verifyInviteTx', () => {
  it('round-trips the invite document id', () => {
    const now = nowMs();
    const id = 'c'.repeat(64);
    const token = signInviteTx({ id }, now);
    expect(verifyInviteTx(token, now)).toEqual({
      id,
      iat: now,
      exp: now + 10 * 60 * 1000,
    });
  });

  it('rejects expired tokens', () => {
    const now = nowMs();
    const token = signInviteTx({ id: 'd'.repeat(64) }, now);
    expect(verifyInviteTx(token, now + 11 * 60 * 1000)).toBeNull();
  });

  it('rejects session, oauth, and accessreq tokens', () => {
    const now = nowMs();
    const sessionToken = signSession({ sub: 's', email: 'a@b.c' }, now);
    const authTxToken = signAuthTx(
      { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' },
      now,
    );
    const accessreq = signAccessRequestTx({ sub: 's', email: 'a@b.c' }, now);
    expect(verifyInviteTx(sessionToken, now)).toBeNull();
    expect(verifyInviteTx(authTxToken, now)).toBeNull();
    expect(verifyInviteTx(accessreq, now)).toBeNull();
  });

  it('sets the invite cookie Max-Age to 10 minutes', () => {
    expect(inviteCookie('tok', { secure: true })).toContain('Max-Age=600');
    expect(inviteCookie('tok', { secure: true })).toContain('HttpOnly');
  });
});

describe('signCollectionLinkTx / verifyCollectionLinkTx', () => {
  it('round-trips the link document id for 10 minutes', () => {
    const now = nowMs();
    const id = 'e'.repeat(64);
    const token = signCollectionLinkTx({ id }, now);
    expect(verifyCollectionLinkTx(token, now)).toEqual({ id, iat: now, exp: now + 10 * 60 * 1000 });
    expect(verifyCollectionLinkTx(token, now + 11 * 60 * 1000)).toBeNull();
  });

  it('refuses to sign anything but a sha256 hex id', () => {
    expect(() => signCollectionLinkTx({ id: 'raw-token' }, nowMs())).toThrow();
  });

  it('is its own family: invite, oauth, session, and accessreq do not cross', () => {
    const now = nowMs();
    const id = 'f'.repeat(64);
    const link = signCollectionLinkTx({ id }, now);
    expect(verifyInviteTx(link, now)).toBeNull();
    expect(verifyAuthTx(link, now)).toBeNull();
    expect(verifySession(link, now)).toBeNull();
    expect(verifyAccessRequestTx(link, now)).toBeNull();
    expect(verifyCollectionLinkTx(signInviteTx({ id }, now), now)).toBeNull();
    expect(verifyCollectionLinkTx(signSession({ sub: 's', email: 'a@b.c' }, now), now)).toBeNull();
    expect(
      verifyCollectionLinkTx(
        signAuthTx({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/' }, now),
        now,
      ),
    ).toBeNull();
  });

  it('scopes the hop cookie to /c, HttpOnly, Lax, 10 minutes', () => {
    const cookie = collectionLinkCookie('tok', { secure: true });
    expect(cookie.startsWith(`${COLLECTION_LINK_COOKIE_NAME}=tok;`)).toBe(true);
    expect(cookie).toContain('Path=/c');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
    expect(clearedCollectionLinkCookie({ secure: false })).toContain('Max-Age=0');
    expect(clearedCollectionLinkCookie({ secure: false })).toContain('Path=/c');
    expect(COLLECTION_LINK_COOKIE_NAME).not.toBe(INVITE_COOKIE_NAME);
    expect(COLLECTION_LINK_COOKIE_NAME).not.toBe(OAUTH_COOKIE_NAME);
  });
});

describe('signMcpAuthzTx / verifyMcpAuthzTx', () => {
  const tx = {
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirectUri: 'http://localhost:3118/callback',
    state: 'st',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    scopes: ['recipes:read'],
    nonce: 'nonce-1',
  };

  it('round-trips the request for 10 minutes, with and without state', () => {
    const now = nowMs();
    expect(verifyMcpAuthzTx(signMcpAuthzTx(tx, now), now)).toEqual({
      ...tx,
      iat: now,
      exp: now + 10 * 60 * 1000,
    });
    const { state: _state, ...stateless } = tx;
    expect(verifyMcpAuthzTx(signMcpAuthzTx(stateless, now), now)).not.toHaveProperty('state');
    expect(verifyMcpAuthzTx(signMcpAuthzTx(tx, now), now + 11 * 60 * 1000)).toBeNull();
  });

  it('is its own family: session, oauth, invite, clink, and accessreq do not cross', () => {
    const now = nowMs();
    const authz = signMcpAuthzTx(tx, now);
    expect(verifySession(authz, now)).toBeNull();
    expect(verifyAuthTx(authz, now)).toBeNull();
    expect(verifyInviteTx(authz, now)).toBeNull();
    expect(verifyCollectionLinkTx(authz, now)).toBeNull();
    expect(verifyAccessRequestTx(authz, now)).toBeNull();
    const id = 'a'.repeat(64);
    for (const other of [
      signSession({ sub: 's', email: 'a@b.c' }, now),
      signAuthTx({ state: 's', nonce: 'n', verifier: 'v', returnTo: '/' }, now),
      signInviteTx({ id }, now),
      signCollectionLinkTx({ id }, now),
      signAccessRequestTx({ sub: 's', email: 'a@b.c' }, now),
    ]) {
      expect(verifyMcpAuthzTx(other, now)).toBeNull();
    }
  });

  it('rejects a tampered payload', () => {
    const [payload, signature] = signMcpAuthzTx(tx, nowMs()).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), scopes: ['recipes:write'] }),
    ).toString('base64url');
    expect(verifyMcpAuthzTx(`${forged}.${signature}`, nowMs())).toBeNull();
  });

  it('scopes the hop cookie to /oauth, HttpOnly, Lax, 10 minutes', () => {
    const cookie = mcpAuthzCookie('tok', { secure: true });
    expect(cookie.startsWith(`${MCP_AUTHZ_COOKIE_NAME}=tok;`)).toBe(true);
    expect(cookie).toContain('Path=/oauth');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
    expect(clearedMcpAuthzCookie({ secure: false })).toContain('Max-Age=0');
    expect(clearedMcpAuthzCookie({ secure: false })).toContain('Path=/oauth');
    expect(new Set([MCP_AUTHZ_COOKIE_NAME, COLLECTION_LINK_COOKIE_NAME, INVITE_COOKIE_NAME, OAUTH_COOKIE_NAME]).size).toBe(4);
  });
});
