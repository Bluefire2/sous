/**
 * Strict validation of recipe input from the MCP `create_recipe` and
 * `update_recipe` tools. A bad field is rejected with its path, never
 * silently repaired, so the model can fix its own call. (The import
 * normalizer repairs instead, which is right for imports and wrong here.)
 * Pure: no I/O.
 */
import { reconcileImportCheck, type ImportCheck } from '../importWarnings.ts';
import { normalizeLang } from '../lang.ts';
import { MAX_LANE_CHARS } from '../recipeSteps.ts';
import { compactVariantOf } from '../recipeVariant.ts';
import { compactRecipeFields, MAX_RECIPE_LANG_CHARS } from '../store.ts';

export const RECIPE_LIMITS = {
  title: 200,
  sectionName: 200,
  sections: 50,
  itemsPerSection: 200,
  item: 300,
  unit: 32,
  note: 300,
  steps: 200,
  step: 5000,
  lane: MAX_LANE_CHARS,
  tags: 30,
  tag: 40,
  longText: 10_000,
  sourceUrl: 2000,
  minServings: 1,
  maxServings: 1000,
  maxMinutes: 10_000,
} as const;

/** `validateRecipePut` rejects a payload whose `JSON.stringify` is this long or longer. */
const MAX_PAYLOAD_CHARS = 200_000;

export type FieldError = { path: string; message: string };

export type RecipeIngredient = { item: string; quantity?: number; unit?: string; note?: string };
export type RecipeIngredientSection = { name?: string; items: RecipeIngredient[] };
/** `lane`: who does the step when two people cook (`docs/plans/parallel-steps.md`). */
export type RecipeStepInput = { text: string; lane?: string };

/** The text a model may write. Photos, collections, and the import check are not part of it. */
export type RecipeContentInput = {
  title: string;
  description?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: RecipeIngredientSection[];
  steps: RecipeStepInput[];
  tags: string[];
  notes?: string;
};

export type NewRecipeInput = RecipeContentInput & { sourceUrl?: string; lang?: string };

/** Each key present replaces that field; `null` clears an optional one. */
export type RecipeChanges = {
  title?: string;
  description?: string | null;
  servings?: number;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  ingredientSections?: RecipeIngredientSection[];
  steps?: RecipeStepInput[];
  tags?: string[];
  notes?: string | null;
};

const CONTENT_FIELDS = [
  'title',
  'description',
  'servings',
  'prepMinutes',
  'cookMinutes',
  'ingredientSections',
  'steps',
  'tags',
  'notes',
] as const;
const NEW_RECIPE_FIELDS: ReadonlySet<string> = new Set([...CONTENT_FIELDS, 'sourceUrl', 'lang']);
const CHANGE_FIELDS: ReadonlySet<string> = new Set(CONTENT_FIELDS);
const CLEARABLE_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'notes',
  'prepMinutes',
  'cookMinutes',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({ path: path === '' ? key : `${path}.${key}`, message: 'is not a recipe field' });
    }
  }
}

/** A trimmed string of 1..max characters, or an error. */
function requiredText(
  value: unknown,
  path: string,
  max: number,
  errors: FieldError[],
): string | undefined {
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push({ path, message: 'must not be empty' });
    return undefined;
  }
  if (trimmed.length > max) {
    errors.push({ path, message: `must be at most ${max} characters` });
    return undefined;
  }
  return trimmed;
}

/**
 * An optional string of at most `max` characters. A blank string means "not
 * set", the same as leaving it out; it never becomes a stored empty field.
 */
function optionalText(
  value: unknown,
  path: string,
  max: number,
  errors: FieldError[],
): string | undefined {
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    errors.push({ path, message: `must be at most ${max} characters` });
    return undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}

function numberInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: FieldError[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ path, message: 'must be a number' });
    return undefined;
  }
  if (value < min || value > max) {
    errors.push({ path, message: `must be between ${min} and ${max}` });
    return undefined;
  }
  return value;
}

const INGREDIENT_FIELDS: ReadonlySet<string> = new Set(['item', 'quantity', 'unit', 'note']);
const SECTION_FIELDS: ReadonlySet<string> = new Set(['name', 'items']);
const STEP_FIELDS: ReadonlySet<string> = new Set(['text', 'lane']);

