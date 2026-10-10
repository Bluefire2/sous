/**
 * Test mode (docs/plans/test-mode.md): the app against a seeded Firestore
 * emulator, with fake personas signed in by `/__test/sign-in`. Not in the
 * image; never imported by app code.
 *
 *   npm run dev:test                 # API on :3001 for Vite on :5173
 *   npm run dev:test -- --keep       # keep the emulator's data, no reseed
 *   node testing/test-server.ts --static --port 4173   # serves dist/ too
 *
 * Needs a running Firestore emulator, at 127.0.0.1:8085 unless
 * FIRESTORE_EMULATOR_HOST names another loopback address. It refuses to start
 * otherwise.
 *
 * Nothing from the app is imported statically: ESM hoists static imports, and
 * the environment must be set before any app module loads.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { emulatorHost, testModeEnv, testModeRefusals } from './env.ts';
import { FIXTURE_IDS } from './fixtures.ts';
import { PERSONAS, personaByName } from './personas.ts';
import { seededMcpTokens } from './seededMcp.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function refuse(reasons: string[]): never {
  for (const reason of reasons) {
    console.error(`test mode refused: ${reason}`);
  }
  process.exit(1);
}

async function emulatorAnswers(host: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(5000) });
    return (await res.text()).trim() === 'Ok';
  } catch {
    return false;
  }
}

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    static: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const isStatic = values.static === true;
const port = Number(values.port ?? (isStatic ? 4173 : 3001));
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  refuse([`--port must be a port number, not ${values.port}.`]);
}
const publicOrigin = isStatic ? `http://localhost:${port}` : 'http://localhost:5173';

const refusals = testModeRefusals(process.env);
if (refusals.length > 0) {
  refuse(refusals);
}
const host = emulatorHost(process.env);
if (host === null) {
  refuse(['FIRESTORE_EMULATOR_HOST is not a loopback address.']);
}
if (!(await emulatorAnswers(host))) {
  refuse([
    `No Firestore emulator answered at http://${host}/. Start it first: ` +
      `gcloud emulators firestore start --host-port=${host}`,
  ]);
}

for (const [name, value] of Object.entries(testModeEnv(process.env, { publicOrigin, port }))) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const staticRoot = isStatic ? join(repoRoot, 'dist') : null;
if (staticRoot !== null && !existsSync(join(staticRoot, 'index.html'))) {
  refuse(['--static serves dist/, which has no index.html. Run npm run build first.']);
}

const { createRequestListener } = await import('../scripts/server.ts');
const { safeReturnTo, sessionCookie, signSession } = await import('../server/session.ts');
const { upsertUser } = await import('../server/store.ts');

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Set once the seed (or --keep) is done. `/__test/personas` is the readiness
 * probe, and the picker offers no persona until then.
 */
let ready = false;

/**
 * When the seed's relative times were taken ("3 days ago"); absent with
 * --keep. Browser tests can freeze their clock relative to it.
 */
let seededAt: number | undefined;

/**
 * The persona list. Until the seed is done it offers no links: a sign-in then
 * would land signed out, because the persona is not admitted yet.
 * `/__test/sign-in` itself stays open, since the seed signs in through it.
 */
function pickerPage(): Response {
  const rows = PERSONAS.map(
    (p) =>
      `<li><a href="/__test/sign-in?as=${p.as}">${escapeHtml(p.as)}</a> — ${escapeHtml(p.description)}</li>`,
  ).join('\n');
  const body = ready
    ? `<p>Sign in as a fake account. Data lives in the Firestore emulator. Sign out from Settings.</p>
<ul>
${rows}
</ul>`
    : '<p>Seeding the emulator. This page reloads itself when the personas are ready.</p>';
  const refresh = ready ? '' : '<meta http-equiv="refresh" content="1">\n';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>Sous test mode</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 1rem}li{margin:.5rem 0}</style>
