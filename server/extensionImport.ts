/**
 * `POST /api/extension/import` — the Chrome extension's one-shot import.
 *
 * Unlike `/api/import`, which extracts and hands the recipe back for the client
 * to save, this route extracts **and writes**: the extension has no Dexie, no
 * outbox and no sync engine. It writes through `applyPushOp` so validation, LWW
 * and `compactRecipeFields` keep their single home in `server/sync.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  loggableUrl,
  noteImportOutcome,
  withImportLog,
  type ImportLogEntry,
} from './importLog.ts';
import { meteredImportDeps } from './importRoute.ts';
import { admitLlm, llmRefusal } from './llmBudget.ts';
import { RequestBodyError, readBoundedText, requireHeaderMember } from './membership.ts';
import { recipePutFromExtraction } from './recipeFromExtraction.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  importFromHtml,
  MAX_PAGE_HTML_CHARS,
  readImportTranslateTo,
  type ImportOutcome,
  type RecipeImportDeps,
} from './recipeImport.ts';
import { applyPushOp } from './sync.ts';

/** The body limit, in UTF-16 code units of the decoded body, matching `syncPush`. */
const MAX_BODY_CHARS = 1_500_000;
/** Where reading stops: UTF-8 spends at most 3 bytes per code unit, so no body within `MAX_BODY_CHARS` is longer. */
const MAX_BODY_BYTES = 3 * MAX_BODY_CHARS;
const TOO_LARGE = 'Page was too large to import.';
const UNUSABLE = 'Extraction produced an unusable recipe.';

interface ExtensionImportBody {
  url?: unknown;
  html?: unknown;
  translateTo?: unknown;
}

/**
 * Real Chrome extension ids are 32 characters drawn from a–p. Used to decide
 * whether a preflight deserves an answer; it grants no authority on its own,
 * since the session header is what authenticates.
 */
export function isExtensionOrigin(origin: string | null): boolean {
  return origin !== null && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!isExtensionOrigin(origin)) {
    return {};
  }
  return {
    // No Allow-Credentials: the cookie is deliberately not what authenticates
    // here, and omitting it makes a credentialed cross-origin request fail.
    'Access-Control-Allow-Origin': origin as string,
    Vary: 'Origin',
  };
}

function fail(req: Request, code: string, error: string, status: number): Response {
  return jsonResponse(req, { error, code }, status);
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
    },
  });
}

export function extensionImportOptions(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (Object.keys(cors).length === 0) {
    return Promise.resolve(
      new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } }),
    );
  }
  return Promise.resolve(
    new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type, x-sous-session',
        'Access-Control-Max-Age': '600',
      },
    }),
  );
}

export async function extensionImport(
  req: Request,
  deps?: RecipeImportDeps,
): Promise<Response> {
  const access = await requireHeaderMember(req);
  if (access.kind === 'denied') {
    return fail(req, 'unauthorized', 'Unauthorized', 401);
  }
  if (access.kind === 'unknown') {
    return fail(req, 'membership-unavailable', 'Membership unavailable', 503);
  }

  const entry: ImportLogEntry = { sub: access.sub, via: 'extension' };
  return withImportLog(entry, () => importAndSave(req, access.sub, entry, deps));
}

