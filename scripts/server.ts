/**
 * Production HTTP server: API routes plus static `dist/` and SPA fallback.
 * Run after `npm run build`:
 *
 *   node --env-file=.env.local scripts/server.ts
 *
 * `createRequestListener({ staticRoot: null })` is the API-only listener used
 * by `scripts/dev-api-server.ts`. With `staticRoot: null`, `/privacy`,
 * `/terms`, and `/about` return 404 on this port; Vite serves `public/` on
 * :5173 in dev. `/invite/:token` and the collection-link pages under `/c/`
 * are handled here in both modes (Vite proxies `/invite` and `/c/`), as are
 * the MCP server's `/mcp`, `/oauth/*`, and `/.well-known/oauth-*` (Vite
 * proxies those too).
 *
 * Requires Node 22.18+ for native TypeScript type stripping.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { POST as chatPost } from '../api/chat.ts';
import { importPost } from '../server/importRoute.ts';
import { featureRequestPost } from '../server/featureRequest.ts';
import { introGet, introSeenPost } from '../server/intro.ts';
import { importFeedbackPost } from '../server/importFeedback.ts';
import {
  authCallbackGoogle,
  authSession,
  authSignout,
  authStart,
} from '../server/auth.ts';
import { redirectUri } from '../server/env.ts';
import {
  adminDecisionPost,
  adminInviteRevokePost,
  adminInvitesGet,
  adminInvitesPost,
  adminRequestsGet,
  memberInvitesPost,
} from '../server/admin.ts';
import { accessRequestPost } from '../server/access.ts';
import {
  collectionLinkJoinGet,
  collectionLinkJoinPost,
  collectionLinkLandingGet,
  collectionLinksGet,
  collectionLinksPost,
  collectionLinksRevokePost,
} from '../server/collectionLinksHttp.ts';
import { extensionImport, extensionImportOptions } from '../server/extensionImport.ts';
import { inviteLandingGet } from '../server/invites.ts';
import { withMembership } from '../server/membership.ts';
import { photosGet, photosPost } from '../server/photos.ts';
import {
  collectionPublicLinkGet,
  collectionPublicLinkPost,
  collectionPublicLinkRevokePost,
  publicGet,
  publicJoinPost,
} from '../server/publicLinksHttp.ts';
import { agentPost } from '../server/agent/index.ts';
import { matchMcpRoute, mcpGrantsGet, mcpGrantsRevokePost } from '../server/mcp/index.ts';
import { sttPost } from '../server/stt.ts';
import { translatePost } from '../server/translateRoute.ts';
import {
  collectionGrantsGet,
  collectionGrantsPost,
  collectionGrantsRevokePost,
  collectionGrantsRolePost,
  sharedLeavePost,
} from '../server/grantsHttp.ts';
import { syncPull, syncPush, syncSharedPull } from '../server/sync.ts';

type ApiHandler = (req: Request) => Promise<Response>;

export interface ApiRoute {
  method: string;
  path: string;
  handler: ApiHandler;
}

/** Exact-path API routes; exported for scripts/server.dispatch.test.ts. */
export const apiRoutes: readonly ApiRoute[] = [
  { method: 'POST', path: '/api/chat', handler: withMembership(chatPost) },
  { method: 'POST', path: '/api/import', handler: withMembership(importPost) },
  { method: 'POST', path: '/api/import-feedback', handler: withMembership(importFeedbackPost) },
  { method: 'POST', path: '/api/feature-request', handler: withMembership(featureRequestPost) },
  { method: 'GET', path: '/api/intro', handler: introGet },
  { method: 'POST', path: '/api/intro/seen', handler: introSeenPost },
  { method: 'POST', path: '/api/stt', handler: sttPost },
  { method: 'POST', path: '/api/agent', handler: agentPost },
  { method: 'POST', path: '/api/translate', handler: translatePost },
  { method: 'POST', path: '/api/access-request', handler: accessRequestPost },
  { method: 'GET', path: '/api/admin/requests', handler: adminRequestsGet },
  { method: 'POST', path: '/api/admin/decision', handler: adminDecisionPost },
  { method: 'GET', path: '/api/admin/invites', handler: adminInvitesGet },
  { method: 'POST', path: '/api/admin/invites', handler: adminInvitesPost },
  { method: 'POST', path: '/api/admin/invites/revoke', handler: adminInviteRevokePost },
  { method: 'POST', path: '/api/invites', handler: memberInvitesPost },
  { method: 'GET', path: '/api/auth/start', handler: authStart },
  { method: 'GET', path: '/api/auth/callback/google', handler: authCallbackGoogle },
  { method: 'GET', path: '/api/auth/session', handler: authSession },
  { method: 'POST', path: '/api/auth/signout', handler: authSignout },
  { method: 'GET', path: '/api/sync/pull', handler: syncPull },
  { method: 'GET', path: '/api/sync/shared', handler: syncSharedPull },
  { method: 'POST', path: '/api/sync/push', handler: syncPush },
  { method: 'POST', path: '/api/shared/leave', handler: sharedLeavePost },
  { method: 'POST', path: '/api/public/join', handler: publicJoinPost },
  { method: 'POST', path: '/api/extension/import', handler: extensionImport },
  { method: 'OPTIONS', path: '/api/extension/import', handler: extensionImportOptions },
  { method: 'GET', path: '/api/mcp/grants', handler: mcpGrantsGet },
  { method: 'POST', path: '/api/mcp/grants/revoke', handler: mcpGrantsRevokePost },
];

