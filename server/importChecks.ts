/**
 * Deterministic checks on an imported recipe (`docs/plans/import-reliability.md`,
 * spec §6). They compare the model's output with what the page or pasted text
 * holds and return typed warnings plus a failure class, which decides whether
 * a retry can help. Nothing here calls Gemini or does I/O.
 *
 * Conservative by design: a false warning costs more trust than a missed one,
 * so when a signal is unclear the checks lean toward "the page has it" and
 * "the ingredient is grounded".
 */
import {
  BLOCKING_IMPORT_WARNINGS,
  MIN_STEPS,
  isBlockingWarning,
  type ImportWarning,
  type ImportWarningCode,
} from './importWarnings.ts';
import {
  primaryRegion,
  recipeJsonLdNode,
  regionSource,
  stripToText,
  withinRegion,
  type PageScan,
} from './pageScan.ts';
import type { ImportedRecipe } from './recipeImport.ts';
import { COMMON_UNITS } from './recipeTranslation.ts';

export {
  BLOCKING_IMPORT_WARNINGS,
  IMPORT_WARNING_CODES,
  MIN_STEPS,
  type ImportWarning,
  type ImportWarningCode,
} from './importWarnings.ts';

/** Ingredients flag when the extraction has fewer than the JSON-LD count less max(this, …). */
export const INGREDIENT_COUNT_SLACK = 2;
/** …or less this fraction of the JSON-LD count, whichever is larger. */
export const INGREDIENT_COUNT_SLACK_RATIO = 0.2;
/** Steps flag below this fraction of the JSON-LD count; the prompt lets Gemini merge steps. */
export const STEP_COUNT_MIN_RATIO = 0.5;
export const MAX_UNGROUNDED_REPORTED = 3;

export type ImportFailureClass = 'none' | 'extraction' | 'source';

/** The model's own report of what the source holds. A weak signal, never the only one. */
export interface ImportSelfReport {
  instructionsOnPage?: boolean;
  ingredientsOnPage?: boolean;
}

/** What the page's Recipe JSON-LD lists. A count is absent when the list is absent or uncountable. */
export interface RecipeJsonLd {
  node: Record<string, unknown>;
  ingredientCount?: number;
  stepCount?: number;
  /** `recipeInstructions` holds some text. */
  hasInstructions: boolean;
  /** Every string in the node, for the grounding corpus. */
  text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) stringLeaves(item, out);
  }
}

function hasText(value: unknown): boolean {
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  return leaves.some(nonBlank);
}

function ingredientCount(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => nonBlank(item) || (isPlainObject(item) && hasText(item))).length;
}

/**
 * Steps with `HowToSection` flattened. A step is a non-blank string or an
 * object with non-blank `text` (or `name` when it has no text). One string
 * holding the whole method cannot be counted, so it returns `undefined`.
 */
function stepCount(value: unknown): number | undefined {
  if (typeof value === 'string') return undefined;
  if (isPlainObject(value)) {
    if (value.itemListElement !== undefined) return stepCount(value.itemListElement);
    return nonBlank(value.text) || nonBlank(value.name) ? 1 : 0;
  }
  if (!Array.isArray(value)) return undefined;
  let count = 0;
  for (const item of value) {
    if (nonBlank(item)) {
      count += 1;
    } else if (isPlainObject(item)) {
      const nested = stepCount(item);
      if (nested === undefined) return undefined;
      count += nested;
    }
  }
  return count;
}

/** The page's Recipe JSON-LD and its counts, or `null` when it has none. */
export function readRecipeJsonLd(scan: PageScan): RecipeJsonLd | null {
  const node = recipeJsonLdNode(scan);
  if (node === null) return null;
  const leaves: string[] = [];
  stringLeaves(node, leaves);
  const result: RecipeJsonLd = {
    node,
    hasInstructions: hasText(node.recipeInstructions),
    text: leaves.join(' '),
  };
  const ingredients = ingredientCount(node.recipeIngredient);
  if (ingredients !== undefined) result.ingredientCount = ingredients;
  const steps = stepCount(node.recipeInstructions);
  if (steps !== undefined) result.stepCount = steps;
  return result;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** NFKD, diacritics stripped, lowercase. Both sides of every comparison go through this. */
export function normalizeForMatch(text: string): string {
  return decodeEntities(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Heading words for a method section, already in `normalizeForMatch` form.
 * en, uk, ru, zh, ja, es, fr, it, de.
 */
const INSTRUCTION_WORDS = [
  'instructions',
  'instruction',
  'directions',
  'method',
  'preparation',
  'steps',
  'how to make',
  'приготування',
  'спосіб приготування',
  'інструкція',
  'інструкції',
  'кроки',
  'приготовление',
  'способ приготовления',
  'инструкция',
  'шаги',
  '做法',
  '步骤',
  '制作方法',
  '製作',
  '作り方',
  'instrucciones',
  'preparacion',
  'elaboracion',
  'pasos',
  'etapes',
  'deroulement',
  'preparazione',
  'procedimento',
  'istruzioni',
  'zubereitung',
  'anleitung',
  'schritte',
].map(normalizeForMatch);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function containsTerm(text: string, term: string): boolean {
  if (CJK.test(term)) return text.includes(term);
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + term.length] ?? '';
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) return true;
    from = at + 1;
  }
}

