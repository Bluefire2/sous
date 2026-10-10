import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentCollection, type AgentRecipe } from './library.ts';
import { recipeTotalMinutes, scoreRecipe, searchRecipes, searchRecipesPage } from './search.ts';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [{ items: [{ item: 'onion' }, { item: 'garlic' }] }],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function library(
  recipes: AgentRecipe[],
  collections: AgentCollection[] = [],
) {
  return buildAgentLibrary(recipes, collections, {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('recipeTotalMinutes', () => {
  it('sums prep and cook when both present', () => {
    expect(recipeTotalMinutes(recipe({ id: 'a', title: 't', prepMinutes: 10, cookMinutes: 20 }))).toEqual({
      totalMinutes: 30,
      timeUnknown: false,
    });
  });

  it('marks unknown when no times', () => {
    expect(recipeTotalMinutes(recipe({ id: 'a', title: 't' }))).toEqual({ timeUnknown: true });
  });
});

describe('scoreRecipe', () => {
  it('weights title above tags and ingredients', () => {
    const r = recipe({
      id: 'a',
      title: 'Chicken soup',
      tags: ['soup'],
      ingredientSections: [{ items: [{ item: 'chicken broth' }] }],
    });
    expect(scoreRecipe(r, 'chicken')).toBeGreaterThanOrEqual(100);
  });
});

describe('searchRecipes', () => {
  const recipes = [
    recipe({
      id: 'a',
      title: 'Alpha pasta',
      tags: ['pasta'],
      prepMinutes: 5,
      cookMinutes: 10,
      description: 'Quick alpha',
    }),
    recipe({
      id: 'b',
      title: 'Beta bake',
      tags: ['bake'],
      cookMinutes: 60,
      ingredientSections: [{ items: [{ item: 'flour' }] }],
    }),
    recipe({
      id: 'c',
      title: 'Gamma',
      tags: ['quick'],
    }),
  ];
  const collections: AgentCollection[] = [
    { id: 'col-a', name: 'Folder A', recipeIds: ['a'] },
    { id: 'col-b', name: 'Folder B', recipeIds: ['b', 'a'] },
  ];
  const lib = library(recipes, collections);

  it('sorts by score then title for non-empty query', () => {
    const hits = searchRecipes(lib, { query: 'alpha', limit: 10 });
    expect(hits[0]?.id).toBe('a');
  });

  it('sorts by title when query is empty', () => {
    const hits = searchRecipes(lib, { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters by maxTotalMinutes but keeps unknown times', () => {
    const hits = searchRecipes(lib, { maxTotalMinutes: 20, limit: 10 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b');
  });

  it('requires all includeIngredients terms', () => {
    const lib2 = library([
      recipe({
        id: 'a',
        title: 'A',
        ingredientSections: [{ items: [{ item: 'onion' }, { item: 'garlic' }] }],
      }),
      recipe({
        id: 'b',
        title: 'B',
        ingredientSections: [{ items: [{ item: 'onion' }] }],
      }),
    ]);
    const hits = searchRecipes(lib2, { includeIngredients: ['onion', 'garlic'], limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('excludes recipes with forbidden ingredients', () => {
    const hits = searchRecipes(lib, { excludeIngredients: ['flour'], limit: 10 });
    expect(hits.find((h) => h.id === 'b')).toBeUndefined();
  });

  it('filters unfiled collection', () => {
    const hits = searchRecipes(lib, { collectionId: 'unfiled', limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['c']);
  });

  it('clamps limit to 20 and defaults to 10', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      recipe({ id: `id-${i}`, title: `Recipe ${i}` }),
    );
    const bigLib = library(many);
    expect(searchRecipes(bigLib, { limit: 100 }).length).toBe(20);
    expect(searchRecipes(bigLib, {}).length).toBe(10);
  });
});

describe('searchRecipesPage', () => {
  const lib = library(
    Array.from({ length: 25 }, (_, i) =>
      recipe({ id: `r${String(i).padStart(2, '0')}`, title: `Dish ${String(i).padStart(2, '0')}` }),
    ),
  );

  it('pages alphabetically with a total, and the agent search is its first page', () => {
    const first = searchRecipesPage(lib, {}, { offset: 0, limit: 10 });
    expect(first.total).toBe(25);
    expect(first.hits.map((h) => h.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Dish ${String(i).padStart(2, '0')}`),
    );
    expect(searchRecipes(lib, { limit: 10 })).toEqual(first.hits);
    const last = searchRecipesPage(lib, {}, { offset: 20, limit: 10 });
    expect(last.hits.map((h) => h.id)).toEqual(['r20', 'r21', 'r22', 'r23', 'r24']);
    expect(searchRecipesPage(lib, {}, { offset: 30, limit: 10 })).toEqual({ hits: [], total: 25 });
  });

  it('clamps the limit to 20 and a bad offset to 0', () => {
    expect(searchRecipesPage(lib, {}, { offset: 0, limit: 100 }).hits).toHaveLength(20);
    expect(searchRecipesPage(lib, {}, { offset: -5, limit: 1 }).hits[0]?.id).toBe('r00');
    expect(searchRecipesPage(lib, {}, { offset: 2.7, limit: 1 }).hits[0]?.id).toBe('r02');
  });

  it('counts only matches in total', () => {
    expect(searchRecipesPage(lib, { query: 'dish 1' }, { limit: 3 }).total).toBe(10);
  });
});
