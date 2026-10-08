/**
 * Test-mode smoke check (docs/plans/test-mode.md). Signs each persona in on a
 * running test server and reads the seed back through the routes the app
 * uses. The `test-mode` CI job runs it; locally:
 *
 *   node testing/smoke.ts http://localhost:3001
 *
 * Expected values come from testing/fixtures.ts and testing/personas.ts, so a
 * fixture change moves the checks with it. Exits non-zero on any failure.
 */
import type { PublicCollectionBody } from '../server/publicLinks.ts';
import { FIXTURE_IDS, memberLibrary, ownerLibrary, viewerLibrary, viewerSharedChat } from './fixtures.ts';
import { checkMcpEndpoints } from './mcpSmoke.ts';
import { checkWrites } from './writeSmoke.ts';
import { PERSONAS, type PersonaName, persona } from './personas.ts';

const baseUrl = (process.argv[2] ?? 'http://localhost:3001').replace(/\/+$/, '');

// Only the ids matter here, and they do not depend on the time.
const member = memberLibrary(0);
const owner = ownerLibrary(0);
const viewer = viewerLibrary(0);

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`ok    ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail === '' ? '' : `: ${detail}`}`);
    failures += 1;
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Passes when both lists hold the same strings; the detail shows both. */
function checkSame(name: string, actual: Iterable<string>, expected: Iterable<string>): void {
  const a = sorted(actual);
  const e = sorted(expected);
  check(name, JSON.stringify(a) === JSON.stringify(e), `got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`);
}

async function get(path: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('application/json') && text !== '') {
    body = JSON.parse(text);
  }
  return { status: res.status, body };
}

