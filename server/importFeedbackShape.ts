// Keep this module dependency-free and browser-safe: src/lib/importFeedback.ts
// imports it into the Vite client bundle as well as the Node route. Only the
// TextEncoder, TextDecoder and URL globals; no Node APIs.
/**
 * Import feedback: the wire shape of a report (or a thumbs-up) and the two
 * string helpers both sides share (`docs/plans/import-feedback.md`).
 */
import type { ImportWarning } from './importWarnings.ts';

/** `generate` is a recipe written from a brief; its report carries the brief as `pastedText`. */
export const IMPORT_FEEDBACK_VIAS = ['url', 'paste', 'photos', 'generate'] as const;
export type ImportFeedbackVia = (typeof IMPORT_FEEDBACK_VIAS)[number];
export const IMPORT_FEEDBACK_TRIGGERS = ['failed', 'warnings', 'down'] as const;
export type ImportFeedbackTrigger = (typeof IMPORT_FEEDBACK_TRIGGERS)[number];

export const MAX_FEEDBACK_URL_CHARS = 2048;
export const MAX_FEEDBACK_PASTE_BYTES = 150_000;
export const MAX_FEEDBACK_RECIPE_BYTES = 200_000;
export const MAX_FEEDBACK_COMMENT_CHARS = 2000;
export const MAX_FEEDBACK_MESSAGE_CHARS = 500;

export interface ImportFeedbackError {
  code?: string;
  status?: number;
  siteStatus?: number;
  message?: string;
}
export interface ImportFeedbackResult {
  recipeJson?: string;
  recipeTruncated?: true;
  warnings?: ImportWarning[];
  translationFailed?: true;
  translatedTo?: string;
}
/** The POST body of a report. */
export interface ImportFeedbackReport {
  id: string;
  trigger: ImportFeedbackTrigger;
  via: ImportFeedbackVia;
  url?: string;
  /** The pasted text (`paste`) or the brief (`generate`). */
  pastedText?: string;
  pastedTruncated?: true;
  photos?: number;
  error?: ImportFeedbackError;
  result?: ImportFeedbackResult;
  comment?: string;
  locale?: string;
}
/** The POST body of a 👍. */
export interface ImportRatingUp {
  trigger: 'up';
  via: ImportFeedbackVia;
  url?: string;
}

/** Cut `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * `text` with the `user:pass@` part of every http(s) link in it removed. For
 * text that holds links rather than being one, such as a recipe's JSON with its
 * `sourceUrl`; it works on truncated text too. An `@` after the host, in a path
 * or query, is left alone.
 */
export function stripUrlUserinfo(text: string): string {
  return text.replace(/\b(https?:\/\/)[^\s"\\/?#@]+@/gi, '$1');
}

/** An http(s) link with any `user:pass@` removed; query and fragment kept. */
export function feedbackUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.username = '';
  url.password = '';
  return url.href.length <= MAX_FEEDBACK_URL_CHARS ? url.href : undefined;
}
