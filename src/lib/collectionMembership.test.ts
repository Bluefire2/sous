import { describe, expect, it } from 'vitest';
import {
  moveRecipe,
  moveRecipes,
  recipeIdsAfterMove,
  recipeCounts,
  recipesInCollection,
  unfiledRecipes,
  winningMembership,
  wouldExceedRecipeIdCap,
} from './collectionMembership';
import { MAX_COLLECTION_RECIPE_IDS } from './compactCollection';
import type { Collection, Recipe } from './types';

const r1: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 1,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: [],
};
const r2: Recipe = { ...r1, id: 'r2', title: 'Stew' };
const r3: Recipe = { ...r1, id: 'r3', title: 'Pie' };

const dinners: Collection = {
  id: 'c-b',
  name: 'Dinners',
  recipeIds: ['r1', 'r2'],
  createdAt: 1,
  updatedAt: 2,
};
const lunches: Collection = {
  id: 'c-a',
  name: 'Lunches',
  recipeIds: ['r1'],
  createdAt: 1,
  updatedAt: 2,
};

describe('winningMembership', () => {
  it('gives a recipe listed twice to the lexicographically smallest collection id', () => {
    const map = winningMembership([dinners, lunches]);
    expect(map.get('r1')).toBe('c-a');
    expect(map.get('r2')).toBe('c-b');
  });
});

describe('unfiledRecipes', () => {
  it('returns recipes not claimed by any live named collection', () => {
    expect(unfiledRecipes([r1, r2, r3], [dinners]).map((r) => r.id)).toEqual(['r3']);
  });
});

describe('recipeCounts', () => {
  it('counts each recipe once, under the collection that wins it', () => {
    const counts = recipeCounts([r1, r2, r3], [dinners, lunches]);
    expect(counts.unfiled).toBe(unfiledRecipes([r1, r2, r3], [dinners, lunches]).length);
    expect(counts.byCollection.get('c-b')).toBe(
      recipesInCollection([r1, r2, r3], dinners, [dinners, lunches]).length,
    );
    expect(counts.byCollection.get('c-a')).toBe(
      recipesInCollection([r1, r2, r3], lunches, [dinners, lunches]).length,
    );
  });
});

describe('recipesInCollection', () => {
  it('skips unknown ids and ids that belong to another collection', () => {
    const all = [dinners, lunches];
    expect(recipesInCollection([r1, r2, r3], dinners, all).map((r) => r.id)).toEqual(
      ['r2'],
    );
    expect(recipesInCollection([r1, r2, r3], lunches, all).map((r) => r.id)).toEqual(
      ['r1'],
    );
  });
  it('preserves library order instead of membership insertion order', () => {
    const newest = { ...r2, updatedAt: 10 };
    expect(recipesInCollection([newest, r1, r3], dinners, [dinners])).toEqual([newest, r1]);
  });
});

describe('moveRecipes', () => {
  it('removes ids from every source and appends them to the destination', () => {
    const desserts: Collection = {
      id: 'c-d',
      name: 'Desserts',
      recipeIds: ['r3'],
      createdAt: 1,
      updatedAt: 2,
    };
    const changed = moveRecipes([dinners, lunches, desserts], ['r1', 'r2'], 'c-d', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
      { ...desserts, recipeIds: ['r3', 'r1', 'r2'], updatedAt: 9 },
    ]);
  });

  it('does not duplicate ids already on the destination', () => {
    const changed = moveRecipes([dinners], ['r2'], 'c-b', 9);
    expect(changed).toEqual([]);
  });

  it('leaves ids already on the destination in place', () => {
    const dest: Collection = { ...dinners, recipeIds: ['r2', 'r1'] };
    const changed = moveRecipes([dest, lunches], ['r2', 'r1'], 'c-b', 9);
    expect(changed.find((c) => c.id === 'c-b')).toBeUndefined();
    expect(changed.find((c) => c.id === 'c-a')?.recipeIds).toEqual([]);
  });

  it('removes a doubly-listed id from the non-destination collection', () => {
    const changed = moveRecipes([dinners, lunches], ['r1'], 'c-b', 9);
    expect(changed.find((c) => c.id === 'c-a')?.recipeIds).toEqual([]);
    expect(changed.find((c) => c.id === 'c-b')).toBeUndefined();
    const applied = [dinners, lunches].map((c) => changed.find((x) => x.id === c.id) ?? c);
    expect(applied.find((c) => c.id === 'c-b')?.recipeIds).toEqual(['r1', 'r2']);
    expect(winningMembership(applied).get('r1')).toBe('c-b');
  });

  it('moving to default only strips named membership', () => {
    const changed = moveRecipes([dinners, lunches], ['r1', 'r2'], 'default', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
    ]);
  });

  it('appends 500 ids to an empty destination without truncating', () => {
    const empty: Collection = { id: 'c-empty', name: 'Empty', recipeIds: [], createdAt: 1, updatedAt: 2 };
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    const changed = moveRecipes([empty], ids, 'c-empty', 9);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.recipeIds).toHaveLength(MAX_COLLECTION_RECIPE_IDS);
    expect(changed[0]?.recipeIds[0]).toBe('recipe-0');
    expect(changed[0]?.recipeIds[MAX_COLLECTION_RECIPE_IDS - 1]).toBe(
      `recipe-${MAX_COLLECTION_RECIPE_IDS - 1}`,
    );
  });

  it('does not silently truncate when more than 500 ids are appended', () => {
    const empty: Collection = { id: 'c-empty', name: 'Empty', recipeIds: [], createdAt: 1, updatedAt: 2 };
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS + 1 }, (_, i) => `recipe-${i}`);
    const changed = moveRecipes([empty], ids, 'c-empty', 9);
    expect(changed[0]?.recipeIds).toHaveLength(MAX_COLLECTION_RECIPE_IDS + 1);
  });
});

