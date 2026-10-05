import type { ItemOrigin } from './libraryMemory';
import type { Recipe } from './types';

const EMPTY: readonly Recipe[] = [];

/** `null` for the person's own recipe, else the sub of whoever shared it. */
function ownerOf(origins: ReadonlyMap<string, ItemOrigin>, id: string): string | null {
  const origin = origins.get(id);
  return origin?.kind === 'shared' ? origin.ownerSub : null;
}

/**
 * The variants a recipe shares a group with, itself included: every recipe
 * whose `variantOf ?? id` matches its own (`docs/plans/recipe-variants.md`).
 * The original comes first while it exists, then the rest oldest first.
 *
 * Owned and shared recipes group together, with one limit: a recipe someone
 * else owns appears only when it is the group's original or has the same
 * owner as the recipe on screen. Otherwise a member who shares a collection
 * with you could put their recipe, titled as they like, on your own
 * recipe's page by pointing its `variantOf` at it.
 *
 * A group of one is `EMPTY`, the same reference every time, so a memoized
 * reader keeps its value.
 */
export function variantGroup(
  recipes: ReadonlyMap<string, Recipe>,
  origins: ReadonlyMap<string, ItemOrigin>,
  id: string | undefined,
): readonly Recipe[] {
  const recipe = id === undefined ? undefined : recipes.get(id);
  if (recipe === undefined) return EMPTY;
  const key = recipe.variantOf ?? recipe.id;
  const shownOwner = ownerOf(origins, recipe.id);
  const members: Recipe[] = [];
  for (const candidate of recipes.values()) {
    if ((candidate.variantOf ?? candidate.id) !== key) continue;
    const owner = ownerOf(origins, candidate.id);
    if (owner === null || owner === shownOwner || candidate.id === key) members.push(candidate);
  }
  if (members.length < 2) return EMPTY;
  return members.sort(
    (a, b) =>
      Number(b.id === key) - Number(a.id === key) ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