async function waitForSeed(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/__test/personas`)).status === 200) {
        return true;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function signIn(name: string): Promise<{ status: number; cookie: string | undefined }> {
  const res = await fetch(`${baseUrl}/__test/sign-in?as=${encodeURIComponent(name)}`, { redirect: 'manual' });
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((pair) => pair.startsWith('sous_session='));
  return { status: res.status, cookie };
}

// Response shapes, as far as these checks read them.
interface SessionBody {
  user: { sub: string; isOwner: boolean } | null;
}
interface PullBody {
  changes: Record<'recipes' | 'collections' | 'cookLogs' | 'chatMessages' | 'cookState', Record<string, unknown>[]>;
  hasMore: boolean;
}
interface SharedBody {
  changes: { collections: { id: string; name: string; role: string }[]; recipes: { id: string }[] };
  cursorToken?: string;
  hasMore: boolean;
}
interface RequestRows {
  rows: { sub: string }[];
}

function ids(rows: Record<string, unknown>[] | undefined, key = 'id'): string[] {
  return (rows ?? []).map((row) => String(row[key]));
}

async function pull(cookie: string): Promise<PullBody | undefined> {
  const { status, body } = await get('/api/sync/pull?limit=500', cookie);
  return status === 200 ? (body as PullBody) : undefined;
}

async function checkSessions(cookies: Map<string, string>): Promise<void> {
  for (const p of PERSONAS) {
    const cookie = cookies.get(p.as);
    if (cookie === undefined) continue;
    const { body } = await get('/api/auth/session', cookie);
    const user = (body as SessionBody).user;
    if (p.admission === 'owner' || p.admission === 'member') {
      check(
        `${p.as} session is ${p.sub}${p.admission === 'owner' ? ', an owner' : ''}`,
        user?.sub === p.sub && user.isOwner === (p.admission === 'owner'),
        JSON.stringify(user),
      );
    } else {
      check(`${p.as} is not admitted`, user === null, JSON.stringify(user));
    }
  }
}

async function checkMember(cookie: string): Promise<void> {
  const body = await pull(cookie);
  check('member pull answers in one page', body?.hasMore === false);
  checkSame('member recipes', ids(body?.changes.recipes), member.recipes.map((r) => r.id));
  checkSame('member collections', ids(body?.changes.collections), member.collections.map((c) => c.id));
  checkSame('member cook log', ids(body?.changes.cookLogs), member.cookLogs.map((l) => l.id));
  checkSame('member chat', ids(body?.changes.chatMessages), member.chat.map((m) => m.id));
  checkSame(
    'member cook progress',
    ids(body?.changes.cookState, 'recipeId'),
    member.cookStates.map((s) => s.recipeId),
  );

  const weeknights = member.collections.find((c) => c.id === FIXTURE_IDS.member.weeknights);
  const link = await get(`/api/collections/${FIXTURE_IDS.member.weeknights}/public`, cookie);
  const url = (link.body as { url?: unknown }).url;
  const token = typeof url === 'string' ? /\/p\/([^/?#]+)$/.exec(url)?.[1] : undefined;
  check('Weeknights has a public link', link.status === 200 && token !== undefined, JSON.stringify(link.body));
  if (token !== undefined) {
    const visit = await get(`/api/public/${token}`);
    const page = visit.body as PublicCollectionBody;
    check('the public link reads signed out', visit.status === 200, `status ${visit.status}`);
    check('the public page is Weeknights', page.collection?.name === weeknights?.name);
    checkSame('the public page lists Weeknights', ids(page.recipes), weeknights?.recipeIds ?? []);
  }

  const grants = await get('/api/mcp/grants', cookie);
  const rows = (grants.body as { grants?: { clientHost: string; scopes: string[] }[] }).grants ?? [];
  check('member has one connected app', rows.length === 1, JSON.stringify(rows));
  check(
    'the connected app is claude.ai with read and write',
    rows[0]?.clientHost === 'claude.ai' &&
      JSON.stringify(sorted(rows[0].scopes)) === JSON.stringify(['recipes:read', 'recipes:write']),
  );
}

async function checkViewer(cookie: string): Promise<void> {
  const body = await pull(cookie);
  checkSame('viewer own recipes', ids(body?.changes.recipes), viewer.recipes.map((r) => r.id));
  checkSame('viewer chat on shared recipes', ids(body?.changes.chatMessages), viewerSharedChat(0).map((m) => m.id));

  const roles = new Map<string, string>();
  const sharedRecipes: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const res = await get(`/api/sync/shared${query}`, cookie);
    if (res.status !== 200) {
      check('viewer shared pull answers', false, `status ${res.status}`);
      return;
    }
    const page = res.body as SharedBody;
    for (const c of page.changes.collections) roles.set(c.name, c.role);
    sharedRecipes.push(...page.changes.recipes.map((r) => r.id));
    cursor = page.hasMore ? page.cursorToken : undefined;
    pages += 1;
  } while (cursor !== undefined && pages < 10);

  const weeknights = member.collections.find((c) => c.id === FIXTURE_IDS.member.weeknights);
  const picks = owner.collections.find((c) => c.id === FIXTURE_IDS.owner.picks);
  check('viewer views Weeknights', weeknights !== undefined && roles.get(weeknights.name) === 'viewer');
  check("viewer edits Owner's picks", picks !== undefined && roles.get(picks.name) === 'editor');
  check('viewer has no other shares', roles.size === 2, JSON.stringify([...roles]));
  checkSame('viewer shared recipes', sharedRecipes, [...(weeknights?.recipeIds ?? []), ...(picks?.recipeIds ?? [])]);
}

async function checkOwner(cookie: string): Promise<void> {
  const body = await pull(cookie);
  checkSame('owner recipes', ids(body?.changes.recipes), owner.recipes.map((r) => r.id));
  checkSame('owner collections', ids(body?.changes.collections), owner.collections.map((c) => c.id));

  const requests = (await get('/api/admin/requests', cookie)).body as Record<string, RequestRows | undefined>;
  const subs = (list: string) => (requests[list]?.rows ?? []).map((row) => row.sub);
  const withAdmission = (admission: string) => PERSONAS.filter((p) => p.admission === admission).map((p) => p.sub);
  checkSame('/admin pending', subs('pending'), withAdmission('pending'));
  checkSame('/admin approved', subs('approved'), withAdmission('member'));
  checkSame('/admin declined', subs('denied'), withAdmission('declined'));

  const invites = (await get('/api/admin/invites', cookie)).body as { invites?: unknown[] };
  check('owner has one unused invite', invites.invites?.length === 1, JSON.stringify(invites));
}

async function checkEmpty(cookie: string): Promise<void> {
  const body = await pull(cookie);
  check('empty pull answers', body !== undefined);
  checkSame('empty has no recipes', ids(body?.changes.recipes), []);
  checkSame('empty has no collections', ids(body?.changes.collections), []);
}

async function post(path: string, cookie: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON; the status says enough.
  }
  return { status: res.status, body: parsed };
}

const CHAT_BODY = { messages: [{ role: 'user', content: 'How long?' }], recipe: { title: 'Soup' } };
const PASTE_BODY = { text: 'Simmer the tomatoes for ten minutes.' };

/**
 * The daily AI budget (server/llmBudget.ts): `capped` is refused before the
 * model key is checked, so this runs without GEMINI_API_KEY. Agent, STT, and
 * translate check the key first, so CI cannot reach their budget check.
 */
async function checkCapped(cookie: string): Promise<void> {
  for (const [path, body] of [
    ['/api/chat', CHAT_BODY],
    ['/api/import', PASTE_BODY],
  ] as const) {
    const res = await post(path, cookie, body);
    check(
      `capped ${path} answers 429 llm-budget-exceeded`,
      res.status === 429 && (res.body as { code?: unknown }).code === 'llm-budget-exceeded',
      `${res.status} ${JSON.stringify(res.body)}`,
    );
  }
}

async function checkNotCapped(cookie: string): Promise<void> {
  const res = await post('/api/chat', cookie, CHAT_BODY);
  check('empty /api/chat is not refused by the AI budget', res.status !== 429, `${res.status}`);
}

async function main(): Promise<void> {
  console.log(`Waiting for the seed at ${baseUrl}`);
  if (!(await waitForSeed())) {
    console.log(`FAIL  ${baseUrl}/__test/personas never answered 200`);
    process.exitCode = 1;
    return;
  }

  const cookies = new Map<string, string>();
  for (const p of PERSONAS) {
    const { status, cookie } = await signIn(p.as);
    check(`${p.as} signs in with a session cookie`, status === 303 && cookie !== undefined, `status ${status}`);
    if (cookie !== undefined) cookies.set(p.as, cookie);
  }
  check('an unknown persona is 404', (await signIn('nobody')).status === 404);
  check('pull without a cookie is 401', (await get('/api/sync/pull')).status === 401);

  await checkSessions(cookies);
  const run = async (name: PersonaName, fn: (cookie: string) => Promise<void>) => {
    const cookie = cookies.get(persona(name).as);
    if (cookie === undefined) {
      check(`${name} checks ran`, false, 'no session');
      return;
    }
    await fn(cookie);
  };
  await run('member', checkMember);
  await run('viewer', checkViewer);
  await run('owner', checkOwner);
  await run('empty', checkEmpty);
  await run('capped', checkCapped);
  await run('empty', checkNotCapped);
  await run('member', (cookie) => checkMcpEndpoints(baseUrl, cookie, check));
  // Last: these add rows, and the MCP checks above assert exact counts.
  await checkWrites(baseUrl, cookies, check);

  console.log(failures === 0 ? 'All test-mode checks passed' : `${failures} test-mode check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