/** `extensionImport` after the membership check; it records what happened on `entry`. */
async function importAndSave(
  req: Request,
  sub: string,
  entry: ImportLogEntry,
  deps: RecipeImportDeps | undefined,
): Promise<Response> {
  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_BODY_BYTES);
  } catch (err) {
    // `RequestBodyError` is the client going away mid-upload.
    entry.outcome = err instanceof RequestBodyError ? 'aborted' : 'bad_request';
    return fail(req, 'bad-request', 'Bad request', 400);
  }
  if (raw === null || raw.length > MAX_BODY_CHARS) {
    entry.outcome = 'too_large';
    return fail(req, 'import-too-large', TOO_LARGE, 413);
  }

  let body: ExtensionImportBody;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    body = parsed as ExtensionImportBody;
  } catch {
    entry.outcome = 'bad_request';
    return fail(req, 'bad-request', 'Bad request', 400);
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  // `sourceUrl` is stored on the recipe even though this route never fetches
  // the URL: empty html is an error, not a `fetchPageHtml` fallback.
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    entry.outcome = 'bad_url';
    return fail(req, 'import-bad-url', 'That does not look like a web address.', 422);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    entry.outcome = 'bad_url';
    return fail(req, 'import-bad-scheme', 'Only http and https URLs are supported.', 422);
  }
  Object.assign(entry, loggableUrl(url));

  const html = typeof body.html === 'string' ? body.html : '';
  // The extension caps itself at 400 000; this is the server refusing to be
  // the one that runs out of memory. The website fetch truncates at the same cap.
  if (html.length > MAX_PAGE_HTML_CHARS) {
    entry.outcome = 'too_large';
    return fail(req, 'import-too-large', TOO_LARGE, 413);
  }
  if (html.trim() === '') {
    entry.outcome = 'empty_source';
    return fail(req, 'import-unreadable', 'Could not read that page.', 422);
  }

  const target = readImportTranslateTo(body.translateTo);
  if (!target.ok) {
    entry.outcome = 'bad_language';
    return fail(req, IMPORT_BAD_LANGUAGE_CODE, IMPORT_BAD_LANGUAGE_ERROR, 400);
  }

  const admission = await admitLlm(sub, 'extension_import');
  if (admission.kind !== 'ok') {
    entry.outcome = 'llm_refused';
    const refusal = llmRefusal(admission);
    const headers = new Headers(refusal.headers);
    for (const [name, value] of Object.entries(corsHeaders(req))) headers.set(name, value);
    return new Response(refusal.body, { status: refusal.status, headers });
  }
  let outcome: ImportOutcome;
  try {
    outcome = await importFromHtml(
      html,
      meteredImportDeps(deps, admission.meter),
      target.translateTo,
    );
  } finally {
    admission.meter.release();
  }
  noteImportOutcome(entry, outcome);
  switch (outcome.kind) {
    case 'ok':
      break;
    case 'empty_source':
      return fail(req, 'import-unreadable', 'Could not read that page.', 422);
    case 'not_a_recipe':
      return fail(req, 'import-no-recipe', "Couldn't find a recipe in that content.", 422);
    case 'parse_error':
      return fail(req, 'import-extract-failed', 'Extraction failed — no structured result.', 502);
    case 'unusable':
      return fail(req, 'import-unusable', UNUSABLE, 502);
    case 'model_error':
      return fail(req, 'import-model-failed', "Couldn't read that recipe — try again.", 502);
  }

  // A failed translation still saves the original. The extension has no preview.
  let recipe = outcome.recipe;
  let translated = false;
  if (outcome.translation?.kind === 'ok') {
    translated = true;
    recipe = { ...outcome.translation.recipe, lang: outcome.translation.lang };
  }
  const now = Date.now();
  const payload = recipePutFromExtraction(recipe, {
    id: randomUUID(),
    now,
    sourceUrl: url,
    // The extension has no preview, so the warnings show on the recipe view.
    ...(outcome.warnings.length > 0
      ? { importCheck: { at: now, warnings: outcome.warnings } }
      : {}),
  });
  if (payload === null) {
    entry.outcome = 'unusable';
    return fail(req, 'import-unusable', UNUSABLE, 502);
  }

  // Firestore is the likeliest thing to fail here, and an escaping throw would
  // reach the dispatcher as a text/plain 500 the popup cannot parse.
  let applied: boolean;
  try {
    const result = await applyPushOp(sub, { kind: 'recipe.put', payload });
    applied = result.applied;
  } catch (err) {
    console.error(err);
    applied = false;
  }
  if (!applied) {
    entry.outcome = 'save_failed';
    return fail(req, 'import-save-failed', 'Could not save the recipe.', 500);
  }

  return jsonResponse(req, { id: payload.id, title: payload.title, translated });
}
