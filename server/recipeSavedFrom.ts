// Keep this module dependency-free and browser-safe: src/lib/recipeSavedFrom.ts
// re-exports it into the Vite client bundle as well as the Node import path.
/**
 * `Recipe.savedFrom`: where a recipe saved from someone's recipe link came
 * from (`docs/plans/recipe-links.md`). Only the server sets it, when it saves
 * the copy; the saver's own edits keep it. The client and the server keep or
 * drop it by this one rule.
 */

export type SavedFrom = {
  /** The sharer's display name when the copy was saved. Missing when they had none. */
  name?: string;
  /** When the copy was saved (ms). */
  savedAt: number;
};

export const MAX_SAVED_FROM_NAME_CHARS = 100;

/** A well-formed `savedFrom`, or `undefined`. Malformed is dropped, not rejected. */
export function compactSavedFrom(value: unknown): SavedFrom | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt) || raw.savedAt <= 0) {
    return undefined;
  }
  const out: SavedFrom = { savedAt: raw.savedAt };
  const name = savedFromName(raw.name);
  if (name !== undefined) {
    out.name = name;
  }
  return out;
}

/** A display name trimmed and capped for `savedFrom.name`, or `undefined` when blank. */
export function savedFromName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().slice(0, MAX_SAVED_FROM_NAME_CHARS).trim();
  return trimmed === '' ? undefined : trimmed;
}