function validateIngredient(
  raw: unknown,
  path: string,
  errors: FieldError[],
): RecipeIngredient | undefined {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'must be an object with an item' });
    return undefined;
  }
  const before = errors.length;
  unknownKeys(raw, INGREDIENT_FIELDS, path, errors);
  const item = requiredText(raw.item, `${path}.item`, RECIPE_LIMITS.item, errors);
  const out: RecipeIngredient = { item: item ?? '' };
  if (raw.quantity !== undefined) {
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || raw.quantity <= 0) {
      errors.push({ path: `${path}.quantity`, message: 'must be a number greater than 0' });
    } else {
      out.quantity = raw.quantity;
    }
  }
  if (raw.unit !== undefined) {
    const unit = optionalText(raw.unit, `${path}.unit`, RECIPE_LIMITS.unit, errors);
    if (unit !== undefined) out.unit = unit;
  }
  if (raw.note !== undefined) {
    const note = optionalText(raw.note, `${path}.note`, RECIPE_LIMITS.note, errors);
    if (note !== undefined) out.note = note;
  }
  return errors.length === before ? out : undefined;
}

function validateSections(
  raw: unknown,
  path: string,
  errors: FieldError[],
): RecipeIngredientSection[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push({ path, message: 'must be an array of sections' });
    return undefined;
  }
  if (raw.length > RECIPE_LIMITS.sections) {
    errors.push({ path, message: `must have at most ${RECIPE_LIMITS.sections} sections` });
    return undefined;
  }
  const before = errors.length;
  const sections: RecipeIngredientSection[] = [];
  raw.forEach((section, i) => {
    const sectionPath = `${path}[${i}]`;
    if (!isPlainObject(section)) {
      errors.push({ path: sectionPath, message: 'must be an object with items' });
      return;
    }
    unknownKeys(section, SECTION_FIELDS, sectionPath, errors);
    const out: RecipeIngredientSection = { items: [] };
    if (section.name !== undefined) {
      const name = optionalText(section.name, `${sectionPath}.name`, RECIPE_LIMITS.sectionName, errors);
      if (name !== undefined) out.name = name;
    }
    const items = section.items;
    if (!Array.isArray(items) || items.length === 0) {
      errors.push({ path: `${sectionPath}.items`, message: 'must be a non-empty array' });
      return;
    }
    if (items.length > RECIPE_LIMITS.itemsPerSection) {
      errors.push({
        path: `${sectionPath}.items`,
        message: `must have at most ${RECIPE_LIMITS.itemsPerSection} items`,
      });
      return;
    }
    items.forEach((item, j) => {
      const ingredient = validateIngredient(item, `${sectionPath}.items[${j}]`, errors);
      if (ingredient !== undefined) out.items.push(ingredient);
    });
    sections.push(out);
  });
  return errors.length === before ? sections : undefined;
}

function validateSteps(raw: unknown, path: string, errors: FieldError[]): RecipeStepInput[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push({ path, message: 'must be an array of { text, lane? } objects' });
    return undefined;
  }
  if (raw.length > RECIPE_LIMITS.steps) {
    errors.push({ path, message: `must have at most ${RECIPE_LIMITS.steps} steps` });
    return undefined;
  }
  const before = errors.length;
  const steps: RecipeStepInput[] = [];
  raw.forEach((step, i) => {
    const stepPath = `${path}[${i}]`;
    if (!isPlainObject(step)) {
      errors.push({ path: stepPath, message: 'must be an object with text' });
      return;
    }
    unknownKeys(step, STEP_FIELDS, stepPath, errors);
    const text = requiredText(step.text, `${stepPath}.text`, RECIPE_LIMITS.step, errors);
    // A blank lane means none; a long or non-string one is an error, and so
    // is one that compactLane would change (a line break, tab, or double
    // space), since this input is never repaired.
    let lane =
      step.lane === undefined
        ? undefined
        : optionalText(step.lane, `${stepPath}.lane`, RECIPE_LIMITS.lane, errors);
    if (lane !== undefined && /\s{2,}|[^\S ]/.test(lane)) {
      errors.push({ path: `${stepPath}.lane`, message: 'must be one line with single spaces' });
      lane = undefined;
    }
    if (text !== undefined) steps.push(lane === undefined ? { text } : { text, lane });
  });
  return errors.length === before ? steps : undefined;
}

/** Trimmed and deduplicated, in order. */
function validateTags(raw: unknown, path: string, errors: FieldError[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push({ path, message: 'must be an array of strings' });
    return undefined;
  }
  const before = errors.length;
  const tags: string[] = [];
  const seen = new Set<string>();
  raw.forEach((tag, i) => {
    const text = requiredText(tag, `${path}[${i}]`, RECIPE_LIMITS.tag, errors);
    if (text !== undefined && !seen.has(text)) {
      seen.add(text);
      tags.push(text);
    }
  });
  if (errors.length !== before) return undefined;
  if (tags.length > RECIPE_LIMITS.tags) {
    errors.push({ path, message: `must have at most ${RECIPE_LIMITS.tags} tags` });
    return undefined;
  }
  return tags;
}

