/**
 * Recipe import: page HTML, pasted text, photos, or an idea for a dish in, a
 * saveable recipe draft out.
 *
 * The one pipeline behind `POST /api/import` (`server/importRoute.ts`),
 * `POST /api/extension/import` (`server/extensionImport.ts`) and the live
 * import evals (`evals/recipeImport.eval.ts`, `evals/recipeGenerate.eval.ts`).
 * Callers enter through `importFromHtml`, `importFromSource`,
 * `importFromImages`, or `generateFromBrief` (the model writes the recipe
 * from a short brief, `docs/plans/recipe-generation.md`). Nothing here
 * knows about HTTP: routes map `ImportOutcome` / `PageFetchOutcome` to statuses
 * and copy. The Gemini client and model are passed in; `recipeImportDepsFromEnv`
 * is the only place that reads the environment. Translation uses the injected
 * `translator` (`translateSegments`); a failure there never fails the import.
 *
 * Photo import is bound by `docs/constitutions/image-import.md`.
 */
import {
  GoogleGenAI,
  MediaResolution,
  Type,
  type GroundingMetadata,
  type Schema,
} from '@google/genai';
import {
  checkImport,
  groundingCorpus,
  hasInstructionLikeContent,
  pickBestAttempt,
  readRecipeJsonLd,
  type ImportFailureClass,
  type ImportSelfReport,
  type RecipeJsonLd,
} from './importChecks.ts';
import type { UnitSystem } from './accountPreferences.ts';
import { thrownStatus } from './importLog.ts';
import {
  isBlockingWarning,
  type ImportWarning,
  type ImportWarningCode,
} from './importWarnings.ts';
import {
  primaryRegion,
  recipeJsonLdNode,
  regionSource,
  scanPage,
  stripToText,
  type PageScan,
} from './pageScan.ts';
import { normalizeLang, sameLanguage, toSupportedLocale, type Locale } from './lang.ts';
import {
  pinnedGet,
  resolveHost,
  resolvePublicAddress,
  type PinnedGet,
  type PinnedResponse,
  type ResolveHost,
} from './netGuard.ts';
import { applyTranslation, recipeSegments, translationExceedsCaps } from './recipeTranslation.ts';
import {
  TRANSLATE_FAILED,
  geminiTranslateDepsFromEnv,
  translateSegments,
  validateTranslatedSegments,
  type TranslateInput,
  type TranslateOutcome,
} from './translate.ts';

export interface ImportedIngredient {
  quantity?: number;
  unit?: string;
  item: string;
  note?: string;
}

export interface ImportedIngredientSection {
  name?: string;
  items: ImportedIngredient[];
}

/** Structurally a `RecipeDraft` (src/lib/types.ts) without sourceUrl or photos. */
export interface ImportedRecipe {
  title: string;
  servings: number;
  ingredientSections: ImportedIngredientSection[];
  steps: { text: string }[];
  tags: string[];
  description?: string;
  notes?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  /** Canonical BCP 47 tag, when the source language could be normalized. */
  lang?: string;
}

/**
 * Bound `translateSegments`: the same input and outcome, with the provider
 * client already applied. Fakes implement this and must not call the network.
 * A missing key or unavailable provider resolves to `{ ok: false }`; it does
 * not throw.
 */
export type RecipeTranslator = (input: TranslateInput) => Promise<TranslateOutcome>;

/**
 * One photo: raw base64 with no data-URL prefix, the same shape as
 * `ChatRequestImage`. `importFromImages` trusts it, so callers validate first
 * (`checkImportImages` in `server/importRoute.ts`).
 */
export interface ImportImage {
  mediaType: string;
  base64: string;
}

export interface RecipeImportDeps {
  /** Only `models.generateContent` is used; fakes implement exactly this. */
  ai: { models: Pick<GoogleGenAI['models'], 'generateContent'> };
  model: string;
  translator: RecipeTranslator;
  /** Test seam: overrides `MAX_IMPORT_RETRIES` for page and paste imports. */
  maxRetries?: number;
  /** Test seam for the retry deadline. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Extra Gemini calls a page or paste import may make after the first, for a
 * hard failure or a blocking extraction warning. A code constant, not an env
 * var, so a deploy that replaces the env map cannot silently change it.
 * Phase 2 of `docs/plans/import-reliability.md` ships it at 0.
 */
export const MAX_IMPORT_RETRIES = 0;
/** No new attempt starts after this long, so one bulk row cannot stall the batch. */
export const IMPORT_RETRY_DEADLINE_MS = 40_000;

/** Longest brief `generateFromBrief` accepts; the route rejects longer ones, the client caps the textarea. */
export const MAX_GENERATE_BRIEF_CHARS = 2000;
/** Grounding sources kept on a generated recipe. */
export const MAX_GENERATE_SOURCES = 10;

export const IMPORT_BAD_LANGUAGE_CODE = 'import-bad-language';
export const IMPORT_BAD_LANGUAGE_ERROR = 'That language is not supported.';

/**
 * Absent is allowed. A present value must normalize to a supported UI
 * language (`ua` → `uk`, `zh-CN` → `zh-Hans`). Anything else is rejected.
 */
export function readImportTranslateTo(
  value: unknown,
): { ok: true; translateTo?: Locale } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const translateTo = toSupportedLocale(value);
  if (translateTo === undefined) {
    return { ok: false };
  }
  return { ok: true, translateTo };
}

export type ImportTranslation =
  | { kind: 'ok'; lang: string; recipe: ImportedRecipe }
  | { kind: 'failed' };

/** Whether a page import read the Recipe JSON-LD or the page text. Pasted text is `text`. */
export type ImportSourceRead = 'jsonld' | 'text';

/** One Gemini call's result, for the log line only. */
export interface ImportAttempt {
  result: 'ok' | 'warn' | 'not_a_recipe' | 'parse_error' | 'unusable' | 'threw';
  codes: ImportWarningCode[];
}

