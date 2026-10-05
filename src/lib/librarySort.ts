import type { ItemOrigin } from './libraryMemory';
import type { CookLog, Recipe } from './types';

/**
 * Library list orders. `updated` is the order `useRecipes` already gives
 * (`sortRecipes`), so it is the default and stores nothing.
 */
export const LIBRARY_SORTS = ['updated', 'title', 'created', 'cooked'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export const DEFAULT_LIBRARY_SORT: LibrarySort = 'updated';

export function isLibrarySort(value: unknown): value is LibrarySort {
  return typeof value === 'string' && (LIBRARY_SORTS as readonly string[]).includes(value);
}

/**
 * Latest `cookedOn` per recipe, derived from the cook logs in memory and
 * never stored (cook-log constitution, principle 1). A recipe shared with
 * you has no cook log of yours (principle 3); a stray entry under a shared
 * recipe is skipped anyway, so a card never shows someone else's history.
 */
export function lastCookedByRecipe(
  cookLogs: ReadonlyMap<string, CookLog>,
  recipeOrigins: ReadonlyMap<string, ItemOrigin>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const log of cookLogs.values()) {
    if (recipeOrigins.get(log.recipeId)?.kind === 'shared') continue;
    const current = latest.get(log.recipeId);
    // `YYYY-MM-DD` compares as a string (cook-log principle 5).
    if (current === undefined || log.cookedOn > current) {
      latest.set(log.recipeId, log.cookedOn);
    }
  }
  return latest;
}

const collators = new Map<string, Intl.Collator>();

function collatorFor(locale: string): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    collators.set(locale, collator);
  }
  return collator;
}

function byUpdated(a: Recipe, b: Recipe): number {
  return b.updatedAt - a.updatedAt;
}

/**
 * A new array in the chosen order; the input is not changed. Every order
 * falls back to most recently updated, then id, so equal keys never shuffle
 * between renders. Title order follows the UI language's collation
 * (`locale`). Last cooked puts recipes with no cook last, in updated order.
 */
export function sortLibraryRecipes(
  recipes: readonly Recipe[],
  sort: LibrarySort,
  { lastCooked, locale }: { lastCooked: ReadonlyMap<string, string>; locale: string },
): Recipe[] {
  const tieBreak = (a: Recipe, b: Recipe): number => {
    const updated = byUpdated(a, b);
    if (updated !== 0) return updated;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  };
  switch (sort) {
    case 'title': {
      const collator = collatorFor(locale);
      return [...recipes].sort(
        (a, b) => collator.compare(a.title.trim(), b.title.trim()) || tieBreak(a, b),
      );
    }
    case 'created':
      return [...recipes].sort((a, b) => b.createdAt - a.createdAt || tieBreak(a, b));
    case 'cooked':
      return [...recipes].sort((a, b) => {
        const left = lastCooked.get(a.id);
        const right = lastCooked.get(b.id);
        if (left !== right) {
          if (left === undefined) return 1;
          if (right === undefined) return -1;
          return left < right ? 1 : -1;
        }
        return tieBreak(a, b);
      });
    case 'updated':
      return [...recipes].sort(tieBreak);
  }
}