function validateSourceUrl(raw: unknown, path: string, errors: FieldError[]): string | undefined {
  const text = optionalText(raw, path, RECIPE_LIMITS.sourceUrl, errors);
  if (text === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    errors.push({ path, message: 'must be an http or https URL' });
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push({ path, message: 'must be an http or https URL' });
    return undefined;
  }
  return text;
}

function validateLang(raw: unknown, path: string, errors: FieldError[]): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_RECIPE_LANG_CHARS) {
    errors.push({ path, message: 'must be a BCP 47 language tag such as "en" or "zh-Hans"' });
    return undefined;
  }
  if (raw.trim() === '') return undefined;
  const lang = normalizeLang(raw);
  if (lang === undefined) {
    errors.push({ path, message: 'must be a BCP 47 language tag such as "en" or "zh-Hans"' });
  }
  return lang;
}

function tooLarge(): FieldError {
  return { path: '', message: `the recipe must be under ${MAX_PAYLOAD_CHARS} characters of JSON` };
}

export function validateNewRecipe(
  raw: unknown,
): { ok: true; recipe: NewRecipeInput } | { ok: false; errors: FieldError[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '', message: 'must be an object' }] };
  }
  const errors: FieldError[] = [];
  unknownKeys(raw, NEW_RECIPE_FIELDS, '', errors);
  const title = requiredText(raw.title, 'title', RECIPE_LIMITS.title, errors);
  const servings = numberInRange(
    raw.servings,
    'servings',
    RECIPE_LIMITS.minServings,
    RECIPE_LIMITS.maxServings,
    errors,
  );
  const ingredientSections = validateSections(raw.ingredientSections, 'ingredientSections', errors);
  const steps = validateSteps(raw.steps, 'steps', errors);
  const tags = raw.tags === undefined ? [] : validateTags(raw.tags, 'tags', errors);
  const recipe: NewRecipeInput = {
    title: title ?? '',
    servings: servings ?? 1,
    ingredientSections: ingredientSections ?? [],
    steps: steps ?? [],
    tags: tags ?? [],
  };
  if (raw.description !== undefined) {
    const description = optionalText(raw.description, 'description', RECIPE_LIMITS.longText, errors);
    if (description !== undefined) recipe.description = description;
  }
  if (raw.notes !== undefined) {
    const notes = optionalText(raw.notes, 'notes', RECIPE_LIMITS.longText, errors);
    if (notes !== undefined) recipe.notes = notes;
  }
  for (const key of ['prepMinutes', 'cookMinutes'] as const) {
    if (raw[key] !== undefined) {
      const minutes = numberInRange(raw[key], key, 0, RECIPE_LIMITS.maxMinutes, errors);
      if (minutes !== undefined) recipe[key] = minutes;
    }
  }
  if (raw.sourceUrl !== undefined) {
    const sourceUrl = validateSourceUrl(raw.sourceUrl, 'sourceUrl', errors);
    if (sourceUrl !== undefined) recipe.sourceUrl = sourceUrl;
  }
  if (raw.lang !== undefined) {
    const lang = validateLang(raw.lang, 'lang', errors);
    if (lang !== undefined) recipe.lang = lang;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, recipe };
}