/** What the import log records about how the outcome was reached. Never recipe text. */
export interface ImportOutcomeLog {
  source?: ImportSourceRead;
  attempts: ImportAttempt[];
  /** A numeric status from the last thrown provider error, when it had one. */
  errorStatus?: number;
  /**
   * `generateFromBrief` with search on: how many searches the research call
   * ran, whatever the outcome. Never the queries themselves.
   */
  searchQueries?: number;
}

/** A page Gemini grounded a generated recipe on. */
export interface GenerateSource {
  /** Google's title for the page, usually the site name; `''` when Google gave none. */
  title: string;
  url: string;
}

/** What Google Search grounding reported for one `generateFromBrief` call. */
export interface GenerateGrounding {
  /** Distinct http(s) pages, in the order reported, at most `MAX_GENERATE_SOURCES`. */
  sources: GenerateSource[];
  /**
   * Google's Search Suggestions snippet (`searchEntryPoint.renderedContent`).
   * Google's terms require it to be shown with the result, as provided.
   */
  searchSuggestions?: string;
}

export type ImportOutcome =
  | {
      kind: 'ok';
      recipe: ImportedRecipe;
      translation?: ImportTranslation;
      /** Computed on the original extraction, before translation. May be empty. */
      warnings: ImportWarning[];
      /** `generateFromBrief` with search on, when Google reported anything. */
      grounding?: GenerateGrounding;
      log?: ImportOutcomeLog;
    }
  /** Nothing to send; Gemini is not called. */
  | { kind: 'empty_source'; log?: ImportOutcomeLog }
  /** The model reported that the source holds no recipe. */
  | { kind: 'not_a_recipe'; log?: ImportOutcomeLog }
  /** The model's output was not a JSON object. */
  | { kind: 'parse_error'; log?: ImportOutcomeLog }
  /** JSON, but `normalizeImportedRecipe` could not make a recipe of it. */
  | { kind: 'unusable'; log?: ImportOutcomeLog }
  /** The Gemini call threw on the last attempt (page and paste only; photos still throw). */
  | { kind: 'model_error'; log?: ImportOutcomeLog };

export type PageFetchOutcome =
  | { kind: 'ok'; html: string }
  | { kind: 'invalid_url' }
  | { kind: 'unsupported_scheme' }
  | { kind: 'unreachable' }
  /**
   * The host, or a redirect's host, resolves to an address that is not
   * public (`isPublicAddress`). Nothing was sent to it. Routes answer it as
   * `unreachable`; the kind exists so the log line can tell them apart.
   */
  | { kind: 'blocked' }
  | { kind: 'refused'; status: number };

const DEFAULT_MODEL = 'gemini-3.8-flash';

const MAX_SOURCE_CHARS = 60000;

// NOTE: `api/chat.ts` still carries its own copy of this schema for
// `update_recipe`. Keep the two in sync until chat gets the same treatment,
// except `lang` and `propertyOrdering`: they are import-only and must not be
// copied into `api/chat.ts`, whose Gemini request shape is frozen (AGENTS.md).
const RECIPE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    description: { type: Type.STRING, description: 'One or two sentences.' },
    servings: { type: Type.NUMBER },
    prepMinutes: { type: Type.NUMBER },
    cookMinutes: { type: Type.NUMBER },
    ingredientSections: {
      type: Type.ARRAY,
      description:
        'Use a single unnamed section unless the recipe clearly has component groups like "Sauce" and "Dough".',
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quantity: { type: Type.NUMBER, description: 'e.g. 0.5 for ½' },
                unit: {
                  type: Type.STRING,
                  description:
                    'Prefer one of: piece, tsp, tbsp, cup, ml, l, g, kg, oz, lb. Use "piece" for countable items when a unit reads naturally; omit the unit entirely for items counted without one. If none of these fit, use a short lowercase unit.',
                },
                item: { type: Type.STRING, description: 'The ingredient itself' },
                note: { type: Type.STRING, description: 'e.g. "thinly sliced"' },
              },
              required: ['item'],
            },
          },
        },
        required: ['items'],
      },
    },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ['text'],
      },
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2-4 short lowercase tags like "pasta", "weeknight".',
    },
    notes: { type: Type.STRING, description: 'Tips or variations worth keeping.' },
    lang: {
      type: Type.STRING,
      description:
        'BCP 47 language tag of the source recipe, such as "it" or "zh-Hans". Omit if you cannot tell.',
    },
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
  // Times before the required lists, so a free-form number is never the last
  // token: the lists always follow it, and the optional `notes` and `lang`
  // after them are strings. Left to itself the model writes the required
  // fields first and the optional ones after them, so `prepMinutes` came last
  // and sometimes ran on (20.000000000000004, or zeros until MAX_TOKENS,
  // which is a `parse_error`), and some runs dropped `description`, `notes`
  // and `lang` (evals/EXPERIMENTS.md, 2026-10-06).
  // `PAGE_RECIPE_SCHEMA` appends its two booleans to this order, so changing
  // it changes the page and paste request too and needs measuring
  // (evals/AGENTS.md).
  propertyOrdering: [
    'title',
    'description',
    'servings',
    'prepMinutes',
    'cookMinutes',
    'ingredientSections',
    'steps',
    'tags',
    'notes',
    'lang',
  ],
};

const RECIPE_OUTPUT_CONFIG = {
  maxOutputTokens: 4096,
  responseMimeType: 'application/json',
  responseSchema: RECIPE_SCHEMA,
};

/**
 * Page and paste imports only: `RECIPE_SCHEMA` plus the model's report of what
 * the source holds, one input to `checkImport`. The photo schema and the
 * `api/chat.ts` copy do not get these fields.
 */
