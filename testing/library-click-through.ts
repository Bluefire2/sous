/**
 * Local click-through of Library search persistence and collection switching
 * (issue #57), in test mode. Not part of `npm test` or CI.
 *
 * Run (testing/README.md has the one-time setup):
 *   1. `gcloud emulators firestore start --host-port=127.0.0.1:8085`
 *   2. `npm run dev:test`, wait for `Test mode ready`
 *   3. `npm run dev`
 *   4. `npm run click:library` (add `-- --headed` to watch)
 *
 * It signs in as the `member` persona through `/__test/sign-in`, so it needs
 * no Google account and touches only the emulator. On other ports, pass the
 * same ones everywhere: `npm run dev:test -- --port 3101`, `npm run dev --
 * --port 5273 --api-port 3101`, and `npm run click:library -- --port 5273`.
 *
 * The script still aborts every non-GET `/api` request (sign-out excepted,
 * last step) and fails if any was attempted: that is how flow 4 proves
 * nothing was submitted. Discovery picks collections and a query from what
 * the persona has; nothing is created.
 *
 * Uses the installed Chrome. Where `PLAYWRIGHT_BROWSERS_PATH` is set, uses
 * the bundled Chromium instead.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { DEFAULT_WEB_PORT, devPort } from '../scripts/devPorts.ts';

const BASE = `http://localhost:${devPort(process.argv, '--port', 'SOUS_WEB_PORT', DEFAULT_WEB_PORT)}`;
const STORAGE_KEY = 'cook.librarySearch';
const SEARCH_ALL_PLACEHOLDER = 'Search all recipes…';
// Two owned collections, an unfiled recipe, and recipes in each (fixtures.ts).
const PERSONA = 'member';
const SEED_WAIT_MS = 60_000;

type StoredView = { query?: unknown; browseAll?: unknown } | null;

class Precondition extends Error {}

async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function searchBox(page: Page) {
  return page.locator('input[type="search"]');
}

function chip(page: Page, href: string) {
  return page.locator(`section[aria-labelledby="collections-label"] a[href="${href}"]`);
}

function firstRecipeLink(page: Page) {
  return page.locator('ul li a[href^="/recipe/"]:not([href$="/edit"])').first();
}

/**
 * The ⋮ trigger for the open collection's Rename and Delete. CollectionSection
 * renders it only for a named collection you own; its label is "Actions for
 * {name}" (library.collectionActions). Recipe cards use the same words for
 * their own menus, so look only inside the collections section.
 */
function collectionActionsButton(page: Page) {
  return page
    .locator('section[aria-labelledby="collections-label"]')
    .getByRole('button', { name: /^Actions for / });
}

/** Opens the rename sheet through the collection actions menu. */
async function openRename(page: Page): Promise<void> {
  await collectionActionsButton(page).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
}

function allCollectionsButton(page: Page) {
  return page.getByRole('button', { name: 'All collections', exact: true });
}

async function stored(page: Page): Promise<StoredView> {
  const raw = (await page.evaluate(`sessionStorage.getItem('${STORAGE_KEY}')`)) as string | null;
  return raw === null ? null : (JSON.parse(raw) as StoredView);
}

async function clearStored(page: Page): Promise<void> {
  await page.evaluate(`sessionStorage.removeItem('${STORAGE_KEY}')`);
}

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

async function waitForPath(page: Page, path: string): Promise<void> {
  await waitUntil(`URL path is ${path} (now ${pathOf(page)})`, async () => pathOf(page) === path);
}

/** The search box is up, recipes have loaded, and the collection row is shown. */
async function waitForLibrary(page: Page): Promise<void> {
  await searchBox(page).waitFor({ state: 'visible' });
  await page.getByText('Loading recipes…').waitFor({ state: 'detached' });
  await page.locator('section[aria-labelledby="collections-label"]').waitFor({ state: 'visible' });
}

async function openLibrary(page: Page, path: string): Promise<void> {
  await page.goto(BASE + path);
  await waitForLibrary(page);
}

async function expectBox(page: Page, value: string, where: string): Promise<void> {
  await waitUntil(`search box holds ${JSON.stringify(value)} ${where}`, async () =>
    (await searchBox(page).inputValue()) === value,
  );
}

async function hasRecipeCard(page: Page): Promise<boolean> {
  return (await firstRecipeLink(page).count()) > 0;
}

type Fixture = { a: string; b: string; query: string; recipeList: string };

