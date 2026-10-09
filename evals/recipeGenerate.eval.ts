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
import { kitchenProfilePromptBlock, type KitchenProfileFields } from '../server/kitchenProfile.ts';
import { ingredientCount } from './judge.ts';

const GUMBO = 'shrimp gumbo in a pressure cooker for 6';
const NO_PROFILE: KitchenProfileFields = { allergens: [], diets: [], avoid: '', dislikes: '', equipment: '', notes: '' };

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

  it('leaves out an allergen from the kitchen profile even when the dish usually has it', async () => {
    const kitchenProfile = kitchenProfilePromptBlock({ ...NO_PROFILE, allergens: ['peanuts'] });
    const outcome = await generateFromBrief('pad thai for two', recipeImportDepsFromEnv(), {
      search: false,
      kitchenProfile,
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const items = outcome.recipe.ingredientSections.flatMap((s) => s.items.map((i) => i.item));
    expect(items.some((item) => /peanut/i.test(item)), JSON.stringify(items)).toBe(false);
    expect(outcome.recipe.servings).toBe(2);
  }, 60_000);

  it('follows the kitchen profile diet for a dish that usually has meat', async () => {
    const kitchenProfile = kitchenProfilePromptBlock({ ...NO_PROFILE, diets: ['vegetarian'] });
    const outcome = await generateFromBrief('lasagne for 4', recipeImportDepsFromEnv(), {
      search: false,
      kitchenProfile,
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const items = outcome.recipe.ingredientSections.flatMap((s) => s.items.map((i) => i.item));
    expect(
      items.some((item) => /beef|pork|veal|sausage|pancetta|bacon|chicken|mince|meat/i.test(item)),
      JSON.stringify(items),
    ).toBe(false);
  }, 60_000);

  it('writes in metric for a member who reads in metric, even for an American dish', async () => {
    const outcome = await generateFromBrief('chocolate chip cookies', recipeImportDepsFromEnv(), {
      search: false,
      units: 'metric',
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const units = outcome.recipe.ingredientSections.flatMap((s) => s.items.map((i) => (i.unit ?? '').toLowerCase()));
    expect(
      units.filter((unit) => /^(cups?|c\.?|oz|ounces?|lbs?|pounds?|sticks?|fl oz)$/.test(unit)),
      JSON.stringify(units),
    ).toEqual([]);
    expect(units.some((unit) => unit === 'g' || unit === 'kg'), JSON.stringify(units)).toBe(true);
    const steps = outcome.recipe.steps.map((step) => step.text).join('\n');
    expect(/°\s?F|℉|degrees F/i.test(steps), steps).toBe(false);
    expect(/°\s?C|℃/.test(steps), steps).toBe(true);
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
    }
    // An untitled page is allowed (the preview labels it), but Google normally names the site.
    expect(outcome.grounding.sources.some((source) => source.title !== '')).toBe(true);
    expect(outcome.log?.searchQueries).toBeGreaterThan(0);
  }, 90_000);
});
