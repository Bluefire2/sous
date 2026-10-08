/**
 * `POST /api/import` — URL, pasted text, up to 4 photos, or a brief for the
 * model to write a recipe from, in; a recipe draft out for the client to
 * review and save. Gated by `withMembership` in `scripts/server.ts`. The
 * pipeline lives in `server/recipeImport.ts`; this file only maps its
 * outcomes to HTTP and writes one log line per request (`server/importLog.ts`).
 *
 * Photo import is bound by `docs/constitutions/image-import.md`. Writing a
 * recipe from a brief is `docs/plans/recipe-generation.md`.
 */
import {
  loggableUrl,
  noteImportOutcome,
  thrownStatus,
  withImportLog,
  type ImportLogEntry,
} from './importLog.ts';
import { readKitchenProfileBlock, type KitchenProfileStore } from './kitchenProfile.ts';
import {
  RequestBodyError,
  readBoundedText,
  storeUnavailable,
  type MembershipHandlerContext,
} from './membership.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  MAX_GENERATE_BRIEF_CHARS,
  fetchPageHtml,
  generateFromBrief,
  importFromHtml,
  importFromImages,
  importFromSource,
  readImportTranslateTo,
  recipeImportDepsFromEnv,
  type ImportImage,
  type ImportOutcome,
  type PageFetchOutcome,
  type RecipeImportDeps,
} from './recipeImport.ts';
import { admitTranslateCall } from './recipeTranslation.ts';
import { admitLlm, llmRefusal, meteredAi, type LlmMeter, type LlmRoute } from './llmBudget.ts';

export const MAX_IMPORT_IMAGES = 4;
/** Decoded bytes, per image. */
export const MAX_IMPORT_IMAGE_BYTES = 3 * 1024 * 1024;
/** Raw request body. Four images at the per-image cap exceed it. */
export const MAX_IMPORT_BODY_BYTES = 12 * 1024 * 1024;
export const IMPORT_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

interface ImportRequestBody {
  /** URL of a recipe page to fetch and extract. */
  url?: string;
  /** Raw recipe text pasted by the user (used when no url is given). */
  text?: string;
  /** Supported UI language. When set, the response may include a translation. */
  translateTo?: unknown;
  /**
   * Photos of one recipe, `{ mediaType, base64 }`, used only when `url` is
   * absent. `text` becomes extra context.
   */
  images?: unknown;
  /**
   * An idea for a dish for the model to write a recipe from. Used when `url`
   * and `images` are absent; wins over `text`. A string of at most
   * `MAX_GENERATE_BRIEF_CHARS`.
   */
  brief?: unknown;
  /** With `brief`: let Gemini run Google searches for it. A boolean. */
  search?: unknown;
}

/**
 * Searched generations per member per hour, per container instance. Each
 * search Google runs is billed, so the brief path is the only import that is
 * rate-limited; unsearched briefs cost what a paste import costs.
 */
export const MAX_IMPORT_SEARCHES_PER_HOUR = 20;
const SEARCH_WINDOW_MS = 60 * 60 * 1000;
const searchBuckets = new Map<string, number[]>();

/** Test hook: clears the per-instance search rate-limit buckets. */
export function resetImportSearchRateLimitForTest(): void {
  searchBuckets.clear();
}

/**
 * Runs `run` with model deps charged to the member's daily budget
 * (`server/llmBudget.ts`), or answers the refusal. `deps` is the test seam;
 * otherwise the deps come from env, the translator's client metered too.
 */
export async function withImportBudget(
  sub: string,
  route: LlmRoute,
  entry: ImportLogEntry,
  deps: RecipeImportDeps | undefined,
  run: (deps: RecipeImportDeps) => Promise<Response>,
): Promise<Response> {
  const admission = await admitLlm(sub, route);
  if (admission.kind !== 'ok') {
    entry.outcome = 'llm_refused';
    return llmRefusal(admission);
  }
  const { meter } = admission;
  try {
    return await run(meteredImportDeps(deps, meter));
  } finally {
    meter.release();
  }
}

/**
 * `deps` (the test seam) or the env deps, with every model client charged to
 * `meter`. With `deps`, only `deps.ai` is wrapped: a test's translator is a
 * plain function with no client to meter.
 */