const PAGE_RECIPE_SCHEMA: Schema = {
  ...RECIPE_SCHEMA,
  properties: {
    ...RECIPE_SCHEMA.properties,
    instructionsOnPage: {
      type: Type.BOOLEAN,
      description: 'Whether the source material itself contains the steps to make the dish.',
    },
    ingredientsOnPage: {
      type: Type.BOOLEAN,
      description: 'Whether the source material itself contains an ingredient list.',
    },
  },
  required: [...(RECIPE_SCHEMA.required ?? []), 'instructionsOnPage', 'ingredientsOnPage'],
  // The recipe order, then the two booleans. Without an order the model wrote
  // `prepMinutes` last, and a trailing number sometimes ran on until
  // MAX_TOKENS (`parse_error`) or came back as 5.000000000000001e-05;
  // a boolean cannot run on (evals/EXPERIMENTS.md, 2026-10-01).
  propertyOrdering: [...(RECIPE_SCHEMA.propertyOrdering ?? []), 'instructionsOnPage', 'ingredientsOnPage'],
};

const PAGE_RECIPE_OUTPUT_CONFIG = { ...RECIPE_OUTPUT_CONFIG, responseSchema: PAGE_RECIPE_SCHEMA };

/**
 * Recipe JSON-LD fields that say nothing about how to make the dish: reader
 * reviews and comments, ratings, and media. Dropped only when a node is over
 * the cap, where a site's review list would otherwise push the recipe's own
 * fields out and leave Gemini an unterminated object.
 */
const NON_RECIPE_JSON_LD_KEYS = [
  'review',
  'comment',
  'aggregateRating',
  'interactionStatistic',
  'video',
];

function recipeNodeSource(node: object): string {
  const full = JSON.stringify(node);
  if (full.length <= MAX_SOURCE_CHARS) return full;
  const trimmed: Record<string, unknown> = { ...node };
  for (const key of NON_RECIPE_JSON_LD_KEYS) delete trimmed[key];
  return JSON.stringify(trimmed).slice(0, MAX_SOURCE_CHARS);
}

/** What Gemini reads from a scanned page, and which branch produced it. */
function sourceFromScan(scan: PageScan): { source: string; read: ImportSourceRead } {
  const node = recipeJsonLdNode(scan);
  if (node !== null) {
    return { source: recipeNodeSource(node), read: 'jsonld' };
  }
  const text = stripToText(regionSource(scan.html, primaryRegion(scan)));
  return { source: text.slice(0, MAX_SOURCE_CHARS), read: 'text' };
}

/**
 * Prefers the schema.org/Recipe JSON-LD block most recipe sites embed
 * (compact and unambiguous); falls back to the page's stripped text,
 * preferring `<article>` / `<main>` so a news-article recipe is not lost
 * behind nav chrome. An empty Recipe block does not count. The `type`
 * attribute may be unquoted (`type=application/ld+json`), which HTML allows
 * and minifiers emit. `@graph` is unwrapped one level. A short article
 * yields to a larger `<main>` or `role="main"`.
 *
 * parse5 (with source locations, `server/pageScan.ts`) finds the script
 * bodies and the region slices. Both are cut from the original HTML. A Recipe
 * that exists only inside a comment does not win, because a comment is not
 * an element.
 */
export function extractRecipeSource(html: string): string {
  return sourceFromScan(scanPage(html)).source;
}
/**
 * The most page HTML import reads, from a fetch or from the extension
 * (`server/extensionImport.ts` refuses a larger tab with 413).
 */
export const MAX_PAGE_HTML_CHARS = 600_000;
/** The whole website fetch, every redirect and the body included. */
export const PAGE_FETCH_TIMEOUT_MS = 15_000;
export const MAX_PAGE_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const PAGE_REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'text/html',
};

/** How `fetchPageHtml` resolves and connects. Tests inject fakes. */
export type PageFetchDeps = {
  resolve: ResolveHost;
  get: PinnedGet;
  timeoutMs: number;
};

const LIVE_PAGE_FETCH: PageFetchDeps = {
  resolve: resolveHost,
  get: pinnedGet,
  timeoutMs: PAGE_FETCH_TIMEOUT_MS,
};

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** `URL.hostname` keeps the brackets of an IPv6 literal; DNS wants it bare. */
function lookupName(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Rejects with the abort reason once `signal` fires, whether or not `work` honours it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The decoder for a response: the `charset` in Content-Type when Node knows
 * it, else UTF-8. A `<meta charset>` inside the HTML is not sniffed, so a
 * non-UTF-8 page that declares its encoding only there still decodes as
 * UTF-8, as it did when this was `Response.text()`.
 */
function pageDecoder(contentType: string | undefined): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8');
}

/** Cuts at `MAX_PAGE_HTML_CHARS` without leaving half a surrogate pair. */
function capPageHtml(text: string): string {
  if (text.length <= MAX_PAGE_HTML_CHARS) return text;
  const end = /[\uD800-\uDBFF]/.test(text[MAX_PAGE_HTML_CHARS - 1]!)
    ? MAX_PAGE_HTML_CHARS - 1
    : MAX_PAGE_HTML_CHARS;
  return text.slice(0, end);
}

/**
 * Reads the body up to `MAX_PAGE_HTML_CHARS` and stops there. A longer page
 * is truncated, not refused: `extractRecipeSource` prefers the Recipe
 * JSON-LD and the `<main>` / `<article>` region, which usually sit well
 * inside the first 600 000 characters, and the model input is cut to
 * `MAX_SOURCE_CHARS` anyway. The extension refuses instead (413) because
 * there the browser already holds the whole page and the cap bounds the
 * request body.
 */