const PUBLIC_HTML: Record<string, string> = {
  '/privacy': '/privacy.html',
  '/terms': '/terms.html',
  '/about': '/about.html',
};

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const NO_CACHE_NAMES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'manifest.webmanifest',
  'privacy.html',
  'terms.html',
  'about.html',
]);

let loggedRedirectUri = false;

function logRedirectUriOnce(): void {
  if (loggedRedirectUri) {
    return;
  }
  loggedRedirectUri = true;
  try {
    console.log(`OAuth redirect URI: ${redirectUri()}`);
  } catch {
    // PUBLIC_ORIGIN may be unset in API-only dev without full auth env.
  }
}

export function createRequestListener(options: { staticRoot: string | null }) {
  logRedirectUriOnce();
  const staticRoot = options.staticRoot === null ? null : resolve(options.staticRoot);

  return (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    void handleRequest(nodeReq, nodeRes, staticRoot);
  };
}

async function handleRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  staticRoot: string | null,
): Promise<void> {
  try {
    const rawUrl = nodeReq.url ?? '/';
    const q = rawUrl.indexOf('?');
    const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const method = nodeReq.method ?? 'GET';

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (!decodedPath.startsWith('/') || decodedPath.includes('\0')) {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (decodedPath.startsWith('/api/')) {
      await handleApi(nodeReq, nodeRes, decodedPath, method);
      return;
    }

    const mcpHandler = matchMcpRoute(decodedPath, method);
    if (mcpHandler !== null) {
      if (mcpHandler === 'notFound') {
        sendText(nodeReq, nodeRes, 404, 'Not found');
        return;
      }
      if (mcpHandler === 'wrongMethod') {
        sendText(nodeReq, nodeRes, 405, 'Method not allowed');
        return;
      }
      await dispatchFetch(nodeReq, nodeRes, decodedPath, method, mcpHandler);
      return;
    }

    if (decodedPath === '/invite' || decodedPath.startsWith('/invite/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(nodeReq, nodeRes, 405, 'Method not allowed');
        return;
      }
      await dispatchFetch(nodeReq, nodeRes, decodedPath, method, inviteLandingGet);
      return;
    }

    if (decodedPath === '/c' || decodedPath.startsWith('/c/')) {
      const handler = matchCollectionLinkPage(decodedPath, method);
      if (handler === 'wrongMethod') {
        sendText(nodeReq, nodeRes, 405, 'Method not allowed');
        return;
      }
      await dispatchFetch(nodeReq, nodeRes, decodedPath, method, handler);
      return;
    }

    if (staticRoot === null) {
      sendText(nodeReq, nodeRes, 404, 'Not found');
      return;
    }

    if (decodedPath === '/p' || decodedPath.startsWith('/p/')) {
      // Public collection pages carry their token in the path: keep it out of
      // every Referer (images, the source link, the Google sign-in hop) and
      // out of search results. The SPA renders them from index.html.
      nodeRes.setHeader('Referrer-Policy', 'no-referrer');
      nodeRes.setHeader('X-Robots-Tag', 'noindex');
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(nodeReq, nodeRes, 405, 'Method not allowed');
      return;
    }

    const publicRelative = PUBLIC_HTML[decodedPath];
    if (publicRelative !== undefined) {
      const publicPath = resolveContained(staticRoot, publicRelative);
      if (publicPath !== null && (await serveIfFile(nodeRes, publicPath, decodedPath, method))) {
        return;
      }
      sendText(nodeReq, nodeRes, 404, 'Not found');
      return;
    }

    const filePath = resolveContained(staticRoot, decodedPath);
    if (filePath === null) {
      sendText(nodeReq, nodeRes, 400, 'Bad request');
      return;
    }

    if (await serveIfFile(nodeRes, filePath, decodedPath, method)) {
      return;
    }

    const lastSegment = decodedPath.slice(decodedPath.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) {
      const indexPath = resolve(staticRoot, 'index.html');
      if (resolveContained(staticRoot, '/index.html') && (await fileExists(indexPath))) {
        await sendFile(nodeRes, indexPath, '/index.html', method, 200);
        return;
      }
    }

    sendText(nodeReq, nodeRes, 404, 'Not found');
  } catch (err) {
    if (isRequestAbort(nodeReq)) {
      nodeRes.destroy();
      return;
    }
    console.error(err);
    if (nodeRes.headersSent) {
      nodeRes.destroy();
      return;
    }
    nodeRes.statusCode = 500;
    if (nodeReq.method === 'HEAD') {
      nodeRes.end();
      return;
    }
    nodeRes.end('Internal error');
  }
}

/**
 * Whether the request was cut off before its body finished arriving. Usually
 * the client hung up mid-upload; Node's request timeout ends it the same way.
 * A route that throws then failed on the body it was reading
 * (`readBoundedText`'s `RequestBodyError`, or Node's ECONNRESET "aborted"
 * from another reader), and the connection is gone, so the dispatcher does
 * not log it or send a 500. A request whose body arrived in full is never
 * covered. `isClientHangUp` is the same for a client that leaves while the
 * response is being written.
 */
export function isRequestAbort(req: Pick<IncomingMessage, 'destroyed' | 'complete'>): boolean {
  return req.destroyed && !req.complete;
}

/** `/c/join` is the confirm step; any other `/c/...` is a token landing (bad shapes render the generic page). */
function matchCollectionLinkPage(pathname: string, method: string): ApiHandler | 'wrongMethod' {
  if (pathname === '/c/join') {
    if (method === 'GET' || method === 'HEAD') {
      return collectionLinkJoinGet;
    }
    if (method === 'POST') {
      return collectionLinkJoinPost;
    }
    return 'wrongMethod';
  }
  if (method === 'GET' || method === 'HEAD') {
    return collectionLinkLandingGet;
  }
  return 'wrongMethod';
}

function matchApiRoute(pathname: string, method: string): ApiHandler | 'wrongMethod' | null {
  let pathMatched = false;
  for (const route of apiRoutes) {
    if (route.path === pathname) {
      pathMatched = true;
      if (route.method === method) {
        return route.handler;
      }
    }
  }
  if (pathMatched) {
    return 'wrongMethod';
  }

  // Visitor reads, no session: /api/public/<token>[/recipes/<id>/photos/<id>].
  // `/api/public/join` is an exact route above.
  if (pathname.startsWith('/api/public/')) {
    if (method === 'GET' || method === 'HEAD') {
      return publicGet;
    }
    return 'wrongMethod';
  }

  const photosPrefix = '/api/photos/';
  if (pathname.startsWith(photosPrefix)) {
    const rest = pathname.slice(photosPrefix.length);
    if (rest !== '' && !rest.includes('/')) {
      if (method === 'POST') {
        return photosPost;
      }
      if (method === 'GET' || method === 'HEAD') {
        return photosGet;
      }
      return 'wrongMethod';
    }
  }

  const grantsMatch = pathname.match(/^\/api\/collections\/[^/]+\/grants$/);
  if (grantsMatch) {
    if (method === 'GET') {
      return collectionGrantsGet;
    }
    if (method === 'POST') {
      return collectionGrantsPost;
    }
    return 'wrongMethod';
  }
  const revokeMatch = pathname.match(/^\/api\/collections\/[^/]+\/grants\/revoke$/);
  if (revokeMatch) {
    if (method === 'POST') {
      return collectionGrantsRevokePost;
    }
    return 'wrongMethod';
  }
  const roleMatch = pathname.match(/^\/api\/collections\/[^/]+\/grants\/role$/);
  if (roleMatch) {
    if (method === 'POST') {
      return collectionGrantsRolePost;
    }
    return 'wrongMethod';
  }
  if (/^\/api\/collections\/[^/]+\/public$/.test(pathname)) {
    if (method === 'GET') {
      return collectionPublicLinkGet;
    }
    if (method === 'POST') {
      return collectionPublicLinkPost;
    }
    return 'wrongMethod';
  }
  if (/^\/api\/collections\/[^/]+\/public\/revoke$/.test(pathname)) {
    if (method === 'POST') {
      return collectionPublicLinkRevokePost;
    }
    return 'wrongMethod';
  }
  if (/^\/api\/collections\/[^/]+\/links$/.test(pathname)) {
    if (method === 'GET') {
      return collectionLinksGet;
    }
    if (method === 'POST') {
      return collectionLinksPost;
    }
    return 'wrongMethod';
  }
  if (/^\/api\/collections\/[^/]+\/links\/revoke$/.test(pathname)) {
    if (method === 'POST') {
      return collectionLinksRevokePost;
    }
    return 'wrongMethod';
  }

  return null;
}

async function handleApi(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  pathname: string,
  method: string,
): Promise<void> {
  const match = matchApiRoute(pathname, method);
  if (match === null) {
    sendText(nodeReq, nodeRes, 404, 'Not found');
    return;
  }
  if (match === 'wrongMethod') {
    sendText(nodeReq, nodeRes, 405, 'Method not allowed');
    return;
  }

  await dispatchFetch(nodeReq, nodeRes, pathname, method, match);
}

async function dispatchFetch(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  pathname: string,
  method: string,
  handler: ApiHandler,
): Promise<void> {
  const host = nodeReq.headers.host;
  const port = nodeReq.socket.localPort ?? Number(process.env.PORT || 8080);
  const origin = host ? `http://${host}` : `http://localhost:${port}`;

  const request = new Request(`${origin}${nodeReq.url ?? pathname}`, {
    method: nodeReq.method,
    headers: nodeReq.headers as Record<string, string>,
    body: method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(nodeReq) as ReadableStream),
    duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
  });

  const response = await handler(request);
  if (!nodeReq.complete) {
    await discardUnreadBody(request.body, declaredLength(nodeReq));
  }
  await writeFetchResponse(nodeRes, response);
}

