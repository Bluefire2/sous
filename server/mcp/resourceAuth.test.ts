import { describe, expect, it, vi } from 'vitest';
import type { StoredGrant, StoredToken } from './oauth/store.ts';
import { hashSecret } from './oauth/store.ts';
import { accessTokenUsable, authenticateMcp, bearerToken, type ResourceAuthDependencies } from './resourceAuth.ts';

const NOW = 1_700_000_000_000;

function token(overrides: Partial<StoredToken> = {}): StoredToken {
  return { kind: 'access', sub: 'sub-1', grantId: 'g1', scopes: ['recipes:read'], expiresAt: NOW + 1000, ...overrides };
}

function grant(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    id: 'g1',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientHost: 'claude.ai',
    scopes: ['recipes:read', 'recipes:write'],
    email: 'member@example.com',
    createdAt: NOW - 10,
    lastUsedAt: NOW - 10,
    ...overrides,
  };
}

function req(authorization?: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request('https://sous.example/mcp', { method: 'POST', headers });
}

function deps(overrides: Partial<ResourceAuthDependencies> = {}): ResourceAuthDependencies {
  return {
    now: () => NOW,
    readAccessContext: vi.fn(async () => ({ token: token(), grant: grant() })),
    admit: vi.fn(async () => 'ok' as const),
    touchGrant: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('bearerToken', () => {
  it('reads the Authorization header only', () => {
    expect(bearerToken(req('Bearer sous_at_abc'))).toBe('sous_at_abc');
    expect(bearerToken(req('bearer sous_at_abc'))).toBe('sous_at_abc');
    expect(bearerToken(req('Basic xyz'))).toBeNull();
    expect(bearerToken(req(undefined, 'sous_session=abc.def'))).toBeNull();
  });
});

describe('accessTokenUsable', () => {
  it('needs an unexpired access token whose grant is live and still allows a scope', () => {
    expect(accessTokenUsable(token(), grant(), NOW)).toBe(true);
    expect(accessTokenUsable(token({ kind: 'refresh' }), grant(), NOW)).toBe(false);
    expect(accessTokenUsable(token({ expiresAt: NOW }), grant(), NOW)).toBe(false);
    expect(accessTokenUsable(token(), grant({ revokedAt: NOW - 1 }), NOW)).toBe(false);
    expect(accessTokenUsable(token(), null, NOW)).toBe(false);
    expect(accessTokenUsable(token({ scopes: ['recipes:write'] }), grant({ scopes: ['recipes:read'] }), NOW)).toBe(false);
  });
});

describe('authenticateMcp', () => {
  it('looks up the hash of the token and returns the grant identity and scopes', async () => {
    const d = deps();
    expect(await authenticateMcp(req('Bearer sous_at_abc'), d)).toEqual({
      kind: 'ok',
      sub: 'sub-1',
      grantId: 'g1',
      scopes: ['recipes:read'],
      clientHost: 'claude.ai',
    });
    expect(d.readAccessContext).toHaveBeenCalledWith(hashSecret('sous_at_abc'));
    expect(d.admit).toHaveBeenCalledWith({ sub: 'sub-1', email: 'member@example.com' });
  });

  it('never reads a cookie, and refuses a non-Sous token unread', async () => {
    const d = deps();
    expect(await authenticateMcp(req(undefined, 'sous_session=abc.def'), d)).toEqual({ kind: 'invalid', presented: false });
    expect(await authenticateMcp(req('Bearer sous_rt_abc'), d)).toEqual({ kind: 'invalid', presented: true });
    expect(d.readAccessContext).not.toHaveBeenCalled();
  });

  it('a revoked grant is refused on the very next call', async () => {
    const d = deps({ readAccessContext: async () => ({ token: token(), grant: grant({ revokedAt: NOW - 1 }) }) });
    expect(await authenticateMcp(req('Bearer sous_at_abc'), d)).toEqual({ kind: 'invalid', presented: true });
  });

  it('keeps denied and unknown apart', async () => {
    expect(await authenticateMcp(req('Bearer sous_at_abc'), deps({ admit: async () => 'denied' }))).toEqual({
      kind: 'denied',
    });
    expect(await authenticateMcp(req('Bearer sous_at_abc'), deps({ admit: async () => 'unknown' }))).toEqual({
      kind: 'unknown',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = deps({
      readAccessContext: async () => {
        throw new Error('down');
      },
    });
    expect(await authenticateMcp(req('Bearer sous_at_abc'), down)).toEqual({ kind: 'unknown' });
  });

  it('touches lastUsedAt at most once an hour, and a failed touch does not fail the call', async () => {
    const fresh = deps();
    await authenticateMcp(req('Bearer sous_at_abc'), fresh);
    expect(fresh.touchGrant).not.toHaveBeenCalled();
    const stale = deps({
      readAccessContext: async () => ({ token: token(), grant: grant({ lastUsedAt: NOW - 61 * 60 * 1000 }) }),
      touchGrant: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await authenticateMcp(req('Bearer sous_at_abc'), stale)).kind).toBe('ok');
    expect(stale.touchGrant).toHaveBeenCalledWith('sub-1', 'g1', NOW);
  });
});