async function readPageText(
  body: PinnedResponse['body'],
  contentType: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const decoder = pageDecoder(contentType);
  const onAbort = () =>
    body.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    let text = '';
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array);
      text += decoder.decode(bytes, { stream: true });
      if (text.length >= MAX_PAGE_HTML_CHARS) {
        body.destroy();
        return capPageHtml(text);
      }
    }
    return capPageHtml(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Website URL path only. The Chrome extension sends the tab HTML instead.
 *
 * A member's URL is fetched by the server, so it must not reach anything
 * the server can reach but the internet cannot. Every hop resolves its host
 * and goes on only if every address is public (`server/netGuard.ts`); the
 * connection is pinned to the checked address, so DNS rebinding cannot swap
 * it. Redirects (301, 302, 303, 307, 308) are followed here, at most
 * `MAX_PAGE_REDIRECTS`, each with the scheme and address checks again. The
 * whole fetch has `PAGE_FETCH_TIMEOUT_MS`, and the body stops at
 * `MAX_PAGE_HTML_CHARS`. Nothing here logs the URL or an address.
 */
export async function fetchPageHtml(
  rawUrl: string,
  deps: PageFetchDeps = LIVE_PAGE_FETCH,
): Promise<PageFetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'invalid_url' };
  }
  // Matches RecipeView's http/https allowlist.
  if (!isHttpUrl(url)) {
    return { kind: 'unsupported_scheme' };
  }

  const signal = AbortSignal.timeout(deps.timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const address = await untilAborted(resolvePublicAddress(lookupName(url), deps.resolve), signal);
      if (address === null) {
        return { kind: 'blocked' };
      }
      const page = await untilAborted(
        deps.get(url, address, { headers: PAGE_REQUEST_HEADERS, signal }),
        signal,
      );
      const location = firstHeader(page.headers.location);
      if (REDIRECT_STATUSES.has(page.status) && location !== undefined) {
        page.body.destroy();
        if (redirects >= MAX_PAGE_REDIRECTS) {
          return { kind: 'unreachable' };
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { kind: 'unreachable' };
        }
        if (!isHttpUrl(next)) {
          return { kind: 'unreachable' };
        }
        url = next;
        continue;
      }
      if (page.status < 200 || page.status > 299) {
        page.body.destroy();
        return { kind: 'refused', status: page.status };
      }
      const html = await readPageText(page.body, firstHeader(page.headers['content-type']), signal);
      return { kind: 'ok', html };
    }
  } catch {
    // DNS failure, connection or TLS error, timeout, or a body that broke off.
    return { kind: 'unreachable' };
  }
}

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

/**
 * Longest prep or cook time an import keeps: about 69 days, so a real cure,
 * ferment or extract (21 days is 30,240) survives. It is not MCP's
 * `RECIPE_LIMITS.maxMinutes` (10,000, about 7 days), which would drop those.
 */
export const MAX_IMPORT_MINUTES = 100_000;

/**
 * A duration as whole minutes, or `undefined` to drop it. Negative values and
 * values that round to over `MAX_IMPORT_MINUTES` are dropped, which catches a
 * large whole-number run-on (305106198964720960). A fractional run-on rounds to the number it
 * started as (20.000000000000004 is 20), but a positive value that would
 * round to 0 (5.000000000000001e-05) is dropped: no time is better than a
 * wrong "0 min". 0 is kept, for a dish with no cooking, and -0 reads as 0
 * (evals/EXPERIMENTS.md, 2026-10-06).
 */
function wholeMinutes(value: unknown): number | undefined {
  const minutes = finiteNumber(value);
  if (minutes === undefined || minutes < 0) return undefined;
  const rounded = Math.round(minutes);
  if (rounded > MAX_IMPORT_MINUTES) return undefined;
  if (rounded === 0) return minutes > 0 ? undefined : 0;
  return rounded;
}

function normalizeIngredient(item: unknown): ImportedIngredient | undefined {
  if (!isPlainObject(item)) return undefined;
  const itemText = nonEmptyString(item.item);
  if (itemText === undefined) return undefined;
  const result: ImportedIngredient = { item: itemText };
  const quantity = finiteNumber(item.quantity);
  if (quantity !== undefined) result.quantity = quantity;
  const unit = nonEmptyString(item.unit);
  if (unit !== undefined) result.unit = unit;
  const note = nonEmptyString(item.note);
  if (note !== undefined) result.note = note;
  return result;
}

function normalizeIngredientSections(value: unknown): ImportedIngredientSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ImportedIngredientSection[] = [];
  for (const section of value) {
    if (!isPlainObject(section)) continue;
    const items = (Array.isArray(section.items) ? section.items : [])
      .map(normalizeIngredient)
      .filter((item): item is ImportedIngredient => item !== undefined);
    if (items.length === 0) continue;
    const name = nonEmptyString(section.name);
    sections.push(name !== undefined ? { name, items } : { items });
  }
  return sections;
}

