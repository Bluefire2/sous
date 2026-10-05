// Keep this module dependency-free and browser-safe: src/lib/recipeVariant.ts
// re-exports it into the Vite client bundle as well as the Node import path.
/**
 * `Recipe.variantOf`: the id of the original a variant was made from, shared
 * by every variant of it (`docs/plans/recipe-variants.md`). The client and
 * the server keep or drop it by this one rule.
 */
import { isUuid } from './uuid.ts';

/** A recipe id other than the recipe's own, or `undefined`. Malformed is dropped, not rejected. */
export function compactVariantOf(value: unknown, id: unknown): string | undefined {
  return isUuid(value) && value !== id ? value : undefined;
}