/** A short line or heading that names a method section. */
function namesInstructions(line: string): boolean {
  const text = normalizeForMatch(line).trim();
  if (text === '' || text.length > 60) return false;
  return INSTRUCTION_WORDS.some((term) => containsTerm(text, term));
}

const STEP_ONE =
  /(^|[^\p{L}])(step|шаг|крок|paso|etape|passo|schritt|stap)\s*(1|one)(?!\d)/u;
const STEP_ONE_CJK = /第\s*[1一]\s*步/u;
/** "1. … 2. …" in text whose line breaks are gone. */
const INLINE_NUMBERED = /(^|\s)1\s*[.)]\s+\S[\s\S]{0,600}?\s2\s*[.)]\s+\S/;
const NUMBERED_LINE = /^\s*\d{1,2}\s*[.)]\s+\S/;

function textHasSteps(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return STEP_ONE.test(normalized) || STEP_ONE_CJK.test(text) || INLINE_NUMBERED.test(text);
}

/** At least this much text in a block marked as instructions counts as a method. */
const MIN_INSTRUCTION_BLOCK_CHARS = 40;

/**
 * True when the source looks like it holds a method. For a page: a non-empty
 * JSON-LD `recipeInstructions`, an `<ol>` of 2+ items in the primary region,
 * a heading that names a method section, a block marked as instructions, or
 * "Step 1" / "1. … 2. …" text. For pasted text: the same words on a short
 * line, 2+ numbered lines, or "Step 1". Errs toward true: the source-failure
 * warning needs this to be false.
 */
export function hasInstructionLikeContent(input: {
  scan?: PageScan;
  text?: string;
  jsonLd?: RecipeJsonLd | null;
}): boolean {
  if (input.jsonLd?.hasInstructions) return true;
  const { scan } = input;
  if (scan !== undefined) {
    const region = primaryRegion(scan);
    if (scan.orderedLists.some((list) => list.items >= 2 && withinRegion(list, region))) {
      return true;
    }
    if (scan.headings.some((heading) => namesInstructions(heading.text))) return true;
    if (scan.instructionBlocks.some((block) => block.length >= MIN_INSTRUCTION_BLOCK_CHARS)) {
      return true;
    }
    if (textHasSteps(stripToText(regionSource(scan.html, region)))) return true;
  }
  if (input.text !== undefined) {
    const lines = input.text.split(/\r?\n/);
    if (lines.some(namesInstructions)) return true;
    if (lines.filter((line) => NUMBERED_LINE.test(line)).length >= 2) return true;
    if (textHasSteps(input.text)) return true;
  }
  return false;
}

/**
 * The text an extracted ingredient should appear in, already normalized: the
 * whole page's text, untruncated, plus the JSON-LD (which `stripToText`
 * drops with every `<script>`). For pasted text, the text itself.
 */
export function groundingCorpus(input: {
  scan?: PageScan;
  text?: string;
  jsonLd?: RecipeJsonLd | null;
}): string {
  const parts: string[] = [];
  if (input.scan !== undefined) parts.push(stripToText(input.scan.html));
  if (input.jsonLd) parts.push(input.jsonLd.text);
  if (input.text !== undefined) parts.push(input.text);
  return normalizeForMatch(parts.join(' '));
}

const UNIT_WORDS = new Set(
  [
    ...COMMON_UNITS,
    'pieces',
    'cups',
    'tablespoon',
    'tablespoons',
    'teaspoon',
    'teaspoons',
    'tbs',
    'tbl',
    'gram',
    'grams',
    'kilogram',
    'kilograms',
    'ounce',
    'ounces',
    'pound',
    'pounds',
    'lbs',
    'liter',
    'liters',
    'litre',
    'litres',
    'milliliter',
    'milliliters',
    'millilitre',
    'millilitres',
    'pinch',
    'dash',
    'handful',
    'bunch',
    'can',
    'cans',
    'package',
    'packages',
    'stick',
    'sticks',
    'slice',
    'slices',
  ].map(normalizeForMatch),
);

