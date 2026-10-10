import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisitorMembership } from '../../membership.ts';
import { MCP_AUTHZ_COOKIE_NAME, signMcpAuthzTx, verifyMcpAuthzTx, type McpAuthzTx } from '../../session.ts';
import {
  clientRedirectUrl,
  handleAuthorizeGet,
  handleConsentGet,
  handleConsentPost,
  parseAuthorizeRequest,
  type AuthorizeDependencies,
} from './authorize.ts';
import type { ClientMetadataResult } from './clientMetadata.ts';

const ORIGIN = 'https://sous.example';
const NOW = 1_700_000_000_000;
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://localhost:3118/callback';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-mcp-authorize';
});

function authorizeParams(overrides: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'recipes:read',
    resource: `${ORIGIN}/mcp`,
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value !== null) params.set(key, value);
  }
  return params;
}

describe('parseAuthorizeRequest', () => {
  it('accepts a well-formed request and defaults scope to read', () => {
    expect(parseAuthorizeRequest(authorizeParams({ scope: null, resource: null }), ORIGIN)).toEqual({
      kind: 'ok',
      tx: { clientId: CLIENT_ID, redirectUri: REDIRECT, state: 'xyz', codeChallenge: CHALLENGE, scopes: ['recipes:read'] },
    });
  });

  it('renders a page for a bad client_id or redirect_uri, a repeated parameter, or a huge state', () => {
    expect(parseAuthorizeRequest(authorizeParams({ client_id: 'http://claude.ai/x' }), ORIGIN)).toEqual({
      kind: 'page',
      reason: 'bad_client_id',
    });
    expect(parseAuthorizeRequest(authorizeParams({ redirect_uri: 'http://evil.example/cb' }), ORIGIN)).toEqual({
      kind: 'page',
      reason: 'bad_redirect_uri',
    });
    const twice = authorizeParams();
    twice.append('client_id', CLIENT_ID);
    expect(parseAuthorizeRequest(twice, ORIGIN)).toEqual({ kind: 'page', reason: 'bad_request' });
    expect(parseAuthorizeRequest(authorizeParams({ state: 's'.repeat(513) }), ORIGIN)).toEqual({
      kind: 'page',
      reason: 'bad_request',
    });
  });

  it('carries other errors for the client, to report once the redirect URI is verified', () => {
    const errorOf = (overrides: Record<string, string | null>) => {
      const parsed = parseAuthorizeRequest(authorizeParams(overrides), ORIGIN);
      return parsed.kind === 'ok' ? parsed.tx.error : parsed.reason;
    };
    expect(errorOf({ response_type: 'token' })).toBe('unsupported_response_type');
    expect(errorOf({ code_challenge: null })).toBe('invalid_request');
    expect(errorOf({ code_challenge_method: 'plain' })).toBe('invalid_request');
    expect(errorOf({ code_challenge_method: null })).toBe('invalid_request');
    expect(errorOf({ scope: 'recipes:read admin' })).toBe('invalid_scope');
    expect(errorOf({ resource: 'https://other.example/mcp' })).toBe('invalid_target');
    expect(errorOf({})).toBeUndefined();
  });
});

describe('clientRedirectUrl', () => {
  it('adds code or error, state, and iss, keeping the URI query', () => {
    expect(clientRedirectUrl('https://app.example/cb?x=1', { code: 'c' }, 's t', ORIGIN)).toBe(
      'https://app.example/cb?x=1&code=c&state=s+t&iss=https%3A%2F%2Fsous.example',
    );
    expect(clientRedirectUrl(REDIRECT, { error: 'access_denied' }, undefined, ORIGIN)).toBe(
      'http://localhost:3118/callback?error=access_denied&iss=https%3A%2F%2Fsous.example',
    );
  });
});

const MEMBER: VisitorMembership = { kind: 'ok', sub: 'member-sub', email: 'member@example.com', isOwner: false };
const CLIENT_OK: ClientMetadataResult = {
  ok: true,
  client: { clientId: CLIENT_ID, clientName: 'Claude Code', redirectUris: ['http://localhost/callback'] },
};

function deps(overrides: Partial<AuthorizeDependencies> = {}) {
  const createGrant = vi.fn(async () => ({ code: 'the-code', grantId: 'g1' }));
  const resolveClient = vi.fn(async () => CLIENT_OK);
  const d: AuthorizeDependencies = {
    now: () => NOW,
    secure: () => true,
    origin: () => ORIGIN,
    nonce: () => 'nonce-1',
    identity: async () => MEMBER,
    resolveClient,
    createGrant,
    ...overrides,
  };
  return d;
}

function hop(overrides: Partial<McpAuthzTx> = {}): string {
  return signMcpAuthzTx(
    {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      state: 'xyz',
      codeChallenge: CHALLENGE,
      scopes: ['recipes:read'],
      nonce: 'nonce-1',
      ...overrides,
    },
    NOW,
  );
}

function consentGet(cookie?: string): Request {
  return new Request(`${ORIGIN}/oauth/consent`, {
    headers: cookie === undefined ? {} : { cookie: `${MCP_AUTHZ_COOKIE_NAME}=${cookie}` },
  });
}

