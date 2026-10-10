import type { AgentLibrary, AgentRecipe } from './library.ts';

export type CombinedLine = {
  item: string;
  quantity?: number;
  unit?: string;
  asNeeded?: true;
  /** Optional in every source recipe; never merged with a required line of the same item. */
  optional?: true;
  sourceRecipeIds: string[];
};

type UnitFamily = 'us_volume' | 'metric_volume' | 'metric_mass' | 'imperial_mass' | 'count' | 'other';

type UnitDef = {
  family: UnitFamily;
  canonical: string;
  toBase: number;
};

const US_VOLUME: UnitDef[] = [
  { family: 'us_volume', canonical: 'tsp', toBase: 1 },
  { family: 'us_volume', canonical: 'tbsp', toBase: 3 },
  { family: 'us_volume', canonical: 'cup', toBase: 48 },
];

const METRIC_VOLUME: UnitDef[] = [
  { family: 'metric_volume', canonical: 'ml', toBase: 1 },
  { family: 'metric_volume', canonical: 'l', toBase: 1000 },
];

const METRIC_MASS: UnitDef[] = [
  { family: 'metric_mass', canonical: 'g', toBase: 1 },
  { family: 'metric_mass', canonical: 'kg', toBase: 1000 },
];

const IMPERIAL_MASS: UnitDef[] = [
  { family: 'imperial_mass', canonical: 'oz', toBase: 1 },
  { family: 'imperial_mass', canonical: 'lb', toBase: 16 },
];

const COUNT_CANONICAL = 'piece';

/** Grams per ounce, for a member who reads in metric (`docs/plans/measurement-units.md`). */
const GRAMS_PER_OUNCE = 28.349523125;

const ALIASES: Record<string, UnitDef> = {
  tsp: US_VOLUME[0]!,
  teaspoon: US_VOLUME[0]!,
  teaspoons: US_VOLUME[0]!,
  tbsp: US_VOLUME[1]!,
  tablespoon: US_VOLUME[1]!,
  tablespoons: US_VOLUME[1]!,
  cup: US_VOLUME[2]!,
  cups: US_VOLUME[2]!,
  ml: METRIC_VOLUME[0]!,
  milliliter: METRIC_VOLUME[0]!,
  milliliters: METRIC_VOLUME[0]!,
  l: METRIC_VOLUME[1]!,
  liter: METRIC_VOLUME[1]!,
  litre: METRIC_VOLUME[1]!,
  liters: METRIC_VOLUME[1]!,
  litres: METRIC_VOLUME[1]!,
  g: METRIC_MASS[0]!,
  gram: METRIC_MASS[0]!,
  grams: METRIC_MASS[0]!,
  kg: METRIC_MASS[1]!,
  kilogram: METRIC_MASS[1]!,
  kilograms: METRIC_MASS[1]!,
  oz: IMPERIAL_MASS[0]!,
  ounce: IMPERIAL_MASS[0]!,
  ounces: IMPERIAL_MASS[0]!,
  lb: IMPERIAL_MASS[1]!,
  lbs: IMPERIAL_MASS[1]!,
  pound: IMPERIAL_MASS[1]!,
  pounds: IMPERIAL_MASS[1]!,
  piece: { family: 'count', canonical: COUNT_CANONICAL, toBase: 1 },
  pieces: { family: 'count', canonical: COUNT_CANONICAL, toBase: 1 },
};

function familyUnits(family: UnitFamily): UnitDef[] {
  switch (family) {
    case 'us_volume':
      return US_VOLUME;
    case 'metric_volume':
      return METRIC_VOLUME;
    case 'metric_mass':
      return METRIC_MASS;
    case 'imperial_mass':
      return IMPERIAL_MASS;
    default:
      return [];
  }
}

