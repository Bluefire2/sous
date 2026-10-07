import { originAccess, type LibraryAccess, type LibrarySnapshot } from './libraryMemory';
import type { CookLog, CookStateRow, Recipe } from './types';

/**
 * Selectors for `useLibrarySelect`. Each returns a value the snapshot already
 * holds, or a primitive, never a new object: React compares results with
 * `Object.is`, and a fresh object would re-render forever.
 * `librarySelectors.test.ts` checks every export for that.
 */

/** `undefined` while loading, `null` if not found. */
export function selectRecipe(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => Recipe | null | undefined {
  return (snapshot) => {
    if (!snapshot.loaded) {
      return undefined;
    }
    return id ? (snapshot.recipes.get(id) ?? null) : null;
  };
}

/** `undefined` when the recipe is not in the library. */
export function selectRecipeAccess(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => LibraryAccess | undefined {
  return (snapshot) =>
    id === undefined ? undefined : originAccess(snapshot.recipeOrigins.get(id));
}

/**
 * Collection this recipe is listed in. `undefined` while loading, when the
 * id is missing, or when the recipe is unfiled. Two lists resolve the same
 * way the library does (`winningMembership`): the smallest collection id
 * wins. One pass with no allocation, since this runs on every library publish.
 */
export function selectRecipeCollectionId(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => string | undefined {
  return (snapshot) => {
    if (!snapshot.loaded || id === undefined) return undefined;
    let winner: string | undefined;
    for (const collection of snapshot.collections.values()) {
      if ((winner === undefined || collection.id < winner) && collection.recipeIds.includes(id)) {
        winner = collection.id;
      }
    }
    return winner;
  };
}

/** Email of whoever shared this recipe, when known. */
export function selectRecipeSharedBy(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => string | undefined {
  return (snapshot) => {
    const origin = id === undefined ? undefined : snapshot.recipeOrigins.get(id);
    return origin?.kind === 'shared' ? origin.ownerEmail : undefined;
  };
}

/** `undefined` while loading, `null` if not found. */
export function selectCookLog(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => CookLog | null | undefined {
  return (snapshot) => {
    if (!snapshot.loaded) {
      return undefined;
    }
    return id ? (snapshot.cookLogs.get(id) ?? null) : null;
  };
}

export function selectCookRow(
  recipeId: string | undefined,
): (snapshot: LibrarySnapshot) => CookStateRow | undefined {
  return (snapshot) => (recipeId ? snapshot.cook.get(recipeId) : undefined);
}

export function selectPendingBlob(
  id: string | undefined,
): (snapshot: LibrarySnapshot) => Blob | undefined {
  return (snapshot) => (id ? snapshot.pendingBlobs.get(id) : undefined);
}

/**
 * Whether the member has a live recipe of their own (shared rows don't
 * count). `undefined` while loading. Takes no id; the factory shape matches
 * the other selectors. Used by the new-member intro
 * (`docs/plans/new-member-intro.md`).
 */
export function selectHasOwnRecipe(): (snapshot: LibrarySnapshot) => boolean | undefined {
  return (snapshot) => {
    if (!snapshot.loaded) return undefined;
    for (const id of snapshot.recipes.keys()) {
      if (snapshot.recipeOrigins.get(id)?.kind !== 'shared') return true;
    }
    return false;
  };
}
