/**
 * Builds the import report a person can choose to send after a failed or
 * flagged import, or a 👎 on a clean one (`docs/plans/import-feedback.md`).
 * This decides what leaves the device: a photo import contributes its photo
 * count only, never image bytes or the notes typed with the photos
 * (`docs/constitutions/image-import.md`, principle 3).
 */
import {
  MAX_FEEDBACK_COMMENT_CHARS,
  MAX_FEEDBACK_MESSAGE_CHARS,
  MAX_FEEDBACK_PASTE_BYTES,
  MAX_FEEDBACK_RECIPE_BYTES,
  feedbackUrl,
  stripUrlUserinfo,
  truncateUtf8,
  type ImportFeedbackReport,
  type ImportFeedbackResult,
  type ImportFeedbackTrigger,
  type ImportFeedbackVia,
  type ImportRatingUp,
} from '../../server/importFeedbackShape.ts';
import type { ImportWarning } from './importCheck';
import type { RecipeDraft } from './types';

export interface ImportSource {
  via: ImportFeedbackVia;
  url?: string;
  /** The pasted text (`paste`) or the brief the recipe was written from (`generate`). */
  pastedText?: string;
  photos?: number;
}

export interface ImportFailure {
  code?: string;
  status: number;
  siteStatus?: number;
  message: string;
}

export interface FeedbackResultInput {
  recipe: RecipeDraft;
  warnings?: ImportWarning[];
  translationFailed?: boolean;
  translatedTo?: string;
}

export interface BuildImportFeedbackInput {
  id: string;
  trigger: ImportFeedbackTrigger;
  source: ImportSource;
  locale: string;
  failure?: ImportFailure;
  result?: FeedbackResultInput;
  comment?: string;
}

/** What a card is given; the card adds `id` and `comment`. */
export type FeedbackCardInput = Omit<BuildImportFeedbackInput, 'id' | 'comment'>;

export type IncludedSummary =
  | { kind: 'url'; url: string }
  | { kind: 'paste'; preview: string; chars: number }
  | { kind: 'brief'; preview: string; chars: number }
  | { kind: 'photos' }
  | { kind: 'none' };

function typedText(source: ImportSource): boolean {
  return source.via === 'paste' || source.via === 'generate';
}

function textPreview(text: string): { preview: string; chars: number } {
  const preview =
    text.length > PASTE_PREVIEW_CHARS ? `${text.slice(0, PASTE_PREVIEW_CHARS)}…` : text;
  return { preview, chars: text.length };
}

const PASTE_PREVIEW_CHARS = 200;

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * The machine fields of an `importRecipe` failure, or `null` when no report
 * should be offered: no HTTP status (a network error, a client-side check, a
 * store failure in bulk) or a 401 (the person is signed out).
 */
export function importFailureDetails(err: unknown): ImportFailure | null {
  if (!(err instanceof Error)) return null;
  const fields = err as Error & { code?: unknown; status?: unknown; siteStatus?: unknown };
  const status = httpStatus(fields.status);
  if (status === undefined || status === 401) return null;
  const failure: ImportFailure = { status, message: err.message.slice(0, MAX_FEEDBACK_MESSAGE_CHARS) };
  if (typeof fields.code === 'string' && fields.code !== '') failure.code = fields.code;
  const siteStatus = httpStatus(fields.siteStatus);
  if (siteStatus !== undefined) failure.siteStatus = siteStatus;
  return failure;
}

/**
 * The extraction as JSON with no `user:pass@` in it. A URL import's draft
 * carries the submitted address on `sourceUrl`, so that is cleaned like the
 * report's own `url`, and the whole string is swept for any other link, before
 * the byte cap so a cut cannot keep a secret.
 */
function recipeJson(recipe: RecipeDraft): string {
  const { sourceUrl, ...rest } = recipe;
  const cleanUrl = feedbackUrl(sourceUrl);
  return stripUrlUserinfo(
    JSON.stringify(cleanUrl !== undefined ? { ...rest, sourceUrl: cleanUrl } : rest),
  );
}

function feedbackResult(input: FeedbackResultInput): ImportFeedbackResult {
  const recipe = truncateUtf8(recipeJson(input.recipe), MAX_FEEDBACK_RECIPE_BYTES);
  const result: ImportFeedbackResult = { recipeJson: recipe.text };
  if (recipe.truncated) result.recipeTruncated = true;
  if (input.warnings !== undefined && input.warnings.length > 0) result.warnings = input.warnings;
  if (input.translationFailed === true) result.translationFailed = true;
  if (typeof input.translatedTo === 'string' && input.translatedTo !== '') {
    result.translatedTo = input.translatedTo;
  }
  return result;
}

/**
 * The POST body for a report. Absent values are omitted, never `undefined`,
 * because the server's Firestore write rejects `undefined`.
 */
export function buildImportFeedback(input: BuildImportFeedbackInput): ImportFeedbackReport {
  const { source } = input;
  const report: ImportFeedbackReport = { id: input.id, trigger: input.trigger, via: source.via };
  const url = feedbackUrl(source.url);
  if (url !== undefined) report.url = url;
  if (typedText(source) && typeof source.pastedText === 'string') {
    const pasted = truncateUtf8(source.pastedText, MAX_FEEDBACK_PASTE_BYTES);
    report.pastedText = pasted.text;
    if (pasted.truncated) report.pastedTruncated = true;
  }
  if (source.via === 'photos' && source.photos !== undefined) report.photos = source.photos;
  if (input.failure !== undefined) report.error = { ...input.failure };
  if (input.result !== undefined) report.result = feedbackResult(input.result);
  const comment = input.comment?.trim() ?? '';
  if (comment !== '') report.comment = comment.slice(0, MAX_FEEDBACK_COMMENT_CHARS);
  report.locale = input.locale;
  return report;
}

/** A 👍: how the recipe arrived and the link, nothing else. */
export function ratingUp(source: ImportSource): ImportRatingUp {
  const up: ImportRatingUp = { trigger: 'up', via: source.via };
  const url = feedbackUrl(source.url);
  if (url !== undefined) up.url = url;
  return up;
}

/** What "What's included" names as the source. */
export function includedSummary(source: ImportSource): IncludedSummary {
  const url = feedbackUrl(source.url);
  if (url !== undefined) return { kind: 'url', url };
  if (typedText(source) && typeof source.pastedText === 'string' && source.pastedText !== '') {
    return { kind: source.via === 'generate' ? 'brief' : 'paste', ...textPreview(source.pastedText) };
  }
  if (source.via === 'photos') return { kind: 'photos' };
  return { kind: 'none' };
}