function normalizeSteps(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const steps: { text: string }[] = [];
  for (const step of value) {
    if (!isPlainObject(step)) continue;
    const text = nonEmptyString(step.text);
    if (text !== undefined) steps.push({ text });
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

/**
 * Repairs what can be repaired of a model's output and returns `null` when it
 * cannot be saved at all. `title` is the only field with no sensible repair;
 * everything else is normalized or dropped. Unknown keys never survive.
 */
export function normalizeImportedRecipe(raw: unknown): ImportedRecipe | null {
  if (!isPlainObject(raw)) return null;

  const title = nonEmptyString(raw.title);
  if (title === undefined) return null;

  // A missing or nonsensical serving count would break the recipe view's
  // scaler, and bulk and extension imports save without review. One serving
  // is wrong but usable, and editable in the app.
  const servings = finiteNumber(raw.servings);

  const recipe: ImportedRecipe = {
    title,
    servings: servings === undefined || servings < 1 ? 1 : servings,
    ingredientSections: normalizeIngredientSections(raw.ingredientSections),
    steps: normalizeSteps(raw.steps),
    tags: normalizeTags(raw.tags),
  };

  const description = nonEmptyString(raw.description);
  if (description !== undefined) recipe.description = description;

  const notes = nonEmptyString(raw.notes);
  if (notes !== undefined) recipe.notes = notes;

  const prepMinutes = wholeMinutes(raw.prepMinutes);
  if (prepMinutes !== undefined) recipe.prepMinutes = prepMinutes;

  const cookMinutes = wholeMinutes(raw.cookMinutes);
  if (cookMinutes !== undefined) recipe.cookMinutes = cookMinutes;

  const lang = normalizeLang(raw.lang);
  if (lang !== undefined) recipe.lang = lang;

  return recipe;
}

/**
 * What `checkImport` compares an extraction against: whether the source
 * holds a method, the normalized grounding corpus, and the page's JSON-LD
 * counts. Built once per import, before the first Gemini call.
 */
export interface ImportCheckContext {
  read: ImportSourceRead;
  sourceHasInstructions: boolean;
  corpus: string;
  jsonLd?: RecipeJsonLd | null;
}

/** Context for pasted text, which is its own corpus. */
export function textCheckContext(text: string): ImportCheckContext {
  return {
    read: 'text',
    sourceHasInstructions: hasInstructionLikeContent({ text }),
    corpus: groundingCorpus({ text }),
  };
}

/** Context for page HTML, the same one `importFromHtml` builds. Offline calibration uses it. */
export function htmlCheckContext(html: string): ImportCheckContext {
  const scan = scanPage(html);
  return pageCheckContext(scan, sourceFromScan(scan).read);
}

function pageCheckContext(scan: PageScan, read: ImportSourceRead): ImportCheckContext {
  const jsonLd = readRecipeJsonLd(scan);
  return {
    read,
    sourceHasInstructions: hasInstructionLikeContent({ scan, jsonLd }),
    corpus: groundingCorpus({ scan, jsonLd }),
    jsonLd,
  };
}

const PAGE_PROMPT =
  'Extract the recipe from the source material below and save it. ' +
  'Convert fractions to decimals for quantities. Keep step texts ' +
  'faithful to the original but trim fluff. If the source contains ' +
  'no recipe, save a recipe with the title "NOT_A_RECIPE".\n\n';

type ExtractionAttempt =
  | { kind: 'ok'; recipe: ImportedRecipe; warnings: ImportWarning[]; failureClass: ImportFailureClass }
  | { kind: 'not_a_recipe' | 'parse_error' | 'unusable' | 'model_error' };

/**
 * Source text (pasted, or from `extractRecipeSource`) → outcome.
 * Each attempt is one Gemini call that stays faithful to the source, then
 * `checkImport`. A throw, unparseable or unusable output, or a blocking
 * extraction warning starts another attempt, up to `MAX_IMPORT_RETRIES` more
 * and never after `IMPORT_RETRY_DEADLINE_MS`. A source failure or "not a
 * recipe" never retries. With every attempt warned, the best one wins
 * (`pickBestAttempt`). `translateTo`, when set, may add a translation of the
 * chosen extraction; it never changes the calls. `check` defaults to treating
 * `source` as pasted text.
 */
export async function importFromSource(
  source: string,
  deps: RecipeImportDeps,
  translateTo?: string,
  check: ImportCheckContext = textCheckContext(source),
): Promise<ImportOutcome> {
  if (source.trim() === '') {
    return { kind: 'empty_source', log: { source: check.read, attempts: [] } };
  }

  const maxRetries = deps.maxRetries ?? MAX_IMPORT_RETRIES;
  const now = deps.now ?? Date.now;
  const started = now();
  const log: ImportOutcomeLog = { source: check.read, attempts: [] };
  const usable: Extract<ExtractionAttempt, { kind: 'ok' }>[] = [];
  let last: ExtractionAttempt = { kind: 'model_error' };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0 && now() - started >= IMPORT_RETRY_DEADLINE_MS) break;
    last = await extractOnce(source, deps, check, log);
    if (last.kind === 'not_a_recipe') break;
    if (last.kind !== 'ok') continue;
    usable.push(last);
    const blocks = last.warnings.some(isBlockingWarning);
    if (!blocks || last.failureClass !== 'extraction') break;
  }

  if (usable.length > 0) {
    const best = pickBestAttempt(usable);
    const finished = await finishImport(best.recipe, translateTo, deps);
    return { ...finished, warnings: best.warnings, log };
  }
  return { kind: last.kind === 'ok' ? 'unusable' : last.kind, log };
}


/** One Gemini call and its check. Records the attempt on `log`; never throws for the model. */
async function extractOnce(
  source: string,
  deps: RecipeImportDeps,
  check: ImportCheckContext,
  log: ImportOutcomeLog,
): Promise<ExtractionAttempt> {
  let text: string | undefined;
  try {
    const result = await deps.ai.models.generateContent({
      model: deps.model,
      contents: `${PAGE_PROMPT}Source material:\n${source}`,
      config: { ...PAGE_RECIPE_OUTPUT_CONFIG },
    });
    text = result.text;
  } catch (err) {
    return noteThrow(err, log);
  }
  const read = readModelText(text);
  if (read.kind !== 'ok') {
    log.attempts.push({ result: read.kind, codes: [] });
    return { kind: read.kind };
  }
  const { warnings, failureClass } = checkImport({
    recipe: read.recipe,
    selfReport: read.selfReport,
    jsonLd: check.jsonLd,
    sourceHasInstructions: check.sourceHasInstructions,
    corpus: check.corpus,
    blankItems: read.blankItems,
  });
  log.attempts.push({
    result: warnings.length > 0 ? 'warn' : 'ok',
    codes: warnings.map((w) => w.code),
  });
  return { kind: 'ok', recipe: read.recipe, warnings, failureClass };
}

/**
 * Records a thrown Gemini call on `log` and returns the `model_error` attempt.
 * Only a numeric status is kept from the error: SDK messages can echo the request.
 */
function noteThrow(err: unknown, log: ImportOutcomeLog): { kind: 'model_error' } {
  log.attempts.push({ result: 'threw', codes: [] });
  const status = thrownStatus(err);
  if (status !== undefined) log.errorStatus = status;
  else delete log.errorStatus;
  return { kind: 'model_error' };
}