/** How much of a body a route left unread the dispatcher drops before answering. */
export const UNREAD_BODY_LIMITS = { bytes: 16 * 1024 * 1024, ms: 10_000 };

/** The request's Content-Length, or null when it has none (a chunked body) or it is not a number. */
function declaredLength(nodeReq: IncomingMessage): number | null {
  const raw = nodeReq.headers['content-length'];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Reads and drops the rest of a request body the route answered without
 * reading to the end: one over a route's limit (`readBoundedText` stops there),
 * or one refused before it was read (a 401, a 413 by Content-Length).
 * Answered with the upload still arriving, a `Connection: close` request has
 * its socket closed with data unread, which resets the connection and, on
 * some systems (Windows), throws the answer away; a kept-alive one waits on a
 * body nobody reads, so the client hangs. Only the current chunk is held.
 *
 * A client may not hold the server to an endless upload: a body that declares
 * more than `limits.bytes` is not drained at all, and past `limits.bytes`
 * dropped or `limits.ms` in total the body is cancelled. Cancelling aborts the
 * request; Node still writes the answer and then closes the connection under
 * the arriving upload, so the client may see a reset instead of the answer.
 * A body a route still holds is left alone, and a client that hangs up ends
 * the drain.
 */
export async function discardUnreadBody(
  body: ReadableStream<Uint8Array> | null,
  declared: number | null = null,
  limits: { bytes: number; ms: number } = UNREAD_BODY_LIMITS,
): Promise<void> {
  if (body === null || body.locked) {
    return;
  }
  if (declared !== null && declared > limits.bytes) {
    await body.cancel().catch(() => {});
    return;
  }
  const reader = body.getReader();
  const timer = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, limits.ms);
  try {
    let dropped = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      dropped += value.byteLength;
      if (dropped > limits.bytes) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // The client hung up mid-upload; the response goes nowhere either way.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pipes a route's response body to the client. When the client is already
 * gone, `pipeline` throws ERR_STREAM_UNABLE_TO_PIPE without touching the
 * body, which would leave its upstream (a GCS read, a model stream) open
 * until it fails on a stream nobody listens to, killing the process. So a
 * gone client cancels the body instead. (Cancel the web stream itself:
 * destroying a `Readable.fromWeb` over a `Readable.toWeb` body that still
 * holds data throws ERR_INVALID_STATE from Node's adapter.) When the client
 * leaves mid-response, `pipeline` destroys the body and rejects; the extra
 * listener absorbs anything the body emits after that.
 */
export async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  destination: Writable,
): Promise<void> {
  if (destination.destroyed) {
    await body.cancel().catch(() => {});
    return;
  }
  const source = Readable.fromWeb(body);
  source.on('error', () => {});
  await pipeline(source, destination);
}

async function writeFetchResponse(nodeRes: ServerResponse, response: Response): Promise<void> {
  nodeRes.statusCode = response.status;
  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'set-cookie') {
      return;
    }
    nodeRes.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    nodeRes.setHeader('Set-Cookie', setCookies);
  }
  nodeRes.flushHeaders();

  if (!response.body) {
    nodeRes.end();
    return;
  }

  try {
    await pipeResponseBody(response.body, nodeRes);
  } catch (err) {
    if (!isClientHangUp(err)) {
      console.error(err);
    }
    nodeRes.destroy();
  }
}

