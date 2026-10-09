/**
 * Display-time conversion of US weights and Fahrenheit to metric
 * (`docs/plans/measurement-units.md`). Pure: the recipe screen calls it when
 * the member chose Metric, and the stored recipe never changes. Volumes
 * (cups, spoons, fl oz) are left as written, since turning them into grams
 * needs each ingredient's density.
 */

/** Mirrored from `server/accountPreferences.ts`. */
export const UNIT_SYSTEMS = ['asWritten', 'metric'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

const GRAMS_PER_POUND = 453.59237;
const GRAMS_PER_OUNCE = 28.349523125;

const GRAMS_PER_UNIT: Record<string, number> = {
  lb: GRAMS_PER_POUND,
  lbs: GRAMS_PER_POUND,
  pound: GRAMS_PER_POUND,
  pounds: GRAMS_PER_POUND,
  oz: GRAMS_PER_OUNCE,
  ounce: GRAMS_PER_OUNCE,
  ounces: GRAMS_PER_OUNCE,
};

/** Grams in `quantity` of a weight `unit` (lb, oz and their spellings), or null for any other unit. */
export function toGrams(quantity: number, unit: string | undefined): number | null {
  if (unit === undefined || !Number.isFinite(quantity) || quantity <= 0) return null;
  const perUnit = GRAMS_PER_UNIT[unit.trim().toLowerCase().replace(/\.$/, '')];
  return perUnit === undefined ? null : quantity * perUnit;
}

/** Coarsest first; the first within `WEIGHT_TOLERANCE` of the exact value wins. */
const WEIGHT_STEPS = [500, 250, 100, 50, 25, 10, 5, 1];
const WEIGHT_TOLERANCE = 0.05;

export interface MetricWeight {
  value: number;
  unit: 'g' | 'kg';
}

/**
 * `grams` as the roundest amount a cookbook would print: the coarsest step
 * whose rounded value is within 5% of the exact one, so 1 lb is 450 g and
 * 14 oz is 400 g. Under 10 g, where whole grams can be more than 5% off,
 * it falls back to tenths. 1000 g and over reads in kg.
 */
export function niceWeight(grams: number): MetricWeight {
  let rounded: number | undefined;
  for (const step of WEIGHT_STEPS) {
    const candidate = Math.round(grams / step) * step;
    if (candidate > 0 && Math.abs(candidate - grams) <= grams * WEIGHT_TOLERANCE) {
      rounded = candidate;
      break;
    }
  }
  rounded ??= Math.max(0.1, Math.round(grams * 10) / 10);
  return rounded >= 1000 ? { value: rounded / 1000, unit: 'kg' } : { value: rounded, unit: 'g' };
}

/**
 * °F to °C. An oven setting (`oven`, a multiple of 25 °F from 250 to 550)
 * rounds to the nearest 10 °C, as oven dials do: 350 °F is 180 °C. Anything
 * else rounds to the nearest degree, because a meat, sugar, or oil
 * temperature must not move by 5 °C: 165 °F is 74 °C, and frying oil at
 * 350 °F is 177 °C.
 */
export function fahrenheitToCelsius(fahrenheit: number, oven = false): number {
  const celsius = ((fahrenheit - 32) * 5) / 9;
  const dial = oven && fahrenheit >= 250 && fahrenheit <= 550 && fahrenheit % 25 === 0;
  // `+ 0` turns a rounded -0 into 0.
  return (dial ? Math.round(celsius / 10) * 10 : Math.round(celsius)) + 0;
}

// Regex sources, written with String.raw so a backslash reaches RegExp as typed.
/** An optional space, including the no-break and thin spaces web pages use. */
const SPACE = String.raw`\s?`;
const DEGREE = '[°º˚]';
const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;
/** Between the two ends of a range: "325–350", "325/350", "325 to 350", "350 and 375". */
const RANGE = String.raw`(?:${SPACE}[-–—/]${SPACE}|\s(?:to|and|or)\s)`;
const F = String.raw`(?:[Ff]|[Ff]ahrenheit)\b`;
const DEGREES_WORD = String.raw`\s(?:[Dd]egrees?|[Dd]eg\.?)\s`;
/**
 * A Fahrenheit temperature or range: "350°F", "350 ºf", "350℉", "350 degrees F",
 * "350 deg. Fahrenheit", "350F", "325–350°F", "325 to 350°F", "between 350 and
 * 375°F", "-10°F". A bare "350°" is not one (it could be Celsius), and neither
 * is a one- or two-digit number with a bare F ("a 12F probe").
 */
const FAHRENHEIT = new RegExp(
  String.raw`(?<![\w.,])(${NUMBER})(?:${RANGE}(${NUMBER}))?` +
    String.raw`(?:${SPACE}${DEGREE}${SPACE}${F}|${SPACE}℉|${DEGREES_WORD}${F}|(?<=\d{3})F\b)`,
  'g',
);
/** A Celsius temperature already written near the match, as in "425°F / 220°C" or "180C/350F". */
const CELSIUS_NEARBY = new RegExp(
  String.raw`\d(?:${SPACE}${DEGREE}${SPACE}[Cc]\b|${SPACE}℃|C\b|${DEGREES_WORD}(?:[Cc]|[Cc]elsius)\b)`,
);
const CELSIUS_NEARBY_CHARS = 25;
/**
 * Words that make a temperature an oven setting, before it ("Bake at …") or
 * just after ("a 375°F oven"), in English and in the UI languages a recipe
 * may be translated into (духовка, піч/печь, 烤箱).
 */
const OVEN_WORDS = /\b(?:oven|preheat|pre-heat|bake[sd]?|baking|roast(?:s|ed|ing)?|broil)|духов|піч|печ|烤/i;
const OVEN_BEFORE_CHARS = 60;
const OVEN_AFTER_CHARS = 12;

/**
 * `text` with each Fahrenheit temperature replaced by `format(celsius,
 * original)`, where `celsius` is like "180°C" or "160–180°C" and `original`
 * is the text matched. A temperature that already has a Celsius one near it
 * is left alone. Oven rounding applies only when an oven word is near.
 */
export function convertTemperaturesInText(
  text: string,
  format: (celsius: string, original: string) => string,
): string {
  return text.replace(FAHRENHEIT, (match: string, from: string, to: string | undefined, offset: number) => {
    const end = offset + match.length;
    const near = (before: number, after: number) =>
      `${text.slice(Math.max(0, offset - before), offset)} ${text.slice(end, end + after)}`;
    if (CELSIUS_NEARBY.test(near(CELSIUS_NEARBY_CHARS, CELSIUS_NEARBY_CHARS))) return match;
    const oven = OVEN_WORDS.test(near(OVEN_BEFORE_CHARS, OVEN_AFTER_CHARS));
    const low = fahrenheitToCelsius(Number(from), oven);
    const celsius = to === undefined ? `${low}°C` : `${low}–${fahrenheitToCelsius(Number(to), oven)}°C`;
    return format(celsius, match);
  });
}
