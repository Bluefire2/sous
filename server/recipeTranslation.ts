/**
 * Pure recipe ↔ segment mapping for translation.
 *
 * The server image cannot import `src/`, so this file keeps its own copy of
 * `COMMON_UNITS`. `server/recipeTranslation.test.ts` asserts the two lists
 * match. Only text is translated; quantities, known unit tokens, order, and
 * counts pass through (`docs/constitutions/i18n.md`, principle 4).
 */
import { createHash } from 'node:crypto';
import { SUPPORTED_LOCALES, normalizeLang, type Locale } from './lang.ts';

/** Own copy of `src/lib/units.ts` `COMMON_UNITS`. Known tokens are never translated. */
export const COMMON_UNITS = [
  'piece',
  'tsp',
  'tbsp',
  'cup',
  'ml',
  'l',
  'g',
  'kg',
  'oz',
  'lb',
] as const;

/** Same limit as `MAX_RECIPE_LANG_CHARS` in `server/store.ts`. */
const MAX_LANG_CHARS = 32;

export const MAX_TRANSLATE_SEGMENTS = 200;
export const MAX_TRANSLATE_CHARS = 20_000;

export const TRANSLATE_RATE_LIMIT = 60;
export const TRANSLATE_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Bump when the prompt or provider changes so cached translations miss.
 * Included in `translationSourceHash`.
 * 2: detectedLang is judged from the text, not the caller's hint.
 */
export const TRANSLATION_VERSION = 2;

/** Firestore collection under `users/{uid}`, outside sync. */
export const TRANSLATIONS_COLLECTION = 'translations';

export interface RecipeSegment {
  id: string;
  text: string;
}

export interface TranslatableIngredient {
  quantity?: number;
  unit?: string;
  item: string;
  note?: string;
  /** Structure, not text: copied through, never translated. */
  optional?: boolean;
}

export interface TranslatableSection {
  name?: string;
  items: TranslatableIngredient[];
}

export interface TranslatableStep {
  text: string;
}

/** Translatable text plus the structure servings scaling and cook mode need. */
export interface TranslatableRecipe {
  title: string;
  description?: string;
  notes?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: TranslatableSection[];
  steps: TranslatableStep[];
  tags: string[];
  lang?: string;
}

const TITLE_ID = 'title';
const DESCRIPTION_ID = 'description';
const NOTES_ID = 'notes';

function sectionNameId(section: number): string {
  return `section.${section}.name`;
}

function itemId(section: number, item: number): string {
  return `section.${section}.item.${item}.item`;
}

function noteId(section: number, item: number): string {
  return `section.${section}.item.${item}.note`;
}

function unitId(section: number, item: number): string {
  return `section.${section}.item.${item}.unit`;
}

