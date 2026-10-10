/**
 * Live translation eval. Included only by `vitest.eval.config.ts`
 * (`npm run test:import`), not by `npm test`.
 *
 * Imports two cached pages, translates each whole recipe into uk, ru, and
 * zh-Hans, checks structure with `recipeSegments` and `applyTranslation`,
 * and asks an LLM judge about meaning and, for uk and ru, grammatical
 * gender. p50/p95 of the whole-recipe call are printed and do not fail
 * the test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  importFromHtml,
  recipeImportDepsFromEnv,
  type ImportedRecipe,
} from '../server/recipeImport.ts';
import {
  COMMON_UNITS,
  applyTranslation,
  recipeSegments,
  type RecipeSegment,
  type TranslatableRecipe,
} from '../server/recipeTranslation.ts';
import {
  geminiTranslateDepsFromEnv,
  translateSegments,
  type GeminiTranslateDeps,
  type TranslateInput,
  type TranslateOutcome,
  type TranslateSegment,
} from '../server/translate.ts';

const sitesRoot = join(dirname(fileURLToPath(import.meta.url)), 'import-sites');

const PAGE_FIXTURES = ['giallozafferano-carbonara', 'marmiton-boeuf-bourguignon'] as const;

const TARGETS = ['uk', 'ru', 'zh-Hans'] as const;

/** Small on purpose so `npm run test:import` finishes. Not a pass/fail threshold. */
const LATENCY_REPEATS = 5;

const MISSING_KEY =
  'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).';

const JUDGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pass: { type: Type.BOOLEAN },
    failures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['field', 'reason'],
      },
    },
  },
  required: ['pass', 'failures'],
};

const imported = new Map<string, ImportedRecipe>();
let translateDeps: GeminiTranslateDeps | undefined;

function isKnownUnit(unit: string): boolean {
  return (COMMON_UNITS as readonly string[]).includes(unit);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function translateInput(
  segments: readonly RecipeSegment[],
  target: string,
  sourceLang: string | undefined,
): TranslateInput {
  const input: TranslateInput = { segments, target };
  if (sourceLang !== undefined) {
    input.sourceLang = sourceLang;
  }
  return input;
}

/**
 * Inclusive linear percentile (the index is `(p/100) * (n-1)`).
 * With n=5, p50 is the middle sample and p95 sits near the slowest.
 */
function percentile(samplesMs: readonly number[], p: number): number {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('latency sample is empty');
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function printLatency(fixture: string, target: string, samplesMs: readonly number[]): void {
  const rounded = samplesMs.map((ms) => String(Math.round(ms))).join(',');
  console.log(
    `[translate-eval] ${fixture} → ${target} whole-recipe n=${samplesMs.length} ` +
      `p50=${Math.round(percentile(samplesMs, 50))}ms ` +
      `p95=${Math.round(percentile(samplesMs, 95))}ms ` +
      `samples=${rounded}`,
  );
}

function assertStructurePreserved(
  fixture: string,
  target: string,
  source: ImportedRecipe,
  sourceSegments: readonly RecipeSegment[],
  outcome: Extract<TranslateOutcome, { ok: true }>,
): TranslatableRecipe {
  const label = `${fixture} → ${target}`;
  expect(
    outcome.segments.map((segment) => segment.id),
    `${label} segment ids`,
  ).toEqual(sourceSegments.map((segment) => segment.id));
  for (const segment of outcome.segments) {
    expect(segment.text.trim().length, `${label} segment ${segment.id}`).toBeGreaterThan(0);
  }

  const applied = applyTranslation(source, outcome.segments);
  expect(applied.servings, `${label} servings`).toBe(source.servings);
  expect(applied.prepMinutes, `${label} prepMinutes`).toBe(source.prepMinutes);
  expect(applied.cookMinutes, `${label} cookMinutes`).toBe(source.cookMinutes);
  expect(applied.tags, `${label} tags`).toEqual(source.tags);
  expect(applied.steps, `${label} steps`).toHaveLength(source.steps.length);
  expect(applied.ingredientSections, `${label} sections`).toHaveLength(
    source.ingredientSections.length,
  );
  source.ingredientSections.forEach((section, sectionIndex) => {
    const next = applied.ingredientSections[sectionIndex];
    expect(next.items, `${label} section ${sectionIndex} items`).toHaveLength(section.items.length);
    section.items.forEach((item, itemIndex) => {
      const translated = next.items[itemIndex];
      const where = `${label} section ${sectionIndex} item ${itemIndex}`;
      expect(translated.quantity, `${where} quantity`).toBe(item.quantity);
      expect(translated.unit === undefined, `${where} unit presence`).toBe(item.unit === undefined);
      // Known unit tokens pass through. Custom unit strings are their own segments.
      if (item.unit !== undefined && isKnownUnit(item.unit)) {
        expect(translated.unit, `${where} unit token`).toBe(item.unit);
      }
    });
  });
  return applied;
}

function parseJudgeVerdict(raw: string): {
  pass: boolean;
  failures: { field: string; reason: string }[];
} {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || typeof parsed.pass !== 'boolean') {
    throw new Error('judge verdict is not a { pass, failures } object');
  }
  const failures: { field: string; reason: string }[] = [];
  if (Array.isArray(parsed.failures)) {
    for (const row of parsed.failures) {
      if (!isPlainObject(row)) continue;
      if (typeof row.field !== 'string' || typeof row.reason !== 'string') continue;
      failures.push({ field: row.field, reason: row.reason });
    }
  }
  return { pass: parsed.pass, failures };
}

function genderRule(target: string): string {
  if (target === 'uk' || target === 'ru') {
    return (
      '- Pronouns and past-tense verbs agree in grammatical gender with their referents. ' +
      'A referent may be named in an earlier step or only in the ingredient list. ' +
      'A mismatch is a fail. Put the segment id in field.\n'
    );
  }
  return '- Grammatical gender is not a criterion for this target.\n';
}

async function judgeOnce(
  ai: GoogleGenAI,
  source: ImportedRecipe,
  applied: TranslatableRecipe,
  segments: readonly TranslateSegment[],
  target: string,
): Promise<string> {
  const result = await ai.models.generateContent({
    model: process.env.CHAT_MODEL || 'gemini-3.8-flash',
    contents:
      'You judge a recipe translation against the source recipe. ' +
      'Do not require exact wording. Quantities and known unit tokens are checked separately; ' +
      'do not fail them for formatting.\n\n' +
      'Pass unless a rule below fails:\n' +
      '- The translation names the same dish.\n' +
      '- Every source ingredient is present under a recognizable name. A missing main ingredient is a fail. Extra garnish is ok.\n' +
      '- Steps describe the same operations in the same order. A step that does a different action is a fail.\n' +
      '- Meaning that contradicts the source (wrong method, dropped component, added main ingredient) is a fail.\n' +
      genderRule(target) +
      '\n' +
      `Target language: ${target}\n\n` +
      `Source:\n${JSON.stringify(source)}\n\n` +
      `Translated segments:\n${JSON.stringify(segments)}\n\n` +
      `Applied recipe:\n${JSON.stringify(applied)}`,
    config: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: JUDGE_SCHEMA,
    },
  });
  return result.text ?? '';
}

