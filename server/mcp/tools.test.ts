import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentCollection, type AgentRecipe } from '../agent/sous/library.ts';
import { ownRecipeUpdateDecision, recipeDocBody, type OwnRecipeUpdateResult } from '../store.ts';
import { runCollectionWrite, UNFILED, type CollectionSharing, type CollectionTxPort } from './collectionMove.ts';
import { SCOPE_READ, SCOPE_WRITE } from './config.ts';
import {
  callToolResult,
  MCP_TOOLS,
  mcpToolByName,
  toolListing,
  UNTRUSTED_TEXT_NOTICE,
  type McpToolContext,
  type McpToolOutcome,
} from './tools.ts';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const PHOTO = '44444444-4444-4444-8444-444444444444';
const SOUPS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLIC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [{ items: [{ item: 'leeks' }] }],
    steps: [{ text: 'Cook.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

/**
 * A fake store over plain docs, so the update path runs the real decision and
 * merge, and collection writes run the real `runCollectionWrite` over an
 * in-memory port.
 */
function fakeContext(
  recipes: AgentRecipe[],
  collections: AgentCollection[] = [],
  opts: { loadCap?: number; publicIds?: string[]; sharedWith?: Record<string, number>; joinLinks?: string[] } = {},
): McpToolContext & {
  docs: Map<string, Record<string, unknown>>;
  collectionDocs: Map<string, Record<string, unknown> & { id: string }>;
  created: string[];
  directReads: string[][];
} {
  const docs = new Map<string, Record<string, unknown>>(recipes.map((r) => [r.id, { ...r }]));
  const collectionDocs = new Map<string, Record<string, unknown> & { id: string }>(
    collections.map((c) => [c.id, { ...c, createdAt: 1, updatedAt: 1 }]),
  );
  const created: string[] = [];
  const directReads: string[][] = [];
  const sharingOf = (id: string): CollectionSharing => ({
    public: (opts.publicIds ?? []).includes(id),
    members: opts.sharedWith?.[id] ?? 0,
    joinLinkOpen: (opts.joinLinks ?? []).includes(id),
  });
  const port: CollectionTxPort = {
    async readRecipes(ids) {
      return ids.map((id) => docs.get(id));
    },
    async readCollections() {
      return [...collectionDocs.values()];
    },
    async readSharing(id) {
      return sharingOf(id);
    },
    createRecipe(id, doc) {
      docs.set(id, doc);
      created.push(id);
    },
    setCollection(id, doc) {
      collectionDocs.set(id, { ...doc, id });
    },
  };
  const loaded = opts.loadCap === undefined ? recipes : recipes.slice(0, opts.loadCap);
  return {
    docs,
    collectionDocs,
    created,
    directReads,
    async loadLibrary() {
      return buildAgentLibrary(loaded, collections, {
        truncated: loaded.length < recipes.length,
        maxIndexEntries: 500,
        maxIndexChars: 40_000,
      });
    },
    async readRecipes(ids) {
      directReads.push([...ids]);
      return ids.map((id) => recipes.find((r) => r.id === id));
    },
    async readOwnRecipeDoc(id) {
      const doc = docs.get(id);
      return doc === undefined ? undefined : { ...doc, id };
    },
    async createRecipe(id, payload) {
      docs.set(id, payload);
      created.push(id);
      return true;
    },
    createRecipeInCollection: (id, payload, dest) =>
      runCollectionWrite(port, { moveIds: [], create: { id, payload }, dest, serverNow: 400 }),
    moveRecipes: (ids, dest) => runCollectionWrite(port, { moveIds: ids, dest, serverNow: 400 }),
    async collectionSharing(ids) {
      return new Map(ids.map((id) => [id, sharingOf(id)]));
    },
    async updateRecipe(id, expectedVersion, apply): Promise<OwnRecipeUpdateResult> {
      const decision = ownRecipeUpdateDecision(docs.get(id), expectedVersion);
      if (decision.kind !== 'ok') return decision;
      const payload = apply(decision.stored, 500);
      if (payload === null) return { kind: 'too_large' };
      const doc = recipeDocBody(payload, id, 500, 501);
      docs.set(id, doc);
      return { kind: 'ok', doc };
    },
    newId: () => NEW_ID,
    now: () => 400,
  };
}

async function run(name: string, args: unknown, ctx: McpToolContext): Promise<McpToolOutcome> {
  const tool = mcpToolByName(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
}

describe('tool specs', () => {
  it('are the six tools, with scopes, annotations and the untrusted-text notice', () => {
    expect(MCP_TOOLS.map((t) => [t.name, t.scope, t.annotations.readOnlyHint])).toEqual([
      ['search_recipes', SCOPE_READ, true],
      ['get_recipes', SCOPE_READ, true],
      ['list_collections', SCOPE_READ, true],
      ['create_recipe', SCOPE_WRITE, false],
      ['update_recipe', SCOPE_WRITE, false],
      ['move_recipes', SCOPE_WRITE, false],
    ]);
    for (const tool of MCP_TOOLS) {
      expect(tool.description).toContain(UNTRUSTED_TEXT_NOTICE);
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool.annotations.destructiveHint ?? false).toBe(false);
      expect(tool.inputSchema.type).toBe('object');
      expect(toolListing(tool)).not.toHaveProperty('scope');
    }
  });
});

describe('search_recipes', () => {
  const recipes = Array.from({ length: 12 }, (_, i) =>
    recipe({ id: `r${String(i).padStart(2, '0')}`, title: `Dish ${String(i).padStart(2, '0')}` }),
  );

  it('pages with total and nextOffset', async () => {
    const ctx = fakeContext(recipes);
    const first = await run('search_recipes', { limit: 5 }, ctx);
    expect(first.ok && first.data.total).toBe(12);
    expect(first.ok && first.data.nextOffset).toBe(5);
    const last = await run('search_recipes', { limit: 5, offset: 10 }, ctx);
    expect(last.ok && (last.data.hits as unknown[]).length).toBe(2);
    expect(last.ok && 'nextOffset' in last.data).toBe(false);
  });

  it('rejects bad arguments with paths', async () => {
    const out = await run('search_recipes', { limit: 50, offset: -1, tags: 'soup', mood: 'x' }, fakeContext(recipes));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('invalid');
    expect((out.data?.errors as { path: string }[]).map((e) => e.path)).toEqual(['mood', 'tags', 'limit', 'offset']);
  });
});

describe('get_recipes', () => {
  it('returns version and missingIds, and never photo ids or createdAt', async () => {
    const ctx = fakeContext(
      [recipe({ id: R1, title: 'Soup', updatedAt: 77, photoId: PHOTO, galleryPhotoIds: [PHOTO] })],
      [{ id: 'c1', name: 'Weeknight', recipeIds: [R1] }],
    );
    const out = await run('get_recipes', { ids: [R1, R2] }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.missingIds).toEqual([R2]);
    const [got] = out.data.recipes as Record<string, unknown>[];
    expect(got).toMatchObject({ id: R1, version: 77, title: 'Soup', collectionName: 'Weeknight' });
    for (const key of ['photoId', 'galleryPhotoIds', 'createdAt', 'updatedAt', 'importCheck', 'lang', 'variantOf']) {
      expect(got).not.toHaveProperty(key);
    }
    expect(ctx.directReads).toEqual([]);
  });

  it('reads ids a capped library left out directly, in the order asked', async () => {
    const R3 = '55555555-5555-4555-8555-555555555555';
    const ctx = fakeContext([recipe({ id: R1, title: 'Loaded' }), recipe({ id: R2, title: 'Past the cap' })], [], {
      loadCap: 1,
    });
    const out = await run('get_recipes', { ids: [R2, R1, R3] }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.data.recipes as { title: string }[]).map((r) => r.title)).toEqual(['Past the cap', 'Loaded']);
    expect(out.data.missingIds).toEqual([R3]);
    expect(ctx.directReads).toEqual([[R2, R3]]);
  });

  it('rejects zero or more than eight ids', async () => {
    const ctx = fakeContext([]);
    expect((await run('get_recipes', { ids: [] }, ctx)).ok).toBe(false);
    expect((await run('get_recipes', { ids: Array(9).fill(R1) }, ctx)).ok).toBe(false);
    expect((await run('get_recipes', {}, ctx)).ok).toBe(false);
  });
});

describe('list_collections', () => {
  it('counts each recipe once and adds Unfiled', async () => {
    const ctx = fakeContext(
      [recipe({ id: R1, title: 'A' }), recipe({ id: R2, title: 'B' })],
      [{ id: 'c1', name: 'Soups', recipeIds: [R1] }],
    );
    const out = await run('list_collections', {}, ctx);
    expect(out.ok && out.data.collections).toEqual([
      { id: 'c1', name: 'Soups', recipeCount: 1 },
      { id: 'unfiled', name: 'Unfiled', recipeCount: 1 },
    ]);
  });

  it('marks public, member-shared and join-link collections', async () => {
    const ctx = fakeContext(
      [],
      [
        { id: SOUPS, name: 'Soups', recipeIds: [] },
        { id: PUBLIC, name: 'For everyone', recipeIds: [] },
      ],
      { publicIds: [PUBLIC], sharedWith: { [SOUPS]: 3 }, joinLinks: [SOUPS] },
    );
    const out = await run('list_collections', {}, ctx);
    expect(out.ok && out.data.collections).toEqual([
      { id: SOUPS, name: 'Soups', recipeCount: 0, sharedWithMembers: 3, joinLinkOpen: true },
      { id: PUBLIC, name: 'For everyone', recipeCount: 0, public: true },
      { id: 'unfiled', name: 'Unfiled', recipeCount: 0 },
    ]);
  });
});

describe('create_recipe', () => {
  it('assigns the id and time, stores Unfiled, and returns the version', async () => {
    const ctx = fakeContext([]);
    const out = await run(
      'create_recipe',
      { title: 'MCP test', servings: 2, ingredientSections: [{ items: [{ item: 'egg' }] }], steps: [{ text: 'Boil.' }] },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(ctx.created).toEqual([NEW_ID]);
    expect(ctx.docs.get(NEW_ID)).toMatchObject({ id: NEW_ID, createdAt: 400, updatedAt: 400 });
    expect(out.data.recipe).toMatchObject({ id: NEW_ID, version: 400, collectionName: 'Unfiled' });
  });

  it('rejects an invalid recipe without writing', async () => {
    const ctx = fakeContext([]);
    const out = await run('create_recipe', { title: 'x', servings: 0, ingredientSections: [], steps: [] }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctx.created).toEqual([]);
  });

  const EGG = { title: 'Egg', servings: 1, ingredientSections: [{ items: [{ item: 'egg' }] }], steps: [{ text: 'Boil.' }] };

  it('files the new recipe into a collection and says who else sees it', async () => {
    const ctx = fakeContext([], [{ id: SOUPS, name: 'Soups', recipeIds: [R1] }], { sharedWith: { [SOUPS]: 2 } });
    const out = await run('create_recipe', { ...EGG, collectionId: SOUPS }, ctx);
    expect(out).toMatchObject({ ok: true, data: { recipe: { id: NEW_ID, collectionName: 'Soups' }, sharedWithMembers: 2 } });
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([R1, NEW_ID]);
    expect(ctx.created).toEqual([NEW_ID]);
  });

  it('flags an open join link on the destination even with no members yet', async () => {
    const ctx = fakeContext([], [{ id: SOUPS, name: 'Soups', recipeIds: [] }], { joinLinks: [SOUPS] });
    const out = await run('create_recipe', { ...EGG, collectionId: SOUPS }, ctx);
    expect(out).toMatchObject({ ok: true, data: { joinLinkOpen: true } });
    expect(out.ok && out.data).not.toHaveProperty('sharedWithMembers');
  });

  describe('variantOf', () => {
    const ORIGINAL = '55555555-5555-4555-8555-555555555555';

    it('saves a variant of a recipe and says which one', async () => {
      const ctx = fakeContext([recipe({ id: R1, title: 'Carrot stew' })]);
      const out = await run('create_recipe', { ...EGG, title: 'Potato stew', variantOf: R1 }, ctx);
      expect(out).toMatchObject({
        ok: true,
        data: { recipe: { id: NEW_ID, title: 'Potato stew' }, variantOf: { id: R1, title: 'Carrot stew' } },
      });
      expect(ctx.docs.get(NEW_ID)).toMatchObject({ variantOf: R1 });
      // The original is left as it was.
      expect(ctx.docs.get(R1)).not.toHaveProperty('variantOf');
    });

    it("joins a variant's group instead of nesting under it", async () => {
      const ctx = fakeContext([recipe({ id: R1, title: 'Spicy stew' })]);
      ctx.docs.set(R1, { ...ctx.docs.get(R1), variantOf: ORIGINAL });
      const out = await run('create_recipe', { ...EGG, variantOf: R1 }, ctx);
      expect(out).toMatchObject({ ok: true, data: { variantOf: { id: R1 } } });
      expect(ctx.docs.get(NEW_ID)).toMatchObject({ variantOf: ORIGINAL });
    });

    it("takes the original's language unless lang is given", async () => {
      const ctx = fakeContext([recipe({ id: R1, title: 'Борщ' })]);
      ctx.docs.set(R1, { ...ctx.docs.get(R1), lang: 'uk' });
      await run('create_recipe', { ...EGG, variantOf: R1 }, ctx);
      expect(ctx.docs.get(NEW_ID)).toMatchObject({ lang: 'uk' });
      await run('create_recipe', { ...EGG, variantOf: R1, lang: 'en' }, ctx);
      expect(ctx.docs.get(NEW_ID)).toMatchObject({ lang: 'en' });
    });

    it('files a variant into a collection', async () => {
      const ctx = fakeContext([recipe({ id: R1, title: 'Carrot stew' })], [{ id: SOUPS, name: 'Soups', recipeIds: [R1] }]);
      const out = await run('create_recipe', { ...EGG, variantOf: R1, collectionId: SOUPS }, ctx);
      expect(out).toMatchObject({ ok: true, data: { recipe: { collectionName: 'Soups' }, variantOf: { id: R1 } } });
      expect(ctx.docs.get(NEW_ID)).toMatchObject({ variantOf: R1 });
    });

    it('refuses a deleted recipe, one not in this library, and a malformed id, without writing', async () => {
      const ctx = fakeContext([recipe({ id: R1, title: 'Carrot stew' })]);
      const DELETED = '66666666-6666-4666-8666-666666666666';
      ctx.docs.set(DELETED, { id: DELETED, title: 'Old stew', deletedAt: 300, updatedAt: 300 });
      for (const variantOf of [DELETED, R2, 'not-an-id', '../users/other/recipes/x']) {
        const out = await run('create_recipe', { ...EGG, variantOf }, ctx);
        expect(out).toMatchObject({ ok: false, code: 'not_found' });
      }
      const bad = await run('create_recipe', { ...EGG, variantOf: 7 }, ctx);
      expect(bad).toMatchObject({ ok: false, code: 'invalid' });
      expect(ctx.created).toEqual([]);
    });

    it('stores no variantOf on an ordinary create', async () => {
      const ctx = fakeContext([]);
      await run('create_recipe', EGG, ctx);
      expect(ctx.docs.get(NEW_ID)).not.toHaveProperty('variantOf');
    });
  });

  it('treats "unfiled" as no collection', async () => {
    const ctx = fakeContext([], [{ id: SOUPS, name: 'Soups', recipeIds: [] }]);
    const out = await run('create_recipe', { ...EGG, collectionId: 'unfiled' }, ctx);
    expect(out).toMatchObject({ ok: true, data: { recipe: { collectionName: 'Unfiled' } } });
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([]);
  });

  it('writes nothing for a public, unknown, or malformed collection', async () => {
    const ctx = fakeContext([], [{ id: PUBLIC, name: 'For everyone', recipeIds: [] }], { publicIds: [PUBLIC] });
    expect(await run('create_recipe', { ...EGG, collectionId: PUBLIC }, ctx)).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await run('create_recipe', { ...EGG, collectionId: SOUPS }, ctx)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await run('create_recipe', { ...EGG, collectionId: 'Soups' }, ctx)).toMatchObject({ ok: false, code: 'not_found' });
    const blank = await run('create_recipe', { ...EGG, collectionId: ' ' }, ctx);
    expect(blank).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctx.created).toEqual([]);
  });
});