function imageImportPrompt(extraText: string): string {
  const prompt = [
    'The photos are the pages of one recipe, often handwritten. Extract the recipe and save it.',
    'Read the pages in the order given: the first photo is page 1.',
    'Transcribe what is written. Skip anything that is crossed out.',
    "If you are unsure how a word reads, write your best reading followed by (?). If you are unsure of an amount, keep your best reading as the quantity and add (?) to that ingredient's note.",
    'If you cannot tell whether an amount is a tablespoon or a teaspoon (for example a T that could be a t), use your best reading and say so in notes.',
    'Never invent quantities, ingredients, or steps that are not written. If an amount is missing or unreadable, leave the quantity out.',
    'Convert fractions to decimals for quantities.',
    'If no title is written, use a short plain name for the dish. Give a description or prep and cook times only if they are written. If servings are not written, use 1.',
    'If the photos contain no recipe, save a recipe with the title "NOT_A_RECIPE".',
  ].join('\n');
  const notes = extraText.trim();
  if (notes === '') return prompt;
  return (
    `${prompt}\n\nNotes from the person importing these photos (context only; the photos are the source):\n` +
    notes.slice(0, MAX_SOURCE_CHARS)
  );
}

/**
 * Photos of one recipe, in page order, plus optional notes → outcome.
 * The one Gemini call extracts. `translateTo`, when set, may add a translation
 * and never changes that call.
 */
export async function importFromImages(
  images: readonly ImportImage[],
  extraText: string,
  deps: RecipeImportDeps,
  translateTo?: string,
): Promise<ImportOutcome> {
  if (images.length === 0) {
    return { kind: 'empty_source' };
  }

  const result = await deps.ai.models.generateContent({
    model: deps.model,
    contents: [
      {
        role: 'user',
        parts: [
          ...images.map((image) => ({
            inlineData: { mimeType: image.mediaType, data: image.base64 },
          })),
          { text: imageImportPrompt(extraText) },
        ],
      },
    ],
    config: {
      ...RECIPE_OUTPUT_CONFIG,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
    },
  });

  const read = readModelText(result.text);
  if (read.kind !== 'ok') return { kind: read.kind };
  // Photo import runs no checks (constitution `image-import.md`, principle 1).
  const finished = await finishImport(read.recipe, translateTo, deps);
  return { ...finished, warnings: [] };
}

/**
 * How the structured call uses the member's kitchen profile
 * (`docs/plans/kitchen-profile.md`). Allergens and "never include" foods are
 * never written, even when the brief names one; the diet and dislikes give
 * way to a brief that explicitly asks otherwise.
 */
const KITCHEN_PROFILE_GENERATE_RULE =
  'Write for the kitchen profile above: never include an allergen or a "never include" food, even if the request names one; use a substitute and say so in notes. Follow the diet and leave out the dislikes unless the request explicitly asks otherwise. Treat the equipment as notes, not a full list: never need anything the profile says is missing.';

/**
 * For a member who chose Metric in Settings (`docs/plans/measurement-units.md`).
 * A unit the request names still wins.
 */
const METRIC_GENERATE_RULE =
  'The user cooks in metric: write weights in g or kg, liquids in ml or l (teaspoons and tablespoons are fine for small amounts), oven temperatures in °C, and sizes in cm, unless the request asks for other units.';

/**
 * The prompt for a recipe written from an idea. It is the opposite of
 * `PAGE_PROMPT` and `imageImportPrompt`, which never invent: here the model is
 * asked to fill in everything the brief leaves out. `evals/recipeGenerate.eval.ts`
 * exercises it live; `server/recipeImport.test.ts` pins its key phrases.
 * With `withNotes`, the research call's notes follow the request; with a
 * `kitchenProfile` block, the profile and its rule close the prompt.
 */
function generatePrompt(withNotes: boolean, kitchenProfile = '', units: UnitSystem = 'asWritten'): string {
  const fillIn =
    'Fill in the ingredients with quantities and the method as clear numbered steps from your knowledge of cooking.' +
    (withNotes
      ? ' Notes from a web search follow the request: combine what they say in your own words, prefer them where they disagree with your memory, and never copy one page\'s recipe.'
      : '');
  return [
    'The request below is an idea for a dish, not a finished recipe. Write a complete recipe that someone can cook from, and save it.',
    fillIn,
    'Keep every constraint the request states: equipment, diet, cuisine, ingredients to use or avoid, servings, time.',
    'Convert fractions to decimals for quantities. Give realistic prep and cook minutes. Set servings to what the request says; otherwise 4.',
    'Write in the language the request is written in, and set lang to it.',
    'Put a short description of the dish in description, and tips or variations in notes.',
    'If the request is not about something that can be cooked or eaten, save a recipe with the title "NOT_A_RECIPE".',
    ...(kitchenProfile !== '' ? [kitchenProfile, KITCHEN_PROFILE_GENERATE_RULE] : []),
    ...(units === 'metric' ? [METRIC_GENERATE_RULE] : []),
  ].join('\n');
}

/**
 * The research call that runs before the structured call when search is on.
 * Measured 2026-10-05 (`evals/EXPERIMENTS.md`): with the Google Search tool on
 * the structured call itself, the model never searched for a known dish (0 of
 * 17 runs, however firmly the prompt asked), but a call framed as research
 * searched every time (3 of 3). So the search happens here, as free text,
 * and the structured call writes from these notes.
 */
function researchPrompt(request: string): string {
  return (
    'Use Google Search to find at least three published recipes that match the request below. ' +
    'Report what you found, not a recipe of your own: for each page, its name, the main ingredients with quantities, ' +
    'the method in a few lines, and the timings. Note where the pages disagree. Keep it under 400 words.\n\n' +
    `Request:\n${request}`
  );
}

