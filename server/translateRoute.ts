/**
 * `POST /api/translate`. Display-only: the response is not a recipe write.
 * Cache docs live at `users/{uid}/translations/{recipeId}.{target}` and are
 * written only for the caller's own live recipe. The provider call is outside
 * that transaction. Shared recipes and unknown ids are translated and not stored.
 */
import { SUPPORTED_LOCALES, normalizeLang, toSupportedLocale } from './lang.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
} from './membership.ts';
import {
  TRANSLATIONS_COLLECTION,
  admitTranslateCall,
  applyTranslation,
  cacheWriteDecision,
  compactTranslatableRecipe,
  recipeSegments,
  translationCacheDocIds,
  translationCacheHit,
  translationExceedsCaps,
  translationSourceHash,
  type RecipeSegment,
  type TranslatableRecipe,
} from './recipeTranslation.ts';
import { getStoreFirestore, isUuid, recipeDocRef } from './store.ts';
import {
  TRANSLATE_FAILED,
  TRANSLATE_PROVIDER_UNAVAILABLE,
  geminiTranslateDepsFromEnv,
  resolveTranslateConfig,
  translateSegments,
  validateTranslatedSegments,
  type GeminiTranslateDeps,
} from './translate.ts';

/**
 * Request body limit in bytes. The body carries the whole recipe, and a
 * stored recipe is under 200 000 JSON chars (`validateRecipePut`), at most
 * 600 000 UTF-8 bytes, so every recipe that can be translated fits. The
 * text actually sent to the provider is capped far lower by
 * `translationExceedsCaps`; this only stops a body being buffered unbounded.
 */
const MAX_TRANSLATE_BODY_BYTES = 1_000_000;

const BAD_REQUEST = 'Bad request';
const TOO_LARGE = 'This recipe is too long to translate.';
const UNAVAILABLE = 'Translation is temporarily unavailable.';
const PROVIDER_UNAVAILABLE = 'This translation provider is not available.';
const FAILED = "Couldn't translate this recipe.";
const RATE_LIMITED = 'Too many translations. Try again later.';

export const TRANSLATE_BAD_REQUEST = 'translate-bad-request';
export const TRANSLATE_TOO_LARGE = 'translate-too-large';
export const TRANSLATE_UNAVAILABLE = 'translate-unavailable';
export const TRANSLATE_RATE_LIMITED = 'translate-rate-limited';

/** Per container instance. Cache hits do not go through this map. */
const translateRateBuckets = new Map<string, number[]>();

export type TranslateRecipeIdStatus =
  | { kind: 'omit' }
  | { kind: 'ok'; recipeId: string }
  | { kind: 'invalid' };

/** `recipeId` is optional. Present values must be `isUuid` (a slash never is). */
export function classifyTranslateRecipeId(recipeId: unknown): TranslateRecipeIdStatus {
  if (recipeId === undefined) {
    return { kind: 'omit' };
  }
  if (isUuid(recipeId)) {
    return { kind: 'ok', recipeId };
  }
  return { kind: 'invalid' };
}

export type TranslateParse =
  | {
      ok: true;
      recipeId?: string;
      target: (typeof SUPPORTED_LOCALES)[number];
      sourceLang?: string;
      recipe: TranslatableRecipe;
      segments: RecipeSegment[];
    }
  | { ok: false; status: 400 | 413; code: string; error: string };

