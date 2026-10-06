/**
 * Live Gemini evals for `generateFromBrief` (`docs/plans/recipe-generation.md`):
 * the model writes a recipe from a short idea. There is no golden and no
 * judge; a brief has many right answers, so the checks are the constraints
 * the brief states (servings, equipment, language) and that the recipe is
 * complete enough to cook from. Runs under `npm run test:import` with
 * `GEMINI_API_KEY` from `.env.local`; never in `npm test` or CI.
 *
 * `evals/AGENTS.md`: the prompt here is `generatePrompt`, outside the
 * dev/holdout rules for the extraction prompts, but every change to it is
 * still recorded in `evals/EXPERIMENTS.md`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { generateFromBrief, recipeImportDepsFromEnv } from '../server/recipeImport.ts';
import { ingredientCount } from './judge.ts';

const GUMBO = 'shrimp gumbo in a pressure cooker for 6';

describe('write a recipe from a brief (live Gemini)', () => {
  beforeAll(() => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(
        'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).',
      );
    }
  });

  it('writes a complete recipe that keeps the servings and the equipment', async () => {
    const outcome = await generateFromBrief(GUMBO, recipeImportDepsFromEnv(), { search: false });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const recipe = outcome.recipe;
    expect(recipe.servings).toBe(6);
    expect(ingredientCount(recipe), JSON.stringify(recipe)).toBeGreaterThanOrEqual(6);
    expect(recipe.steps.length, JSON.stringify(recipe)).toBeGreaterThanOrEqual(4);
    expect(recipe.steps.some((step) => /pressure/i.test(step.text)), JSON.stringify(recipe.steps)).toBe(true);
    expect(recipe.lang).toBe('en');
    expect(outcome.warnings).toEqual([]);
    expect(outcome).not.toHaveProperty('grounding');
  }, 60_000);

  it('writes in the language of the brief', async () => {
    const outcome = await generateFromBrief(
      'веганський рамен на двох, без грибів',
      recipeImportDepsFromEnv(),
      { search: false },
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.recipe.lang).toBe('uk');
    expect(outcome.recipe.servings).toBe(2);
    expect(/[а-яіїє]/i.test(outcome.recipe.steps[0]?.text ?? '')).toBe(true);
  }, 60_000);

  it('refuses a brief that is not about food', async () => {
    const outcome = await generateFromBrief(
      "what's the weather tomorrow in Lviv",
      recipeImportDepsFromEnv(),
      { search: false },
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe('not_a_recipe');
  }, 60_000);

  it('grounds on web pages when search is on', async () => {
    const outcome = await generateFromBrief(GUMBO, recipeImportDepsFromEnv(), { search: true });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.recipe.servings).toBe(6);
    if (outcome.grounding === undefined) {
      // The model may answer from memory without searching. Not a failure, but
      // worth a line in evals/EXPERIMENTS.md if it is the usual outcome.
      console.warn('generateFromBrief with search on returned no grounding metadata');
      return;
    }
    expect(outcome.grounding.sources.length).toBeGreaterThan(0);
    for (const source of outcome.grounding.sources) {
      expect(source.url).toMatch(/^https?:\/\//);
      expect(source.title).not.toBe('');
    }
    expect(outcome.grounding.queries).toBeGreaterThan(0);
  }, 90_000);
});
