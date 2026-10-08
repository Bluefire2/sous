/**
 * One structured log line per import request, so a failed import can be found
 * by account and by site (`docs/plans/import-reliability.md`). Cloud Logging
 * parses a JSON line on stdout as `jsonPayload`; query it with
 * `jsonPayload.event="import"`.
 *
 * Logged: the account `sub`, how the import arrived, the page address without
 * its query string or fragment, whether the page was read from its Recipe
 * JSON-LD or its text, each Gemini attempt's result, the warning codes on the
 * result, for a recipe written from a brief whether web search was on and how
 * many searches ran, the outcome, counts, and timing. Never logged:
 * the email, recipe text, page HTML, pasted text, the brief, the search
 * queries, photo bytes, or an error message (SDK errors can echo the
 * request). `/privacy` and `/terms` describe this line; change them with it.
 */
import type { ImportWarningCode } from './importWarnings.ts';
import type {
  ImportAttempt,
  ImportOutcome,
  ImportSourceRead,
  PageFetchOutcome,
} from './recipeImport.ts';

export type ImportVia = 'url' | 'paste' | 'photos' | 'extension' | 'generate';

/**
 * `ImportOutcome` kinds, plus the ways a request ends before or after the
 * pipeline. `threw` means the Gemini call (or something after it) threw.
 * `rate_limited` is a searched generation the per-member limit refused.
 * `aborted` means the request body stopped before it all arrived, which is
 * the client going away mid-upload (`RequestBodyError`), not a server failure.
 */
export type ImportLogOutcome =
  | ImportOutcome['kind']
  | 'aborted'
  | 'bad_request'
  | 'too_large'
  | 'bad_language'
  | 'bad_url'
  | 'fetch_failed'
  | 'bad_photos'
  | 'bad_brief'
  | 'rate_limited'
  | 'save_failed'
  | 'store_unavailable'
  | 'threw';

export interface ImportLogEntry {
  sub?: string;
  via?: ImportVia;
  /** `origin + pathname` only. */
  url?: string;
  host?: string;
  fetch?: PageFetchOutcome['kind'];
  /** The site's HTTP status when it refused the fetch. */
  siteStatus?: number;
  outcome?: ImportLogOutcome;
  ingredients?: number;
  steps?: number;
  translation?: 'ok' | 'failed';
  /** Page and paste imports: what Gemini read. */
  source?: ImportSourceRead;
  /** Page and paste imports: each Gemini call's result, in order. */
  attempts?: ImportAttempt['result'][];
  /** Warning codes on the returned recipe. */
  codes?: ImportWarningCode[];
  photos?: number;
  bytes?: number;
  /** Generated recipes: whether Google Search grounding was requested. */
  search?: boolean;
  /** Generated recipes with search: how many searches Google reported, on any outcome after the research call. Never the queries. */
  searchQueries?: number;
  /** A numeric HTTP status on a thrown provider error (429, 503, …), when it has one. */
  errorStatus?: number;
  /** The status this route answered with. */
  status?: number;
  ms?: number;
}

/** The address to log: `origin + pathname`, or nothing when it is not an http(s) URL. */
export function loggableUrl(raw: unknown): { url: string; host: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  // `origin` already omits any `user:password@`.
  return { url: parsed.origin + parsed.pathname, host: parsed.hostname };
}

/** `status` from a provider error such as `@google/genai`'s `ApiError`. Never the message. */
export function thrownStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Records an `ImportOutcome` on the entry: its kind, and counts when it is a recipe. */
export function noteImportOutcome(entry: ImportLogEntry, outcome: ImportOutcome): void {
  entry.outcome = outcome.kind;
  const log = outcome.log;
  if (log !== undefined) {
    if (log.source !== undefined) entry.source = log.source;
    entry.attempts = log.attempts.map((attempt) => attempt.result);
    if (log.errorStatus !== undefined) entry.errorStatus = log.errorStatus;
    if (log.searchQueries !== undefined) entry.searchQueries = log.searchQueries;
  }
  if (outcome.kind !== 'ok') return;
  if (outcome.warnings.length > 0) entry.codes = outcome.warnings.map((w) => w.code);
  entry.ingredients = outcome.recipe.ingredientSections.reduce(
    (n, section) => n + section.items.length,
    0,
  );
  entry.steps = outcome.recipe.steps.length;
  if (outcome.translation !== undefined) entry.translation = outcome.translation.kind;
}

export function importLogLine(entry: ImportLogEntry): string {
  return JSON.stringify({ event: 'import', ...entry });
}

/**
 * An error to rethrow in place of `err`. Its fixed message names `err`'s class
 * and numeric status, and nothing else: no message, no stack, no `cause`.
 * The dispatcher in `scripts/server.ts` `console.error`s whatever escapes, and
 * an SDK message can quote the request (pasted text, a page's HTML, or an
 * extension page behind a login).
 */
export function sanitizedImportError(err: unknown): Error {
  return sanitizedError('Import failed', err);
}

/** `sanitizedImportError` with another fixed prefix, for routes that are not imports. */
export function sanitizedError(prefix: string, err: unknown): Error {
  const rawName = err instanceof Error ? err.name : typeof err;
  const name = /^[A-Za-z]{1,40}$/.test(rawName) ? rawName : 'Error';
  const status = thrownStatus(err);
  return new Error(
    `${prefix}: ${name}${status === undefined ? '' : ` (status ${status})`}; message withheld`,
  );
}

/**
 * Runs `handle`, then writes one line with its status and duration. A throw is
 * logged as `threw` and rethrown as `sanitizedImportError`, so the client still
 * gets the dispatcher's plain-text 500 but no request text reaches the logs.
 */
export async function withImportLog(
  entry: ImportLogEntry,
  handle: () => Promise<Response>,
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await handle();
    entry.status = response.status;
    return response;
  } catch (err) {
    entry.outcome = 'threw';
    const status = thrownStatus(err);
    if (status !== undefined) entry.errorStatus = status;
    entry.status = 500;
    throw sanitizedImportError(err);
  } finally {
    entry.ms = Date.now() - started;
    console.log(importLogLine(entry));
  }
}
