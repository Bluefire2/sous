import type { Recipe } from './types';

const EMPTY: readonly Recipe[] = [];

/**
 * The variants a recipe shares a group with, itself included: every recipe
 * whose `variantOf ?? id` matches its own (`docs/plans/recipe-variants.md`).
 * The original comes first while it exists, then the rest oldest first.
 * Owned and shared recipes group alike. A group of one is `EMPTY`, the same
 * reference every time, so a memoized reader keeps its value.
 */
export function variantGroup(
  recipes: ReadonlyMap<string, Recipe>,
  id: string | undefined,
): readonly Recipe[] {
  const recipe = id === undefined ? undefined : recipes.get(id);
  if (recipe === undefined) return EMPTY;
  const key = recipe.variantOf ?? recipe.id;
  const members: Recipe[] = [];
  for (const candidate of recipes.values()) {
    if ((candidate.variantOf ?? candidate.id) === key) members.push(candidate);
  }
  if (members.length < 2) return EMPTY;
  return members.sort(
    (a, b) =>
      Number(b.id === key) - Number(a.id === key) ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
