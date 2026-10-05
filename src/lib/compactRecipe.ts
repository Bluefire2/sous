import { normalizeLang } from '../i18n/lang';
import { compactImportCheck } from './importCheck';
import { compactGalleryPhotoIds } from './recipePhotos';
import { compactVariantOf } from './recipeVariant';
import type { Recipe } from './types';

/**
 * `put` replaces the whole record, so an explicit `undefined` would sit in
 * the payload as a key the editor never writes. Drop those keys so apply and
 * save leave the same shape.
 */
export function compactRecipe(recipe: Recipe): Recipe {
  const next: Recipe = {
    id: recipe.id,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    tags: recipe.tags,
  };
  if (recipe.description !== undefined) next.description = recipe.description;
  if (recipe.sourceUrl !== undefined) next.sourceUrl = recipe.sourceUrl;
  if (recipe.prepMinutes !== undefined) next.prepMinutes = recipe.prepMinutes;
  if (recipe.cookMinutes !== undefined) next.cookMinutes = recipe.cookMinutes;
  if (recipe.notes !== undefined) next.notes = recipe.notes;
  if (recipe.photoId !== undefined) next.photoId = recipe.photoId;
  const lang = normalizeLang(recipe.lang);
  if (lang !== undefined) next.lang = lang;
  const galleryPhotoIds = compactGalleryPhotoIds(
    recipe.galleryPhotoIds,
    recipe.photoId,
  );
  if (galleryPhotoIds !== undefined) next.galleryPhotoIds = galleryPhotoIds;
  const importCheck = compactImportCheck(recipe.importCheck);
  if (importCheck !== undefined) next.importCheck = importCheck;
  const variantOf = compactVariantOf(recipe.variantOf, recipe.id);
  if (variantOf !== undefined) next.variantOf = variantOf;
  return next;
}
