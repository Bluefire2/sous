/**
 * Write checks for the test-mode smoke script (docs/plans/test-coverage.md,
 * step 8). They run after the read and MCP checks in `testing/smoke.ts`,
 * because those assert exact counts and these add rows. Every write goes
 * through the routes the app uses, and every result is read back the same
 * way: last-write-wins and tombstones, the recipe delete cascade, editor and
 * viewer rules on shared recipes, the collection-link hop, public join, saving
 * a copy from a recipe link, admin approve and revoke against the 60-second
 * membership cache, and the kitchen profile.
 *
 * Fresh UUIDs for every new row; the shared fixtures are put back the way
 * the seed left them (grants and roles) so later checks see the seed.
 */
import { randomUUID } from 'node:crypto';
import { FIXTURE_IDS, memberLibrary, ownerLibrary } from './fixtures.ts';
import { persona } from './personas.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
type Row = Record<string, unknown>;
type PushResult = { index: number; applied: boolean; reason?: string; current?: Row };
type PullChanges = Record<'recipes' | 'collections' | 'cookLogs' | 'chatMessages' | 'cookState', Row[]>;

const REVOCATION_BOUND_MS = 65_000;
const member = memberLibrary(0);
const owner = ownerLibrary(0);

export async function checkWrites(baseUrl: string, cookies: ReadonlyMap<string, string>, check: Check): Promise<void> {
  const http = client(baseUrl);
  const cookieOf = (name: string): string => {
    const cookie = cookies.get(name);
    if (cookie === undefined) throw new Error(`no session for ${name}`);
    return cookie;
  };
  const phases: [string, () => Promise<void>][] = [
    ['last-write-wins', () => lastWriteWins(http, cookieOf, check)],
    ['cascade', () => cascade(http, cookieOf, check)],
    ['editor and viewer', () => sharedWrites(http, cookieOf, check)],
    ['collection link', () => collectionLink(http, cookieOf, check)],
    ['public join', () => publicJoin(http, cookieOf, check)],
    ['recipe link save', () => recipeLinkSave(http, cookieOf, check)],
    ['admin approve and revoke', () => adminFlow(http, cookieOf, check)],
    ['kitchen profile', () => kitchenProfile(http, cookieOf, check)],
    ['account preferences', () => accountPreferences(http, cookieOf, check)],
  ];
  for (const [name, run] of phases) {
    try {
      await run();
    } catch (err) {
      check(`${name} checks ran`, false, err instanceof Error ? err.message : String(err));
    }
  }
}

// --- HTTP ------------------------------------------------------------------

type Http = ReturnType<typeof client>;

function client(baseUrl: string) {
  async function send(
    method: string,
    path: string,
    options: { cookie?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie !== undefined) headers.Cookie = options.cookie;
    let body: string | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('application/json') && text !== '') {
      parsed = JSON.parse(text);
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    baseUrl,
    send,
    get: (path: string, cookie?: string) => send('GET', path, { cookie }),
    post: (path: string, cookie: string | undefined, json?: unknown) => send('POST', path, { cookie, json }),
    async push(cookie: string, ops: unknown[]): Promise<{ status: number; results: PushResult[] }> {
      const res = await send('POST', '/api/sync/push', { cookie, json: { ops } });
      return { status: res.status, results: ((res.body as { results?: PushResult[] }).results ?? []) };
    },
    async pull(cookie: string): Promise<PullChanges> {
      const res = await send('GET', '/api/sync/pull?limit=500', { cookie });
      if (res.status !== 200) throw new Error(`pull answered ${res.status}`);
      return (res.body as { changes: PullChanges }).changes;
    },
    /** Every page of the shared pull: collection name to role, and the shared recipe ids. */
    /** Throws on any status but 200, so a failed read never looks like "no shares". */
    async shared(cookie: string): Promise<{ roles: Map<string, string>; recipes: Row[] }> {
      const roles = new Map<string, string>();
      const recipes: Row[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
        const res = await send('GET', `/api/sync/shared${query}`, { cookie });
        if (res.status !== 200) throw new Error(`shared pull answered ${res.status}`);
        const body = res.body as {
          changes: { collections: { name: string; role: string }[]; recipes: Row[] };
          hasMore: boolean;
          cursorToken?: string;
        };
        for (const c of body.changes.collections) roles.set(c.name, c.role);
        recipes.push(...body.changes.recipes);
        cursor = body.hasMore ? body.cursorToken : undefined;
        if (cursor === undefined) break;
      }
      return { roles, recipes };
    },
  };
}

