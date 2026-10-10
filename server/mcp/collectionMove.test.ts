import { describe, expect, it } from 'vitest';
import { MAX_COLLECTION_RECIPE_IDS } from '../store.ts';
import { planCollectionMove, runCollectionWrite, UNFILED, type CollectionTxPort } from './collectionMove.ts';

// Lexical order matters: the smallest id wins when two lists hold a recipe.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = 1_000;

function collection(id: string, recipeIds: string[], extra: Record<string, unknown> = {}) {
  return { id, name: `Name ${id.slice(0, 1)}`, recipeIds, createdAt: 1, updatedAt: 500, serverUpdatedAt: 500, ...extra };
}

describe('planCollectionMove', () => {
  it('appends to the destination and removes from every other collection', () => {
    const plan = planCollectionMove([collection(A, ['r1', 'r2']), collection(B, ['r0'])], ['r1'], B, NOW);
    expect(plan).toMatchObject({ kind: 'ok', moved: ['r1'], alreadyThere: [], collectionName: 'Name b' });
    if (plan.kind !== 'ok') return;
    expect(plan.writes.map((w) => [w.id, w.doc.recipeIds])).toEqual([
      [A, ['r2']],
      [B, ['r0', 'r1']],
    ]);
  });

  it('stamps each write above its stored time and keeps its other fields', () => {
    const plan = planCollectionMove(
      [collection(A, ['r1'], { updatedAt: 5_000, extra: 'kept' }), collection(B, [])],
      ['r1'],
      B,
      NOW,
    );
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    const [fromA, toB] = plan.writes;
    // A device clock ahead of the server: one past the stored time still wins.
    expect(fromA!.doc).toMatchObject({ updatedAt: 5_001, serverUpdatedAt: NOW, extra: 'kept', name: 'Name a', createdAt: 1 });
    expect(toB!.doc).toMatchObject({ updatedAt: NOW, serverUpdatedAt: NOW });
  });

  it('keeps an id the destination already lists in place, and writes nothing when all are there', () => {
    const plan = planCollectionMove([collection(A, ['r1', 'r2'])], ['r2', 'r1'], A, NOW);
    expect(plan).toMatchObject({ kind: 'ok', writes: [], moved: [], alreadyThere: ['r2', 'r1'] });
  });

  it('moves a recipe listed twice out of the list that won, and out of the other too', () => {
    // r1 shows under A (smallest id); moving it to C changes its collection.
    const plan = planCollectionMove([collection(B, ['r1']), collection(A, ['r1']), collection(C, [])], ['r1'], C, NOW);
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    expect(plan.moved).toEqual(['r1']);
    expect(plan.writes.map((w) => [w.id, w.doc.recipeIds])).toEqual([
      [B, []],
      [A, []],
      [C, ['r1']],
    ]);
    // Moving to B, which already lists it but lost to A, still counts as a move.
    const toB = planCollectionMove([collection(B, ['r1']), collection(A, ['r1'])], ['r1'], B, NOW);
    expect(toB).toMatchObject({ kind: 'ok', moved: ['r1'], alreadyThere: [] });
    if (toB.kind === 'ok') expect(toB.writes.map((w) => w.id)).toEqual([A]);
  });

  it('only removes when the destination is Unfiled', () => {
    const plan = planCollectionMove([collection(A, ['r1']), collection(B, ['r2'])], ['r1', 'r3', 'r1'], UNFILED, NOW);
    expect(plan).toMatchObject({ kind: 'ok', moved: ['r1'], alreadyThere: ['r3'] });
    if (plan.kind !== 'ok') return;
    expect(plan.writes.map((w) => [w.id, w.doc.recipeIds])).toEqual([[A, []]]);
    expect(plan).not.toHaveProperty('collectionName');
  });

  it('never writes a deleted collection, and refuses one as the destination', () => {
    const deleted = collection(A, ['r1'], { deletedAt: 400 });
    expect(planCollectionMove([deleted, collection(B, [])], ['r1'], A, NOW)).toEqual({ kind: 'collection_not_found' });
    const plan = planCollectionMove([deleted, collection(B, [])], ['r1'], B, NOW);
    if (plan.kind !== 'ok') throw new Error(plan.kind);
    expect(plan.writes.map((w) => w.id)).toEqual([B]);
    expect(planCollectionMove([], ['r1'], C, NOW)).toEqual({ kind: 'collection_not_found' });
  });

  it('refuses a move that would pass the recipe cap', () => {
    const full = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `r${i}`);
    expect(planCollectionMove([collection(A, full)], ['new'], A, NOW)).toEqual({
      kind: 'collection_full',
      max: MAX_COLLECTION_RECIPE_IDS,
    });
    // Already listed ids do not count against the cap.
    expect(planCollectionMove([collection(A, full)], ['r0'], A, NOW)).toMatchObject({ kind: 'ok', writes: [] });
  });
});

