// Keep this module dependency-free and browser-safe: src/lib/featureRequest.ts
// imports it into the Vite client bundle as well as the Node route.
/**
 * Feature requests: the wire shape of a suggestion sent from `/suggest`
 * (`docs/plans/feature-requests.md`).
 */

/** Where the person opened `/suggest` from. */
export const FEATURE_REQUEST_FROMS = ['library', 'settings'] as const;
export type FeatureRequestFrom = (typeof FEATURE_REQUEST_FROMS)[number];

export const MAX_FEATURE_REQUEST_CHARS = 4000;

/** The POST body of a suggestion. */
export interface FeatureRequestBody {
  id: string;
  text: string;
  contactOk: boolean;
  from?: FeatureRequestFrom;
  locale?: string;
  standalone?: boolean;
}

export function isFeatureRequestFrom(value: unknown): value is FeatureRequestFrom {
  return (FEATURE_REQUEST_FROMS as readonly unknown[]).includes(value);
}

/** The text as stored: trimmed, then capped. Empty means nothing to send. */
export function featureRequestText(raw: string): string {
  return raw.trim().slice(0, MAX_FEATURE_REQUEST_CHARS);
}