export function meteredImportDeps(deps: RecipeImportDeps | undefined, meter: LlmMeter): RecipeImportDeps {
  const wrap = (ai: RecipeImportDeps['ai']) => meteredAi(ai, meter);
  return deps !== undefined ? { ...deps, ai: wrap(deps.ai) } : recipeImportDepsFromEnv(wrap);
}

export type ImportImagesCheck =
  | { kind: 'absent' } // undefined, null, or []
  | { kind: 'ok'; images: ImportImage[]; bytes: number } // bytes = decoded total
  | { kind: 'too_many' }
  | { kind: 'bad_type' }
  | { kind: 'unreadable' }
  | { kind: 'too_large' };

const NOTHING_TO_IMPORT = 'Provide a URL, recipe text, or photos.';
const BODY_TOO_LARGE = "That's too large to import — try fewer photos.";
const PHOTOS_NOT_A_RECIPE = "Couldn't find a recipe in those photos.";
const MODEL_FAILED = "Couldn't read that recipe — try again.";
const BRIEF_TOO_LONG = "That's too long — keep the idea under 2,000 characters.";
const SEARCH_RATE_LIMITED = 'Too many web searches. Try again later, or turn Search the web off.';
const BRIEF_NOT_A_RECIPE = "Couldn't make a recipe from that — describe a dish.";
const GENERATE_FAILED = "Couldn't generate that recipe — try again.";

const NOT_A_RECIPE_DEFAULT = { code: 'import-no-recipe', error: "Couldn't find a recipe in that content." };
const MODEL_FAILED_DEFAULT = { code: 'import-model-failed', error: MODEL_FAILED };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((byte, i) => bytes[at + i] === byte);
}

function hasMagic(mediaType: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  switch (mediaType) {
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}

/** Validates `images` from a request body. The first failure wins, in the order checked. */
export function checkImportImages(raw: unknown): ImportImagesCheck {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!Array.isArray(raw)) return { kind: 'unreadable' };
  if (raw.length === 0) return { kind: 'absent' };
  if (raw.length > MAX_IMPORT_IMAGES) return { kind: 'too_many' };

  const images: ImportImage[] = [];
  let bytes = 0;
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.mediaType !== 'string' || typeof item.base64 !== 'string') {
      return { kind: 'unreadable' };
    }
    const mediaType = item.mediaType.trim().toLowerCase();
    if (!IMPORT_IMAGE_TYPES.has(mediaType)) return { kind: 'bad_type' };
    const base64 = item.base64;
    if (base64 === '' || base64.length % 4 !== 0 || !BASE64.test(base64)) {
      return { kind: 'unreadable' };
    }
    const size = decodedBytes(base64);
    if (size > MAX_IMPORT_IMAGE_BYTES) return { kind: 'too_large' };
    if (!hasMagic(mediaType, base64)) return { kind: 'unreadable' };
    images.push({ mediaType, base64 });
    bytes += size;
  }
  return { kind: 'ok', images, bytes };
}

function imagesFailure(check: Exclude<ImportImagesCheck, { kind: 'absent' } | { kind: 'ok' }>): Response {
  switch (check.kind) {
    case 'too_many':
      return fail('import-too-many-photos', 'Up to 4 photos.', 400);
    case 'bad_type':
      return fail('import-bad-photo-type', 'Photos must be JPEG, PNG, or WebP.', 400);
    case 'unreadable':
      return fail('import-photos-unreadable', "Those photos couldn't be read.", 400);
    case 'too_large':
      return fail('import-photos-too-large', 'Those photos are too large.', 413);
  }
}

function fail(code: string, error: string, status: number, siteStatus?: number): Response {
  const body: { error: string; code: string; status?: number } = { error, code };
  if (siteStatus !== undefined) {
    body.status = siteStatus;
  }
  return Response.json(body, { status });
}

function fetchFailure(page: Exclude<PageFetchOutcome, { kind: 'ok' }>): Response {
  switch (page.kind) {
    case 'invalid_url':
      return fail('import-bad-url', 'That does not look like a web address.', 422);
    case 'unsupported_scheme':
      return fail('import-bad-scheme', 'Only http and https URLs are supported.', 422);
    case 'unreachable':
    // A non-public address gets the same answer as a dead host, so the
    // response says nothing about what the server's network can reach.
    case 'blocked':
      return fail('import-unreachable', 'Could not reach that URL.', 422);
    case 'refused':
      return fail(
        'import-refused',
        `The site refused the request (${page.status}). Try pasting the recipe text instead.`,
        422,
        page.status,
      );
  }
}

