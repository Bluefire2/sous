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

/**
 * Origins as the library publishes them: `own` lists the person's own
 * recipes (`{ kind: 'own' }`); every other key is an owner's sub and the
 * recipes they share.
 */
function origins(byOwner: { own?: string[]; [ownerSub: string]: string[] | undefined }): Map<string, ItemOrigin> {
  const map = new Map<string, ItemOrigin>();
  for (const [owner, ids] of Object.entries(byOwner)) {
    for (const id of ids ?? []) {
      map.set(id, owner === 'own' ? { kind: 'own' } : { kind: 'shared', ownerSub: owner });
    }
  }
  return map;
}

const ids = (group: readonly Recipe[]) => group.map((r) => r.id);

describe('variantGroup', () => {
  const allOwn = origins({ own: [ORIGINAL, SPICY, VEGAN, OTHER, COPY] });

  it('puts the original first, then the variants oldest first, from any member', () => {
    // The original is the newest here, so it is first by being the original.
    const recipes = library(
      recipe(VEGAN, 3, ORIGINAL),
      recipe(ORIGINAL, 9),
      recipe(SPICY, 2, ORIGINAL),
      recipe(OTHER, 1),
    );
    for (const id of [ORIGINAL, SPICY, VEGAN]) {
      expect(ids(variantGroup(recipes, allOwn, id))).toEqual([ORIGINAL, SPICY, VEGAN]);
    }
  });

  it('is the same empty value for a lone recipe, a missing one, and no id', () => {
    const recipes = library(recipe(OTHER, 1));
    const lone = variantGroup(recipes, allOwn, OTHER);
    expect(lone).toEqual([]);
    expect(variantGroup(recipes, allOwn, ORIGINAL)).toBe(lone);
    expect(variantGroup(recipes, allOwn, undefined)).toBe(lone);
  });

  it('keeps the siblings together after the original is deleted', () => {
    const recipes = library(recipe(VEGAN, 3, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, allOwn, VEGAN))).toEqual([SPICY, VEGAN]);
  });

  it('groups a variant of a variant with the same original, flat', () => {
    // createFromAsk on SPICY stores SPICY.variantOf, not SPICY.id.
    const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(VEGAN, 3, ORIGINAL));
    expect(ids(variantGroup(recipes, allOwn, VEGAN))).toEqual([ORIGINAL, SPICY, VEGAN]);
  });

  it('orders equal creation times by id', () => {
    const recipes = library(recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, allOwn, VEGAN))).toEqual([SPICY, VEGAN]);
  });

  it('reads a recipe with no origin as your own', () => {
    const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
    expect(ids(variantGroup(recipes, new Map(), SPICY))).toEqual([ORIGINAL, SPICY]);
  });

  describe('recipes someone else owns', () => {
    it('groups your copy with the shared original it was made from, both ways', () => {
      // A viewer's Save as new recipe on a shared recipe.
      const recipes = library(recipe(ORIGINAL, 1), recipe(COPY, 2, ORIGINAL));
      const from = origins({ owner: [ORIGINAL], own: [COPY] });
      expect(ids(variantGroup(recipes, from, COPY))).toEqual([ORIGINAL, COPY]);
      expect(ids(variantGroup(recipes, from, ORIGINAL))).toEqual([ORIGINAL, COPY]);
    });

    it("groups your copy of a shared variant with it and the owner's group, while you see their original", () => {
      // Save as new recipe on SPICY stores SPICY.variantOf, the owner's ORIGINAL.
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(COPY, 3, ORIGINAL));
      const from = origins({ owner: [ORIGINAL, SPICY], own: [COPY] });
      for (const id of [COPY, SPICY, ORIGINAL]) {
        expect(ids(variantGroup(recipes, from, id))).toEqual([ORIGINAL, SPICY, COPY]);
      }
    });

    it("shows an owner's shared variants together on their recipes", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
      const from = origins({ owner: [ORIGINAL, SPICY] });
      expect(ids(variantGroup(recipes, from, SPICY))).toEqual([ORIGINAL, SPICY]);
    });

    it("groups one person's variant of another's original, from the variant", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
      const from = origins({ bob: [ORIGINAL], alice: [SPICY] });
      expect(ids(variantGroup(recipes, from, SPICY))).toEqual([ORIGINAL, SPICY]);
    });

    it("keeps someone else's variant off the page of your own recipe", () => {
      // They pointed variantOf at your recipe, then shared it with you.
      const recipes = library(recipe(ORIGINAL, 1), recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 3, ORIGINAL));
      const from = origins({ own: [ORIGINAL, VEGAN], mallory: [SPICY] });
      expect(ids(variantGroup(recipes, from, ORIGINAL))).toEqual([ORIGINAL, VEGAN]);
      expect(ids(variantGroup(recipes, from, VEGAN))).toEqual([ORIGINAL, VEGAN]);
      // On their own recipe's page, your recipes still show: they are yours.
      expect(ids(variantGroup(recipes, from, SPICY))).toEqual([ORIGINAL, VEGAN, SPICY]);
    });

    it("leaves a lone recipe ungrouped when the only other member is someone else's", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL));
      const from = origins({ own: [ORIGINAL], mallory: [SPICY] });
      expect(variantGroup(recipes, from, ORIGINAL)).toEqual([]);
    });

    it("keeps a third person out of a shared group, including on your copy's page", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(COPY, 3, ORIGINAL));
      const from = origins({ owner: [ORIGINAL], mallory: [SPICY], own: [COPY] });
      expect(ids(variantGroup(recipes, from, COPY))).toEqual([ORIGINAL, COPY]);
      expect(ids(variantGroup(recipes, from, ORIGINAL))).toEqual([ORIGINAL, COPY]);
    });

    it("does not mix two other people's variants of a shared original", () => {
      const recipes = library(recipe(ORIGINAL, 1), recipe(SPICY, 2, ORIGINAL), recipe(VEGAN, 3, ORIGINAL));
      const from = origins({ owner: [ORIGINAL], mallory: [SPICY], eve: [VEGAN] });
      expect(ids(variantGroup(recipes, from, SPICY))).toEqual([ORIGINAL, SPICY]);
      expect(ids(variantGroup(recipes, from, ORIGINAL))).toEqual([]);
    });
  });

  // Accepted limits (docs/plans/recipe-variants.md, Client). These pin the
  // behaviour so a change to it is a decision, not an accident.
  describe('known limits', () => {
    it("drops your copy of a shared variant from its group when you can't see their original", () => {
      const recipes = library(recipe(SPICY, 2, ORIGINAL), recipe(COPY, 3, ORIGINAL));
      const from = origins({ owner: [SPICY], own: [COPY] });
      expect(variantGroup(recipes, from, COPY)).toEqual([]);
      // From their variant, your copy is yours, so it still shows there.
      expect(ids(variantGroup(recipes, from, SPICY))).toEqual([SPICY, COPY]);
    });

    it("shows a shared recipe with a deleted original's id as that original", () => {
      // Your ORIGINAL is gone; someone pushed their own recipe with its id.
      const recipes = library(recipe(ORIGINAL, 9), recipe(VEGAN, 2, ORIGINAL), recipe(SPICY, 3, ORIGINAL));
      const from = origins({ own: [VEGAN, SPICY], mallory: [ORIGINAL] });
      expect(ids(variantGroup(recipes, from, VEGAN))).toEqual([ORIGINAL, VEGAN, SPICY]);
    });
  });
});
