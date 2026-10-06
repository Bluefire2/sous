/**
 * `POST /api/import-feedback`: an import report the person chose to send
 * after a failed or flagged import, or a 👎 on a clean one, and the 👍 that
 * stores nothing (`docs/plans/import-feedback.md`). Gated by `withMembership`
 * in `scripts/server.ts`; `sub` comes only from the session.
 *
 * A report is stored in top-level `importFeedback/{id}`, never under
 * `users/{uid}`: it is for the owner and must not sync or back up. `expireAt`
 * drives the 180-day Firestore TTL policy. The id is the client's UUID and
 * the write is `create()`, so a resend after a lost response is a no-op.
 * The stored fields and their limits are documented field by field in
 * `docs/plans/import-feedback.md` (Report schema); keep it in step with
 * `ImportFeedbackDoc`.
 *
 * Validation is lenient: a malformed field is dropped or truncated and the
 * report still stored, because broken extractions are the reports that
 * matter. Only a non-object body, an unknown trigger or via, or a bad id is
 * rejected.
 *
 * One `event: 'import_feedback'` log line per request holds the `sub`,
 * trigger, via, host, warning codes, whether there is a comment, and the
 * status. Never a URL path, recipe or pasted text, the comment, or an error
 * message. `/privacy` and `/terms` describe the stored report and this line;
 * change them with it.
 */
import {
  IMPORT_FEEDBACK_TRIGGERS,
  IMPORT_FEEDBACK_VIAS,
  MAX_FEEDBACK_COMMENT_CHARS,
  MAX_FEEDBACK_MESSAGE_CHARS,
  MAX_FEEDBACK_PASTE_BYTES,
  MAX_FEEDBACK_RECIPE_BYTES,
  feedbackUrl,
  stripUrlUserinfo,
  truncateUtf8,
  type ImportFeedbackError,
  type ImportFeedbackReport,
  type ImportFeedbackResult,
  type ImportFeedbackTrigger,
  type ImportFeedbackVia,
} from './importFeedbackShape.ts';
import { loggableUrl, sanitizedImportError } from './importLog.ts';
import { readImportWarnings, type ImportWarningCode } from './importWarnings.ts';
import { toSupportedLocale } from './lang.ts';
import {
  RequestBodyError,
  readBoundedText,
  storeUnavailable,
  type MembershipHandlerContext,
} from './membership.ts';
import { admitTranslateCall } from './recipeTranslation.ts';
import { getStoreFirestore, isAlreadyExists, isUuid } from './store.ts';

export const IMPORT_FEEDBACK_COLLECTION = 'importFeedback';
export const MAX_IMPORT_FEEDBACK_BODY_BYTES = 512 * 1024;
export const IMPORT_FEEDBACK_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const IMPORT_FEEDBACK_RATE_LIMIT = 20;
export const IMPORT_FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;

export type ImportFeedbackFields = Omit<ImportFeedbackReport, 'id'>;

export interface ImportFeedbackDoc extends ImportFeedbackFields {
  v: 1;
  sub: string;
  createdAt: number;
  /** Stored as a Timestamp; the TTL policy deletes the doc after it. */
  expireAt: Date;
}

export type ReadImportFeedback =
  | { kind: 'report'; id: string; fields: ImportFeedbackFields }
  | { kind: 'up'; via: ImportFeedbackVia; host?: string }
  | { kind: 'bad' };

export interface ImportFeedbackDeps {
  create(id: string, doc: ImportFeedbackDoc): Promise<void>;
  now(): number;
}

interface ImportFeedbackLogEntry {
  sub: string;
  trigger?: ImportFeedbackTrigger | 'up';
  via?: ImportFeedbackVia;
  host?: string;
  codes?: ImportWarningCode[];
  hasComment?: boolean;
  status?: number;
  /** A numeric gRPC code from a failed store write. */
  errorCode?: number;
  ms?: number;
}

