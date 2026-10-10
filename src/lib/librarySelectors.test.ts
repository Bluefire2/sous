import { afterEach, describe, expect, it } from 'vitest';
import { winningMembership } from './collectionMembership';
import {
  addPendingBlob,
  clearLibrary,
  getSnapshot,
  replaceFromPullWithShared,
  restoreSnapshot,
  upsertCollection,
  upsertCookLog,
} from './libraryMemory';
import * as selectors from './librarySelectors';
import type { Collection, Recipe } from './types';

function recipe(id: string): Recipe {
  return {
    id,
    title: id,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function seed(): void {
  replaceFromPullWithShared(
    {
      recipes: new Map([['r1', recipe('r1')]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map([
        ['r1', { recipeId: 'r1', servings: 2, currentStep: 0, checkedKeys: [], recipeUpdatedAt: 1 }],
      ]),
      cookLogs: new Map([
        ['log-1', { id: 'log-1', recipeId: 'r1', cookedOn: '2026-09-20', createdAt: 1, updatedAt: 1 }],
      ]),
      remotePhotoIds: new Set(),
    },
    {
      recipes: new Map([['s1', recipe('s1')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        ['s1', { kind: 'shared', ownerSub: 'alice', ownerEmail: 'alice@example.test', access: 'editor' }],
      ]),
      collectionOrigins: new Map(),
    },
  );
  addPendingBlob('photo-1', new Blob(['x']));
}

// Ids that hit and miss every selector's map, plus the no-id case.
const IDS = ['r1', 's1', 'log-1', 'photo-1', 'absent', undefined];

afterEach(() => {
  clearLibrary();
});

describe('library selectors', () => {
  const entries = Object.entries(selectors) as [
    string,
    (id: string | undefined) => (snapshot: ReturnType<typeof getSnapshot>) => unknown,
  ][];

  it('exports at least the selectors the hooks use', () => {
    expect(entries.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'selectCookLog',
        'selectCookRow',
        'selectPendingBlob',
        'selectRecipe',
        'selectRecipeAccess',
        'selectRecipeSharedBy',
      ]),
    );
  });

  it.each(entries)('%s returns the same value on every read of one snapshot', (_name, select) => {
    seed();
    const loaded = getSnapshot();
    restoreSnapshot({ ...loaded, loaded: false });
    const unloaded = getSnapshot();
    for (const snapshot of [loaded, unloaded]) {
      for (const id of IDS) {
        const first = select(id)(snapshot);
        expect(Object.is(select(id)(snapshot), first)).toBe(true);
        expect(Object.is(select(id)(snapshot), select(id)(snapshot))).toBe(true);
      }
    }
  });

  it.each(entries)('%s keeps its value across a write to another part of the library', (_name, select) => {
    seed();
    const before = getSnapshot();
    upsertCookLog({ id: 'log-2', recipeId: 's1', cookedOn: '2026-09-21', createdAt: 2, updatedAt: 2 });
    const after = getSnapshot();
    for (const id of IDS) {
      expect(Object.is(select(id)(after), select(id)(before))).toBe(true);
    }
  });

  it('selects what the hooks expect', () => {
    seed();
    const snapshot = getSnapshot();
    expect(selectors.selectRecipe('r1')(snapshot)?.id).toBe('r1');
    expect(selectors.selectRecipe('absent')(snapshot)).toBeNull();
    expect(selectors.selectRecipeAccess('r1')(snapshot)).toBe('owner');
    expect(selectors.selectRecipeAccess('s1')(snapshot)).toBe('editor');
    expect(selectors.selectRecipeSharedBy('s1')(snapshot)).toBe('alice@example.test');
    expect(selectors.selectRecipeSharedBy('r1')(snapshot)).toBeUndefined();
    expect(selectors.selectCookLog('log-1')(snapshot)?.id).toBe('log-1');
    expect(selectors.selectCookRow('r1')(snapshot)?.servings).toBe(2);
    expect(selectors.selectPendingBlob('photo-1')(snapshot)).toBeInstanceOf(Blob);
    expect(selectors.selectRecipeCollectionId('r1')(snapshot)).toBeUndefined();
    restoreSnapshot({ ...snapshot, loaded: false });
    expect(selectors.selectRecipe('r1')(getSnapshot())).toBeUndefined();
    expect(selectors.selectRecipeCollectionId('r1')(getSnapshot())).toBeUndefined();
  });

  it('selectRecipeCollectionId returns the list the recipe is filed in', () => {
    seed();
    const dinners: Collection = {
      id: 'c-b',
      name: 'Dinners',
      recipeIds: ['r1'],
      createdAt: 1,
      updatedAt: 2,
    };
    const lunches: Collection = {
      id: 'c-a',
      name: 'Lunches',
      recipeIds: ['r1', 's1'],
      createdAt: 1,
      updatedAt: 2,
    };
    upsertCollection(dinners);
    upsertCollection(lunches);
    const select = selectors.selectRecipeCollectionId('r1');
    expect(select(getSnapshot())).toBe('c-a');
    expect(selectors.selectRecipeCollectionId('s1')(getSnapshot())).toBe('c-a');
    expect(selectors.selectRecipeCollectionId('absent')(getSnapshot())).toBeUndefined();
    // The same answer the library's own membership gives.
    const membership = winningMembership([...getSnapshot().collections.values()]);
    for (const id of ['r1', 's1', 'absent']) {
      expect(selectors.selectRecipeCollectionId(id)(getSnapshot())).toBe(membership.get(id));
    }
    upsertCookLog({
      id: 'log-2',
      recipeId: 's1',
      cookedOn: '2026-09-21',
      createdAt: 2,
      updatedAt: 2,
    });
    expect(select(getSnapshot())).toBe('c-a');
  });
});
