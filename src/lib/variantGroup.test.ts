import { describe, expect, it } from 'vitest';
import type { ItemOrigin } from './libraryMemory';
import { variantGroup } from './variantGroup';
import type { Recipe } from './types';

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPICY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VEGAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COPY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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

/** Recipes shared by `ownerSub`; anything not listed is the person's own. */
function sharedBy(ownerSub: string, ...ids: string[]): Map<string, ItemOrigin> {
  return new Map(ids.map((id) => [id, { kind: 'shared', ownerSub }]));
}

const OWN = new Map<string, ItemOrigin>();

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
      expect(ids(variantGroup(recipes, OWN, id))).toEqual([ORIGINAL, SPICY, VEGAN]);
    }
  });

  it('is the same empty value for a lone recipe, a missing one, and no id', () => {
    const recipes = library(recipe(OTHER, 1));
    const lone = variantGroup(recipes, OWN, OTHER);
    expect(lone).toEqual([]);
    expect(variantGroup(recipes, OWN, ORIGINAL)).toBe(lone);
    expect(variantGroup(recipes, OWN, undefined)).toBe(lone);
  });

  it('keeps the siblings together after the original is deleted', () => {
    const recipes = library(recipe(VEGAN, 3, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, OWN, VEGAN))).toEqual([SPICY, VEGAN]);
  });

  it('groups a variant of a variant with the same original, flat', () => {
    // createFromAsk on SPICY stores SPICY.variantOf, not SPICY.id.
    const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(VEGAN, 3, ORIGINAL));
    expect(ids(variantGroup(recipes, OWN, VEGAN))).toEqual([ORIGINAL, SPICY, VEGAN]);
  });

  it('orders equal creation times by id', () => {
    const recipes = library(recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, OWN, VEGAN))).toEqual([SPICY, VEGAN]);
  });

  describe('recipes someone else owns', () => {
    it("groups my copy with the shared original it was made from, both ways", () => {
      // A viewer's Save as new recipe on a shared recipe.
      const recipes = library(recipe(ORIGINAL, 1), recipe(COPY, 2, ORIGINAL));
      const origins = sharedBy('owner', ORIGINAL);
      expect(ids(variantGroup(recipes, origins, COPY))).toEqual([ORIGINAL, COPY]);
      expect(ids(variantGroup(recipes, origins, ORIGINAL))).toEqual([ORIGINAL, COPY]);
    });

    it("shows an owner's shared variants together on their recipes", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
      const origins = sharedBy('owner', ORIGINAL, SPICY);
      expect(ids(variantGroup(recipes, origins, SPICY))).toEqual([ORIGINAL, SPICY]);
    });

    it("keeps someone else's variant off the page of my own recipe", () => {
      // They pointed variantOf at my recipe, then shared it with me.
      const recipes = library(recipe(ORIGINAL, 1), recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 3, ORIGINAL));
      const origins = sharedBy('mallory', SPICY);
      expect(ids(variantGroup(recipes, origins, ORIGINAL))).toEqual([ORIGINAL, VEGAN]);
      expect(ids(variantGroup(recipes, origins, VEGAN))).toEqual([ORIGINAL, VEGAN]);
      // On their own recipe's page, my recipes still show: they are mine.
      expect(ids(variantGroup(recipes, origins, SPICY))).toEqual([ORIGINAL, VEGAN, SPICY]);
    });

    it("leaves a lone recipe ungrouped when the only other member is someone else's", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
      const origins = sharedBy('mallory', SPICY);
      expect(variantGroup(recipes, origins, ORIGINAL)).toEqual([]);
    });

    it("does not mix two other people's variants of a shared original", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(VEGAN, 3, ORIGINAL));
      const origins = new Map<string, ItemOrigin>([
        ...sharedBy('owner', ORIGINAL),
        ...sharedBy('mallory', SPICY),
        ...sharedBy('eve', VEGAN),
      ]);
      expect(ids(variantGroup(recipes, origins, SPICY))).toEqual([ORIGINAL, SPICY]);
      expect(ids(variantGroup(recipes, origins, ORIGINAL))).toEqual([]);
    });
  });
});