function stepId(step: number): string {
  return `step.${step}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommonUnit(unit: string): boolean {
  return (COMMON_UNITS as readonly string[]).includes(unit);
}

function hasTranslatableText(value: string): boolean {
  return value.trim() !== '';
}

function pushSegment(segments: RecipeSegment[], id: string, text: string | undefined): void {
  if (text !== undefined && hasTranslatableText(text)) {
    segments.push({ id, text });
  }
}

/**
 * Stable ids for every translatable string: title, description, notes,
 * section names, each ingredient item and note, custom units, and each step.
 * Blank strings and known unit tokens are omitted.
 */
export function recipeSegments(recipe: TranslatableRecipe): RecipeSegment[] {
  const segments: RecipeSegment[] = [];
  pushSegment(segments, TITLE_ID, recipe.title);
  pushSegment(segments, DESCRIPTION_ID, recipe.description);
  pushSegment(segments, NOTES_ID, recipe.notes);
  recipe.ingredientSections.forEach((section, sectionIndex) => {
    pushSegment(segments, sectionNameId(sectionIndex), section.name);
    section.items.forEach((item, itemIndex) => {
      pushSegment(segments, itemId(sectionIndex, itemIndex), item.item);
      pushSegment(segments, noteId(sectionIndex, itemIndex), item.note);
      if (item.unit !== undefined && !isCommonUnit(item.unit)) {
        pushSegment(segments, unitId(sectionIndex, itemIndex), item.unit);
      }
    });
  });
  recipe.steps.forEach((step, stepIndex) => {
    pushSegment(segments, stepId(stepIndex), step.text);
  });
  return segments;
}

function translated(byId: ReadonlyMap<string, string>, id: string, original: string): string {
  return byId.get(id) ?? original;
}

/**
 * Returns a new recipe. Quantities, known unit tokens, tags, times, order,
 * and counts are copied. Text is replaced only when `segments` has that id.
 */
export function applyTranslation(
  recipe: TranslatableRecipe,
  segments: readonly RecipeSegment[],
): TranslatableRecipe {
  const byId = new Map(segments.map((segment) => [segment.id, segment.text]));
  const ingredientSections = recipe.ingredientSections.map((section, sectionIndex) => {
    const next: TranslatableSection = {
      items: section.items.map((item, itemIndex) => {
        const nextItem: TranslatableIngredient = {
          item: translated(byId, itemId(sectionIndex, itemIndex), item.item),
        };
        if (item.quantity !== undefined) {
          nextItem.quantity = item.quantity;
        }
        if (item.unit !== undefined) {
          nextItem.unit = isCommonUnit(item.unit)
            ? item.unit
            : translated(byId, unitId(sectionIndex, itemIndex), item.unit);
        }
        if (item.note !== undefined) {
          nextItem.note = translated(byId, noteId(sectionIndex, itemIndex), item.note);
        }
        if (item.optional === true) {
          nextItem.optional = true;
        }
        return nextItem;
      }),
    };
    if (section.name !== undefined) {
      next.name = translated(byId, sectionNameId(sectionIndex), section.name);
    }
    return next;
  });
  const next: TranslatableRecipe = {
    title: translated(byId, TITLE_ID, recipe.title),
    servings: recipe.servings,
    ingredientSections,
    steps: recipe.steps.map((step, stepIndex) => ({
      text: translated(byId, stepId(stepIndex), step.text),
    })),
    tags: recipe.tags.slice(),
  };
  if (recipe.description !== undefined) {
    next.description = translated(byId, DESCRIPTION_ID, recipe.description);
  }
  if (recipe.notes !== undefined) {
    next.notes = translated(byId, NOTES_ID, recipe.notes);
  }
  if (recipe.prepMinutes !== undefined) {
    next.prepMinutes = recipe.prepMinutes;
  }
  if (recipe.cookMinutes !== undefined) {
    next.cookMinutes = recipe.cookMinutes;
  }
  if (recipe.lang !== undefined) {
    next.lang = recipe.lang;
  }
  return next;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}

function optionalFinite(value: unknown): number | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactIngredient(value: unknown): TranslatableIngredient | null {
  if (!isPlainObject(value) || typeof value.item !== 'string') {
    return null;
  }
  const quantity = optionalFinite(value.quantity);
  const unit = optionalString(value.unit);
  const note = optionalString(value.note);
  if (quantity === null || unit === null || note === null) {
    return null;
  }
  const item: TranslatableIngredient = { item: value.item };
  if (quantity !== undefined) {
    item.quantity = quantity;
  }
  if (unit !== undefined) {
    item.unit = unit;
  }
  if (note !== undefined) {
    item.note = note;
  }
  if (value.optional === true) {
    item.optional = true;
  }
  return item;
}

function compactSection(value: unknown): TranslatableSection | null {
  if (!isPlainObject(value) || !Array.isArray(value.items)) {
    return null;
  }
  const name = optionalString(value.name);
  if (name === null) {
    return null;
  }
  const items: TranslatableIngredient[] = [];
  for (const raw of value.items) {
    const item = compactIngredient(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  const section: TranslatableSection = { items };
  if (name !== undefined) {
    section.name = name;
  }
  return section;
}

/**
 * Keeps translatable fields and structure. Drops identity, photos, and
 * `sourceUrl`. `null` means the body is not a recipe.
 */
export function compactTranslatableRecipe(input: unknown): TranslatableRecipe | null {
  if (!isPlainObject(input)) {
    return null;
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return null;
  }
  const servings = optionalFinite(input.servings);
  if (servings === undefined || servings === null) {
    return null;
  }
  if (!Array.isArray(input.ingredientSections) || !Array.isArray(input.steps)) {
    return null;
  }
  if (!Array.isArray(input.tags)) {
    return null;
  }
  const description = optionalString(input.description);
  const notes = optionalString(input.notes);
  const prepMinutes = optionalFinite(input.prepMinutes);
  const cookMinutes = optionalFinite(input.cookMinutes);
  if (description === null || notes === null || prepMinutes === null || cookMinutes === null) {
    return null;
  }
  if (input.lang !== undefined && input.lang !== null) {
    if (typeof input.lang !== 'string' || input.lang.length > MAX_LANG_CHARS) {
      return null;
    }
  }
  const tags: string[] = [];
  for (const tag of input.tags) {
    if (typeof tag !== 'string') {
      return null;
    }
    tags.push(tag);
  }
  const ingredientSections: TranslatableSection[] = [];
  for (const section of input.ingredientSections) {
    const compacted = compactSection(section);
    if (compacted === null) {
      return null;
    }
    ingredientSections.push(compacted);
  }
  const steps: TranslatableStep[] = [];
  for (const step of input.steps) {
    if (!isPlainObject(step) || typeof step.text !== 'string') {
      return null;
    }
    steps.push({ text: step.text });
  }
  const recipe: TranslatableRecipe = {
    title: input.title,
    servings,
    ingredientSections,
    steps,
    tags,
  };
  if (description !== undefined) {
    recipe.description = description;
  }
  if (notes !== undefined) {
    recipe.notes = notes;
  }
  if (prepMinutes !== undefined) {
    recipe.prepMinutes = prepMinutes;
  }
  if (cookMinutes !== undefined) {
    recipe.cookMinutes = cookMinutes;
  }
  const lang = normalizeLang(input.lang);
  if (lang !== undefined) {
    recipe.lang = lang;
  }
  return recipe;
}

export function translationExceedsCaps(segments: readonly { text: string }[]): boolean {
  if (segments.length > MAX_TRANSLATE_SEGMENTS) {
    return true;
  }
  let chars = 0;
  for (const segment of segments) {
    chars += segment.text.length;
    if (chars > MAX_TRANSLATE_CHARS) {
      return true;
    }
  }
  return false;
}

/** Canonical bytes for `translationSourceHash`. Version is part of the input. */
export function canonicalTranslationSource(segments: readonly RecipeSegment[]): string {
  return JSON.stringify({
    version: TRANSLATION_VERSION,
    segments: segments.map((segment) => [segment.id, segment.text]),
  });
}

export function translationSourceHash(segments: readonly RecipeSegment[]): string {
  return createHash('sha256').update(canonicalTranslationSource(segments), 'utf8').digest('hex');
}

/** A matching hash is a hit. Anything else, including a missing doc, is a miss. */
export function translationCacheHit(
  stored: { hash?: unknown } | null | undefined,
  sourceHash: string,
): boolean {
  return typeof stored?.hash === 'string' && stored.hash === sourceHash;
}

/**
 * `{recipeId}.{locale}` for each UI language, in `SUPPORTED_LOCALES` order.
 * Deterministic: cascade delete uses this list and does not query.
 */
export function translationCacheDocIds(recipeId: string): string[] {
  return SUPPORTED_LOCALES.map((locale) => translationCacheDocId(recipeId, locale));
}

export function translationCacheDocId(recipeId: string, target: Locale): string {
  return `${recipeId}.${target}`;
}

/**
 * Write only when the caller's recipe doc was read and is live.
 * `null` / `undefined` is a missing doc: unknown ids and shared recipes
 * (they are not under the caller's `users/{uid}/recipes`).
 */
export function cacheWriteDecision(
  storedDoc: Record<string, unknown> | null | undefined,
): 'write' | 'skip' {
  if (storedDoc == null) {
    return 'skip';
  }
  if (storedDoc.deletedAt !== undefined && storedDoc.deletedAt !== null) {
    return 'skip';
  }
  return 'write';
}

/**
 * Sliding window. `now` is the clock. `buckets` is the per-member history
 * for this container. A rejected call is not recorded. Expired timestamps
 * are dropped.
 */
export function admitTranslateCall(
  buckets: Map<string, number[]>,
  memberId: string,
  now: number,
  limit = TRANSLATE_RATE_LIMIT,
  windowMs = TRANSLATE_RATE_WINDOW_MS,
): boolean {
  const fresh = (buckets.get(memberId) ?? []).filter((at) => now - at < windowMs);
  if (fresh.length >= limit) {
    buckets.set(memberId, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(memberId, fresh);
  return true;
}
