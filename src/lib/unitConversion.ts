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
 * °F to °C. An oven setting (a multiple of 25 °F from 250 to 550) rounds to
 * the nearest 10 °C, as oven dials do: 350 °F is 180 °C. Anything else rounds
 * to the nearest degree, because a meat, sugar, or oil temperature must not
 * move by 5 °C: 165 °F is 74 °C.
 */
export function fahrenheitToCelsius(fahrenheit: number): number {
  const celsius = ((fahrenheit - 32) * 5) / 9;
  const oven = fahrenheit >= 250 && fahrenheit <= 550 && fahrenheit % 25 === 0;
  // `+ 0` turns a rounded -0 into 0.
  return (oven ? Math.round(celsius / 10) * 10 : Math.round(celsius)) + 0;
}

const SPACE = '[ \\u00a0\\u2009\\u202f]?';
const DEGREE = '[°º˚]';
const NUMBER = '-?\\d{1,3}(?:\\.\\d+)?';
/**
 * A Fahrenheit temperature or range: "350°F", "350 ºF", "350℉", "350 degrees F",
 * "350 degrees Fahrenheit", "80F", "325–350°F", "-10°F". A bare "350°" is not
 * one; it could be Celsius.
 */
const FAHRENHEIT = new RegExp(
  `(?<![\\w.,])(${NUMBER})(?:${SPACE}[-–—]${SPACE}(${NUMBER}))?` +
    `(?:${SPACE}${DEGREE}${SPACE}(?:F|Fahrenheit)\\b|${SPACE}℉|\\s[Dd]egrees?\\s(?:F|Fahrenheit)\\b|(?<=\\d{2})F\\b)`,
  'g',
);
/** A Celsius temperature already written next to the match, as in "425°F / 220°C" or "180C/350F". */
const CELSIUS_NEARBY = new RegExp(`\\d(?:${SPACE}${DEGREE}${SPACE}C\\b|${SPACE}℃|C\\b|\\s[Dd]egrees?\\s(?:C|Celsius)\\b)`);
const NEARBY_CHARS = 15;

/**
 * `text` with each Fahrenheit temperature replaced by `format(celsius,
 * original)`, where `celsius` is like "180°C" or "160–180°C" and `original`
 * is the text matched. A temperature that already has a Celsius one beside it
 * is left alone.
 */
export function convertTemperaturesInText(
  text: string,
  format: (celsius: string, original: string) => string,
): string {
  return text.replace(FAHRENHEIT, (match: string, from: string, to: string | undefined, offset: number) => {
    const before = text.slice(Math.max(0, offset - NEARBY_CHARS), offset);
    const after = text.slice(offset + match.length, offset + match.length + NEARBY_CHARS);
    if (CELSIUS_NEARBY.test(before) || CELSIUS_NEARBY.test(after)) return match;
    const low = fahrenheitToCelsius(Number(from));
    const celsius = to === undefined ? `${low}°C` : `${low}–${fahrenheitToCelsius(Number(to))}°C`;
    return format(celsius, match);
  });
}