/** Words that would ground an invented ingredient by appearing on any recipe page. */
const STOPWORDS = new Set(
  [
    'and',
    'the',
    'for',
    'with',
    'without',
    'from',
    'into',
    'plus',
    'more',
    'about',
    'each',
    'other',
    'optional',
    'taste',
    'fresh',
    'freshly',
    'large',
    'small',
    'medium',
    'whole',
    'chopped',
    'sliced',
    'diced',
    'minced',
    'ground',
    'finely',
    'roughly',
    'peeled',
    'divided',
    'room',
    'temperature',
    'cold',
    'warm',
    'hot',
    'softened',
    'melted',
    'cut',
    'pieces',
    'some',
    'extra',
    'serving',
    'garnish',
  ].map(normalizeForMatch),
);

/** Strip a plural `s`/`es` from Latin words, and a two-letter case ending from Cyrillic and Greek ones. */
function stem(token: string): string {
  if (/^[a-z]+$/.test(token)) {
    if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  }
  if (/^[\p{Script=Cyrillic}\p{Script=Greek}]+$/u.test(token)) {
    if (token.length >= 5) return token.slice(0, -2);
    if (token.length === 4) return token.slice(0, -1);
  }
  return token;
}

/**
 * Forms to look for in the corpus for one token; any one counts. The corpus is
 * not stemmed, so the irregular English plurals map both ways: ies and y
 * (berries, berry), ves and f / fe (leaves, leaf, knives, knife). Only ever
 * adds forms, never removes one, so it cannot make the check stricter.
 */
function tokenVariants(token: string): string[] {
  const variants = new Set([stem(token)]);
  if (/^[a-z]+$/.test(token)) {
    variants.add(token);
    if (token.length > 4 && token.endsWith('ies')) {
      variants.add(`${token.slice(0, -3)}y`);
    } else if (token.length > 3 && /[^aeiou]y$/.test(token)) {
      variants.add(`${token.slice(0, -1)}ies`);
    }
    if (token.length > 4 && token.endsWith('ves')) {
      variants.add(`${token.slice(0, -3)}f`);
      variants.add(`${token.slice(0, -3)}fe`);
    } else if (token.length > 2 && token.endsWith('fe')) {
      variants.add(`${token.slice(0, -2)}ves`);
    } else if (token.length > 2 && token.endsWith('f')) {
      variants.add(`${token.slice(0, -1)}ves`);
    }
  }
  return [...variants];
}

/** Tokens to look for (each with its variants), or `[]` when nothing in the item can be judged. */
function groundingTokens(item: string): { words: string[][]; cjk: string[] } {
  const normalized = normalizeForMatch(item);
  const words: string[][] = [];
  for (const raw of normalized.split(/[^\p{L}]+/u)) {
    if (raw === '' || CJK.test(raw)) continue;
    if (raw.length < 3 || STOPWORDS.has(raw) || UNIT_WORDS.has(raw)) continue;
    words.push(tokenVariants(raw));
  }
  const cjk: string[] = [];
  for (const run of normalized.match(new RegExp(`${CJK.source}+`, 'gu')) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      cjk.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) cjk.push(chars[i] + chars[i + 1]);
  }
  return { words, cjk };
}

function isGrounded(item: string, corpus: string): boolean {
  const { words, cjk } = groundingTokens(item);
  if (words.length === 0 && cjk.length === 0) return true;
  return words.some((variants) => variants.some((form) => corpus.includes(form))) || cjk.some((pair) => corpus.includes(pair));
}

/**
 * Positions of ingredients whose name never appears in the corpus, at most
 * `MAX_UNGROUNDED_REPORTED`. Empty when more than half look ungrounded: that
 * means the corpus is wrong (a translated page, an image-only list), not the
 * model.
 */
function ungroundedIngredients(
  recipe: ImportedRecipe,
  corpus: string,
): [number, number][] {
  if (corpus.trim() === '') return [];
  const ungrounded: [number, number][] = [];
  let total = 0;
  recipe.ingredientSections.forEach((section, si) => {
    section.items.forEach((ingredient, ii) => {
      total += 1;
      if (!isGrounded(ingredient.item, corpus)) ungrounded.push([si, ii]);
    });
  });
  if (ungrounded.length * 2 > total) return [];
  return ungrounded.slice(0, MAX_UNGROUNDED_REPORTED);
}

