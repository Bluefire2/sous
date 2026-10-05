/**
 * MCP checks for the test-mode smoke script. They run against the seeded
 * server: discovery, the OAuth endpoints, and `/mcp` with the member's
 * tokens from `GET /__test/personas`.
 *
 * The consent page is not exercised. It fetches the client's metadata
 * document from a public https host, and test mode does not depend on that
 * network. Checking the hop to `/oauth/consent` is as far as this script
 * goes; the page itself stays in `server/mcp/oauth/consentPage.test.ts`.
 * The seed has already redeemed an authorization code through `POST /oauth/token`.
 */
import { s256Challenge } from '../server/mcp/oauth/pkce.ts';
import { MCP_TOOLS } from '../server/mcp/tools.ts';
import { FIXTURE_IDS, memberLibrary } from './fixtures.ts';
import { SEEDED_MCP_CLIENT_ID, SEEDED_MCP_REDIRECT_URI, type SeededMcpTokens } from './seededMcp.ts';

const member = memberLibrary(0);
const memberUnfiled = member.recipes.filter(
  (recipe) => !member.collections.some((collection) => collection.recipeIds.includes(recipe.id)),
).length;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sous-smoke', version: '1' },
  },
};

type Check = (name: string, ok: boolean, detail?: string) => void;

type HttpResult = { status: number; body: unknown; headers: Headers };

async function call(baseUrl: string, path: string, init: RequestInit = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('application/json') && text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}

function rpcBody(method: string, params: unknown, id = 2): unknown {
  return { jsonrpc: '2.0', id, method, params };
}

function mcpHeaders(token?: string, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (cookie !== undefined) headers.Cookie = cookie;
  return headers;
}

async function mcp(
  baseUrl: string,
  body: unknown,
  token?: string,
  cookie?: string,
): Promise<HttpResult> {
  return call(baseUrl, '/mcp', { method: 'POST', headers: mcpHeaders(token, cookie), body: JSON.stringify(body) });
}

function toolCall(name: string, args: unknown, id = 3): unknown {
  return rpcBody('tools/call', { name, arguments: args }, id);
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { text?: string }[];
};

function toolResult(body: unknown): ToolResult | undefined {
  const result = (body as { result?: ToolResult }).result;
  return result;
}

function toolError(body: unknown): string | undefined {
  const result = toolResult(body);
  if (result?.isError !== true) return undefined;
  const error = result.structuredContent?.error;
  return typeof error === 'string' ? error : '';
}

function oauthError(body: unknown): string {
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : '';
}

