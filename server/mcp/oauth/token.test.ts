import { describe, expect, it, vi } from 'vitest';
import { s256Challenge } from './pkce.ts';
import type { IssueOutcome, StoredAuthCode, StoredToken } from './store.ts';
import { hashSecret } from './store.ts';
import {
  authCodeDecision,
  handleRevokePost,
  handleTokenPost,
  refreshDecision,
  type TokenDependencies,
} from './token.ts';

const ORIGIN = 'https://sous.example';
const NOW = 1_700_000_000_000;
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT = 'http://localhost:3118/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function code(overrides: Partial<StoredAuthCode> = {}): StoredAuthCode {
  return {
    sub: 'sub-1',
    grantId: 'g1',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: s256Challenge(VERIFIER),
    scopes: ['recipes:read'],
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function token(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    kind: 'refresh',
    sub: 'sub-1',
    grantId: 'g1',
    scopes: ['recipes:read'],
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

describe('authCodeDecision', () => {
  it('is ok, missing, expired, or reused', () => {
    expect(authCodeDecision(code(), NOW)).toBe('ok');
    expect(authCodeDecision(null, NOW)).toBe('missing');
    expect(authCodeDecision(code({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(authCodeDecision(code({ usedAt: NOW - 5 }), NOW)).toBe('reused');
    expect(authCodeDecision(code({ usedAt: NOW - 5, expiresAt: NOW - 1 }), NOW)).toBe('reused');
  });
});

describe('refreshDecision', () => {
  it('is ok for a live, unrotated refresh token', () => {
    expect(refreshDecision(token(), NOW)).toBe('ok');
  });

  it('treats reuse within 30 s of rotation as a concurrent refresh', () => {
    expect(refreshDecision(token({ rotatedAt: NOW - 30_000 }), NOW)).toBe('grace');
    expect(refreshDecision(token({ rotatedAt: NOW - 1 }), NOW)).toBe('grace');
  });

  it('treats later reuse as theft, which revokes the grant', () => {
    expect(refreshDecision(token({ rotatedAt: NOW - 30_001 }), NOW)).toBe('reused');
  });

  it('is expired after the expiry, and missing for an access token or nothing', () => {
    expect(refreshDecision(token({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(refreshDecision(token({ kind: 'access' }), NOW)).toBe('missing');
    expect(refreshDecision(null, NOW)).toBe('missing');
  });
});

const ISSUED: IssueOutcome = {
  kind: 'ok',
  tokens: { accessToken: 'sous_at_A', refreshToken: 'sous_rt_R', scopes: ['recipes:read', 'recipes:write'] },
  sub: 'sub-1',
  grantId: 'g1',
  clientHost: 'claude.ai',
};

function deps(overrides: Partial<TokenDependencies> = {}): TokenDependencies {
  return {
    now: () => NOW,
    admitLookup: () => true,
    origin: () => ORIGIN,
    admit: async () => 'ok',
    redeemCode: vi.fn(async () => ISSUED),
    rotate: vi.fn(async () => ISSUED),
    revoke: vi.fn(async () => 'claude.ai'),
    ...overrides,
  };
}

function form(fields: Record<string, string>, contentType = 'application/x-www-form-urlencoded'): Request {
  return new Request(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new URLSearchParams(fields).toString(),
  });
}

const CODE_GRANT = {
  grant_type: 'authorization_code',
  code: 'raw-code',
  redirect_uri: REDIRECT,
  client_id: CLIENT_ID,
  code_verifier: VERIFIER,
};

describe('handleTokenPost', () => {
  it('exchanges a code for a bearer pair with no-store', async () => {
    const d = deps();
    const res = await handleTokenPost(form(CODE_GRANT), d);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      access_token: 'sous_at_A',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'sous_rt_R',
      scope: 'recipes:read recipes:write',
    });
    expect(d.redeemCode).toHaveBeenCalledWith(hashSecret('raw-code'), expect.any(Function), d.admit, NOW);
  });

  it('checks client, redirect URI, and PKCE against the stored code', async () => {
    let check: ((c: StoredAuthCode) => 'ok' | 'mismatch') | undefined;
    await handleTokenPost(
      form(CODE_GRANT),
      deps({
        redeemCode: async (_hash, c) => {
          check = c;
          return ISSUED;
        },
      }),
    );
    expect(check?.(code())).toBe('ok');
    expect(check?.(code({ clientId: 'https://other.example/doc' }))).toBe('mismatch');
    expect(check?.(code({ redirectUri: 'http://localhost:9/callback' }))).toBe('mismatch');
    expect(check?.(code({ codeChallenge: s256Challenge(`${VERIFIER}x`) }))).toBe('mismatch');
  });

  it('answers a bogus code with invalid_grant', async () => {
    const res = await handleTokenPost(
      form(CODE_GRANT),
      deps({ redeemCode: async () => ({ kind: 'invalid_grant', reason: 'missing' }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });

  it('answers a membership or store blip with 503, never invalid_grant', async () => {
    const unknown = await handleTokenPost(form(CODE_GRANT), deps({ redeemCode: async () => ({ kind: 'unavailable' }) }));
    expect(unknown.status).toBe(503);
    const thrown = await handleTokenPost(
      form(CODE_GRANT),
      deps({
        redeemCode: async () => {
          throw new Error('firestore down');
        },
      }),
    );
    expect(thrown.status).toBe(503);
  });

  it('refuses a missing parameter, a bad client_id, a foreign resource, or JSON', async () => {
    const { code_verifier: _verifier, ...noVerifier } = CODE_GRANT;
    expect(await (await handleTokenPost(form(noVerifier), deps())).json()).toMatchObject({ error: 'invalid_request' });
    expect(
      await (await handleTokenPost(form({ ...CODE_GRANT, client_id: 'http://x.example/c' }), deps())).json(),
    ).toEqual({ error: 'invalid_client' });
    expect(
      await (await handleTokenPost(form({ ...CODE_GRANT, resource: 'https://other.example/mcp' }), deps())).json(),
    ).toEqual({ error: 'invalid_target' });
    expect((await handleTokenPost(form({ ...CODE_GRANT, resource: `${ORIGIN}/mcp` }), deps())).status).toBe(200);
    const json = await handleTokenPost(form(CODE_GRANT, 'application/json'), deps());
    expect(json.status).toBe(400);
    expect(await (await handleTokenPost(form({ grant_type: 'password' }), deps())).json()).toEqual({
      error: 'unsupported_grant_type',
    });
  });

  it('rotates a refresh token and passes a narrowing scope', async () => {
    const d = deps();
    const res = await handleTokenPost(
      form({ grant_type: 'refresh_token', refresh_token: 'sous_rt_old', client_id: CLIENT_ID, scope: 'recipes:read' }),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.rotate).toHaveBeenCalledWith(
      hashSecret('sous_rt_old'),
      { clientId: CLIENT_ID, requested: ['recipes:read'] },
      d.admit,
      NOW,
    );
  });

  it('answers a dead refresh token with invalid_grant and an unknown scope with invalid_scope', async () => {
    const dead = await handleTokenPost(
      form({ grant_type: 'refresh_token', refresh_token: 'sous_rt_old' }),
      deps({ rotate: async () => ({ kind: 'invalid_grant', reason: 'reused' }) }),
    );
    expect(await dead.json()).toEqual({ error: 'invalid_grant' });
    const scope = await handleTokenPost(
      form({ grant_type: 'refresh_token', refresh_token: 'sous_rt_old', scope: 'recipes:delete' }),
      deps(),
    );
    expect(await scope.json()).toEqual({ error: 'invalid_scope' });
  });

  it('never logs a token, code, or verifier', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTokenPost(form(CODE_GRANT), deps());
    await handleTokenPost(form({ grant_type: 'refresh_token', refresh_token: 'sous_rt_old' }), deps());
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const secret of ['raw-code', VERIFIER, 'sous_at_A', 'sous_rt_R', 'sous_rt_old']) {
        expect(line).not.toContain(secret);
      }
    }
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'mcp_oauth', step: 'token', grantType: 'refresh_token', outcome: 'ok' });
  });
});

describe('the lookup cap', () => {
  it('answers 503 with Retry-After, before any store call, on every grant type and on revoke', async () => {
    const d = deps({ admitLookup: () => false });
    const responses = [
      await handleTokenPost(form(CODE_GRANT), d),
      await handleTokenPost(form({ grant_type: 'refresh_token', refresh_token: 'sous_rt_old' }), d),
      await handleRevokePost(form({ token: 'sous_at_whatever' }), d),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('60');
    }
    expect(d.redeemCode).not.toHaveBeenCalled();
    expect(d.rotate).not.toHaveBeenCalled();
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it('is not spent on a request rejected before the store', async () => {
    const admitLookup = vi.fn(() => true);
    await handleTokenPost(form({ grant_type: 'password' }), deps({ admitLookup }));
    await handleTokenPost(form({ ...CODE_GRANT, client_id: 'http://x.example/c' }), deps({ admitLookup }));
    expect(admitLookup).not.toHaveBeenCalled();
  });
});

describe('handleRevokePost', () => {
  it('revokes by hash and is 200 whether or not the token was known', async () => {
    const d = deps({ revoke: vi.fn(async () => undefined) });
    const res = await handleRevokePost(form({ token: 'sous_at_whatever' }), d);
    expect(res.status).toBe(200);
    expect(d.revoke).toHaveBeenCalledWith(hashSecret('sous_at_whatever'), NOW);
  });

  it('needs a token', async () => {
    expect((await handleRevokePost(form({}), deps())).status).toBe(400);
  });
});
