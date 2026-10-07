/**
 * The production dispatcher (`scripts/server.ts`) on a real socket, with a
 * temporary static root and no Firestore. Every request here is answered
 * before any store read: wrong methods, unknown paths, static files, and
 * routes that refuse an anonymous caller from the cookie alone. Routes that
 * read Firestore for an anonymous visitor (`GET /api/public/<token>`, the
 * `/invite/<token>` and `/c/<token>` landings, the OAuth token and authorize
 * endpoints, photo reads) stay with `.github/scripts/smoke-server.sh`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_BODY_BYTES } from '../server/importRoute.ts';
import { SESSION_COOKIE_NAME, signSession } from '../server/session.ts';
import * as sync from '../server/sync.ts';
import { apiRoutes, createRequestListener } from './server.ts';

vi.mock('../server/sync.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sync.ts')>();
  return { ...actual, syncPull: vi.fn(actual.syncPull) };
});

/**
 * What each exact route answers a caller with no cookie and an empty body.
 * A new route in `apiRoutes` fails the "every route is listed" case until it
 * is added here, with the status it should give a stranger.
 */
const ANONYMOUS_STATUS: Record<string, number> = {
  'POST /api/chat': 401,
  'POST /api/import': 401,
  'POST /api/import-feedback': 401,
  'POST /api/feature-request': 401,
  'POST /api/stt': 401,
  'POST /api/agent': 401,
  'POST /api/translate': 401,
  // The invitation-only form posts a signed token as a form body.
  'POST /api/access-request': 415,
  'GET /api/admin/requests': 401,
  'POST /api/admin/decision': 401,
  'GET /api/admin/invites': 401,
  'POST /api/admin/invites': 401,
  'POST /api/admin/invites/revoke': 401,
  'POST /api/invites': 401,
  'GET /api/auth/start': 302,
  'GET /api/auth/callback/google': 400,
  'GET /api/auth/session': 200,
  'POST /api/auth/signout': 204,
  'GET /api/sync/pull': 401,
  'GET /api/sync/shared': 401,
  'POST /api/sync/push': 401,
  'POST /api/shared/leave': 401,
  'POST /api/public/join': 401,
  'POST /api/extension/import': 401,
  // No chrome-extension:// Origin, so no CORS grant.
  'OPTIONS /api/extension/import': 403,
  'GET /api/mcp/grants': 401,
  'POST /api/mcp/grants/revoke': 401,
};

const UUID = '0b7c9a52-3d7e-4a43-9a43-2f4c5f6f7a10';

let staticDir: string;
let withStatic: Server;
let apiOnly: Server;
let staticBase: string;
let apiBase: string;

