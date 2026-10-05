import { describe, expect, it } from 'vitest';
import { variantGroup } from './variantGroup';
import type { Recipe } from './types';

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPICY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VEGAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function recipe(id: string, createdAt: number, variantOf?: string): Recipe {
  return {
    id,
    title: id,
    servings: 2,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt,
    updatedAt: createdAt,
    ...(variantOf !== undefined ? { variantOf } : {}),
  };
}

function library(...recipes: Recipe[]): Map<string, Recipe> {
  return new Map(recipes.map((r) => [r.id, r]));
}

const ids = (group: readonly Recipe[]) => group.map((r) => r.id);

describe('variantGroup', () => {
  it('puts the original first, then the variants oldest first, from any member', () => {
    // The original is the newest here, so it is first by being the original.
    const recipes = library(
      recipe(VEGAN, 3, ORIGINAL),
      recipe(ORIGINAL, 9),
      recipe(SPICY, 2, ORIGINAL),
      recipe(OTHER, 1),
    );
    for (const id of [ORIGINAL, SPICY, VEGAN]) {
      expect(ids(variantGroup(recipes, id))).toEqual([ORIGINAL, SPICY, VEGAN]);
    }
  });

  it('is the same empty value for a lone recipe, a missing one, and no id', () => {
    const recipes = library(recipe(OTHER, 1));
    const lone = variantGroup(recipes, OTHER);
    expect(lone).toEqual([]);
    expect(variantGroup(recipes, ORIGINAL)).toBe(lone);
    expect(variantGroup(recipes, undefined)).toBe(lone);
  });

  it('keeps the siblings together after the original is deleted', () => {
    const recipes = library(recipe(VEGAN, 3, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, VEGAN))).toEqual([SPICY, VEGAN]);
  });

  it('groups a variant of a variant with the same original, flat', () => {
    // createFromAsk on SPICY stores SPICY.variantOf, not SPICY.id.
    const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(VEGAN, 3, ORIGINAL));
    expect(ids(variantGroup(recipes, VEGAN))).toEqual([ORIGINAL, SPICY, VEGAN]);
  });

  it('orders equal creation times by id', () => {
    const recipes = library(recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, VEGAN))).toEqual([SPICY, VEGAN]);
  });
});
