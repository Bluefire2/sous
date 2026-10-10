// Keep this module dependency-free and browser-safe: src/lib/importCheck.ts
// re-exports it into the Vite client bundle as well as the Node import path.
/**
 * Import warnings: the typed codes an import check raises, and the
 * `Recipe.importCheck` record that carries them on a saved recipe
 * (`docs/plans/import-reliability.md`). The server sends codes; the client
 * owns the words (i18n principle 10).
 */

/** Structural checks on the output, then source cross-checks against the page. */
export const IMPORT_WARNING_CODES = [
  'MISSING_INSTRUCTIONS',
  'MISSING_INGREDIENTS',
  'TOO_FEW_STEPS',
  'MISSING_TITLE',
  'EMPTY_ITEMS',
  'INSTRUCTIONS_NOT_ON_PAGE',
  'INSTRUCTIONS_DROPPED',
  'INGREDIENT_COUNT_MISMATCH',
  'STEP_COUNT_MISMATCH',
  'UNGROUNDED_INGREDIENT',
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

/** These retry where a retry can help, and warn if the recipe still fails. The rest only warn. */
export const BLOCKING_IMPORT_WARNINGS: ReadonlySet<ImportWarningCode> = new Set([
  'MISSING_INSTRUCTIONS',
  'MISSING_INGREDIENTS',
  'INSTRUCTIONS_DROPPED',
  'INSTRUCTIONS_NOT_ON_PAGE',
]);

export interface ImportWarning {
  code: ImportWarningCode;
  /** `[section, item]` in `ingredientSections`, for a warning about one ingredient. */
  at?: [section: number, item: number];
}

export interface ImportCheck {
  /** When the import ran. A new import replaces the whole record. */
  at: number;
  /**
   * Non-empty from an import. An edit that resolves every warning leaves it
   * empty, so `editedAt` still records that the recipe was fixed by hand.
   */
  warnings: ImportWarning[];
  dismissedAt?: number;
  /** The first content change after import. */
  editedAt?: number;
}

export const MAX_IMPORT_WARNINGS = 10;

/**
 * Fewer steps than this raises `TOO_FEW_STEPS`, and an edit that reaches it
 * clears the warning. Calibrate against the phase 1 fixtures.
 */
export const MIN_STEPS = 2;

export function isImportWarningCode(value: unknown): value is ImportWarningCode {
  return (
    typeof value === 'string' && (IMPORT_WARNING_CODES as readonly string[]).includes(value)
  );
}

export function isBlockingWarning(warning: ImportWarning): boolean {
  return BLOCKING_IMPORT_WARNINGS.has(warning.code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** One warning, or `undefined` for an unknown code or a malformed position. */
function compactWarning(raw: unknown): ImportWarning | undefined {
  if (!isPlainObject(raw) || !isImportWarningCode(raw.code)) return undefined;
  if (raw.at === undefined) return { code: raw.code };
  const at = raw.at;
  if (!Array.isArray(at) || at.length !== 2 || !isIndex(at[0]) || !isIndex(at[1])) {
    return undefined;
  }
  return { code: raw.code, at: [at[0], at[1]] };
}

/**
 * Warnings from an import response: unknown codes and malformed entries are
 * dropped, and at most `MAX_IMPORT_WARNINGS` are kept. Never throws.
 */
export function readImportWarnings(raw: unknown): ImportWarning[] {
  if (!Array.isArray(raw)) return [];
  const warnings: ImportWarning[] = [];
  for (const item of raw) {
    const warning = compactWarning(item);
    if (warning !== undefined) warnings.push(warning);
  }
  return warnings.slice(0, MAX_IMPORT_WARNINGS);
}

/**
 * The stored shape of `Recipe.importCheck`, or `undefined` when there is none
 * or it is malformed. A malformed record is dropped, never rejected, so a
 * recipe put from an older or newer client still saves. A warning with a code
 * this build does not know is dropped on its own. Runs on both sides of sync:
 * `compactRecipe` on the client, `compactRecipeFields` on the server.
 */
export function compactImportCheck(raw: unknown): ImportCheck | undefined {
  if (!isPlainObject(raw) || !isFiniteNumber(raw.at)) return undefined;
  if (!Array.isArray(raw.warnings) || raw.warnings.length > MAX_IMPORT_WARNINGS) {
    return undefined;
  }
  if (raw.dismissedAt !== undefined && !isFiniteNumber(raw.dismissedAt)) return undefined;
  if (raw.editedAt !== undefined && !isFiniteNumber(raw.editedAt)) return undefined;
  const warnings: ImportWarning[] = [];
  for (const item of raw.warnings) {
    const warning = compactWarning(item);
    if (warning !== undefined) warnings.push(warning);
  }
  const check: ImportCheck = { at: raw.at, warnings };
  if (raw.dismissedAt !== undefined) check.dismissedAt = raw.dismissedAt;
  if (raw.editedAt !== undefined) check.editedAt = raw.editedAt;
  return check;
}

/**
 * The imported text of a recipe: what an edit after import can change. Tags
 * and photos are not. Structural, so the client's `Recipe` and the server's
 * stored recipe documents both fit.
 */
export interface ImportCheckContent {
  title: string;
  description?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: ReadonlyArray<{ readonly items: readonly unknown[] }>;
  steps: readonly unknown[];
  notes?: string;
}

/** JSON with object keys sorted and `undefined` dropped, so key order never reads as an edit. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function contentKey(recipe: ImportCheckContent): string {
  return canonical([
    recipe.title,
    recipe.description,
    recipe.servings,
    recipe.prepMinutes,
    recipe.cookMinutes,
    recipe.ingredientSections,
    recipe.steps,
    recipe.notes,
  ]);
}

function ingredientCount(recipe: ImportCheckContent): number {
  return recipe.ingredientSections.reduce((n, section) => n + section.items.length, 0);
}

/** Whether a warning still describes `after`, given what changed since `before`. */
function stillHolds(
  warning: ImportWarning,
  before: ImportCheckContent,
  after: ImportCheckContent,
): boolean {
  const sectionsChanged = canonical(before.ingredientSections) !== canonical(after.ingredientSections);
  switch (warning.code) {
    case 'MISSING_INSTRUCTIONS':
    case 'INSTRUCTIONS_DROPPED':
    case 'INSTRUCTIONS_NOT_ON_PAGE':
      return after.steps.length === 0;
    case 'TOO_FEW_STEPS':
      return after.steps.length < MIN_STEPS;
    case 'MISSING_INGREDIENTS':
      return ingredientCount(after) === 0;
    case 'MISSING_TITLE':
      return after.title.trim() === '';
    case 'STEP_COUNT_MISMATCH':
      return after.steps.length <= before.steps.length;
    case 'INGREDIENT_COUNT_MISMATCH':
      return ingredientCount(after) <= ingredientCount(before);
    case 'EMPTY_ITEMS':
      return !sectionsChanged && canonical(before.steps) === canonical(after.steps);
    case 'UNGROUNDED_INGREDIENT': {
      // A position means nothing once the list has changed.
      if (sectionsChanged || warning.at === undefined) return false;
      const [section, item] = warning.at;
      return after.ingredientSections[section]?.items[item] !== undefined;
    }
  }
}

/**
 * The import check after an edit from `before` to `after`. With no content
 * change it is returned as is, so a Dismiss (which changes only
 * `dismissedAt`) is never an edit. The first content change sets `editedAt`.
 * A warning whose condition no longer holds is dropped: steps were added,
 * ingredients were added, or the ingredient list a position pointed into
 * changed. `dismissedAt` is kept. A record whose warnings all resolve stays,
 * with no warnings, so `editedAt` still counts the fix.
 *
 * The app's `recipeStore.save` and the MCP `update_recipe` tool both run it,
 * so an edit from either side reconciles the same way.
 */
export function reconcileImportCheck(
  check: ImportCheck | undefined,
  before: ImportCheckContent,
  after: ImportCheckContent,
  now: number,
): ImportCheck | undefined {
  if (check === undefined || contentKey(before) === contentKey(after)) return check;
  const next: ImportCheck = {
    ...check,
    warnings: check.warnings.filter((warning) => stillHolds(warning, before, after)),
  };
  if (next.editedAt === undefined) next.editedAt = now;
  return next;
}
