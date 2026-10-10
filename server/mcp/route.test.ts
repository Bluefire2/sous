import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgentLibrary } from '../agent/sous/library.ts';
import type { McpAuthResult } from './resourceAuth.ts';
import { calledTools, handleMcpPost, resetMcpRateLimitsForTest, rpcMessages, type McpRouteDependencies } from './route.ts';
import type { McpToolContext } from './tools.ts';

const ORIGIN = 'https://sous.example';
const R1 = '11111111-1111-4111-8111-111111111111';

const READER: McpAuthResult = {
  kind: 'ok',
  sub: 'sub-1',
  grantId: 'g1',
  scopes: ['recipes:read'],
  clientHost: 'claude.ai',
};

function toolContext(): McpToolContext {
  return {
    loadLibrary: async () =>
      buildAgentLibrary(
        [
          {
            id: R1,
            title: 'Leek soup',
            servings: 2,
            ingredientSections: [{ items: [{ item: 'leeks' }] }],
            steps: [{ text: 'Simmer.' }],
            tags: [],
            createdAt: 1,
            updatedAt: 5,
          },
        ],
        [],
        { truncated: false, maxIndexEntries: 500, maxIndexChars: 40_000 },
      ),
    readRecipes: vi.fn(async (ids: readonly string[]) => ids.map(() => undefined)),
    readOwnRecipeDoc: vi.fn(async () => undefined),
    createRecipe: vi.fn(async () => true),
    createRecipeInCollection: vi.fn(async () => ({ kind: 'collection_not_found' as const })),
    moveRecipes: vi.fn(async () => ({ kind: 'collection_not_found' as const })),
    collectionSharing: vi.fn(async () => new Map()),
    updateRecipe: vi.fn(async () => ({ kind: 'not_found' as const })),
    newId: () => '33333333-3333-4333-8333-333333333333',
    now: () => 10,
  };
}

function deps(auth: McpAuthResult = READER): McpRouteDependencies {
  return {
    origin: () => ORIGIN,
    now: () => 1_000,
    authenticate: async () => auth,
    toolContext,
  };
}

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: 'Bearer sous_at_x',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

function call(name: string, args: unknown, id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMcpRateLimitsForTest();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
});

function logged(): Record<string, unknown>[] {
  return log.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

describe('the gate', () => {
  it('a request with no token, including initialize, is 401 with the resource metadata challenge', async () => {
    const res = await handleMcpPost(rpc(INITIALIZE), deps({ kind: 'invalid', presented: false }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://sous.example/.well-known/oauth-protected-resource/mcp", scope="recipes:read"',
    );
    expect(logged()[0]).toMatchObject({ event: 'mcp', outcome: 'unauthorized', status: 401 });
  });

  it('a refused token or a removed member is 401 invalid_token', async () => {
    for (const auth of [{ kind: 'invalid', presented: true }, { kind: 'denied' }] as McpAuthResult[]) {
      const res = await handleMcpPost(rpc(INITIALIZE), deps(auth));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
  });

  it('unknown membership is 503, never 401', async () => {
    const res = await handleMcpPost(rpc(INITIALIZE), deps({ kind: 'unknown' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('a write tool with a read-only token is 403 insufficient_scope, before the SDK', async () => {
    const res = await handleMcpPost(rpc(call('create_recipe', { title: 'x' })), deps());
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="recipes:read recipes:write", resource_metadata="https://sous.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(logged()[0]).toMatchObject({ outcome: 'insufficient_scope', tool: 'create_recipe', sub: 'sub-1' });
  });
});

describe('through the SDK', () => {
  it('initializes statelessly with JSON', async () => {
    const res = await handleMcpPost(rpc(INITIALIZE), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as { result: { serverInfo: { name: string }; capabilities: unknown } };
    expect(body.result.serverInfo.name).toBe('sous');
    expect(body.result.capabilities).toMatchObject({ tools: {} });
  });

  it('lists the six tools with schemas and annotations, without server-only fields', async () => {
    const res = await handleMcpPost(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), deps());
    const body = (await res.json()) as { result: { tools: Record<string, unknown>[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'search_recipes',
      'get_recipes',
      'list_collections',
      'create_recipe',
      'update_recipe',
      'move_recipes',
    ]);
    for (const tool of body.result.tools) {
      expect(tool).toHaveProperty('inputSchema');
      expect(tool).toHaveProperty('annotations');
      expect(tool).not.toHaveProperty('scope');
    }
  });

  it('calls a read tool and returns structured content plus the same JSON as text', async () => {
    const res = await handleMcpPost(rpc(call('get_recipes', { ids: [R1] })), deps());
    const body = (await res.json()) as {
      result: { structuredContent: { recipes: { version: number }[] }; content: { text: string }[] };
    };
    expect(body.result.structuredContent.recipes[0]!.version).toBe(5);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual(body.result.structuredContent);
    expect(logged()[0]).toMatchObject({ method: 'tools/call', tool: 'get_recipes', outcome: 'ok', recipes: 1 });
  });

  it('returns a tool failure as isError, not an HTTP error', async () => {
    const res = await handleMcpPost(rpc(call('get_recipes', { ids: [] })), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: { error: string } } };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toBe('invalid');
  });

  it('rate-limits writes per grant as a rate_limited tool error', async () => {
    const writer: McpAuthResult = { ...READER, scopes: ['recipes:read', 'recipes:write'] };
    const update = call('update_recipe', { id: R1, version: 5, changes: { servings: 3 } });
    for (let i = 0; i < 60; i++) {
      await handleMcpPost(rpc(update), deps(writer));
    }
    const res = await handleMcpPost(rpc(update), deps(writer));
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: { error: string } } };
    expect(body.result.structuredContent.error).toBe('rate_limited');
    // Reads have their own bucket.
    const read = await handleMcpPost(rpc(call('list_collections', {})), deps(writer));
    expect(((await read.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it('hides a thrown store error behind a fixed message', async () => {
    const d = deps();
    d.toolContext = () => ({
      ...toolContext(),
      loadLibrary: async () => {
        throw new Error('secret firestore detail');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleMcpPost(rpc(call('search_recipes', {})), d);
    const text = await res.text();
    expect(text).not.toContain('secret firestore detail');
    expect(text).toContain('Sous could not complete that call');
    expect(JSON.stringify(logged())).not.toContain('secret firestore detail');
  });

  it('never logs arguments or recipe text', async () => {
    await handleMcpPost(rpc(call('search_recipes', { query: 'leek secret query' })), deps());
    const line = JSON.stringify(logged());
    expect(line).not.toContain('leek secret query');
    expect(line).not.toContain('Leek soup');
  });

  it('refuses malformed JSON before the SDK', async () => {
    const res = await handleMcpPost(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sous_at_x' },
        body: '{nope',
      }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe('message helpers', () => {
  it('reads single and batched messages and the known tools they call', () => {
    expect(rpcMessages(42)).toBeNull();
    expect(rpcMessages([])).toBeNull();
    const batch = rpcMessages([call('get_recipes', {}), call('create_recipe', {}), call('nope', {})]);
    expect(calledTools(batch!)).toEqual(['get_recipes', 'create_recipe']);
  });
});
