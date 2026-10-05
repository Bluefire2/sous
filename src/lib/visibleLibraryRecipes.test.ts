import { describe, expect, it } from 'vitest';
import type { Recipe } from './types';
import { visibleLibraryRecipes } from './visibleLibraryRecipes';

const soup: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const cake: Recipe = {
  id: 'r2',
  createdAt: 1,
  updatedAt: 3,
  title: 'Cake',
  servings: 8,
  ingredientSections: [{ items: [{ item: 'flour' }] }],
  steps: [{ text: 'Bake.' }],
  tags: ['dessert'],
};

const stew: Recipe = {
  id: 'r3',
  createdAt: 1,
  updatedAt: 4,
  title: 'Stew',
  servings: 6,
  ingredientSections: [
    { name: 'Dumplings', items: [{ quantity: 200, unit: 'g', item: 'Self-raising flour' }] },
    { items: [{ quantity: 1, unit: 'kg', item: 'Beef chuck', note: 'Cut into cubes' }] },
  ],
  steps: [{ text: 'Simmer.' }],
  tags: [],
};

describe('visibleLibraryRecipes', () => {
  it('is undefined while either list is loading', () => {
    expect(
      visibleLibraryRecipes({
        all: undefined,
        scoped: [soup],
        query: '',
        browseAll: false,
      }),
    ).toBeUndefined();
  });

  it('uses the scoped list until All collections is on', () => {
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: '',
        browseAll: false,
      }),
    ).toEqual([soup]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: '',
        browseAll: true,
      }),
    ).toEqual([soup, cake]);
  });

  it('filters the active source by title or tag', () => {
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: 'cake',
        browseAll: false,
      }),
    ).toEqual([]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup],
        query: 'cake',
        browseAll: true,
      }),
    ).toEqual([cake]);
    expect(
      visibleLibraryRecipes({
        all: [soup, cake],
        scoped: [soup, cake],
        query: 'dessert',
        browseAll: false,
      }),
    ).toEqual([cake]);
  });

  const search = (query: string, recipes: readonly Recipe[] = [soup, cake, stew]) =>
    visibleLibraryRecipes({ all: recipes, scoped: recipes, query, browseAll: false });

  it('matches an ingredient item, ignoring case', () => {
    expect(search('FLOUR')).toEqual([cake, stew]);
    expect(search('chuck')).toEqual([stew]);
  });

  it('matches an ingredient note', () => {
    expect(search('cubes')).toEqual([stew]);
  });

  it('does not match a section name', () => {
    expect(search('dumpling')).toEqual([]);
  });

  it('still returns everything for an empty or blank query', () => {
    expect(search('')).toEqual([soup, cake, stew]);
    expect(search('   ')).toEqual([soup, cake, stew]);
  });

  it('tolerates a recipe with no ingredient sections or items', () => {
    const bare = { ...soup, id: 'r4', ingredientSections: undefined } as unknown as Recipe;
    const empty = { ...soup, id: 'r5', ingredientSections: [{ name: 'Sauce' }] } as unknown as Recipe;
    expect(search('water', [bare, empty, soup])).toEqual([soup]);
    expect(search('soup', [bare, empty])).toEqual([bare, empty]);
  });
});