async function formPost(baseUrl: string, path: string, fields: Record<string, string>): Promise<HttpResult> {
  return call(baseUrl, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function checkDiscovery(baseUrl: string, check: Check): Promise<string | undefined> {
  const root = await call(baseUrl, '/.well-known/oauth-protected-resource');
  const suffixed = await call(baseUrl, '/.well-known/oauth-protected-resource/mcp');
  const doc = suffixed.body as {
    resource?: unknown;
    authorization_servers?: unknown;
    scopes_supported?: unknown;
    bearer_methods_supported?: unknown;
    resource_name?: unknown;
  };
  check(
    'protected-resource metadata matches on both well-known paths',
    root.status === 200 && suffixed.status === 200 && JSON.stringify(root.body) === JSON.stringify(suffixed.body),
    `status ${root.status}/${suffixed.status}`,
  );
  const resource = typeof doc.resource === 'string' ? doc.resource : '';
  const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers : [];
  const issuer = typeof servers[0] === 'string' ? servers[0] : '';
  check(
    'protected-resource metadata names /mcp and its authorization server',
    resource.endsWith('/mcp') && servers.length === 1 && issuer !== '' && resource === `${issuer}/mcp`,
    JSON.stringify({ resource: doc.resource, authorization_servers: doc.authorization_servers }),
  );
  check(
    'protected-resource metadata offers the recipe scopes over a bearer header',
    JSON.stringify(doc.scopes_supported) === JSON.stringify(['recipes:read', 'recipes:write']) &&
      JSON.stringify(doc.bearer_methods_supported) === JSON.stringify(['header']) &&
      doc.resource_name === 'Sous' &&
      suffixed.headers.get('access-control-allow-origin') === '*',
  );

  const as = await call(baseUrl, '/.well-known/oauth-authorization-server');
  const meta = as.body as Record<string, unknown>;
  check('authorization-server metadata answers', as.status === 200, `status ${as.status}`);
  check(
    'authorization-server metadata is a public CIMD server with no registration endpoint',
    meta.issuer === issuer &&
      meta.authorization_endpoint === `${issuer}/oauth/authorize` &&
      meta.token_endpoint === `${issuer}/oauth/token` &&
      meta.revocation_endpoint === `${issuer}/oauth/revoke` &&
      JSON.stringify(meta.response_types_supported) === JSON.stringify(['code']) &&
      JSON.stringify(meta.grant_types_supported) === JSON.stringify(['authorization_code', 'refresh_token']) &&
      Array.isArray(meta.token_endpoint_auth_methods_supported) &&
      (meta.token_endpoint_auth_methods_supported as unknown[]).includes('none') &&
      JSON.stringify(meta.code_challenge_methods_supported) === JSON.stringify(['S256']) &&
      meta.client_id_metadata_document_supported === true &&
      !Object.hasOwn(meta, 'registration_endpoint') &&
      JSON.stringify(meta.scopes_supported) === JSON.stringify(['recipes:read', 'recipes:write']) &&
      as.headers.get('access-control-allow-origin') === '*',
    `issuer ${String(meta.issuer)}`,
  );
  return issuer === '' ? undefined : issuer;
}

async function checkUnauthenticated(baseUrl: string, issuer: string, memberCookie: string, check: Check): Promise<void> {
  for (const method of ['GET', 'DELETE', 'HEAD'] as const) {
    const res = await call(baseUrl, '/mcp', { method });
    check(`${method} /mcp is 405`, res.status === 405, `status ${res.status}`);
  }
  check('GET /oauth/token is 405', (await call(baseUrl, '/oauth/token')).status === 405);
  check('POST /oauth/authorize is 405', (await call(baseUrl, '/oauth/authorize', { method: 'POST' })).status === 405);

  const noToken = await mcp(baseUrl, INITIALIZE);
  const challenge = noToken.headers.get('www-authenticate') ?? '';
  check('POST /mcp with no token is 401', noToken.status === 401, `status ${noToken.status}`);
  check(
    'the 401 points at the resource metadata and does not call a missing token invalid',
    challenge.includes(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`) &&
      !challenge.includes('invalid_token'),
    challenge,
  );

  const cookieOnly = await mcp(baseUrl, INITIALIZE, undefined, memberCookie);
  const cookieChallenge = cookieOnly.headers.get('www-authenticate') ?? '';
  check(
    'a session cookie does not authorize /mcp',
    cookieOnly.status === 401 && !cookieChallenge.includes('invalid_token'),
    `status ${cookieOnly.status}`,
  );

  const bogus = await mcp(baseUrl, INITIALIZE, 'sous_at_not-a-real-token');
  check(
    'an unknown access token is 401 invalid_token',
    bogus.status === 401 && (bogus.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'),
    `status ${bogus.status}`,
  );

  const pull = await call(baseUrl, '/api/sync/pull?limit=1', {
    headers: { Authorization: 'Bearer sous_at_not-a-real-token' },
  });
  check('a bearer token does not authorize library pull', pull.status === 401, `status ${pull.status}`);

  const grants = await call(baseUrl, '/api/mcp/grants', {
    headers: { Authorization: 'Bearer sous_at_not-a-real-token' },
  });
  check('a bearer token does not authorize connected apps', grants.status === 401, `status ${grants.status}`);

  const badAuthorize = await call(baseUrl, '/oauth/authorize');
  check(
    'authorize with no client renders an error page and does not redirect',
    badAuthorize.status === 400 &&
      badAuthorize.headers.get('location') === null &&
      typeof badAuthorize.body === 'string' &&
      badAuthorize.body.includes('try connecting again'),
    `status ${badAuthorize.status}`,
  );

  const authorize = await call(
    baseUrl,
    `/oauth/authorize?${new URLSearchParams({
      client_id: SEEDED_MCP_CLIENT_ID,
      redirect_uri: SEEDED_MCP_REDIRECT_URI,
      response_type: 'code',
      code_challenge: s256Challenge('sous-smoke-pkce-verifier-0123456789abcdef'),
      code_challenge_method: 'S256',
      scope: 'recipes:read recipes:write',
      state: 'smoke',
      resource: `${issuer}/mcp`,
    })}`,
  );
  const hop = authorize.headers.getSetCookie().some((line) => line.startsWith('sous_mcp_authz='));
  check(
    'a well-formed authorize request hops to consent',
    authorize.status === 303 && authorize.headers.get('location') === '/oauth/consent' && hop,
    `status ${authorize.status} location ${authorize.headers.get('location') ?? ''}`,
  );

  const consent = await call(baseUrl, '/oauth/consent');
  check(
    'consent without the hop cookie is an expired page',
    consent.status === 400 &&
      typeof consent.body === 'string' &&
      consent.body.includes('This connection request has expired'),
    `status ${consent.status}`,
  );

  const notForm = await call(baseUrl, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check(
    'the token endpoint refuses a JSON body',
    notForm.status === 400 && oauthError(notForm.body) === 'invalid_request',
    `status ${notForm.status} ${oauthError(notForm.body)}`,
  );
  const unsupported = await formPost(baseUrl, '/oauth/token', { grant_type: 'client_credentials' });
  check(
    'the token endpoint refuses an unknown grant',
    unsupported.status === 400 && oauthError(unsupported.body) === 'unsupported_grant_type',
    oauthError(unsupported.body),
  );
}

async function readTokens(baseUrl: string, check: Check): Promise<SeededMcpTokens | undefined> {
  const res = await call(baseUrl, '/__test/personas');
  const mcp = (res.body as { mcp?: SeededMcpTokens }).mcp;
  const ok =
    res.status === 200 &&
    mcp !== undefined &&
    mcp.clientId === SEEDED_MCP_CLIENT_ID &&
    mcp.accessToken.startsWith('sous_at_') &&
    mcp.refreshToken.startsWith('sous_rt_');
  check(
    'the seed published the member MCP tokens',
    ok,
    res.status === 200 && mcp === undefined ? 'no tokens (restart test mode without --keep)' : `status ${res.status}`,
  );
  return ok ? mcp : undefined;
}

async function checkTools(baseUrl: string, token: string, memberCookie: string, check: Check): Promise<void> {
  const session = await mcp(baseUrl, INITIALIZE, token, memberCookie);
  const info = (session.body as { result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } })
    .result;
  check(
    'initialize answers JSON with no session id',
    session.status === 200 &&
      (session.headers.get('content-type') ?? '').includes('application/json') &&
      session.headers.get('mcp-session-id') === null &&
      info?.serverInfo?.name === 'sous' &&
      info.capabilities?.tools !== undefined,
    `status ${session.status}`,
  );

  const listed = await mcp(baseUrl, rpcBody('tools/list', {}), token);
  const names = ((listed.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((tool) => tool.name);
  const expectedTools = MCP_TOOLS.map((tool) => tool.name);
  check(
    'tools/list matches the server tool list',
    listed.status === 200 && JSON.stringify(names) === JSON.stringify(expectedTools),
    JSON.stringify(names),
  );

  const library = await mcp(baseUrl, toolCall('search_recipes', { limit: 20 }), token);
  const hits = (toolResult(library.body)?.structuredContent?.hits ?? []) as { id: string }[];
  const hitIds = hits.map((hit) => hit.id).sort();
  const ownIds = member.recipes.map((recipe) => recipe.id).sort();
  check(
    'search lists the member library and nothing shared',
    library.status === 200 &&
      toolResult(library.body)?.isError !== true &&
      toolResult(library.body)?.structuredContent?.total === ownIds.length &&
      JSON.stringify(hitIds) === JSON.stringify(ownIds),
    `status ${library.status} total ${String(toolResult(library.body)?.structuredContent?.total)}`,
  );

  const chickenId = FIXTURE_IDS.member.roastChicken;
  const lemon = await mcp(baseUrl, toolCall('search_recipes', { query: 'lemon' }), token);
  const lemonHits = (toolResult(lemon.body)?.structuredContent?.hits ?? []) as { id: string; title: string }[];
  const chicken = member.recipes.find((recipe) => recipe.id === chickenId);
  check(
    'search for lemon finds the roast chicken',
    lemonHits.some((hit) => hit.id === chickenId && hit.title === chicken?.title),
    JSON.stringify(lemonHits.map((hit) => hit.title)),
  );

  const others = await mcp(baseUrl, toolCall('get_recipes', { ids: [FIXTURE_IDS.owner.shakshuka, FIXTURE_IDS.viewer.pancakes] }), token);
  const missing = toolResult(others.body)?.structuredContent;
  check(
    "get_recipes does not return another account's recipes",
    others.status === 200 &&
      JSON.stringify(missing?.recipes) === '[]' &&
      JSON.stringify(missing?.missingIds) === JSON.stringify([FIXTURE_IDS.owner.shakshuka, FIXTURE_IDS.viewer.pancakes]),
    JSON.stringify(missing?.missingIds),
  );

  const full = await mcp(baseUrl, toolCall('get_recipes', { ids: [chickenId, FIXTURE_IDS.member.bananaBread] }), token);
  const recipes = (toolResult(full.body)?.structuredContent?.recipes ?? []) as Record<string, unknown>[];
  const roast = recipes.find((recipe) => recipe.id === chickenId);
  const bread = recipes.find((recipe) => recipe.id === FIXTURE_IDS.member.bananaBread);
  const text = toolResult(full.body)?.content?.[0]?.text;
  check(
    'get_recipes returns the roast chicken in Weeknights, without private fields',
    roast?.title === chicken?.title &&
      roast?.servings === 4 &&
      roast?.collectionName === 'Weeknights' &&
      typeof roast?.version === 'number' &&
      !Object.hasOwn(roast ?? {}, 'lang') &&
      !Object.hasOwn(roast ?? {}, 'photoId') &&
      !Object.hasOwn(roast ?? {}, 'importCheck') &&
      !Object.hasOwn(roast ?? {}, 'createdAt') &&
      bread !== undefined &&
      !Object.hasOwn(bread, 'importCheck') &&
      text === JSON.stringify(toolResult(full.body)?.structuredContent),
    roast === undefined ? 'missing roast chicken' : `collection ${String(roast.collectionName)}`,
  );

  const collections = await mcp(baseUrl, toolCall('list_collections', {}), token);
  const rows = (toolResult(collections.body)?.structuredContent?.collections ?? []) as {
    id: string;
    name: string;
    recipeCount: number;
  }[];
  const byName = new Map(rows.map((row) => [row.name, row]));
  check(
    'list_collections is Weeknights, Baking, and Unfiled',
    byName.get('Weeknights')?.id === FIXTURE_IDS.member.weeknights &&
      byName.get('Weeknights')?.recipeCount === 3 &&
      byName.get('Baking')?.id === FIXTURE_IDS.member.baking &&
      byName.get('Baking')?.recipeCount === 2 &&
      byName.get('Unfiled')?.recipeCount === memberUnfiled &&
      byName.get("Owner's picks") === undefined &&
      rows.length === 3,
    JSON.stringify(rows.map((row) => `${row.name}:${row.recipeCount}`)),
  );

  const oatsId = FIXTURE_IDS.member.overnightOats;
  const bakingId = FIXTURE_IDS.member.baking;
  const moved = await mcp(baseUrl, toolCall('move_recipes', { ids: [oatsId], collectionId: bakingId }), token);
  const movedData = toolResult(moved.body)?.structuredContent;
  const movedTo = movedData?.collection as { id?: unknown } | undefined;
  check(
    'move_recipes files an unfiled recipe into Baking',
    moved.status === 200 &&
      toolResult(moved.body)?.isError !== true &&
      movedTo?.id === bakingId &&
      JSON.stringify(movedData?.movedIds) === JSON.stringify([oatsId]),
    `status ${moved.status} ${toolError(moved.body) ?? ''}`,
  );

  const foreignMove = await mcp(
    baseUrl,
    toolCall('move_recipes', { ids: [oatsId, FIXTURE_IDS.owner.shakshuka], collectionId: bakingId }),
    token,
  );
  check(
    "move_recipes changes nothing when an id is another account's recipe",
    foreignMove.status === 200 &&
      toolError(foreignMove.body) === 'not_found' &&
      JSON.stringify(toolResult(foreignMove.body)?.structuredContent?.missingIds) ===
        JSON.stringify([FIXTURE_IDS.owner.shakshuka]),
    toolError(foreignMove.body) ?? `status ${foreignMove.status}`,
  );

  const afterMove = await call(baseUrl, '/api/sync/pull?limit=500', { headers: { Cookie: memberCookie } });
  const collectionRows = (
    (afterMove.body as { changes?: { collections?: { id: string; recipeIds?: string[] }[] } }).changes?.collections ??
    []
  );
  const recipeIdsOf = (id: string) => collectionRows.find((row) => row.id === id)?.recipeIds ?? [];
  const listedIds = collectionRows.flatMap((row) => row.recipeIds ?? []);
  check(
    'Baking holds the moved recipe and the other account stays out',
    afterMove.status === 200 &&
      recipeIdsOf(bakingId).includes(oatsId) &&
      !recipeIdsOf(FIXTURE_IDS.member.weeknights).includes(oatsId) &&
      !listedIds.includes(FIXTURE_IDS.owner.shakshuka),
    `status ${afterMove.status}`,
  );

  const created = await mcp(
    baseUrl,
    toolCall('create_recipe', {
      title: 'Smoke-test lentils',
      servings: 2,
      ingredientSections: [{ items: [{ item: 'red lentils' }] }],
      steps: [{ text: 'Simmer the lentils until soft.' }],
    }),
    token,
  );
  const createdRecipe = toolResult(created.body)?.structuredContent?.recipe as
    | { id?: unknown; title?: unknown; servings?: unknown; version?: unknown; collectionName?: unknown }
    | undefined;
  const createdId = typeof createdRecipe?.id === 'string' ? createdRecipe.id : '';
  check(
    'create_recipe stores a new unfiled recipe',
    created.status === 200 &&
      toolResult(created.body)?.isError !== true &&
      createdRecipe?.title === 'Smoke-test lentils' &&
      createdRecipe.servings === 2 &&
      createdRecipe.collectionName === 'Unfiled' &&
      typeof createdRecipe.version === 'number' &&
      createdId !== '',
    `status ${created.status} ${toolError(created.body) ?? ''}`,
  );

  if (createdId !== '') {
    const pull = await call(baseUrl, '/api/sync/pull?limit=500', { headers: { Cookie: memberCookie } });
    const ids = (
      ((pull.body as { changes?: { recipes?: { id: string }[] } }).changes?.recipes ?? []) as { id: string }[]
    ).map((row) => row.id);
    check('the created recipe is in the member library', pull.status === 200 && ids.includes(createdId), `status ${pull.status}`);

    const version = createdRecipe?.version as number;
    const edited = await mcp(
      baseUrl,
      toolCall('update_recipe', { id: createdId, version, changes: { servings: 3 } }),
      token,
    );
    const editedRecipe = toolResult(edited.body)?.structuredContent?.recipe as { servings?: unknown; version?: unknown } | undefined;
    check(
      'update_recipe applies a matching version',
      edited.status === 200 && editedRecipe?.servings === 3 && editedRecipe.version !== version,
      `status ${edited.status} ${toolError(edited.body) ?? ''}`,
    );

    const conflict = await mcp(
      baseUrl,
      toolCall('update_recipe', { id: createdId, version, changes: { servings: 9 } }),
      token,
    );
    check(
      'update_recipe with a stale version is a conflict',
      conflict.status === 200 &&
        toolError(conflict.body) === 'conflict' &&
        toolResult(conflict.body)?.structuredContent?.currentVersion === editedRecipe?.version,
      toolError(conflict.body) ?? `status ${conflict.status}`,
    );
    const reread = await mcp(baseUrl, toolCall('get_recipes', { ids: [createdId] }), token);
    const stored = ((toolResult(reread.body)?.structuredContent?.recipes ?? []) as { servings?: unknown }[])[0];
    check('the conflict did not write', stored?.servings === 3, `servings ${String(stored?.servings)}`);
  }

  const foreign = await mcp(
    baseUrl,
    toolCall('update_recipe', {
      id: FIXTURE_IDS.owner.shakshuka,
      version: 1,
      changes: { servings: 1 },
    }),
    token,
  );
  check(
    "update_recipe cannot edit another account's recipe",
    foreign.status === 200 && toolError(foreign.body) === 'not_found',
    toolError(foreign.body) ?? `status ${foreign.status}`,
  );

  // A variant of a variant joins the original's group (docs/plans/recipe-variants.md).
  const variant = await mcp(
    baseUrl,
    toolCall('create_recipe', {
      title: 'Smoke-test garlic roast chicken',
      servings: 4,
      ingredientSections: [{ items: [{ item: 'whole chicken' }, { item: 'garlic' }] }],
      steps: [{ text: 'Roast the chicken with the garlic.' }],
      variantOf: FIXTURE_IDS.member.herbRoastChicken,
    }),
    token,
  );
  const variantResult = toolResult(variant.body)?.structuredContent as
    | { recipe?: { id?: unknown }; variantOf?: { id?: unknown } }
    | undefined;
  const variantId = typeof variantResult?.recipe?.id === 'string' ? variantResult.recipe.id : '';
  check(
    'create_recipe saves a variant and names the recipe it was made from',
    variant.status === 200 &&
      toolResult(variant.body)?.isError !== true &&
      variantResult?.variantOf?.id === FIXTURE_IDS.member.herbRoastChicken &&
      variantId !== '',
    `status ${variant.status} ${toolError(variant.body) ?? ''}`,
  );
  if (variantId !== '') {
    const pull = await call(baseUrl, '/api/sync/pull?limit=500', { headers: { Cookie: memberCookie } });
    const row = (
      ((pull.body as { changes?: { recipes?: { id: string; variantOf?: unknown }[] } }).changes?.recipes ?? []) as {
        id: string;
        variantOf?: unknown;
      }[]
    ).find((r) => r.id === variantId);
    check(
      "the variant is stored in the original's group",
      pull.status === 200 && row?.variantOf === FIXTURE_IDS.member.roastChicken,
      `variantOf ${String(row?.variantOf)}`,
    );
  }
  const foreignVariant = await mcp(
    baseUrl,
    toolCall('create_recipe', {
      title: 'Should not save',
      servings: 1,
      ingredientSections: [{ items: [{ item: 'egg' }] }],
      steps: [{ text: 'Boil.' }],
      variantOf: FIXTURE_IDS.owner.shakshuka,
    }),
    token,
  );
  check(
    "create_recipe cannot make a variant of another account's recipe",
    foreignVariant.status === 200 && toolError(foreignVariant.body) === 'not_found',
    toolError(foreignVariant.body) ?? `status ${foreignVariant.status}`,
  );

  const invalid = await mcp(baseUrl, toolCall('get_recipes', { ids: [] }), token);
  check(
    'an invalid tool call is a tool error, not an HTTP error',
    invalid.status === 200 && toolError(invalid.body) === 'invalid',
    `status ${invalid.status} ${toolError(invalid.body) ?? ''}`,
  );
}

async function checkRefreshAndRevoke(
  baseUrl: string,
  tokens: SeededMcpTokens,
  issuer: string,
  memberCookie: string,
  check: Check,
): Promise<void> {
  const wrongResource = await formPost(baseUrl, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
    resource: 'https://evil.example/mcp',
  });
  check(
    'refresh refuses a resource that is not this server',
    wrongResource.status === 400 && oauthError(wrongResource.body) === 'invalid_target',
    oauthError(wrongResource.body),
  );

  const wrongClient = await formPost(baseUrl, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: 'https://not-claude.example/oauth/metadata',
  });
  check(
    'refresh refuses a different client',
    wrongClient.status === 400 && oauthError(wrongClient.body) === 'invalid_grant',
    oauthError(wrongClient.body),
  );

  const refreshed = await formPost(baseUrl, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
    scope: 'recipes:read',
    resource: `${issuer}/mcp`,
  });
  const next = refreshed.body as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  const readToken = typeof next.access_token === 'string' ? next.access_token : '';
  const nextRefresh = typeof next.refresh_token === 'string' ? next.refresh_token : '';
  check(
    'refresh narrows the grant to recipes:read and rotates the refresh token',
    refreshed.status === 200 &&
      next.token_type === 'Bearer' &&
      next.expires_in === 3600 &&
      next.scope === 'recipes:read' &&
      readToken.startsWith('sous_at_') &&
      readToken !== tokens.accessToken &&
      nextRefresh.startsWith('sous_rt_') &&
      nextRefresh !== tokens.refreshToken,
    `status ${refreshed.status} ${oauthError(refreshed.body)}`,
  );

  if (readToken !== '') {
    const denied = await mcp(
      baseUrl,
      toolCall('create_recipe', {
        title: 'Should not save',
        servings: 1,
        ingredientSections: [{ items: [{ item: 'water' }] }],
        steps: [{ text: 'Boil.' }],
      }),
      readToken,
    );
    check(
      'a read-only token cannot create a recipe',
      denied.status === 403 && (denied.headers.get('www-authenticate') ?? '').includes('error="insufficient_scope"'),
      `status ${denied.status}`,
    );
    const stillReads = await mcp(baseUrl, toolCall('search_recipes', { query: 'lemon', limit: 5 }), readToken);
    const stillHits = (toolResult(stillReads.body)?.structuredContent?.hits ?? []) as { id: string }[];
    check(
      'a read-only token can still search',
      stillReads.status === 200 && stillHits.some((hit) => hit.id === FIXTURE_IDS.member.roastChicken),
      `status ${stillReads.status}`,
    );
  }

  const originalStillWorks = await mcp(baseUrl, toolCall('search_recipes', { query: 'lemon', limit: 5 }), tokens.accessToken);
  check(
    'the previous access token still works after a refresh',
    originalStillWorks.status === 200 && toolResult(originalStillWorks.body)?.isError !== true,
    `status ${originalStillWorks.status}`,
  );

  const listed = await call(baseUrl, '/api/mcp/grants', { headers: { Cookie: memberCookie } });
  const grantId = ((listed.body as { grants?: { id: string }[] }).grants ?? [])[0]?.id;
  const revoked = await call(baseUrl, '/api/mcp/grants/revoke', {
    method: 'POST',
    headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: grantId }),
  });
  check(
    'Settings disconnects the connected app',
    listed.status === 200 &&
      grantId !== undefined &&
      revoked.status === 200 &&
      (revoked.body as { revokedId?: unknown }).revokedId === grantId,
    `status ${revoked.status}`,
  );

  for (const [name, access] of [
    ['the old access token', tokens.accessToken],
    ['the narrowed access token', readToken],
  ] as const) {
    if (access === '') continue;
    const refused = await mcp(baseUrl, INITIALIZE, access);
    check(
      `${name} stops working after disconnect`,
      refused.status === 401 && (refused.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'),
      `status ${refused.status}`,
    );
  }

  const gone = await call(baseUrl, '/api/mcp/grants', { headers: { Cookie: memberCookie } });
  check(
    'the member has no connected app after disconnect',
    gone.status === 200 && ((gone.body as { grants?: unknown[] }).grants ?? []).length === 0,
  );

  const revoke = await formPost(baseUrl, '/oauth/revoke', {
    token: nextRefresh === '' ? tokens.refreshToken : nextRefresh,
  });
  check('revoking the refresh token answers 200', revoke.status === 200, `status ${revoke.status}`);
  const again = await formPost(baseUrl, '/oauth/revoke', { token: 'sous_rt_not-a-real-token' });
  check('revoking an unknown token also answers 200', again.status === 200, `status ${again.status}`);
}

/** Discovery, OAuth, and `/mcp` for the seeded member. */
export async function checkMcpEndpoints(baseUrl: string, memberCookie: string, check: Check): Promise<void> {
  const issuer = await checkDiscovery(baseUrl, check);
  if (issuer === undefined) {
    check('MCP checks continued', false, 'no authorization server issuer');
    return;
  }
  await checkUnauthenticated(baseUrl, issuer, memberCookie, check);
  const tokens = await readTokens(baseUrl, check);
  if (tokens === undefined) return;
  await checkTools(baseUrl, tokens.accessToken, memberCookie, check);
  await checkRefreshAndRevoke(baseUrl, tokens, issuer, memberCookie, check);
}