const ERROR_CODE = /^[a-z0-9-]{1,64}$/;
const PHOTO_COUNTS = { min: 1, max: 4 };

/** Per container instance, separate from translation's buckets. */
const rateBuckets = new Map<string, number[]>();

/** Test hook: clears the per-instance rate-limit buckets. */
export function resetImportFeedbackRateLimitForTest(): void {
  rateBuckets.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVia(value: unknown): value is ImportFeedbackVia {
  return (IMPORT_FEEDBACK_VIAS as readonly unknown[]).includes(value);
}

function isTrigger(value: unknown): value is ImportFeedbackTrigger {
  return (IMPORT_FEEDBACK_TRIGGERS as readonly unknown[]).includes(value);
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function readError(raw: unknown): ImportFeedbackError | undefined {
  if (!isPlainObject(raw)) return undefined;
  const error: ImportFeedbackError = {};
  if (typeof raw.code === 'string' && ERROR_CODE.test(raw.code)) error.code = raw.code;
  const status = httpStatus(raw.status);
  if (status !== undefined) error.status = status;
  const siteStatus = httpStatus(raw.siteStatus);
  if (siteStatus !== undefined) error.siteStatus = siteStatus;
  if (typeof raw.message === 'string') error.message = raw.message.slice(0, MAX_FEEDBACK_MESSAGE_CHARS);
  return Object.keys(error).length > 0 ? error : undefined;
}

function readResult(raw: unknown): ImportFeedbackResult | undefined {
  if (!isPlainObject(raw)) return undefined;
  const result: ImportFeedbackResult = {};
  if (typeof raw.recipeJson === 'string') {
    // The client already cleans this; the sweep here means no client can store a
    // `user:pass@` inside the opaque JSON (a URL draft's `sourceUrl` holds the raw link).
    const recipe = truncateUtf8(stripUrlUserinfo(raw.recipeJson), MAX_FEEDBACK_RECIPE_BYTES);
    result.recipeJson = recipe.text;
    if (recipe.truncated || raw.recipeTruncated === true) result.recipeTruncated = true;
  }
  const warnings = readImportWarnings(raw.warnings);
  if (warnings.length > 0) result.warnings = warnings;
  if (raw.translationFailed === true) result.translationFailed = true;
  const translatedTo = toSupportedLocale(raw.translatedTo);
  if (translatedTo !== undefined) result.translatedTo = translatedTo;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The request body as a report, a 👍, or `bad`. Never yields an `undefined` value. */
export function readImportFeedback(body: unknown): ReadImportFeedback {
  if (!isPlainObject(body)) return { kind: 'bad' };
  if (body.trigger === 'up') {
    if (!isVia(body.via)) return { kind: 'bad' };
    const host = loggableUrl(body.url)?.host;
    return host !== undefined ? { kind: 'up', via: body.via, host } : { kind: 'up', via: body.via };
  }
  if (!isTrigger(body.trigger) || !isVia(body.via)) return { kind: 'bad' };
  if (!isUuid(body.id)) return { kind: 'bad' };

  const via = body.via;
  const fields: ImportFeedbackFields = { trigger: body.trigger, via };
  const url = feedbackUrl(body.url);
  if (url !== undefined) fields.url = url;
  if (via === 'paste' && typeof body.pastedText === 'string') {
    const pasted = truncateUtf8(body.pastedText, MAX_FEEDBACK_PASTE_BYTES);
    fields.pastedText = pasted.text;
    if (pasted.truncated || body.pastedTruncated === true) fields.pastedTruncated = true;
  }
  if (
    via === 'photos' &&
    typeof body.photos === 'number' &&
    Number.isInteger(body.photos) &&
    body.photos >= PHOTO_COUNTS.min &&
    body.photos <= PHOTO_COUNTS.max
  ) {
    fields.photos = body.photos;
  }
  const error = readError(body.error);
  if (error !== undefined) fields.error = error;
  const result = readResult(body.result);
  if (result !== undefined) fields.result = result;
  if (typeof body.comment === 'string') {
    const comment = body.comment.trim();
    if (comment !== '') fields.comment = comment.slice(0, MAX_FEEDBACK_COMMENT_CHARS);
  }
  const locale = toSupportedLocale(body.locale);
  if (locale !== undefined) fields.locale = locale;
  return { kind: 'report', id: body.id, fields };
}

function defaultDeps(): ImportFeedbackDeps {
  return {
    create: (id, doc) =>
      getStoreFirestore()
        .collection(IMPORT_FEEDBACK_COLLECTION)
        .doc(id)
        .create(doc)
        .then(() => {}),
    now: Date.now,
  };
}

function fail(code: string, error: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

const badRequest = () => fail('feedback-bad-request', 'Bad request', 400);

export async function importFeedbackPost(
  req: Request,
  ctx: MembershipHandlerContext,
  deps?: ImportFeedbackDeps,
): Promise<Response> {
  // `withMembership` has already decided access; the sub only names the
  // report's sender and the log line. Read once (membership.test.ts counts it).
  const sub = ctx.authorizedSub;
  const entry: ImportFeedbackLogEntry = { sub };
  const started = Date.now();
  try {
    const response = await handleFeedback(req, sub, entry, deps ?? defaultDeps());
    entry.status = response.status;
    return response;
  } catch (err) {
    // Reuses the import route's sanitizer on purpose: the dispatcher in
    // `scripts/server.ts` logs whatever escapes as an error, and a message can
    // quote the request (a pasted recipe, a note).
    entry.status = 500;
    throw sanitizedImportError(err);
  } finally {
    entry.ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'import_feedback', ...entry }));
  }
}

/** `importFeedbackPost` without the log line; it records what happened on `entry`. */
async function handleFeedback(
  req: Request,
  sub: string,
  entry: ImportFeedbackLogEntry,
  deps: ImportFeedbackDeps,
): Promise<Response> {
  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_IMPORT_FEEDBACK_BODY_BYTES);
  } catch (err) {
    // The client went away mid-upload; nobody reads this answer.
    if (err instanceof RequestBodyError) return badRequest();
    throw err;
  }
  if (raw === null) return fail('feedback-too-large', 'Too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest();
  }
  const parsed = readImportFeedback(body);
  if (parsed.kind === 'bad') return badRequest();

  const now = deps.now();
  // Generic sliding window; reused from translation with its own buckets.
  if (
    !admitTranslateCall(
      rateBuckets,
      sub,
      now,
      IMPORT_FEEDBACK_RATE_LIMIT,
      IMPORT_FEEDBACK_RATE_WINDOW_MS,
    )
  ) {
    return fail('feedback-rate-limited', 'Too many reports', 429);
  }

  if (parsed.kind === 'up') {
    entry.trigger = 'up';
    entry.via = parsed.via;
    if (parsed.host !== undefined) entry.host = parsed.host;
    return new Response(null, { status: 204 });
  }

  const { fields } = parsed;
  entry.trigger = fields.trigger;
  entry.via = fields.via;
  const host = loggableUrl(fields.url)?.host;
  if (host !== undefined) entry.host = host;
  const codes = fields.result?.warnings?.map((warning) => warning.code);
  if (codes !== undefined && codes.length > 0) entry.codes = codes;
  entry.hasComment = fields.comment !== undefined;

  // `fields` first, so nothing in the body can override the session's `sub`.
  const doc: ImportFeedbackDoc = {
    ...fields,
    v: 1,
    sub,
    createdAt: now,
    expireAt: new Date(now + IMPORT_FEEDBACK_RETENTION_MS),
  };
  try {
    await deps.create(parsed.id, doc);
  } catch (err) {
    if (isAlreadyExists(err)) return new Response(null, { status: 204 });
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === 'number') entry.errorCode = code;
    return storeUnavailable();
  }
  return new Response(null, { status: 204 });
}