/** Output cap for the research call; its notes are cut to `MAX_RESEARCH_NOTE_CHARS` before the structured call. */
const RESEARCH_MAX_OUTPUT_TOKENS = 2048;
const MAX_RESEARCH_NOTE_CHARS = 6000;

/** `value` parsed as an http(s) URL, or `undefined`. */
function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return isHttpUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The grounding Google reported, reduced to what the client shows.
 * Google issues one redirect URL per chunk, so a page can appear several
 * times with the same title; the title is the second de-duplication key.
 * An untitled page keeps `title: ''` (the client labels it) and is never
 * merged by title: every link is a redirect on Google's host, so a host name
 * would neither tell pages apart nor name the site.
 * `undefined` when no page and no chip came back.
 */
function readGrounding(metadata: GroundingMetadata | undefined): GenerateGrounding | undefined {
  if (metadata === undefined) return undefined;
  const sources: GenerateSource[] = [];
  const seen = new Set<string>();
  for (const chunk of metadata.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (httpUrl(uri) === undefined || typeof uri !== 'string' || seen.has(uri)) continue;
    const title = typeof chunk.web?.title === 'string' ? chunk.web.title.trim() : '';
    if (title !== '' && seen.has(`title:${title}`)) continue;
    seen.add(uri);
    if (title !== '') seen.add(`title:${title}`);
    sources.push({ title, url: uri });
    if (sources.length >= MAX_GENERATE_SOURCES) break;
  }
  const rendered = metadata.searchEntryPoint?.renderedContent;
  const searchSuggestions =
    typeof rendered === 'string' && rendered.trim() !== '' ? rendered : undefined;
  if (sources.length === 0 && searchSuggestions === undefined) return undefined;
  return { sources, ...(searchSuggestions !== undefined ? { searchSuggestions } : {}) };
}

/**
 * A short brief ("shrimp gumbo in a pressure cooker") → a recipe the model
 * writes. One structured Gemini call with `RECIPE_SCHEMA`. With `search` on,
 * a research call with the Google Search tool runs first (`researchPrompt`);
 * its notes go into the structured call and the pages it used come back as
 * `grounding`. No import checks run, because there is no source to compare
 * against: instead a recipe with no ingredients or no steps is `unusable`
 * (one step is fine here: a drink or a dressing can be written that way, and
 * the model was asked for the method, not quoted). A throw from either call is `model_error`, as for
 * pasted text. `translateTo` works as for every other import.
 */
export async function generateFromBrief(
  brief: string,
  deps: RecipeImportDeps,
  options: {
    search: boolean;
    translateTo?: string;
    /** The member's `kitchenProfilePromptBlock`, or empty. Only the structured call sees it, never the search. */
    kitchenProfile?: string;
    /** The member's measurement units; `metric` adds a rule to the structured call, never the search. */
    units?: UnitSystem;
  },
): Promise<ImportOutcome> {
  const log: ImportOutcomeLog = { attempts: [] };
  const request = brief.trim();
  if (request === '') {
    return { kind: 'empty_source', log };
  }

  let notes: string | undefined;
  let grounding: GenerateGrounding | undefined;
  if (options.search) {
    try {
      const research = await deps.ai.models.generateContent({
        model: deps.model,
        contents: researchPrompt(request),
        config: { maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS, tools: [{ googleSearch: {} }] },
      });
      const found = research.text?.trim() ?? '';
      if (found !== '') notes = found.slice(0, MAX_RESEARCH_NOTE_CHARS);
      const metadata = research.candidates?.[0]?.groundingMetadata;
      // Counted whatever the structured call does next: the searches ran either way.
      log.searchQueries = metadata?.webSearchQueries?.length ?? 0;
      grounding = readGrounding(metadata);
    } catch (err) {
      return { ...noteThrow(err, log), log };
    }
  }

  let text: string | undefined;
  try {
    const result = await deps.ai.models.generateContent({
      model: deps.model,
      contents:
        `${generatePrompt(notes !== undefined, options.kitchenProfile, options.units)}\n\nRequest:\n${request}` +
        (notes !== undefined ? `\n\nNotes from a web search:\n${notes}` : ''),
      config: { ...RECIPE_OUTPUT_CONFIG },
    });
    text = result.text;
  } catch (err) {
    return { ...noteThrow(err, log), log };
  }

  const read = readModelText(text);
  if (read.kind !== 'ok') {
    log.attempts.push({ result: read.kind, codes: [] });
    return { kind: read.kind, log };
  }
  const recipe = read.recipe;
  const ingredients = recipe.ingredientSections.reduce((n, section) => n + section.items.length, 0);
  if (ingredients === 0 || recipe.steps.length === 0) {
    log.attempts.push({ result: 'unusable', codes: [] });
    return { kind: 'unusable', log };
  }
  log.attempts.push({ result: 'ok', codes: [] });
  const finished = await finishImport(recipe, options.translateTo, deps);
  return {
    ...finished,
    warnings: [],
    ...(grounding !== undefined ? { grounding } : {}),
    log,
  };
}

/** Ingredients and steps the model returned with blank text, before normalization drops them. */
function countBlankItems(raw: Record<string, unknown>): number {
  let blank = 0;
  const isBlank = (row: unknown, field: string) =>
    isPlainObject(row) && (typeof row[field] !== 'string' || row[field].trim() === '');
  if (Array.isArray(raw.ingredientSections)) {
    for (const section of raw.ingredientSections) {
      if (!isPlainObject(section) || !Array.isArray(section.items)) continue;
      blank += section.items.filter((item) => isBlank(item, 'item')).length;
    }
  }
  if (Array.isArray(raw.steps)) {
    blank += raw.steps.filter((step) => isBlank(step, 'text')).length;
  }
  return blank;
}

type ModelRead =
  | {
      kind: 'ok';
      recipe: ImportedRecipe;
      selfReport: ImportSelfReport;
      blankItems: number;
    }
  | { kind: 'not_a_recipe' | 'parse_error' | 'unusable' };

