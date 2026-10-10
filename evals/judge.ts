/**
 * The Gemini judge for the live import evals: does an extracted recipe match
 * its golden? Shared by `evals/recipeImport.eval.ts` and `evals/ocrCompare.ts`,
 * so it imports nothing from vitest and plain Node can load it.
 */
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import type { ImportedRecipe } from '../server/recipeImport.ts';

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

export function ingredientCount(draft: ImportedRecipe): number {
  return draft.ingredientSections.reduce((n, section) => n + section.items.length, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function judgeOnce(
  ai: GoogleGenAI,
  extracted: ImportedRecipe,
  golden: ImportedRecipe,
): Promise<string> {
  const result = await ai.models.generateContent({
    model: process.env.CHAT_MODEL || 'gemini-3.8-flash',
    contents:
      'You compare a recipe extracted from source text to a golden RecipeDraft. ' +
      'Decide if the extraction is close enough. Do not require exact JSON equality.\n\n' +
      'Pass unless a rule below fails:\n' +
      '- Title names the same dish; wording may differ.\n' +
      '- Every golden ingredient is present under a recognizable name. Extra garnish, salt, or pepper is ok. A missing main ingredient is a fail.\n' +
      '- Quantities are equivalent (½ ≡ 0.5, 3 tbsp ≡ 3 tablespoon). Unit aliases tsp, tbsp, cup, ml, l, g, kg, oz, lb, piece count as a match.\n' +
      '- Steps cover the same operations in the same order; wording may be shorter.\n' +
      '- Tags overlap in meaning; do not require an identical list.\n' +
      '- description, times, and notes are soft: fail only if they contradict the golden (wrong method, 10 min vs 2 hours).\n\n' +
      `Golden:\n${JSON.stringify(golden)}\n\n` +
      `Extracted:\n${JSON.stringify(extracted)}`,
    config: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: JUDGE_SCHEMA,
    },
  });
  return result.text ?? '';
}

export async function judgeRecipe(
  extracted: ImportedRecipe,
  golden: ImportedRecipe,
): Promise<{ pass: boolean; failures: { field: string; reason: string }[] }> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    return parseJudgeVerdict(await judgeOnce(ai, extracted, golden));
  } catch {
    return parseJudgeVerdict(await judgeOnce(ai, extracted, golden));
  }
}