</head><body>
<h1>Sous test mode</h1>
${body}
</body></html>`;
  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (!ready) {
    headers['Retry-After'] = '1';
  }
  return new Response(html, { status: ready ? 200 : 503, headers });
}

function personasJson(): Response {
  if (!ready) {
    return new Response(JSON.stringify({ ready: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' },
    });
  }
  const mcp = seededMcpTokens();
  const body = {
    personas: PERSONAS.map((p) => ({
      as: p.as,
      sub: p.sub,
      email: p.email,
      admitted: p.admission === 'owner' || p.admission === 'member',
    })),
    fixtures: FIXTURE_IDS,
    seededAt: seededAt ?? null,
    // Present after a fresh seed, absent with --keep. Raw tokens, test mode only.
    ...(mcp === null ? {} : { mcp }),
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function signIn(url: URL): Promise<Response> {
  const p = personaByName(url.searchParams.get('as'));
  if (p === undefined) {
    return new Response('Unknown persona. See /__test/.\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  // The OAuth callback upserts the profile on every sign-in; add-by-email
  // finds people through it.
  await upsertUser(p.sub, { email: p.email, name: p.name });
  const token = signSession({ sub: p.sub, email: p.email }, Date.now());
  // Not Response.redirect: its headers are immutable, so Set-Cookie would drop.
  const headers = new Headers({
    Location: safeReturnTo(url.searchParams.get('returnTo'), publicOrigin),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', sessionCookie(token, { secure: false }));
  return new Response(null, { status: 303, headers });
}

async function testRoute(nodeReq: IncomingMessage): Promise<Response> {
  const url = new URL(nodeReq.url ?? '/', publicOrigin);
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET' } });
  }
  switch (url.pathname) {
    case '/__test':
    case '/__test/':
      return pickerPage();
    case '/__test/personas':
      return personasJson();
    case '/__test/sign-in':
      return signIn(url);
    default:
      return new Response('Not found\n', { status: 404 });
  }
}

async function send(nodeRes: ServerResponse, response: Response, head: boolean): Promise<void> {
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      nodeRes.setHeader(name, value);
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    nodeRes.setHeader('Set-Cookie', cookies);
  }
  nodeRes.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
}

function isTestPath(rawUrl: string | undefined): boolean {
  const path = (rawUrl ?? '/').split('?')[0];
  return path === '/__test' || path.startsWith('/__test/');
}

const appListener = createRequestListener({ staticRoot });

function listener(nodeReq: IncomingMessage, nodeRes: ServerResponse): void {
  if (!isTestPath(nodeReq.url)) {
    appListener(nodeReq, nodeRes);
    return;
  }
  testRoute(nodeReq)
    .then((response) => send(nodeRes, response, nodeReq.method === 'HEAD'))
    .catch((err: unknown) => {
      console.error('test route error:', err);
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 500;
      }
      nodeRes.end();
    });
}

/**
 * Loopback only: a server that signs anyone in must not answer the LAN. Two
 * listeners, because `localhost` may resolve to either family. IPv6 is
 * optional (some containers have none).
 */
async function listenLoopback(): Promise<void> {
  const listenOn = (address: string) =>
    new Promise<void>((resolveListen, rejectListen) => {
      const server = createServer(listener);
      server.once('error', rejectListen);
      server.listen(port, address, () => resolveListen());
    });
  await listenOn('127.0.0.1');
  try {
    await listenOn('::1');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
      throw err;
    }
  }
}

await listenLoopback();

if (values.keep === true) {
  console.log('Keeping the emulator data (--keep): no reseed.');
} else {
  const { clearEmulator, seed } = await import('./seed.ts');
  await clearEmulator(host);
  seededAt = await seed(`http://localhost:${port}`);
  console.log('Seeded the emulator.');
}

ready = true;
console.log(`Test mode ready on http://localhost:${port} (emulator ${host}).`);
console.log(`Pick a persona: ${publicOrigin}/__test/`);