function byId(rows: Row[] | undefined, id: string, key = 'id'): Row | undefined {
  return (rows ?? []).find((row) => row[key] === id);
}

function isTombstone(row: Row | undefined): boolean {
  return row !== undefined && typeof row.deletedAt === 'number';
}

function newRecipe(title: string, updatedAt: number): Row {
  const template = member.recipes[0];
  return {
    id: randomUUID(),
    title,
    servings: template.servings,
    ingredientSections: template.ingredientSections,
    steps: template.steps,
    tags: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

async function waitUntil(test: () => Promise<boolean>, timeoutMs: number, everyMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

// --- Phases -----------------------------------------------------------------

async function lastWriteWins(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const empty = cookieOf('empty');
  const t = Date.now();
  const recipe = newRecipe('LWW soup', t);
  const put = (updatedAt: number, title = 'LWW soup') => ({
    kind: 'recipe.put',
    payload: { ...recipe, title, updatedAt },
  });
  const del = (updatedAt: number) => ({ kind: 'recipe.delete', payload: { id: recipe.id, updatedAt } });
  const one = async (op: unknown) => (await http.push(empty, [op])).results[0];

  check('a new recipe put applies', (await one(put(t))).applied === true);
  const stale = await one(put(t - 1, 'older'));
  // A last-write-wins loss is not a discarded write: no reason, and the stored row to adopt.
  check(
    'an older put loses and returns the stored row',
    stale.applied === false && stale.reason === undefined && stale.current?.title === 'LWW soup',
    JSON.stringify({ applied: stale.applied, reason: stale.reason }),
  );
  check('a newer put applies', (await one(put(t + 1, 'newer'))).applied === true);
  // A recipe.delete always answers applied; the pull says whether it won.
  await one(del(t + 1));
  check('a delete at the same stamp wins over the put', isTombstone(byId((await http.pull(empty)).recipes, recipe.id as string)));
  check('a put at the tombstone stamp does not revive it', (await one(put(t + 1, 'zombie'))).applied === false);
  check('a strictly newer put revives it', (await one(put(t + 2, 'revived'))).applied === true);
  check('the revived recipe is live', !isTombstone(byId((await http.pull(empty)).recipes, recipe.id as string)));
  await one(del(t + 1));
  check('an older delete does not bury the revived recipe', !isTombstone(byId((await http.pull(empty)).recipes, recipe.id as string)));
  await one(del(t + 3));
  check('a newer delete tombstones it again', isTombstone(byId((await http.pull(empty)).recipes, recipe.id as string)));

  const foreign = newRecipe('Not yours', t);
  const result = await http.push(empty, [
    { kind: 'recipe.put', payload: foreign, uid: persona('member').sub, sub: persona('member').sub },
  ]);
  check('a uid or sub in an op is ignored', result.results[0]?.applied === true);
  check('the write lands in the session account', byId((await http.pull(empty)).recipes, foreign.id as string) !== undefined);
  check('and not in the account the op named', byId((await http.pull(cookieOf('member'))).recipes, foreign.id as string) === undefined);

  const tooMany = Array.from({ length: 51 }, () => put(t + 10));
  check('a push of 51 ops is 413', (await http.push(empty, tooMany)).status === 413);
}

async function cascade(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const empty = cookieOf('empty');
  const viewer = cookieOf('viewer');
  const t = Date.now();
  const recipe = newRecipe('Cascade stew', t);
  const recipeId = recipe.id as string;
  const chat = { ...member.chat[0], id: randomUUID(), recipeId, createdAt: t, updatedAt: t };
  const cook = { ...member.cookStates[0], recipeId, updatedAt: t };
  const log = { ...member.cookLogs[0], id: randomUUID(), recipeId, photoIds: [], createdAt: t, updatedAt: t };
  const collectionId = randomUUID();
  const collection = { id: collectionId, name: 'Cascade list', recipeIds: [recipeId], createdAt: t, updatedAt: t };
  const first = await http.push(empty, [{ kind: 'recipe.put', payload: recipe }]);
  const rest = await http.push(empty, [
    { kind: 'chat.put', payload: chat },
    { kind: 'cookState.put', payload: cook },
    { kind: 'cookLog.put', payload: log },
    { kind: 'collection.put', payload: collection },
  ]);
  const applied = [...first.results, ...rest.results].every((r) => r.applied);
  check('a recipe with chat, cook progress, a cook log, and a collection is stored', applied, JSON.stringify(rest.results));

  const deleted = await http.push(empty, [{ kind: 'recipe.delete', payload: { id: recipeId, updatedAt: t + 1 } }]);
  check('the recipe delete is accepted', deleted.results[0]?.applied === true);
  const after = await http.pull(empty);
  check('the recipe is a tombstone', isTombstone(byId(after.recipes, recipeId)));
  check('its chat message is tombstoned', isTombstone(byId(after.chatMessages, chat.id)));
  check('its cook log is tombstoned', isTombstone(byId(after.cookLogs, log.id)));
  check(
    'its cook progress is not live',
    !(after.cookState ?? []).some((row) => row.recipeId === recipeId && !isTombstone(row)),
  );
  const list = byId(after.collections, collectionId);
  check('the collection no longer lists it', Array.isArray(list?.recipeIds) && !(list.recipeIds as string[]).includes(recipeId), JSON.stringify(list));

  // A collection delete tombstones its grants in the same transaction.
  const sharedId = randomUUID();
  const sharedRecipe = newRecipe('Shared then deleted', t);
  await http.push(empty, [{ kind: 'recipe.put', payload: sharedRecipe }]);
  await http.push(empty, [
    { kind: 'collection.put', payload: { id: sharedId, name: 'Cascade shared', recipeIds: [sharedRecipe.id], createdAt: t, updatedAt: t } },
  ]);
  const grant = await http.post(`/api/collections/${sharedId}/grants`, empty, { email: persona('viewer').email, role: 'viewer' });
  check('the empty account shares a collection with viewer', grant.status === 200, `status ${grant.status}`);
  check('viewer sees it', (await http.shared(viewer)).roles.get('Cascade shared') === 'viewer');
  await http.push(empty, [{ kind: 'collection.delete', payload: { id: sharedId, updatedAt: t + 1 } }]);
  check('after the collection delete viewer no longer sees it', !(await http.shared(viewer)).roles.has('Cascade shared'));
  const grants = await http.get(`/api/collections/${sharedId}/grants`, empty);
  check('the deleted collection has no grants route', grants.status === 404, `status ${grants.status}`);
}

async function sharedWrites(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const viewer = cookieOf('viewer');
  const memberCookie = cookieOf('member');
  const ownerCookie = cookieOf('owner');
  const viewerSub = persona('viewer').sub;
  const now = Date.now();

  const pasta = byId((await http.pull(memberCookie)).recipes, FIXTURE_IDS.member.tomatoPasta);
  check("the member's pasta is in the pull", pasta !== undefined);
  if (pasta === undefined) return;
  const viewerPut = await http.push(viewer, [
    { kind: 'recipe.put', shared: true, payload: { ...pasta, title: 'Viewer edit', updatedAt: now } },
  ]);
  check('a viewer cannot save a shared recipe', viewerPut.results[0]?.reason === 'invalid', JSON.stringify(viewerPut.results));
  const pastaAfter = byId((await http.pull(memberCookie)).recipes, FIXTURE_IDS.member.tomatoPasta);
  check("the member's recipe is unchanged", pastaAfter?.title === pasta?.title);

  const ownerRow = () => http.pull(ownerCookie).then((c) => byId(c.recipes, FIXTURE_IDS.owner.shakshuka));
  const shakshuka = await ownerRow();
  check("the owner's shakshuka is in the pull", shakshuka !== undefined);
  if (shakshuka === undefined) return;
  const yearAhead = now + 365 * 24 * 60 * 60 * 1000;
  const editorPut = await http.push(viewer, [
    {
      kind: 'recipe.put',
      shared: true,
      payload: { ...shakshuka, id: FIXTURE_IDS.owner.shakshuka, title: 'Editor shakshuka', createdAt: 1, updatedAt: yearAhead },
    },
  ]);
  check('an editor saves a shared recipe', editorPut.results[0]?.applied === true, JSON.stringify(editorPut.results));
  const edited = await ownerRow();
  check("the edit lands in the owner's row", edited?.title === 'Editor shakshuka');
  check("the owner's createdAt is kept", edited?.createdAt === shakshuka?.createdAt);
  check(
    "the editor's far-future stamp is clamped to server time",
    typeof edited?.updatedAt === 'number' && edited.updatedAt < now + 60_000,
    String(edited?.updatedAt),
  );
  check('the editor did not get a copy in their own tree', byId((await http.pull(viewer)).recipes, FIXTURE_IDS.owner.shakshuka) === undefined);

  const photoPut = await http.push(viewer, [
    { kind: 'recipe.put', shared: true, payload: { ...edited, photoId: randomUUID(), updatedAt: Date.now() } },
  ]);
  check('an editor cannot change a photo id', photoPut.results[0]?.reason === 'invalid', JSON.stringify(photoPut.results));
  const sharedDelete = await http.push(viewer, [
    { kind: 'recipe.delete', payload: { id: FIXTURE_IDS.owner.shakshuka, updatedAt: Date.now() } },
  ]);
  check('an editor cannot delete through a share', sharedDelete.results[0]?.reason === 'invalid', JSON.stringify(sharedDelete.results));
  check('the recipe is still live', !isTombstone(await ownerRow()));

  const picks = FIXTURE_IDS.owner.picks;
  const toViewer = await http.post(`/api/collections/${picks}/grants/role`, ownerCookie, { sub: viewerSub, role: 'viewer' });
  check('the owner makes the editor a viewer', toViewer.status === 200, `status ${toViewer.status}`);
  const demoted = await http.push(viewer, [
    { kind: 'recipe.put', shared: true, payload: { ...edited, title: 'After demotion', updatedAt: Date.now() } },
  ]);
  check('the demoted editor can no longer save', demoted.results[0]?.reason === 'invalid');
  const back = await http.post(`/api/collections/${picks}/grants/role`, ownerCookie, { sub: viewerSub, role: 'editor' });
  check('the owner makes them an editor again', back.status === 200);
  const strangerRole = await http.post(`/api/collections/${picks}/grants/role`, memberCookie, { sub: viewerSub, role: 'viewer' });
  check("someone else cannot change the owner's roles", strangerRole.status === 404, `status ${strangerRole.status}`);

  const weeknights = { ownerSub: persona('member').sub, collectionId: FIXTURE_IDS.member.weeknights };
  const leave = await http.post('/api/shared/leave', viewer, weeknights);
  check('the viewer leaves Weeknights', leave.status === 200, `status ${leave.status}`);
  const again = await http.post('/api/shared/leave', viewer, weeknights);
  check('a second leave is 404', again.status === 404, `status ${again.status}`);
  check('Weeknights is gone from the shared pull', !(await http.shared(viewer)).roles.has('Weeknights'));
  const regrant = await http.post(`/api/collections/${FIXTURE_IDS.member.weeknights}/grants`, memberCookie, {
    email: persona('viewer').email,
    role: 'viewer',
  });
  check('the member shares Weeknights again', regrant.status === 200 && (await http.shared(viewer)).roles.get('Weeknights') === 'viewer');

  const revoke = await http.post(`/api/collections/${picks}/grants/revoke`, ownerCookie, { sub: viewerSub });
  check("the owner revokes the viewer's grant", revoke.status === 200, `status ${revoke.status}`);
  check("Owner's picks is gone from the shared pull", !(await http.shared(viewer)).roles.has("Owner's picks"));
  const restore = await http.post(`/api/collections/${picks}/grants`, ownerCookie, { email: persona('viewer').email, role: 'editor' });
  check('the owner shares it again as editor', restore.status === 200 && (await http.shared(viewer)).roles.get("Owner's picks") === 'editor');

  // Put the seeded title back so later readers see the fixture.
  const fixture = owner.recipes.find((r) => r.id === FIXTURE_IDS.owner.shakshuka);
  const reset = await http.push(ownerCookie, [
    { kind: 'recipe.put', payload: { ...(await ownerRow()), title: fixture?.title, updatedAt: Date.now() } },
  ]);
  check('the owner puts the title back', reset.results[0]?.applied === true);
}

async function collectionLink(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const memberCookie = cookieOf('member');
  const empty = cookieOf('empty');
  const baking = FIXTURE_IDS.member.baking;

  const minted = await http.post(`/api/collections/${baking}/links`, memberCookie, { role: 'viewer' });
  const mint = minted.body as { url?: string; id?: string };
  const token = typeof mint.url === 'string' ? /\/c\/([^/?#]+)$/.exec(mint.url)?.[1] : undefined;
  check('the member mints a link on Baking', minted.status === 200 && token !== undefined && typeof mint.id === 'string', `status ${minted.status}`);
  if (token === undefined || mint.id === undefined) return;

  const landing = await http.get(`/c/${token}`);
  const hopLine = landing.headers.getSetCookie().find((line) => line.startsWith('sous_collection_link='));
  check('the landing leaves the token URL for /c/join', landing.status === 303 && landing.headers.get('location') === '/c/join');
  check('the hop cookie is scoped to /c and HttpOnly', hopLine !== undefined && /Path=\/c(;|$)/.test(hopLine) && hopLine.includes('HttpOnly'), hopLine);
  check('the token is not in the redirect', !(landing.headers.get('location') ?? '').includes(token));
  const hop = hopLine?.split(';')[0] ?? '';
  const both = `${empty}; ${hop}`;

  const confirm = await http.get('/c/join', both);
  const page = typeof confirm.body === 'string' ? confirm.body : '';
  check('the confirm page names the link, not the token', confirm.status === 200 && page.includes(`name="link" value="${mint.id}"`) && !page.includes(token), `status ${confirm.status}`);
  check('GET /c/join joins nothing', !(await http.shared(empty)).roles.has('Baking'));

  const join = (origin: string) =>
    http.send('POST', '/c/join', { cookie: both, form: { link: mint.id as string }, headers: { Origin: origin } });
  const crossSite = await join('https://evil.example');
  check('a cross-site join is refused', crossSite.status === 403, `status ${crossSite.status}`);
  check('and joins nothing', !(await http.shared(empty)).roles.has('Baking'));
  const joined = await join(http.baseUrl);
  check('a same-origin join goes home', joined.status === 303 && joined.headers.get('location') === '/', `status ${joined.status}`);
  check('the joiner now views Baking', (await http.shared(empty)).roles.get('Baking') === 'viewer');
  const twice = await join(http.baseUrl);
  check('joining twice changes nothing', twice.status === 303 && (await http.shared(empty)).roles.get('Baking') === 'viewer');

  const revoked = await http.post(`/api/collections/${baking}/links/revoke`, memberCookie, { id: mint.id });
  check('the member revokes the link', revoked.status === 200, `status ${revoked.status}`);
  check('the revoked link is the generic 404', (await http.get(`/c/${token}`)).status === 404);
}

async function publicJoin(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const memberCookie = cookieOf('member');
  const empty = cookieOf('empty');
  const weeknights = FIXTURE_IDS.member.weeknights;
  const tokenOf = (url: unknown) => (typeof url === 'string' ? /\/p\/([^/?#]+)$/.exec(url)?.[1] : undefined);

  const token = tokenOf(((await http.get(`/api/collections/${weeknights}/public`, memberCookie)).body as { url?: unknown }).url);
  check('Weeknights has a public link', token !== undefined);
  if (token === undefined) return;
  const result = async (cookie: string) => {
    const res = await http.post('/api/public/join', cookie, { token });
    return res.status === 200 ? (res.body as { result?: string }).result : `status ${res.status}`;
  };
  check('a member joins from the public link', (await result(empty)) === 'joined');
  check('joining again is already', (await result(empty)) === 'already');
  check('the owner joining their own link is own', (await result(memberCookie)) === 'own');
  check('the joiner views Weeknights', (await http.shared(empty)).roles.get('Weeknights') === 'viewer');

  const off = await http.post(`/api/collections/${weeknights}/public/revoke`, memberCookie);
  check('the owner turns the public link off', off.status === 200, `status ${off.status}`);
  check('the old link reads 404', (await http.get(`/api/public/${token}`)).status === 404);
  check('and joins 404', (await result(empty)) === 'status 404');
  const on = await http.post(`/api/collections/${weeknights}/public`, memberCookie);
  const fresh = tokenOf((on.body as { url?: unknown }).url);
  check('turning it on again mints a new link', on.status === 200 && fresh !== undefined && fresh !== token);
  check('the new link reads', fresh !== undefined && (await http.get(`/api/public/${fresh}`)).status === 200);
}

async function recipeLinkSave(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const memberCookie = cookieOf('member');
  const empty = cookieOf('empty');
  const oats = FIXTURE_IDS.member.overnightOats;
  const tokenOf = (url: unknown) => (typeof url === 'string' ? /\/p\/([^/?#]+)$/.exec(url)?.[1] : undefined);

  const token = tokenOf(((await http.get(`/api/recipes/${oats}/public`, memberCookie)).body as { url?: unknown }).url);
  check('Overnight oats has a recipe link', token !== undefined);
  if (token === undefined) return;
  const save = async (cookie: string) => {
    const res = await http.post('/api/public/save', cookie, { token });
    return res.status === 200 ? (res.body as { recipeId: string; result: string }) : { recipeId: '', result: `status ${res.status}` };
  };
  const first = await save(empty);
  check('a member saves a copy from the recipe link', first.result === 'saved', first.result);
  const again = await save(empty);
  check('saving again opens the same copy', again.result === 'already' && again.recipeId === first.recipeId);
  const own = await save(memberCookie);
  check("the owner saving their own link is own", own.result === 'own' && own.recipeId === oats);
  check('signed out cannot save', (await save('')).result === 'status 401');

  const copy = byId((await http.pull(empty)).recipes, first.recipeId);
  const original = member.recipes.find((r) => r.id === oats);
  check('the copy is in the saver library', copy !== undefined && copy.title === original?.title);
  check(
    'the copy says who shared it',
    (copy?.savedFrom as { name?: string } | undefined)?.name === persona('member').name,
    JSON.stringify(copy?.savedFrom),
  );

  const deleted = await http.push(empty, [
    { kind: 'recipe.delete', payload: { id: first.recipeId, updatedAt: Date.now() } },
  ]);
  check('the saver deletes the copy', deleted.results[0]?.applied === true);
  const resaved = await save(empty);
  check('saving after a delete makes the copy again', resaved.result === 'saved' && resaved.recipeId === first.recipeId);
  check('the copy is live again', !isTombstone(byId((await http.pull(empty)).recipes, first.recipeId)));

  const off = await http.post(`/api/recipes/${oats}/public/revoke`, memberCookie);
  check('the owner turns the recipe link off', off.status === 200, `status ${off.status}`);
  check('the old recipe link reads 404', (await http.get(`/api/public/${token}`)).status === 404);
  check('and saves 404', (await save(empty)).result === 'status 404');
  check('the saved copy stays', !isTombstone(byId((await http.pull(empty)).recipes, first.recipeId)));
  const on = await http.post(`/api/recipes/${oats}/public`, memberCookie);
  const fresh = tokenOf((on.body as { url?: unknown }).url);
  check('turning it on again mints a new recipe link', on.status === 200 && fresh !== undefined && fresh !== token);

  // Deleting the recipe turns its link off, in the delete transaction; a
  // stale delete that loses last-write-wins leaves it on.
  const doomed = newRecipe('Linked then deleted', Date.now());
  const put = await http.push(memberCookie, [{ kind: 'recipe.put', payload: doomed }]);
  check('a fresh recipe to link saves', put.results[0]?.applied === true);
  const doomedToken = tokenOf(
    ((await http.post(`/api/recipes/${doomed.id as string}/public`, memberCookie)).body as { url?: unknown }).url,
  );
  check('the fresh recipe gets a link', doomedToken !== undefined);
  if (doomedToken === undefined) return;
  const stale = await http.push(memberCookie, [
    { kind: 'recipe.delete', payload: { id: doomed.id, updatedAt: (doomed.updatedAt as number) - 1 } },
  ]);
  check('a stale delete is sent', stale.status === 200, `status ${stale.status}`);
  check('a stale delete leaves the link on', (await http.get(`/api/public/${doomedToken}`)).status === 200);
  const gone = await http.push(memberCookie, [
    { kind: 'recipe.delete', payload: { id: doomed.id, updatedAt: Date.now() } },
  ]);
  check('the owner deletes the linked recipe', gone.results[0]?.applied === true);
  check('the deleted recipe link reads 404', (await http.get(`/api/public/${doomedToken}`)).status === 404);
  const afterDelete = await http.post('/api/public/save', empty, { token: doomedToken });
  check('and saves 404', afterDelete.status === 404, `status ${afterDelete.status}`);
  const relinked = await http.get(`/api/recipes/${doomed.id as string}/public`, memberCookie);
  check('the deleted recipe has no link to show', relinked.status === 404, `status ${relinked.status}`);
}

async function adminFlow(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const ownerCookie = cookieOf('owner');
  const outsider = cookieOf('outsider');
  const sub = persona('outsider').sub;

  const approve = await http.post('/api/admin/decision', ownerCookie, { sub, action: 'approve' });
  check('the owner approves the pending request', approve.status === 200, `status ${approve.status}`);
  const session = (await http.get('/api/auth/session', outsider)).body as { user?: { sub?: string } | null };
  check('the approved person is signed in at once (a denial is never cached)', session.user?.sub === sub, JSON.stringify(session));
  check('and can pull', (await http.get('/api/sync/pull', outsider)).status === 200);

  const revoke = await http.post('/api/admin/decision', ownerCookie, { sub, action: 'revoke' });
  check('the owner revokes them', revoke.status === 200, `status ${revoke.status}`);
  const started = Date.now();
  const refused = await waitUntil(async () => (await http.get('/api/sync/pull', outsider)).status === 401, REVOCATION_BOUND_MS);
  check(
    // The decision clears this server's cache, so this is the next request;
    // the poll only bounds it at the documented 60 s.
    'the revoked person is refused on their next request',
    refused,
    `still admitted after ${Math.round((Date.now() - started) / 1000)} s`,
  );
  const lists = (await http.get('/api/admin/requests', ownerCookie)).body as Record<string, { rows?: { sub: string }[] }>;
  check('/admin lists them as declined', (lists.denied?.rows ?? []).some((row) => row.sub === sub));
}

async function kitchenProfile(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const empty = cookieOf('empty');
  const before = await http.get('/api/settings/kitchen', empty);
  check('an account with no kitchen profile reads null', before.status === 200 && JSON.stringify(before.body) === '{"profile":null}', JSON.stringify(before.body));

  const profile = { allergens: ['sesame'], diets: ['vegan'], avoid: '', dislikes: 'okra', equipment: '', notes: '', sub: persona('member').sub };
  const saved = await http.post('/api/settings/kitchen', empty, profile);
  check('a kitchen profile saves', saved.status === 200, `status ${saved.status}`);
  const after = (await http.get('/api/settings/kitchen', empty)).body as { profile?: Record<string, unknown> };
  check(
    'it reads back as saved',
    JSON.stringify(after.profile?.allergens) === '["sesame"]' && after.profile?.dislikes === 'okra' && typeof after.profile?.updatedAt === 'number',
    JSON.stringify(after),
  );
  const member = (await http.get('/api/settings/kitchen', cookieOf('member'))).body as { profile?: Record<string, unknown> };
  check('a sub in the body is ignored: the member’s profile is unchanged', JSON.stringify(member.profile?.allergens) === '["eggs"]', JSON.stringify(member));

  const bad = await http.post('/api/settings/kitchen', empty, { ...profile, allergens: ['shellfish'] });
  check('an unknown allergen is 400', bad.status === 400, `status ${bad.status}`);
  const unchanged = (await http.get('/api/settings/kitchen', empty)).body as { profile?: Record<string, unknown> };
  check('and changes nothing', JSON.stringify(unchanged.profile?.allergens) === '["sesame"]', JSON.stringify(unchanged));

  check('signed out is 401', (await http.get('/api/settings/kitchen')).status === 401);
}

async function accountPreferences(http: Http, cookieOf: (name: string) => string, check: Check): Promise<void> {
  const empty = cookieOf('empty');
  const units = async (cookie: string) => ((await http.get('/api/settings/preferences', cookie)).body as { preferences?: { units?: string } }).preferences?.units;
  check('an account with no preferences reads as written', (await units(empty)) === 'asWritten');

  const saved = await http.post('/api/settings/preferences', empty, { units: 'metric', sub: persona('member').sub });
  check('metric saves', saved.status === 200, `status ${saved.status}`);
  check('it reads back as metric', (await units(empty)) === 'metric');
  check('the member’s own preference is unchanged', (await units(cookieOf('member'))) === 'metric');

  const bad = await http.post('/api/settings/preferences', empty, { units: 'imperial' });
  check('an unknown unit system is 400', bad.status === 400, `status ${bad.status}`);
  const back = await http.post('/api/settings/preferences', empty, { units: 'asWritten' });
  check('as written saves', back.status === 200 && (await units(empty)) === 'asWritten', `status ${back.status}`);

  check('signed out is 401', (await http.get('/api/settings/preferences')).status === 401);

  // Chat reads the kitchen profile and these preferences (one Firestore getAll)
  // before it parses the body, so an empty body answers 400 only when that read
  // worked; a failed read is 503 "Store unavailable". No model call is made.
  const chat = await http.post('/api/chat', cookieOf('member'), {});
  check('chat reads the prompt context from the store before refusing an empty body', chat.status === 400, `status ${chat.status} ${JSON.stringify(chat.body)}`);
}
