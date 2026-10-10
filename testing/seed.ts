/**
 * Seeds the Firestore emulator for test mode (docs/plans/test-mode.md).
 *
 * Writes through the app's own HTTP routes on the running test server, with
 * each persona's session from `/__test/sign-in`, so validation, compaction,
 * LWW, and the grant transactions all run. The MCP grant has no HTTP path
 * short of the consent page, which fetches a public client-metadata document,
 * so the seed writes it with the server's own store function and then redeems
 * its code through `POST /oauth/token`. The `capped` persona's spent AI
 * budget has no HTTP path either (only real model calls add to it), so the
 * seed writes it with the budget's own store.
 *
 * Loaded by testing/test-server.ts after it has set the test environment.
 */
import { s256Challenge } from '../server/mcp/oauth/pkce.ts';
import { createGrantWithCode, touchGrant } from '../server/mcp/oauth/store.ts';
import { LLM_DAILY_BUDGET_MICRO_USD, firestoreLlmUsageStore, utcDayKey } from '../server/llmBudget.ts';
import { signAccessRequestTx } from '../server/session.ts';
import { TEST_PROJECT_ID } from './env.ts';
import {
  rememberSeededMcpTokens,
  SEEDED_MCP_CLIENT_ID,
  SEEDED_MCP_CODE_VERIFIER,
  SEEDED_MCP_REDIRECT_URI,
} from './seededMcp.ts';
import {
  FIXTURE_IDS,
  ACCOUNT_PREFERENCES,
  KITCHEN_PROFILES,
  memberLibrary,
  ownerLibrary,
  viewerLibrary,
  viewerSharedChat,
  type PersonaLibrary,
} from './fixtures.ts';
import { PERSONAS, persona, type PersonaName } from './personas.ts';

const MAX_PUSH_OPS = 50;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Deletes every document in the emulator's `demo-sous` database. */
export async function clearEmulator(emulatorHost: string): Promise<void> {
  const url = `http://${emulatorHost}/emulator/v1/projects/${TEST_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Clearing the emulator failed: ${res.status}`);
  }
}

type Cookies = Record<PersonaName, string>;

async function signIn(baseUrl: string, name: PersonaName): Promise<string> {
  const res = await fetch(`${baseUrl}/__test/sign-in?as=${name}`, { redirect: 'manual' });
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((pair) => pair.startsWith('sous_session='));
  if (res.status !== 303 || cookie === undefined) {
    throw new Error(`Signing in as ${name} failed: ${res.status}`);
  }
  return cookie;
}

async function request(
  baseUrl: string,
  path: string,
  options: { cookie?: string; json?: unknown; form?: Record<string, string> },
): Promise<unknown> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.cookie !== undefined) {
    headers.Cookie = options.cookie;
  }
  if (options.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json ?? {});
  }
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return type.includes('application/json') && text !== '' ? JSON.parse(text) : text;
}

async function push(baseUrl: string, cookie: string, ops: { kind: string; payload: unknown }[]): Promise<void> {
  for (let start = 0; start < ops.length; start += MAX_PUSH_OPS) {
    const batch = ops.slice(start, start + MAX_PUSH_OPS);
    const response = (await request(baseUrl, '/api/sync/push', { cookie, json: { ops: batch } })) as {
      results: { index: number; applied: boolean; reason?: string }[];
    };
    for (const result of response.results) {
      if (!result.applied) {
        const op = batch[result.index];
        throw new Error(`Seed push of ${op?.kind} was not applied: ${result.reason ?? 'no reason'}`);
      }
    }
  }
}

async function pushLibrary(baseUrl: string, cookie: string, library: PersonaLibrary): Promise<void> {
  // Recipes before the collections that list them, and before rows that hang off them.
  await push(baseUrl, cookie, library.recipes.map((payload) => ({ kind: 'recipe.put', payload })));
  await push(baseUrl, cookie, [
    ...library.collections.map((payload) => ({ kind: 'collection.put', payload })),
    ...library.cookStates.map((payload) => ({ kind: 'cookState.put', payload })),
    ...library.cookLogs.map((payload) => ({ kind: 'cookLog.put', payload })),
    ...library.chat.map((payload) => ({ kind: 'chat.put', payload })),
  ]);
}

async function admit(baseUrl: string, cookies: Cookies): Promise<void> {
  for (const p of PERSONAS) {
    if (p.admission === 'owner') {
      continue;
    }
    // The invitation-only page's form, with its signed token.
    await request(baseUrl, '/api/access-request', {
      form: { t: signAccessRequestTx({ sub: p.sub, email: p.email, name: p.name }, Date.now()) },
    });
  }
  for (const p of PERSONAS) {
    if (p.admission === 'member' || p.admission === 'declined') {
      await request(baseUrl, '/api/admin/decision', {
        cookie: cookies.owner,
        json: { sub: p.sub, action: p.admission === 'member' ? 'approve' : 'deny' },
      });
    }
  }
}