async function judgeTranslation(
  source: ImportedRecipe,
  applied: TranslatableRecipe,
  segments: readonly TranslateSegment[],
  target: string,
): Promise<{ pass: boolean; failures: { field: string; reason: string }[] }> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    return parseJudgeVerdict(await judgeOnce(ai, source, applied, segments, target));
  } catch {
    return parseJudgeVerdict(await judgeOnce(ai, source, applied, segments, target));
  }
}

async function translateWholeRecipe(
  segments: readonly RecipeSegment[],
  target: string,
  sourceLang: string | undefined,
  deps: GeminiTranslateDeps,
): Promise<{ samplesMs: number[]; outcome: Extract<TranslateOutcome, { ok: true }> | undefined }> {
  const samplesMs: number[] = [];
  let outcome: Extract<TranslateOutcome, { ok: true }> | undefined;
  for (let run = 0; run < LATENCY_REPEATS; run += 1) {
    const started = performance.now();
    const result = await translateSegments(translateInput(segments, target, sourceLang), deps);
    samplesMs.push(performance.now() - started);
    if (result.ok) {
      outcome = result;
    }
  }
  return { samplesMs, outcome };
}

const CASES = PAGE_FIXTURES.flatMap((fixture) => TARGETS.map((target) => ({ fixture, target })));

describe('translate cached foreign recipes (live Gemini)', () => {
  beforeAll(async () => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(MISSING_KEY);
    }
    const built = geminiTranslateDepsFromEnv();
    if (!built.ok) {
      throw new Error(MISSING_KEY);
    }
    translateDeps = built.deps;
    for (const name of PAGE_FIXTURES) {
      const html = readFileSync(join(sitesRoot, name, 'page.html'), 'utf8');
      const result = await importFromHtml(html, recipeImportDepsFromEnv());
      if (result.kind !== 'ok') {
        throw new Error(`${name} import outcome: ${result.kind}`);
      }
      imported.set(name, result.recipe);
    }
  }, 300_000);

  it.each(CASES)(
    'preserves structure and meaning for $fixture → $target',
    async ({ fixture, target }) => {
      const source = imported.get(fixture);
      expect(source, `${fixture} import`).toBeDefined();
      if (source === undefined || translateDeps === undefined) return;
      const segments = recipeSegments(source);
      expect(segments.length, `${fixture} segments`).toBeGreaterThan(0);

      const timed = await translateWholeRecipe(segments, target, source.lang, translateDeps);
      printLatency(fixture, target, timed.samplesMs);
      expect(timed.outcome, `${fixture} → ${target} translate`).toBeDefined();
      if (timed.outcome === undefined) return;
      const applied = assertStructurePreserved(fixture, target, source, segments, timed.outcome);
      const verdict = await judgeTranslation(source, applied, timed.outcome.segments, target);
      const failureText =
        verdict.failures.length === 0
          ? 'judge rejected the translation with no failure list'
          : verdict.failures.map((row) => `${row.field}: ${row.reason}`).join('\n');
      expect(
        verdict.pass,
        `${fixture} → ${target} judge:\n${failureText}\n\napplied:\n${JSON.stringify(applied, null, 2)}`,
      ).toBe(true);
    },
    300_000,
  );
});
