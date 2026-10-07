/**
 * Guards data that entered from outside the app (the update_recipe tool, a backup file)
 * and therefore has no compile-time relationship to Recipe.
 */
import { compactLane } from './recipeSteps';
import type { Ingredient, IngredientSection, Recipe, RecipeDraft, RecipeStep } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeIngredient(item: unknown): Ingredient | undefined {
  if (!isPlainObject(item)) return undefined;
  const itemText = nonEmptyString(item.item);
  if (!itemText) return undefined;
  const result: Ingredient = { item: itemText };
  const quantity = finiteNumber(item.quantity);
  if (quantity !== undefined) result.quantity = quantity;
  const unit = nonEmptyString(item.unit);
  if (unit !== undefined) result.unit = unit;
  const note = nonEmptyString(item.note);
  if (note !== undefined) result.note = note;
  return result;
}

function normalizeIngredientSections(value: unknown): IngredientSection[] {
  if (!Array.isArray(value)) return [];
  const sections: IngredientSection[] = [];
  for (const section of value) {
    if (!isPlainObject(section)) continue;
    if (!Array.isArray(section.items)) continue;
    const items = section.items
      .map(normalizeIngredient)
      .filter((i): i is Ingredient => i !== undefined);
    if (items.length === 0) continue;
    const name = nonEmptyString(section.name);
    sections.push(name !== undefined ? { name, items } : { items });
  }
  return sections;
}

function normalizeSteps(value: unknown): RecipeStep[] {
  if (!Array.isArray(value)) return [];
  const steps: RecipeStep[] = [];
  for (const step of value) {
    if (!isPlainObject(step)) continue;
    const text = nonEmptyString(step.text);
    if (text === undefined) continue;
    // A blank lane is kept as '': Ask's way of saying "take this lane off",
    // which `carryStepLanes` honours and strips. Too long is dropped.
    const lane =
      typeof step.lane === 'string' && step.lane.trim() === '' ? '' : compactLane(step.lane);
    steps.push(lane === undefined ? { text } : { text, lane });
  }
  return steps;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    const trimmed = nonEmptyString(tag);
    if (trimmed !== undefined && !seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

export function normalizeRecipeDraft(value: unknown): RecipeDraft | undefined {
  if (!isPlainObject(value)) return undefined;

  const title = nonEmptyString(value.title);
  if (!title) return undefined;

  const servings = finiteNumber(value.servings);
  if (servings === undefined || servings < 1) return undefined;

  const draft: RecipeDraft = {
    title,
    servings,
    ingredientSections: normalizeIngredientSections(value.ingredientSections),
    steps: normalizeSteps(value.steps),
    tags: normalizeTags(value.tags),
  };

  const description = nonEmptyString(value.description);
  if (description !== undefined) draft.description = description;

  const notes = nonEmptyString(value.notes);
  if (notes !== undefined) draft.notes = notes;

  const prepMinutes = finiteNumber(value.prepMinutes);
  if (prepMinutes !== undefined && prepMinutes >= 0) draft.prepMinutes = prepMinutes;

  const cookMinutes = finiteNumber(value.cookMinutes);
  if (cookMinutes !== undefined && cookMinutes >= 0) draft.cookMinutes = cookMinutes;

  return draft;
}

function isValidIngredient(item: unknown): item is Ingredient {
  if (!isPlainObject(item)) return false;
  if (typeof item.item !== 'string') return false;
  if ('quantity' in item && finiteNumber(item.quantity) === undefined) return false;
  if ('unit' in item && typeof item.unit !== 'string') return false;
  if ('note' in item && typeof item.note !== 'string') return false;
  return true;
}

function isValidIngredientSection(section: unknown): section is IngredientSection {
  if (!isPlainObject(section)) return false;
  if ('name' in section && typeof section.name !== 'string') return false;
  if (!Array.isArray(section.items)) return false;
  return section.items.every(isValidIngredient);
}

function isValidStep(step: unknown): step is RecipeStep {
  if (!isPlainObject(step)) return false;
  return typeof step.text === 'string';
}

export function isUsableRecipe(value: unknown): value is Recipe {
  if (!isPlainObject(value)) return false;

  if (typeof value.id !== 'string' || value.id === '') return false;
  if (finiteNumber(value.createdAt) === undefined) return false;
  if (finiteNumber(value.updatedAt) === undefined) return false;
  if (typeof value.title !== 'string' || value.title === '') return false;
  const servings = finiteNumber(value.servings);
  if (servings === undefined || servings < 1) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((t) => typeof t === 'string')) {
    return false;
  }
  if (
    !Array.isArray(value.ingredientSections) ||
    !value.ingredientSections.every(isValidIngredientSection)
  ) {
    return false;
  }
  if (!Array.isArray(value.steps) || !value.steps.every(isValidStep)) return false;

  if ('description' in value && typeof value.description !== 'string') return false;
  if ('notes' in value && typeof value.notes !== 'string') return false;
  if ('sourceUrl' in value && typeof value.sourceUrl !== 'string') return false;
  if ('photoId' in value && typeof value.photoId !== 'string') return false;
  if ('galleryPhotoIds' in value) {
    if (
      !Array.isArray(value.galleryPhotoIds) ||
      !value.galleryPhotoIds.every((id) => typeof id === 'string')
    ) {
      return false;
    }
  }
  if ('prepMinutes' in value) {
    const prep = finiteNumber(value.prepMinutes);
    if (prep === undefined || prep < 0) return false;
  }
  if ('cookMinutes' in value) {
    const cook = finiteNumber(value.cookMinutes);
    if (cook === undefined || cook < 0) return false;
  }

  return true;
}