describe('moveRecipe', () => {
  it('removes from source and appends to dest', () => {
    const changed = moveRecipe([dinners, lunches], 'r2', 'c-a', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: ['r1'], updatedAt: 9 },
      { ...lunches, recipeIds: ['r1', 'r2'], updatedAt: 9 },
    ]);
  });

  it('moving to default only strips named membership', () => {
    const changed = moveRecipe([dinners], 'r1', 'default', 9);
    expect(changed).toEqual([{ ...dinners, recipeIds: ['r2'], updatedAt: 9 }]);
  });
});

const snacks: Collection = {
  id: 'c-c',
  name: 'Snacks',
  recipeIds: ['r3'],
  createdAt: 1,
  updatedAt: 2,
};

describe('moveRecipes', () => {
  it('lands recipes from different collections in one destination, once per collection', () => {
    const changed = moveRecipes([dinners, lunches, snacks], ['r2', 'r1', 'r2'], 'c-c', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
      { ...snacks, recipeIds: ['r3', 'r2', 'r1'], updatedAt: 9 },
    ]);
  });

  it('keeps an id that is already in the destination where it was', () => {
    const changed = moveRecipes([dinners, snacks], ['r1', 'r3'], 'c-c', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: ['r2'], updatedAt: 9 },
      { ...snacks, recipeIds: ['r3', 'r1'], updatedAt: 9 },
    ]);
  });

  it('moving to default only strips named membership', () => {
    const changed = moveRecipes([dinners, lunches], ['r1', 'r2'], 'default', 9);
    expect(changed).toEqual([
      { ...dinners, recipeIds: [], updatedAt: 9 },
      { ...lunches, recipeIds: [], updatedAt: 9 },
    ]);
  });

  it('returns nothing when every id is already only in the destination', () => {
    expect(moveRecipes([snacks], ['r3'], 'c-c', 9)).toEqual([]);
    expect(moveRecipes([dinners], [], 'c-b', 9)).toEqual([]);
  });
});

describe('recipeIdsAfterMove', () => {
  it('appends only ids the destination does not already hold', () => {
    expect(recipeIdsAfterMove(['r1', 'r2'], ['r2', 'r3', 'r3'])).toEqual(['r1', 'r2', 'r3']);
  });

  it('is the list the cap helper sees, so an id already there does not count as new', () => {
    const full = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    expect(wouldExceedRecipeIdCap(recipeIdsAfterMove(full, [full[0]!]))).toBe(false);
    expect(wouldExceedRecipeIdCap(recipeIdsAfterMove(full, ['extra']))).toBe(true);
  });
});

describe('wouldExceedRecipeIdCap', () => {
  it('allows the limit and rejects an additional recipe', () => {
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    expect(wouldExceedRecipeIdCap(ids)).toBe(false);
    expect(wouldExceedRecipeIdCap([...ids, 'extra'])).toBe(true);
  });
});
