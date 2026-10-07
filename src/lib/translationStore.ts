import type { Locale } from '../i18n';
import { recipeStore } from './recipeStore';
import { requestTranslation } from './translateApi';
import type { Recipe, RecipeDraft } from './types';

/**
 * Display translations for the open session. Keyed by recipe id, target
 * locale, and `updatedAt`, so an edit is a miss. Toggle state is per recipe
 * id and is only "translated" for the `updatedAt` it was requested against.
 * Nothing here is written to the recipe, sync, localStorage, or IndexedDB.
 */

export type EffectiveLangInput = {
  storedLang?: string;
  detectedLang?: string;
  /** `updatedAt` the detection was recorded against. */
  detectedAt?: number;
  updatedAt: number;
};

/**
 * The language that decides the translate chip. A detection for this exact
 * version wins, including when it disagrees with `storedLang`. A detection
 * from an older `updatedAt` is discarded. Missing both is `undefined`.
 */
export function effectiveLang(input: EffectiveLangInput): string | undefined {
  if (input.detectedLang !== undefined && input.detectedAt === input.updatedAt) {
    return input.detectedLang;
  }
  return input.storedLang;
}

type CacheKey = string;

type Toggle = {
  updatedAt: number;
  target: Locale;
};

type Detection = {
  lang: string;
  updatedAt: number;
};

const cache = new Map<CacheKey, Recipe>();
const toggles = new Map<string, Toggle>();
const detections = new Map<string, Detection>();
const inflight = new Map<CacheKey, Promise<Recipe>>();

function cacheKey(recipeId: string, target: Locale, updatedAt: number): CacheKey {
  return `${recipeId}\0${target}\0${updatedAt}`;
}

function rememberToggle(recipeId: string, updatedAt: number, target: Locale): void {
  toggles.set(recipeId, { updatedAt, target });
}

function toDisplayRecipe(source: Recipe, translated: RecipeDraft): Recipe {
  const display: Recipe = {
    id: source.id,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    title: translated.title,
    servings: translated.servings,
    ingredientSections: translated.ingredientSections,
    // Translation returns step text only; lanes come from the stored recipe
    // by position, as structure never changes (i18n principle 4).
    steps: translated.steps.map((step, i) => {
      const lane = source.steps[i]?.lane;
      return lane === undefined ? step : { ...step, lane };
    }),
    tags: translated.tags,
  };
  if (translated.description !== undefined) {
    display.description = translated.description;
  } else if (source.description !== undefined) {
    display.description = source.description;
  }
  if (translated.notes !== undefined) {
    display.notes = translated.notes;
  } else if (source.notes !== undefined) {
    display.notes = source.notes;
  }
  if (translated.prepMinutes !== undefined) {
    display.prepMinutes = translated.prepMinutes;
  } else if (source.prepMinutes !== undefined) {
    display.prepMinutes = source.prepMinutes;
  }
  if (translated.cookMinutes !== undefined) {
    display.cookMinutes = translated.cookMinutes;
  } else if (source.cookMinutes !== undefined) {
    display.cookMinutes = source.cookMinutes;
  }
  if (source.sourceUrl !== undefined) {
    display.sourceUrl = source.sourceUrl;
  }
  if (source.photoId !== undefined) {
    display.photoId = source.photoId;
  }
  if (source.galleryPhotoIds !== undefined) {
    display.galleryPhotoIds = source.galleryPhotoIds;
  }
  // The stored label stays. Detection is remembered beside the recipe.
  if (source.lang !== undefined) {
    display.lang = source.lang;
  }
  return display;
}

/**
 * Effective language for this recipe version, using an in-memory detection
 * when it was recorded against `recipe.updatedAt`.
 */
export function effectiveRecipeLang(
  recipe: Pick<Recipe, 'id' | 'lang' | 'updatedAt'>,
): string | undefined {
  const found = detections.get(recipe.id);
  return effectiveLang({
    storedLang: recipe.lang,
    detectedLang: found?.lang,
    detectedAt: found?.updatedAt,
    updatedAt: recipe.updatedAt,
  });
}

/**
 * Detection for this recipe version. A detection recorded against an older
 * `updatedAt` is discarded. This does not read or write `Recipe.lang`.
 */
export function getDetectedLang(recipeId: string, updatedAt: number): string | undefined {
  const found = detections.get(recipeId);
  if (found === undefined || found.updatedAt !== updatedAt) {
    return undefined;
  }
  return found.lang;
}

/** True when this recipe version is showing its translation. An edit reads as idle. */
export function isTranslated(recipeId: string, updatedAt: number): boolean {
  return translatedTarget(recipeId, updatedAt) !== undefined;
}

/** Target locale of the showing translation, or `undefined` when the view is original. */
export function translatedTarget(recipeId: string, updatedAt: number): Locale | undefined {
  const toggle = toggles.get(recipeId);
  if (toggle === undefined || toggle.updatedAt !== updatedAt) {
    return undefined;
  }
  return toggle.target;
}

/** Cached display recipe for this version and target. Independent of the toggle. */
export function getCachedTranslation(
  recipeId: string,
  target: Locale,
  updatedAt: number,
): Recipe | undefined {
  return cache.get(cacheKey(recipeId, target, updatedAt));
}

/** Leave the translated view. The cache stays, so translating again does not refetch. */
export function showOriginal(recipeId: string): void {
  toggles.delete(recipeId);
}

/**
 * Display recipe while the toggle is on for this version and target;
 * otherwise the stored recipe. Does not fetch.
 */
export function displayRecipe(recipe: Recipe, target: Locale): Recipe {
  if (translatedTarget(recipe.id, recipe.updatedAt) !== target) {
    return recipe;
  }
  return cache.get(cacheKey(recipe.id, target, recipe.updatedAt)) ?? recipe;
}

async function fetchTranslation(recipe: Recipe, target: Locale): Promise<Recipe> {
  const key = cacheKey(recipe.id, target, recipe.updatedAt);
  const shared = recipeStore.isShared(recipe.id);
  // No `sourceLang`: the detection must come from the text alone. Given the
  // stored label as a hint, the model tends to echo it back when the text is
  // already in the target language, and "already in {language}" never fires.
  const result = await requestTranslation({
    recipe,
    target,
    ...(shared ? {} : { recipeId: recipe.id }),
  });
  const display = toDisplayRecipe(recipe, result.recipe);
  cache.set(key, display);
  if (result.detectedLang !== undefined) {
    detections.set(recipe.id, { lang: result.detectedLang, updatedAt: recipe.updatedAt });
  }
  rememberToggle(recipe.id, recipe.updatedAt, target);
  return display;
}

/**
 * Translate `recipe` into `target` and show that view. A shared recipe omits
 * `recipeId`. A cache hit for this id, target, and `updatedAt` does not call
 * the network. Does not write the recipe.
 */
export async function translateRecipe(recipe: Recipe, target: Locale): Promise<Recipe> {
  const key = cacheKey(recipe.id, target, recipe.updatedAt);
  const cached = cache.get(key);
  if (cached) {
    rememberToggle(recipe.id, recipe.updatedAt, target);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const promise = fetchTranslation(recipe, target).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Drops session translations. Used by tests; a reload does the same. */
export function clearTranslations(): void {
  cache.clear();
  toggles.clear();
  detections.clear();
  inflight.clear();
}