export interface ImportCheckInput {
  recipe: ImportedRecipe;
  selfReport: ImportSelfReport;
  /** Counts from the page's JSON-LD; absent for pasted text or a page without it. */
  jsonLd?: Pick<RecipeJsonLd, 'ingredientCount' | 'stepCount'> | null;
  sourceHasInstructions: boolean;
  /** From `groundingCorpus`, already normalized. */
  corpus: string;
  /** Ingredients and steps the model returned blank, which normalization dropped. */
  blankItems?: number;
}

export interface ImportCheckResult {
  /** Blocking codes first, in the order raised. */
  warnings: ImportWarning[];
  failureClass: ImportFailureClass;
}

/**
 * Structural checks (spec §6.1) and source cross-checks (§6.2). The failure
 * class is `extraction` when any blocking warning could be the model's fault,
 * `source` when every blocking warning is the page's, and `none` when nothing
 * blocks.
 */
export function checkImport(input: ImportCheckInput): ImportCheckResult {
  const { recipe, selfReport, jsonLd } = input;
  const raised: { warning: ImportWarning; source: boolean }[] = [];
  const raise = (code: ImportWarningCode, source = false, at?: [number, number]) => {
    raised.push({ warning: at === undefined ? { code } : { code, at }, source });
  };

  const steps = recipe.steps.length;
  const ingredients = recipe.ingredientSections.reduce((n, s) => n + s.items.length, 0);

  if (recipe.title.trim() === '') raise('MISSING_TITLE');

  if (steps === 0) {
    if (!input.sourceHasInstructions && selfReport.instructionsOnPage === false) {
      raise('INSTRUCTIONS_NOT_ON_PAGE', true);
    } else if (input.sourceHasInstructions) {
      raise('INSTRUCTIONS_DROPPED');
    } else {
      raise('MISSING_INSTRUCTIONS');
    }
  } else if (steps < MIN_STEPS) {
    raise('TOO_FEW_STEPS');
  }

  if (ingredients === 0) {
    const pageHasNone = (jsonLd?.ingredientCount ?? 0) === 0 && selfReport.ingredientsOnPage === false;
    raise('MISSING_INGREDIENTS', pageHasNone);
  }

  if ((input.blankItems ?? 0) > 0) raise('EMPTY_ITEMS');

  if (ingredients > 0 && jsonLd?.ingredientCount !== undefined) {
    const expected = jsonLd.ingredientCount;
    const slack = Math.max(INGREDIENT_COUNT_SLACK, expected * INGREDIENT_COUNT_SLACK_RATIO);
    if (ingredients < expected - slack) raise('INGREDIENT_COUNT_MISMATCH');
  }
  if (steps > 0 && jsonLd?.stepCount !== undefined) {
    if (steps < jsonLd.stepCount * STEP_COUNT_MIN_RATIO) raise('STEP_COUNT_MISMATCH');
  }

  for (const at of ungroundedIngredients(recipe, input.corpus)) {
    raise('UNGROUNDED_INGREDIENT', false, at);
  }

  const blocking = raised.filter((r) => BLOCKING_IMPORT_WARNINGS.has(r.warning.code));
  const failureClass: ImportFailureClass =
    blocking.length === 0 ? 'none' : blocking.some((r) => !r.source) ? 'extraction' : 'source';
  const warnings = [
    ...blocking.map((r) => r.warning),
    ...raised.filter((r) => !BLOCKING_IMPORT_WARNINGS.has(r.warning.code)).map((r) => r.warning),
  ];
  return { warnings, failureClass };
}

/** Fewest blocking warnings, then most steps, then the earliest attempt. */
export function pickBestAttempt<T extends { recipe: { steps: readonly unknown[] }; warnings: ImportWarning[] }>(
  attempts: readonly T[],
): T {
  if (attempts.length === 0) throw new Error('pickBestAttempt needs at least one attempt');
  let best = attempts[0];
  const blockingCount = (attempt: T) => attempt.warnings.filter(isBlockingWarning).length;
  for (const attempt of attempts.slice(1)) {
    const fewer = blockingCount(attempt) - blockingCount(best);
    if (fewer < 0 || (fewer === 0 && attempt.recipe.steps.length > best.recipe.steps.length)) {
      best = attempt;
    }
  }
  return best;
}