function listen(staticRoot: string | null): Promise<Server> {
  const server = createServer(createRequestListener({ staticRoot }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function baseOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

async function send(base: string, method: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method, redirect: 'manual', ...init });
}

/** A path sent byte for byte; `fetch` would normalize `..` and reject some escapes. */
function rawStatus(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

type UploadResult = { status: number; body: string; reusedSocket: boolean } | { error: string };

/**
 * A POST of `bytes` bytes (forever when `Infinity`) written as fast as the
 * socket takes them, chunked unless `contentLength` is set. Resolves with the
 * response, or the client's error code when the connection fails first.
 */
function upload(
  base: string,
  path: string,
  options: { bytes: number; contentLength?: boolean; agent?: HttpAgent | false; headers?: Record<string, string> },
): Promise<UploadResult> {
  const { hostname, port } = new URL(base);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...options.headers,
  };
  if (options.contentLength) {
    headers['Content-Length'] = String(options.bytes);
  }
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname, port, path, method: 'POST', headers, agent: options.agent ?? false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, reusedSocket: req.reusedSocket }));
        res.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
    const piece = 'a'.repeat(16 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < options.bytes && !req.destroyed) {
        const next = piece.slice(0, Math.min(piece.length, options.bytes - sent));
        sent += next.length;
        if (!req.write(next)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'dispatch-test-secret');
  vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:8080');
  vi.stubEnv('AUTH_GOOGLE_ID', 'client-id.apps.googleusercontent.com');
  vi.stubEnv('AUTH_GOOGLE_SECRET', 'client-secret');
  vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
  vi.spyOn(console, 'log').mockImplementation(() => {});

  staticDir = mkdtempSync(join(tmpdir(), 'sous-dispatch-'));
  mkdirSync(join(staticDir, 'assets'));
  mkdirSync(join(staticDir, 'icons'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Sous</title>');
  writeFileSync(join(staticDir, 'privacy.html'), '<!doctype html><title>Privacy</title>');
  writeFileSync(join(staticDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(staticDir, 'assets', 'app-abc.js'), 'console.log(1);');
  writeFileSync(join(staticDir, 'icons', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  withStatic = await listen(staticDir);
  apiOnly = await listen(null);
  staticBase = baseOf(withStatic);
  apiBase = baseOf(apiOnly);
});

afterAll(async () => {
  await close(withStatic);
  await close(apiOnly);
  rmSync(staticDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(sync.syncPull).mockClear();
});

describe('exact API routes', () => {
  it('every route is listed with the status a stranger gets', () => {
    expect(Object.keys(ANONYMOUS_STATUS).sort()).toEqual(
      apiRoutes.map((route) => `${route.method} ${route.path}`).sort(),
    );
  });

  for (const route of apiRoutes) {
    const key = `${route.method} ${route.path}`;
    it(`${key} answers a caller with no cookie with ${ANONYMOUS_STATUS[key]}`, async () => {
      const res = await send(apiBase, route.method, route.path, route.method === 'GET' ? {} : { body: '' });
      expect(res.status).toBe(ANONYMOUS_STATUS[key]);
      // Denied is 401, never 503 (unknown) or 500 (a crash).
      expect([500, 503]).not.toContain(res.status);
    });
  }

  it('answers 405 for a known path with the wrong method', async () => {
    const paths = new Map<string, Set<string>>();
    for (const route of apiRoutes) {
      paths.set(route.path, (paths.get(route.path) ?? new Set()).add(route.method));
    }
    for (const [path, methods] of paths) {
      const wrong = ['GET', 'POST', 'PUT', 'DELETE'].find((method) => !methods.has(method)) as string;
      const res = await send(apiBase, wrong, path);
      expect(res.status, `${wrong} ${path}`).toBe(405);
    }
  });

  it('answers HEAD on a GET-only API route as a wrong method, with no body', async () => {
    const res = await send(apiBase, 'HEAD', '/api/sync/pull');
    expect(res.status).toBe(405);
    expect(await res.text()).toBe('');
  });

  it('answers 404 for an unknown API path, also without a static root', async () => {
    expect((await send(apiBase, 'GET', '/api/nope')).status).toBe(404);
    expect((await send(staticBase, 'GET', '/api/nope')).status).toBe(404);
    expect((await send(apiBase, 'GET', '/api/sync/pull/extra')).status).toBe(404);
  });
});

describe('prefix API routes', () => {
  it('match only their own shape and method', async () => {
    const cases: [string, string, number][] = [
      ['DELETE', `/api/photos/${UUID}`, 405],
      ['GET', `/api/photos/${UUID}/extra`, 404],
      ['GET', '/api/photos/', 404],
      ['POST', '/api/public/sometoken', 405],
      ['PUT', `/api/collections/${UUID}/grants`, 405],
      ['GET', `/api/collections/${UUID}/grants/revoke`, 405],
      ['GET', `/api/collections/${UUID}/grants/role`, 405],
      ['DELETE', `/api/collections/${UUID}/public`, 405],
      ['GET', `/api/collections/${UUID}/public/revoke`, 405],
      ['DELETE', `/api/collections/${UUID}/links`, 405],
      ['GET', `/api/collections/${UUID}/links/revoke`, 405],
      ['GET', `/api/collections/${UUID}/nope`, 404],
    ];
    for (const [method, path, status] of cases) {
      expect((await send(apiBase, method, path)).status, `${method} ${path}`).toBe(status);
    }
  });

  it('refuses an anonymous owner request on a collection route with 401', async () => {
    for (const path of [`/api/collections/${UUID}/grants`, `/api/collections/${UUID}/links`]) {
      expect((await send(apiBase, 'GET', path)).status, path).toBe(401);
    }
  });
});

describe('MCP and server pages', () => {
  it('serves discovery, refuses /mcp without a bearer, and 405s what it does not serve', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
      const res = await send(apiBase, 'GET', path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('application/json');
    }
    const mcp = await send(apiBase, 'POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toMatch(/^Bearer /);

    const cases: [string, string, number][] = [
      ['GET', '/mcp', 405],
      ['DELETE', '/mcp', 405],
      ['GET', '/oauth/token', 405],
      ['POST', '/oauth/authorize', 405],
      ['GET', '/oauth/nope', 404],
      ['GET', '/.well-known/oauth-nope', 404],
      ['POST', '/invite/sometoken', 405],
      ['PUT', '/c/join', 405],
      ['POST', '/c/sometoken', 405],
    ];
    for (const [method, path, status] of cases) {
      expect((await send(staticBase, method, path)).status, `${method} ${path}`).toBe(status);
    }
  });

  it('never answers an MCP path from the SPA fallback', async () => {
    const res = await send(staticBase, 'GET', '/oauth/nope');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<!doctype html>');
  });
});

describe('static files', () => {
  it('serves the SPA shell for client routes and no-cache on it', async () => {
    for (const path of ['/', '/settings', '/recipes/abc']) {
      const res = await send(staticBase, 'GET', path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text()).toContain('<title>Sous</title>');
    }
  });

  it('serves the legal pages from their html files', async () => {
    const res = await send(staticBase, 'GET', '/privacy');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Privacy</title>');
    // No terms.html in this root: a 404, not the SPA shell.
    expect((await send(staticBase, 'GET', '/terms')).status).toBe(404);
  });

  it('caches hashed assets for a year and the service worker never', async () => {
    const asset = await send(staticBase, 'GET', '/assets/app-abc.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await send(staticBase, 'GET', '/sw.js')).headers.get('cache-control')).toBe('no-cache');
    expect((await send(staticBase, 'GET', '/icons/icon.png')).headers.get('cache-control')).toBe(
      'public, max-age=86400',
    );
  });

  it('answers 404 for a missing file with an extension, and 405 for a write', async () => {
    expect((await send(staticBase, 'GET', '/missing.css')).status).toBe(404);
    expect((await send(staticBase, 'POST', '/')).status).toBe(405);
    expect((await send(staticBase, 'POST', '/settings')).status).toBe(405);
  });

  it('keeps public collection pages out of Referer and search results', async () => {
    for (const path of ['/p', '/p/sometoken', '/p/sometoken/r/abc']) {
      const res = await send(staticBase, 'GET', path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex');
    }
    expect((await send(staticBase, 'GET', '/settings')).headers.get('referrer-policy')).toBeNull();
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await send(staticBase, 'HEAD', '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  });

  it('refuses traversal, NUL, and a malformed escape with 400', async () => {
    expect(await rawStatus(staticBase, '/../package.json')).toBe(400);
    expect(await rawStatus(staticBase, '/assets/../../package.json')).toBe(400);
    expect(await rawStatus(staticBase, '/%2e%2e/package.json')).toBe(400);
    expect(await rawStatus(staticBase, '/%00')).toBe(400);
    expect(await rawStatus(staticBase, '/%zz')).toBe(400);
  });

  it('serves nothing outside the API without a static root', async () => {
    for (const path of ['/', '/privacy', '/p/sometoken', '/settings']) {
      expect((await send(apiBase, 'GET', path)).status, path).toBe(404);
    }
  });
});

// `POST /api/access-request` reads up to 4096 bytes of form body before any
// store read, and `POST /api/import` refuses a caller with no cookie before
// reading the body at all. 4 MiB is far more than the socket buffers hold, so
// the client is still uploading when the route answers.
describe('a route that answers before the body is read', () => {
  const OVER = 4 * 1024 * 1024;

  it('delivers the 413 for a chunked body over the limit instead of resetting', async () => {
    expect(await upload(apiBase, '/api/access-request', { bytes: OVER })).toEqual({
      status: 413,
      body: 'Payload too large',
      reusedSocket: false,
    });
  });

  it('delivers import-body-too-large to an owner whose chunked import is over the cap', async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${signSession({ sub: 'owner-sub', email: 'owner@example.com' }, Date.now())}`;
    const result = await upload(apiBase, '/api/import', {
      bytes: MAX_IMPORT_BODY_BYTES + 1024 * 1024,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    expect(result).toMatchObject({ status: 413 });
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ code: 'import-body-too-large' });
  });

  it('delivers the 413 for a Content-Length over the limit', async () => {
    expect(await upload(apiBase, '/api/access-request', { bytes: OVER, contentLength: true })).toMatchObject({
      status: 413,
      body: 'Payload too large',
    });
  });

  it('delivers a refusal from a route that never reads the body', async () => {
    expect(await upload(apiBase, '/api/import', { bytes: OVER })).toMatchObject({ status: 401 });
  });

  it('keeps a kept-alive connection usable after the 413', async () => {
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await upload(apiBase, '/api/access-request', { bytes: OVER, agent });
      const second = await upload(apiBase, '/api/access-request', { bytes: OVER, agent });
      expect(first).toMatchObject({ status: 413, reusedSocket: false });
      expect(second).toMatchObject({ status: 413, reusedSocket: true });
    } finally {
      agent.destroy();
    }
  });

  it('cuts off a body that never ends, and keeps answering', async () => {
    const result = await upload(apiBase, '/api/access-request', { bytes: Infinity });
    expect(result).toHaveProperty('error');
    // A small body with no access token is read in full and refused as expired.
    expect(await upload(apiBase, '/api/access-request', { bytes: 10 })).toMatchObject({ status: 400 });
  });
});

describe('a handler that throws', () => {
  it('answers 500 with a fixed body that never carries the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sync.syncPull).mockRejectedValueOnce(new Error('secret detail'));
    const res = await send(apiBase, 'GET', '/api/sync/pull');
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal error');
    expect(error).toHaveBeenCalledTimes(1);

    // The server keeps answering after a crash.
    expect((await send(apiBase, 'GET', '/api/sync/pull')).status).toBe(401);
    error.mockRestore();
  });
});
