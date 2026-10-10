/**
 * Turns an imported recipe into a `recipe.put` payload the push layer will
 * accept. The model's output is already cleaned by `normalizeImportedRecipe`
 * in `server/recipeImport.ts`; this adds identity, timestamps and sourceUrl,
 * and refuses a payload the push validator would reject for size.
 */
import { compactImportCheck, type ImportCheck } from './importWarnings.ts';
import type { ImportedRecipe } from './recipeImport.ts';

/** `validateRecipePut` compares `JSON.stringify(payload).length` against this. */
const MAX_PAYLOAD_CHARS = 200_000;

/** Returns `null` when the payload would be too large to push. */
export function recipePutFromExtraction(
  recipe: ImportedRecipe,
  options: { id: string; now: number; sourceUrl?: string; importCheck?: ImportCheck },
): Record<string, unknown> | null {
  // Fields are copied by name, not spread: TypeScript lets an object with extra
  // keys (an `id`, a `photoId`) pass as an `ImportedRecipe`.
  const payload: Record<string, unknown> = {
    id: options.id,
    createdAt: options.now,
    updatedAt: options.now,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    tags: recipe.tags,
  };
  if (recipe.description !== undefined) payload.description = recipe.description;
  if (recipe.notes !== undefined) payload.notes = recipe.notes;
  if (recipe.prepMinutes !== undefined) payload.prepMinutes = recipe.prepMinutes;
  if (recipe.cookMinutes !== undefined) payload.cookMinutes = recipe.cookMinutes;
  if (recipe.lang !== undefined) payload.lang = recipe.lang;

  const sourceUrl = options.sourceUrl?.trim();
  if (sourceUrl) payload.sourceUrl = sourceUrl;

  // Written only with warnings: a clean import carries no record.
  const importCheck = compactImportCheck(options.importCheck);
  if (importCheck !== undefined && importCheck.warnings.length > 0) {
    payload.importCheck = importCheck;
  }

  if (JSON.stringify(payload).length >= MAX_PAYLOAD_CHARS) {
    return null;
  }

  return payload;
}