/**
 * Whether a `pipeline` rejection only means the client went away: its
 * response closed before the body finished (ERR_STREAM_PREMATURE_CLOSE) or
 * was already closed (ERR_STREAM_UNABLE_TO_PIPE). That is routine (a closed
 * tab, a cancelled fetch, a service worker install cut short) and is not
 * logged. A failing source rejects with its own error and is logged.
 */
export function isClientHangUp(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_UNABLE_TO_PIPE';
}

/**
 * Streams a static file to the client. A client that has already gone gets
 * nothing and the file is never opened: `pipeline` would throw
 * ERR_STREAM_UNABLE_TO_PIPE and leave the file open. A client that leaves
 * mid-file resolves quietly, and the file is closed. A read error rejects.
 */
export async function pipeFile(open: () => Readable, destination: Writable): Promise<void> {
  if (destination.destroyed || destination.closed) {
    return;
  }
  const file = open();
  try {
    await pipeline(file, destination);
  } catch (err) {
    file.destroy();
    if (!isClientHangUp(err)) {
      throw err;
    }
  }
}

function resolveContained(root: string, decodedPath: string): string | null {
  const relativePart = decodedPath.replace(/^\/+/, '');
  const candidate = resolve(root, relativePart);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}

/** `stat()` codes that mean "this path is not an existing regular file". */
const STAT_NOT_A_FILE = new Set([
  'ENOENT',
  'ENOTDIR',
  'ENAMETOOLONG',
  'EISDIR',
  'EINVAL',
  'ELOOP',
]);

function isStatNotAFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && STAT_NOT_A_FILE.has(code);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await stat(filePath);
    return st.isFile();
  } catch (err) {
    if (isStatNotAFile(err)) return false;
    throw err;
  }
}

async function serveIfFile(
  nodeRes: ServerResponse,
  filePath: string,
  urlPath: string,
  method: string,
): Promise<boolean> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return false;
  } catch (err) {
    if (isStatNotAFile(err)) return false;
    throw err;
  }
  await sendFile(nodeRes, filePath, urlPath, method, 200);
  return true;
}

async function sendFile(
  nodeRes: ServerResponse,
  filePath: string,
  urlPath: string,
  method: string,
  status: number,
): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const type = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', type);
  nodeRes.setHeader('Cache-Control', cacheControl(urlPath, basename(filePath)));

  if (method === 'HEAD') {
    nodeRes.end();
    return;
  }

  nodeRes.flushHeaders();
  try {
    await pipeFile(() => createReadStream(filePath), nodeRes);
  } catch (err) {
    console.error(err);
    if (nodeRes.headersSent) {
      nodeRes.destroy();
      return;
    }
    throw err;
  }
}

function cacheControl(urlPath: string, fileName: string): string {
  if (urlPath.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (NO_CACHE_NAMES.has(fileName) || /^workbox-.*\.js$/.test(fileName)) {
    return 'no-cache';
  }
  if (urlPath.startsWith('/icons/')) {
    return 'public, max-age=86400';
  }
  return 'no-cache';
}

function sendText(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  status: number,
  body: string,
): void {
  nodeRes.statusCode = status;
  if (nodeReq.method === 'HEAD') {
    nodeRes.end();
    return;
  }
  nodeRes.end(body);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8080);
  const staticRoot = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
  createServer(createRequestListener({ staticRoot })).listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}