export function validateRecipeChanges(
  raw: unknown,
): { ok: true; changes: RecipeChanges } | { ok: false; errors: FieldError[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: 'changes', message: 'must be an object' }] };
  }
  const errors: FieldError[] = [];
  unknownKeys(raw, CHANGE_FIELDS, 'changes', errors);
  const changes: RecipeChanges = {};
  for (const key of Object.keys(raw)) {
    if (!CHANGE_FIELDS.has(key)) continue;
    const value = raw[key];
    const path = `changes.${key}`;
    if (value === null) {
      if (CLEARABLE_FIELDS.has(key)) {
        (changes as Record<string, unknown>)[key] = null;
      } else {
        errors.push({ path, message: 'is required and cannot be cleared' });
      }
      continue;
    }
    switch (key) {
      case 'title': {
        const title = requiredText(value, path, RECIPE_LIMITS.title, errors);
        if (title !== undefined) changes.title = title;
        break;
      }
      case 'description':
      case 'notes': {
        // A blank string clears, like null.
        const text = optionalText(value, path, RECIPE_LIMITS.longText, errors);
        if (typeof value === 'string') changes[key] = text ?? null;
        break;
      }
      case 'servings': {
        const servings = numberInRange(
          value,
          path,
          RECIPE_LIMITS.minServings,
          RECIPE_LIMITS.maxServings,
          errors,
        );
        if (servings !== undefined) changes.servings = servings;
        break;
      }
      case 'prepMinutes':
      case 'cookMinutes': {
        const minutes = numberInRange(value, path, 0, RECIPE_LIMITS.maxMinutes, errors);
        if (minutes !== undefined) changes[key] = minutes;
        break;
      }
      case 'ingredientSections': {
        const sections = validateSections(value, path, errors);
        if (sections !== undefined) changes.ingredientSections = sections;
        break;
      }
      case 'steps': {
        const steps = validateSteps(value, path, errors);
        if (steps !== undefined) changes.steps = steps;
        break;
      }
      case 'tags': {
        const tags = validateTags(value, path, errors);
        if (tags !== undefined) changes.tags = tags;
        break;
      }
    }
  }
  if (errors.length === 0 && Object.keys(changes).length === 0) {
    errors.push({ path: 'changes', message: 'must change at least one field' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, changes };
}

/**
 * What a new variant takes from the stored recipe it was made from: the
 * group's original (the parent's own `variantOf`, else the parent), so a
 * variant of a variant joins the same flat group, and the parent's language.
 * The same rule as `recipeStore.createFromAsk` (`docs/plans/recipe-variants.md`).
 */
export function variantFromParent(parent: Record<string, unknown> & { id: string }): {
  variantOf: string;
  lang?: string;
} {
  const lang = normalizeLang(parent.lang);
  return {
    variantOf: compactVariantOf(parent.variantOf, parent.id) ?? parent.id,
    ...(lang !== undefined ? { lang } : {}),
  };
}

/**
 * The `recipe.put` payload for a new recipe, stamped `createdAt = updatedAt =
 * now`, or an error when it is too large to push. `variantOf` is the group
 * key from `variantFromParent`, never a model-sent value.
 */
export function newRecipePayload(
  recipe: NewRecipeInput,
  id: string,
  now: number,
  variantOf?: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; errors: FieldError[] } {
  // Fields are copied by name so nothing else rides along.
  const payload: Record<string, unknown> = {
    id,
    createdAt: now,
    updatedAt: now,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    tags: recipe.tags,
  };
  for (const key of ['description', 'notes', 'prepMinutes', 'cookMinutes', 'sourceUrl', 'lang'] as const) {
    if (recipe[key] !== undefined) payload[key] = recipe[key];
  }
  if (variantOf !== undefined) payload.variantOf = variantOf;
  if (JSON.stringify(payload).length >= MAX_PAYLOAD_CHARS) {
    return { ok: false, errors: [tooLarge()] };
  }
  return { ok: true, payload };
}

/** Sections whose `items` is not an array read as empty, so a malformed stored doc cannot throw. */
function importCheckContent(doc: Record<string, unknown>) {
  const sections = Array.isArray(doc.ingredientSections) ? doc.ingredientSections : [];
  return {
    title: typeof doc.title === 'string' ? doc.title : '',
    description: doc.description as string | undefined,
    servings: doc.servings as number,
    prepMinutes: doc.prepMinutes as number | undefined,
    cookMinutes: doc.cookMinutes as number | undefined,
    ingredientSections: sections.map((section) =>
      isPlainObject(section) && Array.isArray(section.items) ? (section as { items: unknown[] }) : { items: [] },
    ),
    steps: Array.isArray(doc.steps) ? (doc.steps as unknown[]) : [],
    notes: doc.notes as string | undefined,
  };
}

/**
 * The stored recipe with `changes` applied: each key present replaces that
 * field, `null` clears it, and everything else is kept, including
 * `createdAt`, `sourceUrl`, `photoId`, `galleryPhotoIds` and `lang`. The
 * import check is reconciled as `recipeStore.save` does. Returns null when
 * the result is too large to store.
 */
export function mergeRecipeChanges(
  stored: Record<string, unknown>,
  changes: RecipeChanges,
  updatedAt: number,
): Record<string, unknown> | null {
  const before = compactRecipeFields(stored);
  const next: Record<string, unknown> = { ...before, updatedAt };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  const check = reconcileImportCheck(
    before.importCheck as ImportCheck | undefined,
    importCheckContent(before),
    importCheckContent(next),
    updatedAt,
  );
  if (check === undefined) {
    delete next.importCheck;
  } else {
    next.importCheck = check;
  }
  if (JSON.stringify(next).length >= MAX_PAYLOAD_CHARS) {
    return null;
  }
  return next;
}

/** Field errors as one line each, for the tool's text result. */
export function fieldErrorText(errors: readonly FieldError[]): string {
  return errors
    .map((error) => (error.path === '' ? error.message : `${error.path} ${error.message}`))
    .join('\n');
}