function outcomeResponse(
  outcome: ImportOutcome,
  sourceUrl: string | undefined,
  copy: {
    notARecipe?: { code: string; error: string };
    modelFailed?: { code: string; error: string };
    /** Replaces the extraction wording for `parse_error` and `unusable` (a generated recipe). */
    noRecipe?: { code: string; error: string };
  } = {},
): Response {
  const notARecipe = copy.notARecipe ?? NOT_A_RECIPE_DEFAULT;
  const modelFailed = copy.modelFailed ?? MODEL_FAILED_DEFAULT;
  switch (outcome.kind) {
    case 'ok': {
      const recipe = { ...outcome.recipe, sourceUrl };
      // Codes only; the client owns the words (i18n principle 10).
      const warnings = outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {};
      // The pages a generated recipe was grounded on, and Google's chip.
      const grounding =
        outcome.grounding !== undefined
          ? {
              grounding: {
                sources: outcome.grounding.sources,
                ...(outcome.grounding.searchSuggestions !== undefined
                  ? { searchSuggestions: outcome.grounding.searchSuggestions }
                  : {}),
              },
            }
          : {};
      const translation = outcome.translation;
      if (translation?.kind === 'ok') {
        return Response.json({
          recipe,
          translation: {
            lang: translation.lang,
            recipe: { ...translation.recipe, sourceUrl },
          },
          ...warnings,
          ...grounding,
        });
      }
      if (translation?.kind === 'failed') {
        return Response.json({ recipe, translationFailed: true, ...warnings, ...grounding });
      }
      return Response.json({ recipe, ...warnings, ...grounding });
    }
    case 'empty_source':
      return fail('import-empty', NOTHING_TO_IMPORT, 400);
    case 'not_a_recipe':
      return fail(notARecipe.code, notARecipe.error, 422);
    case 'parse_error':
      if (copy.noRecipe !== undefined) return fail(copy.noRecipe.code, copy.noRecipe.error, 502);
      return fail('import-extract-failed', 'Extraction failed — no structured result.', 502);
    case 'unusable':
      if (copy.noRecipe !== undefined) return fail(copy.noRecipe.code, copy.noRecipe.error, 502);
      return fail('import-unusable', 'Extraction produced an unusable recipe.', 502);
    case 'model_error':
      return fail(modelFailed.code, modelFailed.error, 502);
  }
}

export function importPost(
  req: Request,
  ctx?: MembershipHandlerContext,
  deps?: RecipeImportDeps,
  kitchenStore?: KitchenProfileStore,
): Promise<Response> {
  const entry: ImportLogEntry = {};
  // Log line only; `withMembership` has already decided access.
  if (ctx !== undefined) entry.sub = ctx.authorizedSub;
  return withImportLog(entry, () => handleImport(req, entry, deps, kitchenStore));
}