async function connectApp(baseUrl: string, now: number): Promise<void> {
  const member = persona('member');
  // The grant stays "connected 4 days ago". The code's own clock is now, so
  // its 60 s lifetime covers the exchange below.
  const { grantId, code } = await createGrantWithCode(
    {
      sub: member.sub,
      email: member.email,
      clientId: SEEDED_MCP_CLIENT_ID,
      clientHost: 'claude.ai',
      clientName: 'Claude',
      scopes: ['recipes:read', 'recipes:write'],
      redirectUri: SEEDED_MCP_REDIRECT_URI,
      codeChallenge: s256Challenge(SEEDED_MCP_CODE_VERIFIER),
    },
    now - 4 * DAY,
    Date.now(),
  );
  const exchanged = await exchangeMcpCode(baseUrl, code);
  rememberSeededMcpTokens({
    clientId: SEEDED_MCP_CLIENT_ID,
    accessToken: exchanged.accessToken,
    refreshToken: exchanged.refreshToken,
  });
  // Redeeming the code stamps lastUsedAt. Put the fixture time back so
  // Settings still reads "last used 2 hours ago" on a fresh seed.
  await touchGrant(member.sub, grantId, now - 2 * HOUR);
}

async function exchangeMcpCode(
  baseUrl: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SEEDED_MCP_REDIRECT_URI,
      client_id: SEEDED_MCP_CLIENT_ID,
      code_verifier: SEEDED_MCP_CODE_VERIFIER,
    }),
  });
  const text = await res.text();
  let parsed: { access_token?: unknown; refresh_token?: unknown; scope?: unknown; error?: unknown };
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as typeof parsed);
  } catch {
    parsed = {};
  }
  if (
    res.status !== 200 ||
    typeof parsed.access_token !== 'string' ||
    typeof parsed.refresh_token !== 'string' ||
    parsed.scope !== 'recipes:read recipes:write'
  ) {
    const error = typeof parsed.error === 'string' ? parsed.error : 'no token';
    throw new Error(`MCP code exchange failed: ${res.status} ${error}`);
  }
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token };
}

/**
 * Signs every persona in and writes the fixtures. The emulator must be empty.
 * Returns the time the fixtures are relative to.
 */
export async function seed(baseUrl: string): Promise<number> {
  const now = Date.now();
  const cookies = {} as Cookies;
  for (const p of PERSONAS) {
    cookies[p.as] = await signIn(baseUrl, p.as);
  }

  await admit(baseUrl, cookies);

  await pushLibrary(baseUrl, cookies.member, memberLibrary(now));
  await pushLibrary(baseUrl, cookies.owner, ownerLibrary(now));
  await pushLibrary(baseUrl, cookies.viewer, viewerLibrary(now));

  const viewerEmail = persona('viewer').email;
  await request(baseUrl, `/api/collections/${FIXTURE_IDS.member.weeknights}/grants`, {
    cookie: cookies.member,
    json: { email: viewerEmail, role: 'viewer' },
  });
  await request(baseUrl, `/api/collections/${FIXTURE_IDS.owner.picks}/grants`, {
    cookie: cookies.owner,
    json: { email: viewerEmail, role: 'editor' },
  });
  await push(
    baseUrl,
    cookies.viewer,
    viewerSharedChat(now).map((payload) => ({ kind: 'chat.put', payload })),
  );
  await request(baseUrl, `/api/collections/${FIXTURE_IDS.member.weeknights}/public`, {
    cookie: cookies.member,
  });
  // A recipe link on an unfiled recipe (`docs/plans/recipe-links.md`), and a
  // copy saved from it by `capped`, whose library nothing else checks, so the
  // copy's "Shared by" line can be reviewed.
  const recipeLink = (await request(
    baseUrl,
    `/api/recipes/${FIXTURE_IDS.member.overnightOats}/public`,
    { cookie: cookies.member },
  )) as { url?: string };
  const recipeToken = /\/p\/([^/?#]+)$/.exec(recipeLink.url ?? '')?.[1];
  if (recipeToken !== undefined) {
    await request(baseUrl, '/api/public/save', {
      cookie: cookies.capped,
      json: { token: recipeToken },
    });
  }
  await request(baseUrl, '/api/admin/invites', { cookie: cookies.owner });
  await request(baseUrl, '/api/settings/kitchen', { cookie: cookies.member, json: KITCHEN_PROFILES.member });
  await request(baseUrl, '/api/settings/kitchen', { cookie: cookies.viewer, json: KITCHEN_PROFILES.viewer });
  await request(baseUrl, '/api/settings/preferences', { cookie: cookies.member, json: ACCOUNT_PREFERENCES.member });
  await request(baseUrl, '/api/settings/preferences', { cookie: cookies.viewer, json: ACCOUNT_PREFERENCES.viewer });

  await connectApp(baseUrl, now);
  // Today in UTC: after midnight a kept seed (`--keep`) is no longer capped.
  await firestoreLlmUsageStore.addSpend(
    persona('capped').sub,
    utcDayKey(now),
    LLM_DAILY_BUDGET_MICRO_USD,
    new Date(now + DAY),
  );
  return now;
}