/**
 * Parses one model response. `normalizeImportedRecipe` still strips unknown
 * keys; the page schema's self-report is read beside it and never reaches
 * the recipe.
 */
function readModelText(text: string | undefined): ModelRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    return { kind: 'parse_error' };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'parse_error' };
  }
  if (parsed.title === 'NOT_A_RECIPE') {
    return { kind: 'not_a_recipe' };
  }
  const recipe = normalizeImportedRecipe(parsed);
  if (recipe === null) {
    return { kind: 'unusable' };
  }
  const selfReport: ImportSelfReport = {};
  if (typeof parsed.instructionsOnPage === 'boolean') {
    selfReport.instructionsOnPage = parsed.instructionsOnPage;
  }
  if (typeof parsed.ingredientsOnPage === 'boolean') {
    selfReport.ingredientsOnPage = parsed.ingredientsOnPage;
  }
  return { kind: 'ok', recipe, selfReport, blankItems: countBlankItems(parsed) };
}

/**
 * Page HTML → outcome: one scan gives both what Gemini reads
 * (`extractRecipeSource`'s branch) and what the checks compare against.
 */
export function importFromHtml(
  html: string,
  deps: RecipeImportDeps,
  translateTo?: string,
): Promise<ImportOutcome> {
  const scan = scanPage(html);
  const { source, read } = sourceFromScan(scan);
  return importFromSource(source, deps, translateTo, pageCheckContext(scan, read));
}

/**
 * The only environment read in this module. Call it per request, not at module scope.
 * The translator reads env when it is called, the same way extraction reads the key here.
 */
export function recipeImportDepsFromEnv(wrapAi: WrapAi = (ai) => ai): RecipeImportDeps {
  return {
    ai: wrapAi(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })),
    // `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
    model: process.env.CHAT_MODEL || DEFAULT_MODEL,
    translator: (input) => translateWithEnv(input, wrapAi),
  };
}

/**
 * Wraps each model client the deps build, extraction's and the translator's
 * alike (the routes pass `meteredAi` from `server/llmBudget.ts`).
 */
export type WrapAi = (ai: RecipeImportDeps['ai']) => RecipeImportDeps['ai'];

/** Missing key and provider errors are translation failures, not thrown import errors. */
async function translateWithEnv(input: TranslateInput, wrapAi: WrapAi): Promise<TranslateOutcome> {
  const built = geminiTranslateDepsFromEnv();
  if (!built.ok) {
    return { ok: false, code: TRANSLATE_FAILED };
  }
  try {
    return await translateSegments(input, { ...built.deps, ai: wrapAi(built.deps.ai) });
  } catch {
    return { ok: false, code: TRANSLATE_FAILED };
  }
}

type TranslationAttempt =
  | { kind: 'failed' }
  | { kind: 'ok'; detectedLang: string | null; recipe: ImportedRecipe };

async function translateRecipe(
  recipe: ImportedRecipe,
  translateTo: string,
  translator: RecipeTranslator,
  sourceLang: string | undefined,
): Promise<TranslationAttempt> {
  const segments = recipeSegments(recipe);
  if (translationExceedsCaps(segments)) {
    return { kind: 'failed' };
  }
  const input: TranslateInput = { segments, target: translateTo };
  if (sourceLang !== undefined) {
    input.sourceLang = sourceLang;
  }
  let outcome: TranslateOutcome;
  try {
    outcome = await translator(input);
  } catch {
    return { kind: 'failed' };
  }
  if (!outcome.ok) {
    return { kind: 'failed' };
  }
  const validated = validateTranslatedSegments(
    segments.map((segment) => segment.id),
    outcome.segments,
  );
  if (!validated.ok) {
    return { kind: 'failed' };
  }
  const applied = applyTranslation(recipe, validated.segments);
  return {
    kind: 'ok',
    detectedLang: normalizeLang(outcome.detectedLang) ?? null,
    recipe: { ...applied, lang: translateTo },
  };
}

/**
 * `translateTo` unset: the extraction alone.
 * Same language: skip the translator.
 * Different: translate with the extracted source language.
 * Missing or ambiguous (`sameLanguage` is `unknown`, including bare `zh`
 * against `zh-Hans`): translate with no source language. A detected language
 * that matches the target discards the translation and labels the original.
 * Otherwise the original is labelled with the detection and the translation
 * is returned. Provider failure, caps, and bad segments set `translation`
 * to `{ kind: 'failed' }` and still return the original. Callers add the
 * warnings, which this never changes.
 */
async function finishImport(
  recipe: ImportedRecipe,
  translateTo: string | undefined,
  deps: RecipeImportDeps,
): Promise<{ kind: 'ok'; recipe: ImportedRecipe; translation?: ImportTranslation }> {
  if (translateTo === undefined) {
    return { kind: 'ok', recipe };
  }
  const comparison = sameLanguage(recipe.lang, translateTo);
  if (comparison === 'same') {
    return { kind: 'ok', recipe };
  }
  const knownSource = comparison === 'different';
  const attempt = await translateRecipe(
    recipe,
    translateTo,
    deps.translator,
    knownSource ? recipe.lang : undefined,
  );
  if (attempt.kind === 'failed') {
    return { kind: 'ok', recipe, translation: { kind: 'failed' } };
  }
  if (
    !knownSource &&
    attempt.detectedLang !== null &&
    sameLanguage(attempt.detectedLang, translateTo) === 'same'
  ) {
    return { kind: 'ok', recipe: { ...recipe, lang: attempt.detectedLang } };
  }
  const original =
    !knownSource && attempt.detectedLang !== null
      ? { ...recipe, lang: attempt.detectedLang }
      : recipe;
  return {
    kind: 'ok',
    recipe: original,
    translation: { kind: 'ok', lang: translateTo, recipe: attempt.recipe },
  };
}