/** `importPost` without the log line; it records what happened on `entry`. */
async function handleImport(
  req: Request,
  entry: ImportLogEntry,
  deps: RecipeImportDeps | undefined,
  kitchenStore: KitchenProfileStore | undefined,
): Promise<Response> {
  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_IMPORT_BODY_BYTES);
  } catch (err) {
    if (!(err instanceof RequestBodyError)) throw err;
    // The client went away mid-upload; nobody reads this answer.
    entry.outcome = 'aborted';
    return fail('bad-request', 'Bad request', 400);
  }
  if (raw === null) {
    entry.outcome = 'too_large';
    return fail('import-body-too-large', BODY_TOO_LARGE, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    entry.outcome = 'bad_request';
    return fail('bad-request', 'Bad request', 400);
  }
  if (!isPlainObject(parsed)) {
    entry.outcome = 'bad_request';
    return fail('bad-request', 'Bad request', 400);
  }
  const body = parsed as ImportRequestBody;
  // `entry.sub` is the membership gate's decision; `withMembership` always
  // passes it, so only direct calls without a context (tests) share the '' bucket.
  const member = entry.sub ?? '';
  const target = readImportTranslateTo(body.translateTo);
  if (!target.ok) {
    entry.outcome = 'bad_language';
    return fail(IMPORT_BAD_LANGUAGE_CODE, IMPORT_BAD_LANGUAGE_ERROR, 400);
  }

  if (body.url) {
    entry.via = 'url';
    Object.assign(entry, loggableUrl(body.url));
    const page = await fetchPageHtml(body.url);
    entry.fetch = page.kind;
    if (page.kind !== 'ok') {
      if (page.kind === 'refused') entry.siteStatus = page.status;
      entry.outcome = 'fetch_failed';
      return fetchFailure(page);
    }
    const url = body.url;
    return withImportBudget(member, 'import', entry, deps, async (metered) => {
      const outcome = await importFromHtml(page.html, metered, target.translateTo);
      noteImportOutcome(entry, outcome);
      return outcomeResponse(outcome, url);
    });
  }

  const check = checkImportImages(body.images);
  if (check.kind === 'ok') {
    const { images, bytes } = check;
    entry.via = 'photos';
    entry.photos = images.length;
    entry.bytes = bytes;
    const notes = typeof body.text === 'string' ? body.text : '';
    return withImportBudget(member, 'import', entry, deps, async (metered) => {
      let outcome: ImportOutcome;
      try {
        outcome = await importFromImages(images, notes, metered, target.translateTo);
      } catch (err) {
        // Only a numeric status is kept from the error: SDK messages can echo the request.
        entry.outcome = 'threw';
        const status = thrownStatus(err);
        if (status !== undefined) entry.errorStatus = status;
        return fail('import-photos-failed', "Couldn't read those photos — try again.", 502);
      }
      noteImportOutcome(entry, outcome);
      return outcomeResponse(outcome, undefined, {
        notARecipe: { code: 'import-no-recipe-photos', error: PHOTOS_NOT_A_RECIPE },
      });
    });
  }
  if (check.kind !== 'absent') {
    entry.via = 'photos';
    entry.outcome = 'bad_photos';
    return imagesFailure(check);
  }

  if (body.brief !== undefined && body.brief !== null) {
    entry.via = 'generate';
    if (typeof body.brief !== 'string' || (body.search !== undefined && typeof body.search !== 'boolean')) {
      entry.outcome = 'bad_request';
      return fail('bad-request', 'Bad request', 400);
    }
    const search = body.search === true;
    entry.search = search;
    const brief = body.brief.trim();
    if (brief === '') {
      entry.outcome = 'empty_source';
      return fail('import-empty', NOTHING_TO_IMPORT, 400);
    }
    if (brief.length > MAX_GENERATE_BRIEF_CHARS) {
      entry.outcome = 'bad_brief';
      return fail('import-brief-too-long', BRIEF_TOO_LONG, 400);
    }
    // Read before a search slot or the day's budget is taken. A failed read is
    // 503: a recipe written without the member's allergies is worse than none.
    let kitchenProfile = '';
    if (member !== '') {
      try {
        kitchenProfile = await readKitchenProfileBlock(member, kitchenStore);
      } catch {
        entry.outcome = 'store_unavailable';
        return storeUnavailable();
      }
    }
    if (
      search &&
      !admitTranslateCall(searchBuckets, member, Date.now(), MAX_IMPORT_SEARCHES_PER_HOUR, SEARCH_WINDOW_MS)
    ) {
      entry.outcome = 'rate_limited';
      return fail('import-search-rate-limited', SEARCH_RATE_LIMITED, 429);
    }
    return withImportBudget(member, 'import', entry, deps, async (metered) => {
      const outcome = await generateFromBrief(brief, metered, {
        search,
        translateTo: target.translateTo,
        kitchenProfile,
      });
      noteImportOutcome(entry, outcome);
      return outcomeResponse(outcome, undefined, {
        notARecipe: { code: 'import-no-recipe-brief', error: BRIEF_NOT_A_RECIPE },
        modelFailed: { code: 'import-generate-failed', error: GENERATE_FAILED },
        noRecipe: { code: 'import-generate-failed', error: GENERATE_FAILED },
      });
    });
  }

  entry.via = 'paste';
  const text = body.text?.trim() ?? '';
  if (text === '') {
    entry.outcome = 'empty_source';
    return fail('import-empty', NOTHING_TO_IMPORT, 400);
  }
  return withImportBudget(member, 'import', entry, deps, async (metered) => {
    const outcome = await importFromSource(text, metered, target.translateTo);
    noteImportOutcome(entry, outcome);
    return outcomeResponse(outcome, undefined);
  });
}