function badRequest(): TranslateParse {
  return { ok: false, status: 400, code: TRANSLATE_BAD_REQUEST, error: BAD_REQUEST };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Body validation, caps, and recipe compaction. The route returns this as HTTP. */
export function parseTranslateRequest(body: unknown): TranslateParse {
  if (!isPlainObject(body)) {
    return badRequest();
  }
  const target = toSupportedLocale(body.target);
  if (target === undefined) {
    return badRequest();
  }
  const recipeId = classifyTranslateRecipeId(body.recipeId);
  if (recipeId.kind === 'invalid') {
    return badRequest();
  }
  let sourceLang: string | undefined;
  if (body.sourceLang !== undefined && body.sourceLang !== null) {
    if (typeof body.sourceLang !== 'string') {
      return badRequest();
    }
    if (body.sourceLang.trim() !== '') {
      const normalized = normalizeLang(body.sourceLang);
      if (normalized === undefined) {
        return badRequest();
      }
      sourceLang = normalized;
    }
  }
  const recipe = compactTranslatableRecipe(body.recipe);
  if (recipe === null) {
    return badRequest();
  }
  const segments = recipeSegments(recipe);
  if (translationExceedsCaps(segments)) {
    return { ok: false, status: 413, code: TRANSLATE_TOO_LARGE, error: TOO_LARGE };
  }
  return {
    ok: true,
    ...(recipeId.kind === 'ok' ? { recipeId: recipeId.recipeId } : {}),
    target,
    ...(sourceLang !== undefined ? { sourceLang } : {}),
    recipe,
    segments,
  };
}

function jsonError(status: number, code: string, error: string): Response {
  return Response.json(
    { error, code },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

function jsonOk(body: unknown): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

async function readTranslationCache(
  uid: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const snap = await getStoreFirestore()
      .collection('users')
      .doc(uid)
      .collection(TRANSLATIONS_COLLECTION)
      .doc(docId)
      .get();
    if (!snap.exists) {
      return null;
    }
    const data = snap.data();
    return data ? (data as Record<string, unknown>) : null;
  } catch {
    console.error('translate cache read failed');
    return null;
  }
}

async function writeTranslationCache(
  uid: string,
  recipeId: string,
  docId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const cacheRef = getStoreFirestore()
    .collection('users')
    .doc(uid)
    .collection(TRANSLATIONS_COLLECTION)
    .doc(docId);
  await getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(recipeDocRef(uid, recipeId));
    const stored = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    if (cacheWriteDecision(stored) !== 'write') {
      return;
    }
    tx.set(cacheRef, payload);
  });
}

export async function translatePost(
  req: Request,
  depsOverride?: GeminiTranslateDeps,
): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_TRANSLATE_BODY_BYTES);
  } catch {
    return jsonError(400, TRANSLATE_BAD_REQUEST, BAD_REQUEST);
  }
  if (raw === null) {
    return jsonError(413, TRANSLATE_TOO_LARGE, TOO_LARGE);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, TRANSLATE_BAD_REQUEST, BAD_REQUEST);
  }
  const parsed = parseTranslateRequest(body);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.code, parsed.error);
  }

  if (resolveTranslateConfig(process.env).provider !== 'gemini') {
    return jsonError(503, TRANSLATE_PROVIDER_UNAVAILABLE, PROVIDER_UNAVAILABLE);
  }

  let cacheDocId: string | undefined;
  let sourceHash: string | undefined;
  if (parsed.recipeId !== undefined) {
    const index = SUPPORTED_LOCALES.indexOf(parsed.target);
    cacheDocId = translationCacheDocIds(parsed.recipeId)[index];
    if (cacheDocId === undefined) {
      return jsonError(400, TRANSLATE_BAD_REQUEST, BAD_REQUEST);
    }
    sourceHash = translationSourceHash(parsed.segments);
    const cached = await readTranslationCache(access.sub, cacheDocId);
    if (translationCacheHit(cached, sourceHash)) {
      const validated = validateTranslatedSegments(
        parsed.segments.map((segment) => segment.id),
        cached?.segments,
      );
      if (validated.ok) {
        return jsonOk({
          detectedLang: normalizeLang(cached?.detectedLang) ?? null,
          recipe: applyTranslation(parsed.recipe, validated.segments),
        });
      }
    }
  }

  const built = depsOverride ? { ok: true as const, deps: depsOverride } : geminiTranslateDepsFromEnv();
  if (!built.ok) {
    return jsonError(503, TRANSLATE_UNAVAILABLE, UNAVAILABLE);
  }

  if (!admitTranslateCall(translateRateBuckets, access.sub, Date.now())) {
    return jsonError(429, TRANSLATE_RATE_LIMITED, RATE_LIMITED);
  }

  const outcome = await translateSegments(
    {
      segments: parsed.segments,
      target: parsed.target,
      sourceLang: parsed.sourceLang,
    },
    built.deps,
  );
  if (!outcome.ok) {
    if (outcome.code === TRANSLATE_PROVIDER_UNAVAILABLE) {
      return jsonError(503, outcome.code, PROVIDER_UNAVAILABLE);
    }
    return jsonError(502, TRANSLATE_FAILED, FAILED);
  }

  if (parsed.recipeId !== undefined && cacheDocId !== undefined && sourceHash !== undefined) {
    try {
      await writeTranslationCache(access.sub, parsed.recipeId, cacheDocId, {
        recipeId: parsed.recipeId,
        hash: sourceHash,
        segments: outcome.segments,
        detectedLang: outcome.detectedLang,
        provider: 'gemini',
        model: built.deps.model,
        createdAt: Date.now(),
      });
    } catch {
      console.error('translate cache write failed');
    }
  }

  return jsonOk({
    detectedLang: outcome.detectedLang,
    recipe: applyTranslation(parsed.recipe, outcome.segments),
  });
}