function consentPost(fields: Record<string, string>, options: { cookie?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (options.cookie !== undefined) headers.cookie = `${MCP_AUTHZ_COOKIE_NAME}=${options.cookie}`;
  headers.origin = options.origin ?? ORIGIN;
  return new Request(`${ORIGIN}/oauth/consent`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

describe('GET /oauth/authorize', () => {
  it('stores the request in the /oauth hop cookie and 303s to consent, fetching nothing', async () => {
    const d = deps();
    const res = await handleAuthorizeGet(new Request(`${ORIGIN}/oauth/authorize?${authorizeParams()}`), d);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/oauth/consent');
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toContain('Path=/oauth');
    const value = cookie.split(';')[0]!.slice(`${MCP_AUTHZ_COOKIE_NAME}=`.length);
    expect(verifyMcpAuthzTx(value, NOW)).toMatchObject({ clientId: CLIENT_ID, state: 'xyz', nonce: 'nonce-1' });
    expect(d.resolveClient).not.toHaveBeenCalled();
  });

  it('renders the error page for a malformed client_id, never redirecting', async () => {
    const res = await handleAuthorizeGet(
      new Request(`${ORIGIN}/oauth/authorize?${authorizeParams({ client_id: 'not-a-url' })}`),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('GET /oauth/consent', () => {
  it('sends a signed-out visitor to sign in and back', async () => {
    const res = await handleConsentGet(consentGet(hop()), deps({ identity: async () => ({ kind: 'signedOut' }) }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/api/auth/start?returnTo=%2Foauth%2Fconsent');
  });

  it('shows a non-member the invitation-only page without fetching the client', async () => {
    const d = deps({ identity: async () => ({ kind: 'denied', sub: 's', email: 'x@example.com' }) });
    const res = await handleConsentGet(consentGet(hop()), d);
    expect(res.status).toBe(403);
    expect(d.resolveClient).not.toHaveBeenCalled();
  });

  it('is 503 when membership is unknown', async () => {
    expect((await handleConsentGet(consentGet(hop()), deps({ identity: async () => ({ kind: 'unknown' }) }))).status).toBe(
      503,
    );
  });

  it('renders the consent form for a member, with anti-framing headers', async () => {
    const res = await handleConsentGet(consentGet(hop()), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const html = await res.text();
    expect(html).toContain('claude.ai wants to use your Sous recipes');
    expect(html).toContain('runs on your computer');
    expect(html).toContain('value="nonce-1"');
  });

  it('renders a page, never a redirect, when the metadata fails or the redirect is not registered', async () => {
    const failed = await handleConsentGet(
      consentGet(hop()),
      deps({ resolveClient: async () => ({ ok: false, reason: 'fetch_failed' }) }),
    );
    expect(failed.status).toBe(400);
    expect(failed.headers.get('location')).toBeNull();
    const mismatch = await handleConsentGet(consentGet(hop({ redirectUri: 'http://localhost:3118/other' })), deps());
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get('location')).toBeNull();
  });

  it('reports a carried error to the verified redirect URI', async () => {
    const res = await handleConsentGet(consentGet(hop({ error: 'invalid_scope', scopes: [] })), deps());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3118/callback?error=invalid_scope&state=xyz&iss=https%3A%2F%2Fsous.example',
    );
  });

  it('is the expired page without a hop cookie', async () => {
    expect((await handleConsentGet(consentGet(), deps())).status).toBe(400);
  });
});

describe('POST /oauth/consent', () => {
  it('Allow creates the grant and redirects with code, state, and iss', async () => {
    const d = deps();
    const res = await handleConsentPost(consentPost({ nonce: 'nonce-1', decision: 'allow' }, { cookie: hop() }), d);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3118/callback?code=the-code&state=xyz&iss=https%3A%2F%2Fsous.example',
    );
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect(d.createGrant).toHaveBeenCalledWith(
      {
        sub: 'member-sub',
        email: 'member@example.com',
        clientId: CLIENT_ID,
        clientHost: 'claude.ai',
        clientName: 'Claude Code',
        scopes: ['recipes:read'],
        redirectUri: REDIRECT,
        codeChallenge: CHALLENGE,
      },
      NOW,
    );
  });

  it('Deny redirects with access_denied and writes nothing', async () => {
    const d = deps();
    const res = await handleConsentPost(consentPost({ nonce: 'nonce-1', decision: 'deny' }, { cookie: hop() }), d);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3118/callback?error=access_denied&state=xyz&iss=https%3A%2F%2Fsous.example',
    );
    expect(d.createGrant).not.toHaveBeenCalled();
  });

  it('refuses a cross-site POST or a wrong nonce without writing or clearing the hop cookie', async () => {
    const d = deps();
    const cross = await handleConsentPost(
      consentPost({ nonce: 'nonce-1', decision: 'allow' }, { cookie: hop(), origin: 'https://evil.example' }),
      d,
    );
    expect(cross.status).toBe(403);
    expect(cross.headers.getSetCookie()).toEqual([]);
    const wrongNonce = await handleConsentPost(consentPost({ nonce: 'other', decision: 'allow' }, { cookie: hop() }), d);
    expect(wrongNonce.status).toBe(403);
    expect(d.createGrant).not.toHaveBeenCalled();
  });

  it('re-verifies the redirect URI before writing', async () => {
    const d = deps();
    const res = await handleConsentPost(
      consentPost({ nonce: 'nonce-1', decision: 'allow' }, { cookie: hop({ redirectUri: 'https://evil.example/cb' }) }),
      d,
    );
    expect(res.status).toBe(400);
    expect(d.createGrant).not.toHaveBeenCalled();
  });
});