/** Read-only: pick an owned collection A, another list B, a query, and a list with a recipe. */
async function discover(page: Page): Promise<Fixture> {
  // A fresh context has nothing stored, and about:blank has no sessionStorage.
  await openLibrary(page, '/');
  const chipLinks = await page
    .locator('section[aria-labelledby="collections-label"] a[href^="/collections/"]')
    .all();
  const chips: string[] = [];
  for (const link of chipLinks) {
    const href = await link.getAttribute('href');
    if (href !== null) chips.push(href);
  }
  if (chips.length === 0) {
    throw new Precondition('precondition not met: needs at least one collection');
  }

  let a: string | undefined;
  let recipeList: string | undefined = (await hasRecipeCard(page)) ? '/' : undefined;
  for (const href of chips) {
    await openLibrary(page, href);
    if (a === undefined && (await collectionActionsButton(page).count()) > 0) a = href;
    if (recipeList === undefined && (await hasRecipeCard(page))) recipeList = href;
    if (a !== undefined && recipeList !== undefined) break;
  }
  if (a === undefined) {
    throw new Precondition('precondition not met: needs a collection you own (shows its actions menu)');
  }
  if (recipeList === undefined) {
    throw new Precondition('precondition not met: needs a recipe in some list');
  }
  const b = chips.find((href) => href !== a) ?? '/';

  await openLibrary(page, '/');
  await allCollectionsButton(page).click();
  await firstRecipeLink(page).waitFor({ state: 'visible' });
  const title = await firstRecipeLink(page).locator('h2').innerText();
  const word = /\p{L}{3,}/u.exec(title)?.[0];
  if (word === undefined) {
    throw new Precondition('precondition not met: the first recipe title has no 3-letter word');
  }
  await allCollectionsButton(page).click();
  await clearStored(page);
  return { a, b, query: word.toLowerCase(), recipeList };
}

async function flowChipChanges(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  const route = f.b === '/' ? [f.a, '/'] : [f.b, f.a, '/'];
  for (const href of route) {
    await chip(page, href).click();
    await waitForPath(page, href);
    await expectBox(page, f.query, `after switching to ${href}`);
    const view = await stored(page);
    if (view?.query !== f.query) throw new Error(`stored query lost after switching to ${href}`);
  }
}

async function flowLeaveLibrary(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  await allCollectionsButton(page).click();
  await waitUntil('placeholder says all recipes', async () =>
    (await searchBox(page).getAttribute('placeholder')) === SEARCH_ALL_PLACEHOLDER,
  );
  await waitUntil('query and All collections stored before opening a recipe', async () => {
    const view = await stored(page);
    return view?.query === f.query && view.browseAll === true;
  });
  await firstRecipeLink(page).click();
  await waitUntil('recipe opened', async () => pathOf(page).startsWith('/recipe/'));
  await page.goBack();
  await waitForPath(page, '/');
  await waitForLibrary(page);
  await expectBox(page, f.query, 'after Back from the recipe');
  await waitUntil('All collections scope restored', async () =>
    (await searchBox(page).getAttribute('placeholder')) === SEARCH_ALL_PLACEHOLDER,
  );
  const after = await stored(page);
  if (after?.query !== f.query || after.browseAll !== true) {
    throw new Error('stored view changed after Back from the recipe');
  }
}

async function flowClearingSticks(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, f.recipeList);
  await searchBox(page).fill(f.query);
  await waitUntil('query stored', async () => (await stored(page))?.query === f.query);
  await searchBox(page).fill('');
  await waitUntil('key removed after clearing', async () => (await stored(page)) === null);
  await firstRecipeLink(page).click();
  await waitUntil('recipe opened', async () => pathOf(page).startsWith('/recipe/'));
  await page.goBack();
  await waitForPath(page, f.recipeList);
  await waitForLibrary(page);
  await expectBox(page, '', 'after Back from the recipe');
  if ((await stored(page)) !== null) throw new Error('key came back after Back from the recipe');
}

async function expectNoDialog(page: Page, where: string): Promise<void> {
  // The reset runs in a layout effect; give a late paint time to show up.
  await page.waitForTimeout(500);
  const open = await page.getByRole('dialog').count();
  if (open !== 0) throw new Error(`a sheet is open ${where}`);
}

async function flowNoSheetCarryOver(page: Page, f: Fixture): Promise<void> {
  await clearStored(page);
  await openLibrary(page, f.b);
  await chip(page, f.a).click();
  await waitForPath(page, f.a);
  await openRename(page);
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.goBack();
  await waitForPath(page, f.b);
  await waitForLibrary(page);
  await expectNoDialog(page, `after Back to ${f.b}`);
  await page.goForward();
  await waitForPath(page, f.a);
  await waitForLibrary(page);
  await expectNoDialog(page, `after Forward to ${f.a}`);
}