export function normalizeItemName(item: string): string {
  let s = item.toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function resolveUnit(
  unit: string | undefined,
  hasQuantity: boolean,
): { family: UnitFamily; canonical: string; toBase: number } {
  if (unit === undefined || unit.trim() === '') {
    if (hasQuantity) {
      return { family: 'count', canonical: COUNT_CANONICAL, toBase: 1 };
    }
    return { family: 'other', canonical: '', toBase: 1 };
  }
  const key = unit.toLowerCase().trim();
  const alias = ALIASES[key];
  if (alias) {
    return alias;
  }
  return { family: 'other', canonical: key, toBase: 1 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function baseToDisplayQuantity(
  family: UnitFamily,
  canonicalOther: string,
  baseTotal: number,
): { quantity: number; unit: string } {
  if (family === 'other') {
    return { quantity: round2(baseTotal), unit: canonicalOther };
  }
  if (family === 'count') {
    return { quantity: round2(baseTotal), unit: COUNT_CANONICAL };
  }
  const units = familyUnits(family);
  const smallest = units[0]!;
  for (let i = units.length - 1; i >= 0; i--) {
    const def = units[i]!;
    const value = baseTotal / def.toBase;
    if (value >= 1) {
      return { quantity: round2(value), unit: def.canonical };
    }
  }
  const value = baseTotal / smallest.toBase;
  return { quantity: round2(value), unit: smallest.canonical };
}

function scaleFactor(recipe: AgentRecipe, requestedServings: number | undefined): number {
  if (
    requestedServings === undefined ||
    !Number.isFinite(requestedServings) ||
    requestedServings <= 0
  ) {
    return 1;
  }
  if (!Number.isFinite(recipe.servings) || recipe.servings <= 0) {
    return 1;
  }
  return requestedServings / recipe.servings;
}

type MergeKey = string;

function mergeKey(normalizedItem: string, family: UnitFamily, otherCanonical: string): MergeKey {
  if (family === 'other') {
    return `${normalizedItem}\0other\0${otherCanonical}`;
  }
  return `${normalizedItem}\0${family}`;
}

type Accumulator =
  | { kind: 'asNeeded'; item: string; optional: boolean; sourceRecipeIds: Set<string> }
  | {
      kind: 'quantified';
      item: string;
      optional: boolean;
      family: UnitFamily;
      otherCanonical: string;
      baseTotal: number;
      /** Some of the total was pounds or ounces converted to grams. */
      converted: boolean;
      sourceRecipeIds: Set<string>;
    };

export interface CombineOptions {
  /**
   * The member reads in metric: pounds and ounces become grams and merge with
   * gram amounts of the same item, so the list never needs the model to convert.
   */
  metric?: boolean;
}

/** A converted gram total, rounded the way a shopper reads it: to 5 g from 10 g up. */
function shoppingGrams(grams: number): number {
  return grams >= 10 ? Math.round(grams / 5) * 5 : Math.round(grams);
}

export function combineIngredients(
  library: AgentLibrary,
  recipes: { id: string; servings?: number }[],
  options: CombineOptions = {},
): { lines: CombinedLine[]; missingIds: string[] } {
  const missingIds: string[] = [];
  const acc = new Map<string, Accumulator>();

  for (const ref of recipes) {
    if (typeof ref.id !== 'string' || ref.id === '') {
      continue;
    }
    const recipe = library.recipeById(ref.id);
    if (!recipe) {
      missingIds.push(ref.id);
      continue;
    }
    const factor = scaleFactor(recipe, ref.servings);
    for (const section of recipe.ingredientSections) {
      for (const ing of section.items) {
        const normalized = normalizeItemName(ing.item);
        if (normalized === '') {
          continue;
        }
        // An optional ingredient keeps its own line, so it never inflates a required total.
        const optional = ing.optional === true;
        const optionalKey = optional ? '\0optional' : '';
        const hasQuantity = ing.quantity !== undefined && Number.isFinite(ing.quantity);
        if (!hasQuantity) {
          const key = `${normalized}\0asNeeded${optionalKey}`;
          let entry = acc.get(key);
          if (!entry || entry.kind !== 'asNeeded') {
            entry = { kind: 'asNeeded', item: ing.item.trim(), optional, sourceRecipeIds: new Set() };
            acc.set(key, entry);
          }
          entry.sourceRecipeIds.add(recipe.id);
          continue;
        }
        const qty = ing.quantity! * factor;
        const resolved = resolveUnit(ing.unit, true);
        const converted = options.metric === true && resolved.family === 'imperial_mass';
        const unitInfo = converted
          ? { family: 'metric_mass' as const, canonical: 'g', toBase: resolved.toBase * GRAMS_PER_OUNCE }
          : resolved;
        if (unitInfo.family === 'other') {
          const key = mergeKey(normalized, 'other', unitInfo.canonical) + optionalKey;
          let entry = acc.get(key);
          if (!entry || entry.kind !== 'quantified') {
            entry = {
              kind: 'quantified',
              item: ing.item.trim(),
              optional,
              family: 'other',
              otherCanonical: unitInfo.canonical,
              baseTotal: 0,
              converted: false,
              sourceRecipeIds: new Set(),
            };
            acc.set(key, entry);
          }
          entry.baseTotal += qty;
          entry.sourceRecipeIds.add(recipe.id);
          continue;
        }
        const baseAmount = qty * unitInfo.toBase;
        const key = mergeKey(normalized, unitInfo.family, '') + optionalKey;
        let entry = acc.get(key);
        if (!entry || entry.kind !== 'quantified') {
          entry = {
            kind: 'quantified',
            item: ing.item.trim(),
            optional,
            family: unitInfo.family,
            otherCanonical: '',
            baseTotal: 0,
            converted: false,
            sourceRecipeIds: new Set(),
          };
          acc.set(key, entry);
        }
        entry.baseTotal += baseAmount;
        if (converted) entry.converted = true;
        entry.sourceRecipeIds.add(recipe.id);
      }
    }
  }

  const lines: CombinedLine[] = [];
  for (const entry of acc.values()) {
    if (entry.kind === 'asNeeded') {
      lines.push({
        item: entry.item,
        asNeeded: true,
        ...(entry.optional ? { optional: true as const } : {}),
        sourceRecipeIds: [...entry.sourceRecipeIds].sort(),
      });
      continue;
    }
    const { quantity, unit } = baseToDisplayQuantity(
      entry.family,
      entry.otherCanonical,
      entry.converted ? shoppingGrams(entry.baseTotal) : entry.baseTotal,
    );
    const line: CombinedLine = {
      item: entry.item,
      quantity,
      unit,
      ...(entry.optional ? { optional: true as const } : {}),
      sourceRecipeIds: [...entry.sourceRecipeIds].sort(),
    };
    lines.push(line);
  }

  lines.sort((a, b) => a.item.localeCompare(b.item, undefined, { sensitivity: 'base' }));
  return { lines, missingIds };
}