describe('move_recipes', () => {
  const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const library = () =>
    fakeContext(
      [recipe({ id: R1, title: 'Soup' }), recipe({ id: R2, title: 'Stew' })],
      [
        { id: SOUPS, name: 'Soups', recipeIds: [R1] },
        { id: OTHER, name: 'Other', recipeIds: [] },
        { id: PUBLIC, name: 'For everyone', recipeIds: [R2] },
      ],
      { publicIds: [PUBLIC] },
    );

  it('moves recipes, taking them out of their old collection, and reports what was already there', async () => {
    const ctx = library();
    const out = await run('move_recipes', { ids: [R1, R2], collectionId: OTHER }, ctx);
    expect(out).toMatchObject({ ok: true, data: { collection: { id: OTHER, name: 'Other' }, movedIds: [R1, R2] } });
    expect(ctx.collectionDocs.get(OTHER)?.recipeIds).toEqual([R1, R2]);
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([]);
    // Moving out of a public collection is allowed.
    expect(ctx.collectionDocs.get(PUBLIC)?.recipeIds).toEqual([]);
    const again = await run('move_recipes', { ids: [R1], collectionId: OTHER }, ctx);
    expect(again).toMatchObject({ ok: true, data: { movedIds: [], alreadyThereIds: [R1] } });
  });

  it('unfiles with "unfiled" and says which collection the recipe left', async () => {
    const ctx = library();
    const out = await run('move_recipes', { ids: [R1], collectionId: 'unfiled' }, ctx);
    expect(out).toMatchObject({
      ok: true,
      data: { collection: { id: UNFILED, name: 'Unfiled' }, movedIds: [R1], removedFrom: [{ id: SOUPS, name: 'Soups' }] },
    });
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([]);
  });

  it('reports who loses the recipes when they leave a shared collection', async () => {
    const ctx = fakeContext(
      [recipe({ id: R1, title: 'Soup' }), recipe({ id: R2, title: 'Stew' })],
      [
        { id: SOUPS, name: 'Soups', recipeIds: [R1] },
        { id: PUBLIC, name: 'For everyone', recipeIds: [R2] },
      ],
      { publicIds: [PUBLIC], sharedWith: { [SOUPS]: 3 }, joinLinks: [PUBLIC] },
    );
    const out = await run('move_recipes', { ids: [R1, R2], collectionId: 'unfiled' }, ctx);
    expect(out.ok && out.data.removedFrom).toEqual([
      { id: SOUPS, name: 'Soups', sharedWithMembers: 3 },
      { id: PUBLIC, name: 'For everyone', public: true, joinLinkOpen: true },
    ]);
  });

  it('refuses a public destination and changes nothing', async () => {
    const ctx = library();
    const out = await run('move_recipes', { ids: [R1], collectionId: PUBLIC }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([R1]);
  });

  it('moves nothing when any id is not an own live recipe', async () => {
    const ctx = library();
    const out = await run('move_recipes', { ids: [R1, NEW_ID], collectionId: OTHER }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'not_found', data: { missingIds: [NEW_ID] } });
    expect(await run('move_recipes', { ids: [R1, 'not-an-id'], collectionId: OTHER }, ctx)).toMatchObject({
      ok: false,
      code: 'not_found',
      data: { missingIds: ['not-an-id'] },
    });
    expect(ctx.collectionDocs.get(SOUPS)?.recipeIds).toEqual([R1]);
    expect(ctx.collectionDocs.get(OTHER)?.recipeIds).toEqual([]);
  });

  it('is not_found for an unknown collection and invalid for bad arguments', async () => {
    const ctx = library();
    expect(await run('move_recipes', { ids: [R1], collectionId: NEW_ID }, ctx)).toMatchObject({ ok: false, code: 'not_found' });
    for (const args of [{ ids: [], collectionId: OTHER }, { ids: [R1] }, { ids: Array(21).fill(R1), collectionId: OTHER }, { ids: [R1], collectionId: OTHER, x: 1 }]) {
      expect(await run('move_recipes', args, ctx)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });
});

describe('update_recipe', () => {
  const stored = recipe({ id: R1, title: 'Lasagne', updatedAt: 10, photoId: PHOTO, notes: 'Rest it.' });

  it('patches with the matching version and returns the new version', async () => {
    const ctx = fakeContext([stored]);
    const out = await run('update_recipe', { id: R1, version: 10, changes: { servings: 6, notes: null } }, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.recipe).toMatchObject({ id: R1, version: 500, servings: 6, title: 'Lasagne' });
    expect(out.data.recipe).not.toHaveProperty('notes');
    expect(ctx.docs.get(R1)).toMatchObject({ photoId: PHOTO, createdAt: 1 });
  });

  it('is conflict with the current version when the version is stale', async () => {
    const out = await run('update_recipe', { id: R1, version: 9, changes: { servings: 6 } }, fakeContext([stored]));
    expect(out).toMatchObject({ ok: false, code: 'conflict', data: { currentVersion: 10 } });
    if (out.ok) return;
    expect(out.message).toContain('get_recipes');
  });

  it('is not_found for a missing, tombstoned, or non-id recipe', async () => {
    const ctx = fakeContext([stored]);
    ctx.docs.set(R2, { ...stored, id: R2, deletedAt: 20 });
    for (const id of [R2, NEW_ID, 'shared-or-bogus']) {
      expect(await run('update_recipe', { id, version: 10, changes: { servings: 6 } }, ctx)).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    }
  });

  it('rejects invalid changes before touching the store', async () => {
    const ctx = fakeContext([stored]);
    const out = await run('update_recipe', { id: R1, version: 10, changes: { title: null } }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(ctx.docs.get(R1)).toMatchObject({ updatedAt: 10 });
  });
});

describe('callToolResult', () => {
  it('returns structured content and the same JSON as text', () => {
    const result = callToolResult({ ok: true, data: { hits: [], total: 0 } });
    expect(result.structuredContent).toEqual({ hits: [], total: 0 });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result).not.toHaveProperty('isError');
  });

  it('marks failures isError with a stable code', () => {
    const result = callToolResult({ ok: false, code: 'conflict', message: 'm', data: { currentVersion: 3 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'conflict', message: 'm', currentVersion: 3 });
  });
});
