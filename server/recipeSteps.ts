// Keep this module dependency-free and browser-safe: src/lib/recipeSteps.ts
// re-exports it into the Vite client bundle as well as the Node import path.
/**
 * Recipe steps and their optional `lane` (`docs/plans/parallel-steps.md`).
 * A lane is a short label such as "Sauce" for steps two cooks do at the same
 * time. The client and the server keep or drop step keys by these rules, so
 * an unknown step key never survives a save on either end.
 */

/** The longest lane label kept, in UTF-16 code units after trimming. */
export const MAX_LANE_CHARS = 24;

/**
 * The most `CookStateRow.doneSteps` entries a cook row may hold. Matches the
 * MCP step cap; a real block never comes close.
 */
export const MAX_DONE_STEPS = 200;

/** One step as stored: its text and, for a step done in parallel, its lane. */
export interface CompactStep {
  text: string;
  lane?: string;
}

/**
 * A lane of 1 to `MAX_LANE_CHARS` characters on one line (runs of
 * whitespace, newlines included, become one space; ends trimmed), or
 * `undefined`. Malformed is dropped, not rejected.
 */
export function compactLane(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lane = value.replace(/\s+/g, ' ').trim();
  return lane.length >= 1 && lane.length <= MAX_LANE_CHARS ? lane : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Steps reduced to `{ text }` plus `lane` when it is valid. An entry that is
 * not an object with string `text` is dropped; any other key is dropped.
 * Text is kept as stored (not trimmed), as it was before lanes existed.
 */
export function compactSteps(value: unknown): CompactStep[] {
  if (!Array.isArray(value)) return [];
  const steps: CompactStep[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.text !== 'string') continue;
    const lane = compactLane(entry.lane);
    steps.push(lane === undefined ? { text: entry.text } : { text: entry.text, lane });
  }
  return steps;
}
