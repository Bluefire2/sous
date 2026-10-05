import { describe, expect, it } from 'vitest';
import type { ItemOrigin } from './libraryMemory';
import {
  DEFAULT_LIBRARY_SORT,
  LIBRARY_SORTS,
  isLibrarySort,
  lastCookedByRecipe,
  sortLibraryRecipes,
} from './librarySort';
import type { CookLog, Recipe } from './types';

function recipe(id: string, title: string, createdAt: number, updatedAt: number): Recipe {
  return {
    id,
    title,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt,
    updatedAt,
  };
}

function log(id: string, recipeId: string, cookedOn: string): CookLog {
  return { id, recipeId, cookedOn, createdAt: 1, updatedAt: 1 };
}

const ids = (recipes: readonly Recipe[]) => recipes.map((r) => r.id);

const soup = recipe('a', 'Soup', 10, 40);
const bread = recipe('b', 'bread', 30, 20);
const apple = recipe('c', 'Äpfelkuchen', 20, 30);
const cake = recipe('d', 'Cake', 40, 10);
const RECIPES = [soup, apple, bread, cake];

describe('isLibrarySort', () => {
  it('accepts every sort and nothing else', () => {
    for (const sort of LIBRARY_SORTS) expect(isLibrarySort(sort)).toBe(true);
    expect(isLibrarySort('newest')).toBe(false);
    expect(isLibrarySort(undefined)).toBe(false);
    expect(isLibrarySort(1)).toBe(false);
    expect(DEFAULT_LIBRARY_SORT).toBe('updated');
  });
});

describe('lastCookedByRecipe', () => {
  it('keeps the latest cookedOn per recipe', () => {
    const logs = new Map([
      ['l1', log('l1', 'a', '2026-09-01')],
      ['l2', log('l2', 'a', '2026-09-20')],
      ['l3', log('l3', 'a', '2026-08-30')],
      ['l4', log('l4', 'b', '2025-12-31')],
    ]);
    const latest = lastCookedByRecipe(logs, new Map());
    expect([...latest]).toEqual([
      ['a', '2026-09-20'],
      ['b', '2025-12-31'],
    ]);
  });

  it('is empty with no cook logs', () => {
    expect(lastCookedByRecipe(new Map(), new Map()).size).toBe(0);
  });

  it('skips a recipe shared with you', () => {
    const origins = new Map<string, ItemOrigin>([
      ['a', { kind: 'own' }],
      ['s', { kind: 'shared', ownerSub: 'alice', access: 'editor' }],
    ]);
    const logs = new Map([
      ['l1', log('l1', 'a', '2026-09-01')],
      ['l2', log('l2', 's', '2026-09-02')],
    ]);
    const latest = lastCookedByRecipe(logs, origins);
    expect(latest.get('a')).toBe('2026-09-01');
    expect(latest.has('s')).toBe(false);
  });
});

describe('sortLibraryRecipes', () => {
  const none = { lastCooked: new Map<string, string>(), locale: 'en' };

  it('does not change its input', () => {
    const input = [...RECIPES];
    sortLibraryRecipes(input, 'title', none);
    expect(input).toEqual(RECIPES);
  });

  it('orders by most recently updated by default', () => {
    expect(ids(sortLibraryRecipes(RECIPES, 'updated', none))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('orders titles A to Z in the UI language, ignoring case and accents', () => {
    expect(ids(sortLibraryRecipes(RECIPES, 'title', none))).toEqual(['c', 'b', 'd', 'a']);
  });

  it('orders titles by the locale collation', () => {
    const cyrillic = [recipe('x', 'Ялинка', 1, 1), recipe('y', 'Ґрати', 1, 2), recipe('z', 'Борщ', 1, 3)];
    expect(ids(sortLibraryRecipes(cyrillic, 'title', { ...none, locale: 'uk' }))).toEqual([
      'z',
      'y',
      'x',
    ]);
  });

  it('orders numbers in titles numerically', () => {
    const numbered = [recipe('x', 'Soup 10', 1, 1), recipe('y', 'Soup 9', 1, 1)];
    expect(ids(sortLibraryRecipes(numbered, 'title', none))).toEqual(['y', 'x']);
  });

  it('orders by newest added', () => {
    expect(ids(sortLibraryRecipes(RECIPES, 'created', none))).toEqual(['d', 'b', 'c', 'a']);
  });

  it('orders by last cooked, with never-cooked recipes last in updated order', () => {
    const lastCooked = new Map([
      ['d', '2026-09-01'],
      ['b', '2026-09-20'],
    ]);
    expect(ids(sortLibraryRecipes(RECIPES, 'cooked', { ...none, lastCooked }))).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('breaks ties by most recently updated, then id', () => {
    const twins = [recipe('y', 'Same', 5, 1), recipe('x', 'same', 5, 1), recipe('z', 'Same', 5, 2)];
    const lastCooked = new Map([
      ['x', '2026-09-01'],
      ['y', '2026-09-01'],
      ['z', '2026-09-01'],
    ]);
    for (const sort of LIBRARY_SORTS) {
      expect(ids(sortLibraryRecipes(twins, sort, { lastCooked, locale: 'en' })), sort).toEqual([
        'z',
        'x',
        'y',
      ]);
    }
  });
});
