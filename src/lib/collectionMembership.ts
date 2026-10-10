import { MAX_COLLECTION_RECIPE_IDS } from './compactCollection';
import type { Collection, Recipe } from './types';

/** Smallest collection id wins when a recipe id appears in two live lists. */
export function winningMembership(
  collections: readonly Collection[],
): Map<string, string> {
  const sorted = [...collections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const map = new Map<string, string>();
  for (const collection of sorted) {
    for (const recipeId of collection.recipeIds) {
      if (!map.has(recipeId)) {
        map.set(recipeId, collection.id);
      }
    }
  }
  return map;
}

export function unfiledRecipes(
  recipes: readonly Recipe[],
  collections: readonly Collection[],
): Recipe[] {
  const claimed = winningMembership(collections);
  return recipes.filter((recipe) => !claimed.has(recipe.id));
}

/**
 * One pass over the recipes. `unfiled` is the Recipes row. Every named
 * collection is present in `byCollection`, including ones with no recipes.
 */
export function recipeCounts(
  recipes: readonly Recipe[],
  collections: readonly Collection[],
): { unfiled: number; byCollection: ReadonlyMap<string, number> } {
  const membership = winningMembership(collections);
  const byCollection = new Map<string, number>();
  for (const collection of collections) {
    byCollection.set(collection.id, 0);
  }
  let unfiled = 0;
  for (const recipe of recipes) {
    const collectionId = membership.get(recipe.id);
    if (collectionId === undefined) {
      unfiled += 1;
      continue;
    }
    byCollection.set(collectionId, (byCollection.get(collectionId) ?? 0) + 1);
  }
  return { unfiled, byCollection };
}

export function recipesInCollection(
  recipes: readonly Recipe[],
  collection: Collection,
  allCollections: readonly Collection[],
): Recipe[] {
  const membership = winningMembership(allCollections);
  return recipes.filter((recipe) => membership.get(recipe.id) === collection.id);
}

/** First-seen order, dropping blanks and repeats. */
function uniqueIds(recipeIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of recipeIds) {
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

/**
 * The destination's `recipeIds` after `recipeIds` move into it. Ids already
 * there stay where they are; the rest append in the order given.
 */
export function recipeIdsAfterMove(
  existing: readonly string[],
  recipeIds: readonly string[],
): string[] {
  const present = new Set(existing);
  const appended: string[] = [];
  for (const id of uniqueIds(recipeIds)) {
    if (present.has(id)) {
      continue;
    }
    present.add(id);
    appended.push(id);
  }
  return appended.length === 0 ? [...existing] : [...existing, ...appended];
}

/**
 * Moves every id in one pass. Each collection is returned at most once:
 * the destination appends ids it does not already hold, and every other
 * collection drops them. Moving to `'default'` only removes. An id already
 * in the destination keeps its place.
 */
export function moveRecipes(
  collections: readonly Collection[],
  recipeIds: readonly string[],
  dest: 'default' | string,
  now: number,
): Collection[] {
  const moving = uniqueIds(recipeIds);
  if (moving.length === 0) {
    return [];
  }
  const movingSet = new Set(moving);
  const changed: Collection[] = [];
  for (const collection of collections) {
    const isDest = dest !== 'default' && collection.id === dest;
    if (isDest) {
      const present = new Set(collection.recipeIds);
      const appended = moving.filter((id) => !present.has(id));
      if (appended.length === 0) {
        continue;
      }
      changed.push({
        ...collection,
        recipeIds: [...collection.recipeIds, ...appended],
        updatedAt: now,
      });
      continue;
    }
    if (!collection.recipeIds.some((id) => movingSet.has(id))) {
      continue;
    }
    changed.push({
      ...collection,
      recipeIds: collection.recipeIds.filter((id) => !movingSet.has(id)),
      updatedAt: now,
    });
  }
  return changed;
}

export function moveRecipe(
  collections: readonly Collection[],
  recipeId: string,
  dest: 'default' | string,
  now: number,
): Collection[] {
  return moveRecipes(collections, [recipeId], dest, now);
}

export function wouldExceedRecipeIdCap(recipeIds: readonly string[]): boolean {
  return recipeIds.length > MAX_COLLECTION_RECIPE_IDS;
}
