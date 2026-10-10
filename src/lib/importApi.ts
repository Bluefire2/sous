import { t } from '../i18n';
import { serverError } from './errorText';
import type { EncodedImage } from './image';
import { readImportWarnings, type ImportWarning } from './importCheck';
import { invalidateSession } from './session';
import type { RecipeDraft } from './types';

export type ExtractedRecipe = RecipeDraft;

/**
 * `translation` is the translated draft for the import preview.
 * Callers save `recipe` unless the preview is showing the translation.
 */
export interface ImportRecipeResult {
  recipe: ExtractedRecipe;
  translation?: { lang: string; recipe: ExtractedRecipe };
  translationFailed?: true;
  /**
   * What the import check found on the original extraction, as codes; the
   * words are in the catalogs. Absent for a clean import. Positions in a
   * warning hold for the translation too, which never changes structure.
   */
  warnings?: ImportWarning[];
  /**
   * A recipe written from a brief with Search the web on: the pages Gemini
   * used, and Google's Search Suggestions snippet, which its terms require
   * the preview to show as provided.
   */
  grounding?: ImportGrounding;
}

export interface ImportGrounding {
  sources: { title: string; url: string }[];
  searchSuggestions?: string;
}

/** Mirror of the server cap in `server/recipeImport.ts`, which stays authoritative. */
export const MAX_GENERATE_BRIEF_CHARS = 2000;
/** Mirror of `MAX_GENERATE_SOURCES`; a longer list from the server is cut, not shown. */
const MAX_GROUNDING_SOURCES = 10;

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The server's `grounding`, keeping only well-formed http(s) sources. `undefined` when there is nothing to show. */
export function readImportGrounding(raw: unknown): ImportGrounding | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as { sources?: unknown; searchSuggestions?: unknown };
  const sources: ImportGrounding['sources'] = [];
  if (Array.isArray(record.sources)) {
    for (const item of record.sources) {
      if (typeof item !== 'object' || item === null) continue;
      const { title, url } = item as { title?: unknown; url?: unknown };
      const href = httpUrl(url);
      if (href === undefined || typeof title !== 'string') continue;
      sources.push({ title, url: href });
      if (sources.length >= MAX_GROUNDING_SOURCES) break;
    }
  }
  const searchSuggestions =
    typeof record.searchSuggestions === 'string' && record.searchSuggestions.trim() !== ''
      ? record.searchSuggestions
      : undefined;
  if (sources.length === 0 && searchSuggestions === undefined) return undefined;
  return { sources, ...(searchSuggestions !== undefined ? { searchSuggestions } : {}) };
}

function drafted(recipe: ExtractedRecipe): ExtractedRecipe {
  return {
    ...recipe,
    tags: recipe.tags ?? [],
    ingredientSections: recipe.ingredientSections ?? [],
    steps: recipe.steps ?? [],
  };
}

export const MAX_IMPORT_PHOTOS = 4;
export const IMPORT_PHOTO_LIMIT_ERROR = 'Up to 4 photos.';

// Mirrors of the server caps in `server/importRoute.ts`, which stay
// authoritative; these turn an after-upload 413 into an at-pick-time message.
export const MAX_IMPORT_PHOTO_BYTES = 3 * 1024 * 1024;
/** The 12 MiB body cap, less headroom for the JSON wrapper and notes. */
export const MAX_IMPORT_PHOTOS_BASE64_CHARS = 12 * 1024 * 1024 - 64 * 1024;
export const IMPORT_PHOTO_TOO_LARGE_ERROR = 'That photo is too large — try a smaller one.';
export const IMPORT_PHOTOS_TOTAL_TOO_LARGE_ERROR =
  'Those photos are too large together — remove one and try again.';

/** The leading picks that fit under `MAX_IMPORT_PHOTOS`, in order. */
export function fitImportPhotos<T>(
  currentCount: number,
  picked: readonly T[],
): { accepted: T[]; overflow: boolean } {
  const room = Math.max(0, MAX_IMPORT_PHOTOS - currentCount);
  const accepted = picked.slice(0, room);
  return { accepted, overflow: accepted.length < picked.length };
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function checkImportPhotoBytes(
  current: readonly EncodedImage[],
  next: EncodedImage,
): 'ok' | 'photo_too_large' | 'total_too_large' {
  if (decodedBytes(next.base64) > MAX_IMPORT_PHOTO_BYTES) return 'photo_too_large';
  const total = current.reduce((sum, image) => sum + image.base64.length, next.base64.length);
  if (total > MAX_IMPORT_PHOTOS_BASE64_CHARS) return 'total_too_large';
  return 'ok';
}

export async function importRecipe(params: {
  url?: string;
  text?: string;
  translateTo?: string;
  images?: EncodedImage[];
  /** An idea for a dish; the server writes the recipe. Sent on its own, never with `url`, `text`, or `images`. */
  brief?: string;
  /** With `brief`: let Gemini run Google searches for it. */
  search?: boolean;
}): Promise<ImportRecipeResult> {
  const response = await fetch('/api/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  const data = (await response.json().catch(() => null)) as
    | {
        recipe?: ExtractedRecipe;
        translation?: { lang?: unknown; recipe?: ExtractedRecipe };
        translationFailed?: unknown;
        warnings?: unknown;
        grounding?: unknown;
        error?: string;
        code?: string;
        status?: number;
      }
    | null;
  if (!response.ok || !data?.recipe) {
    // `status` and `siteStatus` ride along for an import report; the words are unchanged.
    throw Object.assign(
      serverError(data, 'error.importFailedStatus', { status: response.status }),
      { status: response.status },
      typeof data?.status === 'number' ? { siteStatus: data.status } : {},
    );
  }

  const result: ImportRecipeResult = { recipe: drafted(data.recipe) };
  if (data.translationFailed === true) {
    result.translationFailed = true;
  }
  // Unknown codes from a newer server are dropped, never shown as raw text.
  const warnings = readImportWarnings(data.warnings);
  if (warnings.length > 0) {
    result.warnings = warnings;
  }
  const grounding = readImportGrounding(data.grounding);
  if (grounding !== undefined) {
    result.grounding = grounding;
  }
  const translation = data.translation;
  if (
    translation !== undefined &&
    typeof translation.lang === 'string' &&
    translation.recipe !== undefined
  ) {
    result.translation = { lang: translation.lang, recipe: drafted(translation.recipe) };
  }
  return result;
}