async function flowSignOut(page: Page, f: Fixture, allowSignOut: () => void): Promise<void> {
  await clearStored(page);
  await openLibrary(page, '/');
  await searchBox(page).fill(f.query);
  await waitUntil('query stored', async () => (await stored(page))?.query === f.query);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await waitForPath(page, '/settings');
  if ((await stored(page))?.query !== f.query) throw new Error('key gone before sign-out');
  allowSignOut();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await waitUntil('key removed after sign-out', async () => (await stored(page)) === null);
}

/** Abort every write so a broken flow cannot change the real library. */
async function guardWrites(context: BrowserContext): Promise<{
  blocked: string[];
  allowSignOut: () => void;
}> {
  const blocked: string[] = [];
  let signOutAllowed = false;
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname;
      if (method === 'GET' || method === 'HEAD') return route.continue();
      if (signOutAllowed && method === 'POST' && path === '/api/auth/signout') {
        return route.continue();
      }
      blocked.push(`${method} ${path}`);
      return route.abort('blockedbyclient');
    },
  );
  context.on('request', (request) => {
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== 'GET' && method !== 'HEAD' && !path.startsWith('/api/')) {
      blocked.push(`${method} ${path} (not aborted)`);
    }
  });
  return { blocked, allowSignOut: () => (signOutAllowed = true) };
}

/** Test mode is up and seeded: `/__test/personas` answers 200. */
async function preflight(context: BrowserContext): Promise<void> {
  const deadline = Date.now() + SEED_WAIT_MS;
  for (;;) {
    let status: number;
    try {
      status = (await context.request.get(`${BASE}/__test/personas`)).status();
    } catch {
      throw new Precondition(`${BASE} is not answering. Start \`npm run dev\`.`);
    }
    if (status === 200) return;
    if (status === 404) {
      throw new Precondition(
        'No test mode behind Vite (/__test/ is 404): stop `npm run dev:api` and run ' +
          '`npm run dev:test` (testing/README.md).',
      );
    }
    if (status !== 503) {
      throw new Precondition(
        `/__test/personas answered ${status}. Start \`npm run dev:test\` (and pass Vite ` +
          'the same --api-port).',
      );
    }
    if (Date.now() > deadline) throw new Precondition('Test mode is still seeding after 60 s.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function signIn(context: BrowserContext, page: Page): Promise<void> {
  await page.goto(`${BASE}/__test/sign-in?as=${PERSONA}&returnTo=/`);
  const response = await context.request.get(`${BASE}/api/auth/session`);
  const user = ((await response.json()) as { user?: unknown }).user ?? null;
  if (user === null) {
    throw new Precondition(
      `Signing in as ${PERSONA} left the session signed out. Restart \`npm run dev:test\` ` +
        'without --keep (testing/README.md, Troubleshooting).',
    );
  }
}

async function main(): Promise<number> {
  const headed = process.argv.includes('--headed') || process.env.SOUS_E2E_HEADED === '1';
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { channel: 'chrome' }),
    headless: !headed,
    slowMo: headed ? 150 : 0,
  });
  let current = 'setup';
  let page: Page | undefined;
  try {
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    const guard = await guardWrites(context);
    await preflight(context);
    const p = await context.newPage();
    page = p;
    p.setDefaultTimeout(15_000);
    await signIn(context, p);

    current = 'discovery';
    const fixture = await discover(p);
    console.log(`fixture: A=${fixture.a} B=${fixture.b} recipes in ${fixture.recipeList}`);

    const flows: [string, () => Promise<void>][] = [
      ['1. Search survives chip changes', () => flowChipChanges(p, fixture)],
      ['2. Search survives leaving the library', () => flowLeaveLibrary(p, fixture)],
      ['3. Clearing sticks', () => flowClearingSticks(p, fixture)],
      ['4. No sheet carry-over', () => flowNoSheetCarryOver(p, fixture)],
      ['5. Sign-out clears it', () => flowSignOut(p, fixture, guard.allowSignOut)],
    ];
    for (const [name, run] of flows) {
      current = name;
      await run();
      if (guard.blocked.length > 0) {
        throw new Error(`blocked writes: ${guard.blocked.join(', ')}`);
      }
      console.log(`✓ ${name}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Precondition) {
      console.error(error.message);
      return 2;
    }
    console.error(`✗ ${current}: ${error instanceof Error ? error.message : String(error)}`);
    if (page !== undefined) {
      const shot = join(tmpdir(), 'sous-library-click-through.png');
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.error(`screenshot: ${shot}`);
      } catch {
        // the page may already be gone
      }
    }
    return 1;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  if (error instanceof Precondition) {
    console.error(error.message);
    return 2;
  }
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