/** A recording port: reads and writes in call order, and a read after any write throws, as Firestore does. */
function fakePort(state: {
  recipes?: Record<string, Record<string, unknown>>;
  collections?: ReturnType<typeof collection>[];
  publicIds?: string[];
  grants?: Record<string, number>;
  joinLinks?: string[];
}): CollectionTxPort & { calls: string[] } {
  const calls: string[] = [];
  let wrote = false;
  const read = (name: string) => {
    if (wrote) throw new Error(`read ${name} after a write`);
    calls.push(name);
  };
  return {
    calls,
    async readRecipes(ids) {
      read('readRecipes');
      return ids.map((id) => state.recipes?.[id]);
    },
    async readCollections() {
      read('readCollections');
      return state.collections ?? [];
    },
    async readSharing(id) {
      read(`readSharing ${id}`);
      return {
        public: (state.publicIds ?? []).includes(id),
        members: state.grants?.[id] ?? 0,
        joinLinkOpen: (state.joinLinks ?? []).includes(id),
      };
    },
    createRecipe(id) {
      wrote = true;
      calls.push(`createRecipe ${id}`);
    },
    setCollection(id) {
      wrote = true;
      calls.push(`setCollection ${id}`);
    },
  };
}

describe('runCollectionWrite', () => {
  const live = { title: 'Soup', updatedAt: 1 };

  it('reads everything, including who can see the destination and each collection left, then writes', async () => {
    const port = fakePort({
      recipes: { r1: live },
      collections: [collection(A, ['r1']), collection(B, [])],
      grants: { [A]: 3, [B]: 2 },
      joinLinks: [B],
    });
    const out = await runCollectionWrite(port, { moveIds: ['r1'], dest: B, serverNow: NOW });
    expect(out).toEqual({
      kind: 'ok',
      moved: ['r1'],
      alreadyThere: [],
      collectionName: 'Name b',
      sharedWithMembers: 2,
      joinLinkOpen: true,
      leftCollections: [{ id: A, name: 'Name a', public: false, members: 3, joinLinkOpen: false }],
    });
    expect(port.calls).toEqual([
      'readRecipes',
      'readCollections',
      `readSharing ${B}`,
      `readSharing ${A}`,
      `setCollection ${A}`,
      `setCollection ${B}`,
    ]);
  });

  it('writes nothing for a public destination, a deleted recipe, or a missing collection', async () => {
    const pub = fakePort({ recipes: { r1: live }, collections: [collection(A, ['r1']), collection(B, [])], publicIds: [B] });
    expect(await runCollectionWrite(pub, { moveIds: ['r1'], dest: B, serverNow: NOW })).toEqual({ kind: 'public_collection' });
    expect(pub.calls.filter((c) => c.startsWith('set') || c.startsWith('create'))).toEqual([]);

    const gone = fakePort({ recipes: { r1: { ...live, deletedAt: 5 } }, collections: [collection(B, [])] });
    expect(await runCollectionWrite(gone, { moveIds: ['r1', 'r2'], dest: B, serverNow: NOW })).toEqual({
      kind: 'recipes_not_found',
      missingIds: ['r1', 'r2'],
    });
    expect(gone.calls).toEqual(['readRecipes']);

    const missing = fakePort({ recipes: { r1: live }, collections: [] });
    expect(await runCollectionWrite(missing, { moveIds: ['r1'], dest: C, serverNow: NOW })).toEqual({
      kind: 'collection_not_found',
    });
  });

  it('reads only the collections left when moving to Unfiled, and reports them', async () => {
    const port = fakePort({ recipes: { r1: live }, collections: [collection(A, ['r1'])], publicIds: [A] });
    const out = await runCollectionWrite(port, { moveIds: ['r1'], dest: UNFILED, serverNow: NOW });
    expect(out).toMatchObject({
      kind: 'ok',
      sharedWithMembers: 0,
      joinLinkOpen: false,
      leftCollections: [{ id: A, public: true }],
    });
    expect(port.calls).toEqual(['readRecipes', 'readCollections', `readSharing ${A}`, `setCollection ${A}`]);
  });

  it('creates the new recipe with its own version and the server time, then files it', async () => {
    const created: Record<string, unknown>[] = [];
    const port = fakePort({ collections: [collection(A, [])] });
    port.createRecipe = (id, doc) => {
      port.calls.push(`createRecipe ${id}`);
      created.push(doc);
    };
    const payload = { id: 'new', title: 'Egg', servings: 1, ingredientSections: [], steps: [], tags: [], createdAt: 400, updatedAt: 400 };
    const out = await runCollectionWrite(port, { moveIds: [], create: { id: 'new', payload }, dest: A, serverNow: NOW });
    expect(out).toMatchObject({ kind: 'ok', moved: ['new'] });
    expect(port.calls.slice(-2)).toEqual(['createRecipe new', `setCollection ${A}`]);
    expect(created[0]).toMatchObject({ id: 'new', updatedAt: 400, serverUpdatedAt: NOW });
  });
});
