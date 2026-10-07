import { MediaResolution, type Content } from '@google/genai';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { RecipeDraft } from '../src/lib/types.ts';
import { fakeImportDeps } from '../test/fakeGemini.ts';
import { fakePageFetch, PUBLIC_ADDRESS, type FakePage } from '../test/fakePageFetch.ts';
import { resolveHost } from './netGuard.ts';
import {
  IMPORT_RETRY_DEADLINE_MS,
  MAX_GENERATE_BRIEF_CHARS,
  MAX_GENERATE_SOURCES,
  MAX_IMPORT_MINUTES,
  MAX_IMPORT_RETRIES,
  MAX_PAGE_HTML_CHARS,
  MAX_PAGE_REDIRECTS,
  extractRecipeSource,
  fetchPageHtml,
  generateFromBrief,
  importFromHtml,
  importFromImages,
  importFromSource,
  normalizeImportedRecipe,
  readImportTranslateTo,
  recipeImportDepsFromEnv,
  type ImportedRecipe,
  type ImportOutcome,
  type RecipeImportDeps,
  type RecipeTranslator,
} from './recipeImport.ts';
import { TRANSLATE_FAILED, type TranslateInput, type TranslateOutcome } from './translate.ts';

// Drift guard: the server cannot import `src/` at runtime, so ImportedRecipe
// is declared separately. If it stops being a RecipeDraft, `tsc -b` fails here.
const importedIsDraft = (recipe: ImportedRecipe): RecipeDraft => recipe;
void importedIsDraft;

const ldBlock = (json: string) =>
  `<script type="application/ld+json">${json}</script>`;

const RECIPE = {
  '@type': 'Recipe',
  name: 'Cacio e Pepe',
  recipeYield: '2 servings',
};

describe('extractRecipeSource', () => {
  it('returns a bare JSON-LD Recipe object', () => {
    const html = `<html><body>${ldBlock(JSON.stringify(RECIPE))}</body></html>`;
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('picks the Recipe out of a JSON-LD array', () => {
    const nodes = [{ '@type': 'WebSite', name: 'Blog' }, RECIPE];
    const html = ldBlock(JSON.stringify(nodes));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('unwraps @graph', () => {
    const html = ldBlock(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'Person', name: 'Author' }, RECIPE],
      }),
    );
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('accepts @type as an array containing Recipe', () => {
    const node = { ...RECIPE, '@type': ['Recipe', 'NewsArticle'] };
    const html = ldBlock(JSON.stringify(node));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('skips a malformed JSON-LD block and keeps looking', () => {
    const html =
      ldBlock('{ "@type": "Recipe", oops }') +
      ldBlock(JSON.stringify(RECIPE));
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('swallows a JSON-LD block that parses to null', () => {
    const html = `${ldBlock('null')}<p>Fallback text</p>`;
    expect(extractRecipeSource(html).trim()).toBe('Fallback text');
  });

  it('falls through to the text path when no node is a Recipe', () => {
    const html =
      ldBlock(JSON.stringify({ '@type': 'BreadcrumbList' })) +
      '<p>Plain page</p>';
    expect(extractRecipeSource(html).trim()).toBe('Plain page');
  });

  it('strips markup, script and style contents, nbsp, and repeated whitespace', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>var analytics = 'tracked';</script>
          <h1>Toast</h1>
          <p>Bread&nbsp;and    butter.</p>
        </body>
      </html>
    `;
    const text = extractRecipeSource(html);
    expect(text.trim()).toBe('Toast Bread and butter.');
    expect(text).not.toContain('analytics');
    expect(text).not.toContain('color');
    expect(text).not.toContain('<');
  });

  it('strips script and style bodies whose end tag has whitespace or junk before >', () => {
    const html =
      '<p>Soup</p><script>var leaked = 1;</script ><STYLE>.leak{}</STYLE foo>' +
      '<script type="x">var alsoLeaked = 2;</script\n>';
    const text = extractRecipeSource(html);
    expect(text.trim()).toBe('Soup');
    expect(text).not.toContain('leak');
  });

  it('caps the JSON-LD path at 60,000 characters', () => {
    const node = { ...RECIPE, description: 'x'.repeat(80000) };
    const html = ldBlock(JSON.stringify(node));
    expect(extractRecipeSource(html)).toHaveLength(60000);
  });

  it('reads a JSON-LD block whose type attribute is unquoted', () => {
    const html =
      `<script type=application/ld+json class=yoast-schema-graph>${JSON.stringify(RECIPE)}</script>` +
      '<article><h1>Page text</h1></article>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('does not read a script whose unquoted type only starts with application/ld+json', () => {
    const html =
      `<script type=application/ld+jsonp>${JSON.stringify(RECIPE)}</script>` +
      '<p>Plain page</p>';
    expect(extractRecipeSource(html).trim()).toBe('Plain page');
  });

  it('drops reviews and other non-recipe fields from a node over the cap, keeping it whole', () => {
    const review = Array.from({ length: 200 }, (_, i) => ({
      '@type': 'Review',
      reviewBody: `Review ${i}: ${'lovely '.repeat(60)}`,
    }));
    const node = {
      '@type': 'Recipe',
      name: 'Banana Bread',
      review,
      aggregateRating: { ratingValue: 4.8 },
      video: [{ '@type': 'VideoObject', name: 'How to' }],
      recipeIngredient: ['3 bananas', '2 cups flour'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Bake at 350F.' }],
    };
    expect(JSON.stringify(node).length).toBeGreaterThan(60000);
    expect(JSON.parse(extractRecipeSource(ldBlock(JSON.stringify(node))))).toEqual({
      '@type': 'Recipe',
      name: 'Banana Bread',
      recipeIngredient: ['3 bananas', '2 cups flour'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Bake at 350F.' }],
    });
  });

  it('leaves reviews on a node under the cap', () => {
    const node = { ...RECIPE, review: [{ '@type': 'Review', reviewBody: 'Great.' }] };
    expect(JSON.parse(extractRecipeSource(ldBlock(JSON.stringify(node))))).toEqual(node);
  });

  it('caps the text path at 60,000 characters', () => {
    const html = `<p>${'word '.repeat(20000)}</p>`;
    expect(extractRecipeSource(html)).toHaveLength(60000);
  });

  it('prefers article text when nav chrome would eat the cap', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><h1>Kapusnyak</h1><p>Ingredients: sauerkraut</p></article>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Kapusnyak');
    expect(text).toContain('sauerkraut');
    expect(text).not.toContain('Menu item');
  });

  it('prefers main when there is no article', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<main class="Page-main"><h2>Ingredients</h2><p>pork shoulder</p></main>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Ingredients');
    expect(text).toContain('pork shoulder');
    expect(text).not.toContain('Menu item');
  });

  it('still prefers a Recipe JSON-LD node over article text', () => {
    const html =
      ldBlock(JSON.stringify(RECIPE)) +
      '<article><h1>A different dish</h1></article>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(RECIPE);
  });

  it('ignores a Recipe block whose ingredients and steps are blank', () => {
    const shell = {
      '@type': 'Recipe',
      name: 'Braised beef short ribs',
      recipeIngredient: [],
      recipeInstructions: [
        { '@type': 'HowToStep', position: 1 },
        { '@type': 'HowToStep', position: 2 },
      ],
    };
    const html =
      ldBlock(JSON.stringify({ '@graph': [shell, { '@type': 'Person', name: 'Maangchi' }] })) +
      '<div id="main"><h1>Galbi-jjim</h1><p>Ingredients: beef short ribs and soy sauce</p></div>';
    const text = extractRecipeSource(html);
    expect(text).toContain('Galbi-jjim');
    expect(text).toContain('beef short ribs');
    expect(text).not.toContain('HowToStep');
  });

  it('keeps a Recipe block that has ingredient text', () => {
    const node = { ...RECIPE, recipeIngredient: ['200 g pecorino'] };
    const html = ldBlock(JSON.stringify(node)) + '<p>Some other page text</p>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('keeps text after a nested related-story article', () => {
    const html =
      '<article><h1>Borscht</h1><article><h2>Related</h2><p>Another soup</p></article><p>Ingredients: beets and beef</p></article>';
    const text = extractRecipeSource(html);
    expect(text).toContain('Borscht');
    expect(text).toContain('beets and beef');
  });

  it('uses the longer article when a header teaser comes first', () => {
    const html =
      '<article><h2>See also</h2><p>A short card</p></article><article><h1>Borscht</h1><p>Ingredients: beets and dill</p></article>';
    const text = extractRecipeSource(html);
    expect(text).toContain('beets and dill');
    expect(text).not.toContain('See also');
  });

  it('does not treat a bare less-than in the copy as a tag', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><p>Heat to <350°F, don't rush.</p><p>Ingredients: beets</p></article>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });

  it('does not stop a role=main region at the first inner close', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<div role="main"><div class="breadcrumbs">Home</div><h1>Borscht</h1><p>Ingredients: beets</p></div>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Borscht');
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });

  it('prefers a large main over a short header teaser article', () => {
    const html =
      '<article><h2>See also</h2><p>Card</p></article><main><h1>Borscht</h1><p>Ingredients: beets and cabbage</p></main>';
    const text = extractRecipeSource(html);
    expect(text).toContain('beets and cabbage');
    expect(text).not.toContain('See also');
  });

  it('reads a JSON-LD script whose earlier attribute contains >', () => {
    const node = { ...RECIPE, recipeIngredient: ['200 g pecorino'] };
    const html =
      `<script data-note="Say 'heat > 180'" type="application/ld+json">${JSON.stringify(node)}</script>` +
      '<p>Plain page</p>';
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('ignores a Recipe script that exists only inside a comment', () => {
    const decoy = { ...RECIPE, name: 'Decoy Stew', recipeIngredient: ['secret sauce'] };
    const html = `<!-- ${ldBlock(JSON.stringify(decoy))} --><p>Real ingredients: beets</p>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('beets');
    expect(text).not.toContain('Decoy Stew');
  });

  it('keeps the article when an unclosed quote would stop a tag scan', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><div data-x="foo><span>nope</span></div><p>Ingredients: beets</p></article>`;
    const text = extractRecipeSource(html);
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });

  it('reads a Recipe script beside an svg template', () => {
    const node = { ...RECIPE, recipeIngredient: ['200 g pecorino'] };
    const html = `<svg><template></template></svg>${ldBlock(JSON.stringify(node))}`;
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('reads a Recipe script inside an HTML template', () => {
    const node = { ...RECIPE, recipeIngredient: ['200 g pecorino'] };
    const html = `<template>${ldBlock(JSON.stringify(node))}</template>`;
    expect(JSON.parse(extractRecipeSource(html))).toEqual(node);
  });

  it('uses an unclosed article instead of the whole page', () => {
    const nav = `<nav>${'Menu item '.repeat(8000)}</nav>`;
    const html = `${nav}<article><h1>Borscht</h1><p>Ingredients: beets`;
    const text = extractRecipeSource(html);
    expect(text).toContain('Borscht');
    expect(text).toContain('beets');
    expect(text).not.toContain('Menu item');
  });
});

const MINIMAL = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }],
  tags: ['soup'],
};

describe('normalizeImportedRecipe', () => {
  it('keeps a well-formed recipe as is', () => {
    expect(normalizeImportedRecipe(MINIMAL)).toEqual(MINIMAL);
  });

  it('keeps only recipe keys', () => {
    const recipe = normalizeImportedRecipe({
      ...MINIMAL,
      description: 'Warming.',
      notes: 'Freezes well.',
      prepMinutes: 5,
      cookMinutes: 20,
      lang: 'it-IT',
      photoId: 'not-from-a-model',
      sourceUrl: 'https://model.example/invented',
      nutrition: { calories: 100 },
    });
    expect(recipe?.lang).toBe('it');
    expect(Object.keys(recipe ?? {}).sort()).toEqual([
      'cookMinutes',
      'description',
      'ingredientSections',
      'lang',
      'notes',
      'prepMinutes',
      'servings',
      'steps',
      'tags',
      'title',
    ]);
  });

  it('drops a lang it cannot normalize without rejecting the recipe', () => {
    for (const lang of ['garbage!!', '', 12, null]) {
      const recipe = normalizeImportedRecipe({ ...MINIMAL, lang });
      expect(recipe).not.toBeNull();
      expect(recipe).not.toHaveProperty('lang');
    }
    expect(normalizeImportedRecipe({ ...MINIMAL, lang: 'zh-CN' })?.lang).toBe('zh-Hans');
  });

  it('returns null without a usable title', () => {
    expect(normalizeImportedRecipe({ ...MINIMAL, title: '   ' })).toBeNull();
    expect(normalizeImportedRecipe({ ...MINIMAL, title: 42 })).toBeNull();
    expect(normalizeImportedRecipe({ ...MINIMAL, title: undefined })).toBeNull();
    expect(normalizeImportedRecipe('not an object')).toBeNull();
    expect(normalizeImportedRecipe(null)).toBeNull();
    expect(normalizeImportedRecipe([MINIMAL])).toBeNull();
  });

  it('defaults an unusable serving count to 1', () => {
    for (const servings of [undefined, 0, -3, Number.NaN, Infinity, 'four']) {
      expect(normalizeImportedRecipe({ ...MINIMAL, servings })).toMatchObject({ servings: 1 });
    }
    expect(normalizeImportedRecipe({ ...MINIMAL, servings: 2.5 })).toMatchObject({
      servings: 2.5,
    });
  });

  it('trims strings and drops ingredients without an item', () => {
    const recipe = normalizeImportedRecipe({
      ...MINIMAL,
      title: '  Tomato soup  ',
      ingredientSections: [
        {
          name: '  Base  ',
          items: [
            { item: '  tomatoes  ', quantity: 6, unit: ' piece ', note: ' ripe ' },
            { item: '   ' },
            { quantity: 2 },
            'nonsense',
          ],
        },
      ],
    });
    expect(recipe).toMatchObject({
      title: 'Tomato soup',
      ingredientSections: [
        {
          name: 'Base',
          items: [{ item: 'tomatoes', quantity: 6, unit: 'piece', note: 'ripe' }],
        },
      ],
    });
  });

  it('drops sections that end up empty, and malformed steps and tags', () => {
    expect(
      normalizeImportedRecipe({
        ...MINIMAL,
        ingredientSections: [{ items: [] }, { items: ['x'] }, 'nope', { name: 'Sauce' }],
        steps: [{ text: 'Keep.' }, { text: '  ' }, { notText: 1 }, 'nope'],
        tags: ['soup', ' soup ', '', 7, 'winter'],
      }),
    ).toMatchObject({
      ingredientSections: [],
      steps: [{ text: 'Keep.' }],
      tags: ['soup', 'winter'],
    });
  });

  it('keeps arrays present when the model omits them entirely', () => {
    expect(normalizeImportedRecipe({ title: 'Bare', servings: 1 })).toEqual({
      title: 'Bare',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
    });
  });

  it('drops negative durations rather than keeping them', () => {
    const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: -5, cookMinutes: 0 });
    expect('prepMinutes' in (recipe ?? {})).toBe(false);
    expect(recipe).toMatchObject({ cookMinutes: 0 });
  });

  it('rounds durations to whole minutes', () => {
    const cases: [number, number][] = [
      [20.000000000000004, 20],
      [12.5, 13],
      [7.4, 7],
      [0.5, 1],
      [45, 45],
      [0, 0],
    ];
    for (const [raw, minutes] of cases) {
      const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: raw, cookMinutes: raw });
      expect(recipe, String(raw)).toMatchObject({ prepMinutes: minutes, cookMinutes: minutes });
    }
  });

  it('drops a positive duration that would round to 0, and a small negative one without making it -0', () => {
    for (const raw of [5.000000000000001e-5, 0.4, -0.4]) {
      const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: raw, cookMinutes: raw });
      expect(recipe, String(raw)).not.toHaveProperty('prepMinutes');
      expect(recipe, String(raw)).not.toHaveProperty('cookMinutes');
    }
  });

  it('reads -0 as 0', () => {
    const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: -0, cookMinutes: -0 });
    expect(Object.is(recipe?.prepMinutes, 0)).toBe(true);
    expect(Object.is(recipe?.cookMinutes, 0)).toBe(true);
  });

  it('keeps multi-day times and drops a duration over the cap (a large whole-number run-on)', () => {
    expect(MAX_IMPORT_MINUTES).toBe(100_000);
    for (const minutes of [10_080, 30_240, MAX_IMPORT_MINUTES]) {
      expect(normalizeImportedRecipe({ ...MINIMAL, prepMinutes: minutes })).toMatchObject({
        prepMinutes: minutes,
      });
    }
    for (const raw of [MAX_IMPORT_MINUTES + 1, 305106198964720960, 1e21]) {
      const recipe = normalizeImportedRecipe({ ...MINIMAL, prepMinutes: raw, cookMinutes: raw });
      expect(recipe, String(raw)).not.toHaveProperty('prepMinutes');
      expect(recipe, String(raw)).not.toHaveProperty('cookMinutes');
    }
  });
});

describe('importFromSource', () => {
  it('does not call the model for blank source', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromSource('  \n\t ', deps)).toEqual({
      kind: 'empty_source',
      log: { source: 'text', attempts: [] },
    });
    expect(calls).toHaveLength(0);
  });

  it('sends the source to the model it was given', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('Tomato soup: simmer tomatoes.', deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('test-model');
    expect(calls[0].contents).toContain('Tomato soup: simmer tomatoes.');
  });

  it('returns the normalized recipe, its warnings, and how it was reached', async () => {
    const { deps } = fakeImportDeps(
      JSON.stringify({ ...MINIMAL, servings: 0, extra: true, instructionsOnPage: true }),
    );
    expect(await importFromSource('soup', deps)).toEqual({
      kind: 'ok',
      recipe: { ...MINIMAL, servings: 1 },
      warnings: [{ code: 'TOO_FEW_STEPS' }],
      log: { source: 'text', attempts: [{ result: 'warn', codes: ['TOO_FEW_STEPS'] }] },
    });
  });

  it('asks pasted and page imports for the self-report, and never keeps it on the recipe', async () => {
    const { deps, calls } = fakeImportDeps(
      JSON.stringify({ ...MINIMAL, instructionsOnPage: false, ingredientsOnPage: true }),
    );
    const outcome = await importFromSource('soup', deps);
    const schema = calls[0].config?.responseSchema as { properties: object; required: string[] };
    expect(schema.properties).toHaveProperty('instructionsOnPage');
    expect(schema.properties).toHaveProperty('ingredientsOnPage');
    expect(schema.required).toEqual(expect.arrayContaining(['instructionsOnPage', 'ingredientsOnPage']));
    expect(outcome.kind === 'ok' && outcome.recipe).not.toHaveProperty('instructionsOnPage');
  });

  it('pins the page-schema order, ending on the two booleans so no number comes last', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', deps);
    const schema = calls[0].config?.responseSchema as {
      properties: Record<string, unknown>;
      propertyOrdering: string[];
    };
    expect([...schema.propertyOrdering].sort()).toEqual(Object.keys(schema.properties).sort());
    // Literal on purpose: the page order is built from RECIPE_SCHEMA's, and changing either
    // changes the page request, which needs its own measurement (evals/AGENTS.md).
    expect(schema.propertyOrdering).toEqual([
      'title',
      'description',
      'servings',
      'prepMinutes',
      'cookMinutes',
      'ingredientSections',
      'steps',
      'tags',
      'notes',
      'lang',
      'instructionsOnPage',
      'ingredientsOnPage',
    ]);
  });

  it('reports output that is not a JSON object as a parse error', async () => {
    for (const reply of [undefined, '', 'Sure! Here is the recipe', '42', 'null']) {
      const { deps } = fakeImportDeps(reply);
      expect(await importFromSource('soup', deps), String(reply)).toEqual({
        kind: 'parse_error',
        log: { source: 'text', attempts: [{ result: 'parse_error', codes: [] }] },
      });
    }
  });

  it('reports the NOT_A_RECIPE sentinel', async () => {
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, title: 'NOT_A_RECIPE' }));
    expect(await importFromSource('a poem', deps)).toMatchObject({ kind: 'not_a_recipe' });
  });

  it('reports JSON with no usable title as unusable', async () => {
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, title: ' ' }));
    expect(await importFromSource('soup', deps)).toMatchObject({ kind: 'unusable' });
  });

  it('turns a thrown model call into model_error, keeping only its status', async () => {
    const run = scriptedDeps([Object.assign(new Error('SECRET request echo'), { status: 503 })]);
    const outcome = await importFromSource('soup', run.deps);
    expect(outcome).toEqual({
      kind: 'model_error',
      log: { source: 'text', attempts: [{ result: 'threw', codes: [] }], errorStatus: 503 },
    });
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
    expect(run.calls).toBe(1);
  });
});

/** Instructions-like pasted text, so an empty `steps` reads as dropped, not missing. */
const PASTED = 'Tomato soup\nIngredients\n6 tomatoes\nMethod\n1. Simmer.\n2. Blend.';
const GOOD = { ...MINIMAL, steps: [{ text: 'Simmer.' }, { text: 'Blend.' }], instructionsOnPage: true };
const NO_STEPS = { ...MINIMAL, steps: [], instructionsOnPage: true };

/**
 * `generateContent` that answers each call with the next scripted reply; an
 * Error is thrown instead. `maxRetries` stands in for phase 3's constant.
 */
function scriptedDeps(
  replies: (object | Error)[],
  options: { maxRetries?: number; now?: () => number } = {},
): { deps: RecipeImportDeps; calls: number } {
  const state = { deps: fakeImportDeps('{}').deps, calls: 0 };
  state.deps = {
    ...state.deps,
    ...options,
    ai: {
      models: {
        generateContent: (params) => {
          const reply = replies[Math.min(state.calls, replies.length - 1)];
          state.calls += 1;
          if (reply instanceof Error) return Promise.reject(reply);
          return fakeImportDeps(JSON.stringify(reply)).deps.ai.models.generateContent(params);
        },
      },
    },
  };
  return state;
}

describe('import attempts', () => {
  it('ships with retries off', () => {
    expect(MAX_IMPORT_RETRIES).toBe(0);
  });

  it('retries a throw, then returns the recipe', async () => {
    const run = scriptedDeps([new Error('overloaded'), GOOD], { maxRetries: 2 });
    const outcome = await importFromSource(PASTED, run.deps);
    expect(run.calls).toBe(2);
    expect(outcome).toMatchObject({ kind: 'ok', warnings: [] });
    expect(outcome.log?.attempts.map((a) => a.result)).toEqual(['threw', 'ok']);
  });

  it('retries empty steps on a page that has a method', async () => {
    const run = scriptedDeps([NO_STEPS, GOOD], { maxRetries: 2 });
    const outcome = await importFromSource(PASTED, run.deps);
    expect(run.calls).toBe(2);
    expect(outcome.log?.attempts).toEqual([
      { result: 'warn', codes: ['INSTRUCTIONS_DROPPED'] },
      { result: 'ok', codes: [] },
    ]);
    expect(outcome).toMatchObject({ kind: 'ok', recipe: { steps: GOOD.steps }, warnings: [] });
  });

  it('does not retry a source failure', async () => {
    const run = scriptedDeps([{ ...NO_STEPS, instructionsOnPage: false }, GOOD], { maxRetries: 2 });
    const outcome = await importFromSource('Tomato soup. You need 6 tomatoes.', run.deps);
    expect(run.calls).toBe(1);
    expect(outcome).toMatchObject({
      kind: 'ok',
      warnings: [{ code: 'INSTRUCTIONS_NOT_ON_PAGE' }],
    });
  });

  it('does not retry not_a_recipe or an advisory warning', async () => {
    const notRecipe = scriptedDeps([{ ...MINIMAL, title: 'NOT_A_RECIPE' }, GOOD], { maxRetries: 2 });
    expect(await importFromSource(PASTED, notRecipe.deps)).toMatchObject({ kind: 'not_a_recipe' });
    expect(notRecipe.calls).toBe(1);

    const advisory = scriptedDeps([{ ...MINIMAL, instructionsOnPage: true }, GOOD], { maxRetries: 2 });
    expect(await importFromSource(PASTED, advisory.deps)).toMatchObject({
      warnings: [{ code: 'TOO_FEW_STEPS' }],
    });
    expect(advisory.calls).toBe(1);
  });

  it('starts no attempt after the deadline', async () => {
    let clock = 0;
    const run = scriptedDeps([new Error('slow'), GOOD], {
      maxRetries: 2,
      now: () => clock,
    });
    const original = run.deps.ai.models.generateContent;
    run.deps.ai.models.generateContent = (params) => {
      clock += IMPORT_RETRY_DEADLINE_MS;
      return original(params);
    };
    expect(await importFromSource(PASTED, run.deps)).toMatchObject({ kind: 'model_error' });
    expect(run.calls).toBe(1);
  });

  it('returns the best attempt when every attempt is warned', async () => {
    const oneStep = { ...MINIMAL, ingredientSections: [], instructionsOnPage: true };
    const run = scriptedDeps([NO_STEPS, oneStep, NO_STEPS], { maxRetries: 2 });
    const outcome = await importFromSource(PASTED, run.deps);
    expect(run.calls).toBe(3);
    // Each has one blocking warning; the one with a step wins.
    expect(outcome).toMatchObject({ kind: 'ok', recipe: { steps: MINIMAL.steps } });
  });

  it('returns the last failure when nothing was usable', async () => {
    const run = scriptedDeps([new Error('x'), { ...MINIMAL, title: ' ' }], { maxRetries: 1 });
    expect(await importFromSource(PASTED, run.deps)).toMatchObject({ kind: 'unusable' });
    expect(run.calls).toBe(2);
  });

  it('makes exactly one call for photos, even when the model throws', async () => {
    const ok = scriptedDeps([NO_STEPS, GOOD], { maxRetries: 2 });
    expect(await importFromImages([{ mediaType: 'image/jpeg', base64: 'AAAA' }], '', ok.deps))
      .toMatchObject({ kind: 'ok', warnings: [] });
    expect(ok.calls).toBe(1);

    const thrown = scriptedDeps([new Error('x'), GOOD], { maxRetries: 2 });
    await expect(
      importFromImages([{ mediaType: 'image/jpeg', base64: 'AAAA' }], '', thrown.deps),
    ).rejects.toThrow('x');
    expect(thrown.calls).toBe(1);
  });
});

describe('importFromImages', () => {
  const JPEG = { mediaType: 'image/jpeg', base64: 'AAAA' };

  async function promptFor(extraText: string): Promise<string> {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([JPEG], extraText, deps);
    const parts = (calls[0].contents as Content[])[0].parts ?? [];
    return parts[parts.length - 1].text ?? '';
  }

  it('returns empty_source and does not call the model with no images', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromImages([], 'notes', deps)).toEqual({ kind: 'empty_source' });
    expect(calls).toHaveLength(0);
  });

  it('sends each photo as an inlineData part, in order, then one prompt part', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    const images = [
      { mediaType: 'image/jpeg', base64: 'AAAA' },
      { mediaType: 'image/png', base64: 'BBBB' },
      { mediaType: 'image/webp', base64: 'CCCC' },
    ];
    await importFromImages(images, '', deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('test-model');
    const contents = calls[0].contents as Content[];
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    const parts = contents[0].parts ?? [];
    expect(parts).toHaveLength(4);
    images.forEach((image, i) => {
      expect(parts[i]).toEqual({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
    });
    expect(typeof parts[3].text).toBe('string');
    expect(parts[3].inlineData).toBeUndefined();
  });

  it('asks for high media resolution with the recipe schema, without the page self-report', async () => {
    const photo = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([JPEG], '', photo.deps);
    const text = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', text.deps);

    const config = photo.calls[0].config;
    expect(config?.mediaResolution).toBe(MediaResolution.MEDIA_RESOLUTION_HIGH);
    expect(config?.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
    expect(config?.maxOutputTokens).toBe(4096);
    expect(config?.responseMimeType).toBe('application/json');
    // The page schema is the photo schema plus the two self-report fields.
    const photoSchema = config?.responseSchema as { properties: Record<string, unknown> };
    const pageSchema = text.calls[0].config?.responseSchema as { properties: Record<string, unknown> };
    expect(photoSchema.properties).not.toHaveProperty('instructionsOnPage');
    expect(photoSchema.properties).not.toHaveProperty('ingredientsOnPage');
    const { instructionsOnPage, ingredientsOnPage, ...shared } = pageSchema.properties;
    expect(instructionsOnPage).toBeDefined();
    expect(ingredientsOnPage).toBeDefined();
    expect(shared).toEqual(photoSchema.properties);
  });

  it('keeps the text import request unchanged', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', deps);
    expect('mediaResolution' in (calls[0].config ?? {})).toBe(false);
    expect(typeof calls[0].contents).toBe('string');
  });

  it('tells the model to transcribe faithfully', async () => {
    const prompt = await promptFor('');
    for (const phrase of [
      'in the order given',
      'crossed out',
      '(?)',
      'tablespoon',
      'teaspoon',
      'notes',
      'Never invent',
      'NOT_A_RECIPE',
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
  });

  it('adds the notes as context only when given', async () => {
    const withNotes = await promptFor("  Grandma's, 1970s  ");
    expect(withNotes).toContain('Notes from the person importing');
    expect(withNotes).toContain("Grandma's, 1970s");

    const blank = await promptFor('   ');
    expect(blank).not.toContain('Notes from');
    expect(blank.endsWith('If the photos contain no recipe, save a recipe with the title "NOT_A_RECIPE".')).toBe(
      true,
    );
  });

  it('maps the model reply like text import', async () => {
    for (const reply of [undefined, '', 'Sure!', '42', 'null']) {
      const { deps } = fakeImportDeps(reply);
      expect(await importFromImages([JPEG], '', deps), String(reply)).toEqual({
        kind: 'parse_error',
      });
    }
    const cases: [unknown, unknown][] = [
      [{ ...MINIMAL, title: 'NOT_A_RECIPE' }, { kind: 'not_a_recipe' }],
      [{ ...MINIMAL, title: ' ' }, { kind: 'unusable' }],
      [
        { ...MINIMAL, servings: 0, photoId: 'x' },
        { kind: 'ok', recipe: { ...MINIMAL, servings: 1 }, warnings: [] },
      ],
    ];
    for (const [reply, outcome] of cases) {
      const { deps } = fakeImportDeps(JSON.stringify(reply));
      expect(await importFromImages([JPEG], '', deps)).toEqual(outcome);
    }
  });
});

describe('importFromHtml', () => {
  it('sends the extracted source, not the page', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    const html =
      '<html><head><script>var tracking = 1;</script></head>' +
      '<body><nav>Home</nav><main><p>Simmer the tomatoes.</p></main></body></html>';
    await importFromHtml(html, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].contents).toContain('Simmer the tomatoes.');
    expect(calls[0].contents).not.toContain('tracking');
  });

  it('treats a page with no text as empty', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(MINIMAL));
    expect(await importFromHtml('<html><body> </body></html>', deps)).toMatchObject({
      kind: 'empty_source',
    });
    expect(calls).toHaveLength(0);
  });

  it('reads JSON-LD, and checks against it', async () => {
    const node = {
      '@type': 'Recipe',
      name: 'Tomato soup',
      recipeIngredient: ['6 tomatoes', '1 onion', '2 cloves garlic', 'salt', 'pepper', 'oil'],
      recipeInstructions: [
        { '@type': 'HowToStep', text: 'Chop.' },
        { '@type': 'HowToStep', text: 'Simmer.' },
      ],
    };
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, steps: [] }));
    const outcome = await importFromHtml(ldBlock(JSON.stringify(node)), deps);
    expect(outcome.log?.source).toBe('jsonld');
    // JSON-LD has steps, so they were dropped; 1 of 6 ingredients is too few.
    expect(outcome).toMatchObject({
      kind: 'ok',
      warnings: [{ code: 'INSTRUCTIONS_DROPPED' }, { code: 'INGREDIENT_COUNT_MISMATCH' }],
    });
  });

  it('reports a page with no method as a source failure', async () => {
    const html = '<main><h1>Tomato soup</h1><p>You need 6 tomatoes. Video below.</p></main>';
    const { deps } = fakeImportDeps(
      JSON.stringify({ ...MINIMAL, steps: [], instructionsOnPage: false }),
    );
    const outcome = await importFromHtml(html, deps);
    expect(outcome.log?.source).toBe('text');
    expect(outcome).toMatchObject({ kind: 'ok', warnings: [{ code: 'INSTRUCTIONS_NOT_ON_PAGE' }] });
  });
});

describe('fetchPageHtml', () => {
  const redirect = (location: string, status = 302): FakePage => ({
    status,
    headers: { Location: location },
  });

  it('rejects what is not a URL', async () => {
    const { deps, lookups, requests } = fakePageFetch();
    expect(await fetchPageHtml('soup', deps)).toEqual({ kind: 'invalid_url' });
    expect([lookups, requests]).toEqual([[], []]);
  });

  it('rejects schemes other than http and https', async () => {
    const { deps, lookups, requests } = fakePageFetch();
    expect(await fetchPageHtml('ftp://example.com/soup', deps)).toEqual({
      kind: 'unsupported_scheme',
    });
    expect([lookups, requests]).toEqual([[], []]);
  });

  it('reports a network failure as unreachable', async () => {
    const { deps } = fakePageFetch({ pages: {} });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({
      kind: 'unreachable',
    });
  });

  it('reports a DNS failure as unreachable', async () => {
    const { deps } = fakePageFetch();
    deps.resolve = () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect(await fetchPageHtml('https://nowhere.example/soup', deps)).toEqual({
      kind: 'unreachable',
    });
  });

  it('reports a non-2xx response with its status', async () => {
    const { deps } = fakePageFetch({
      pages: { 'https://example.com/soup': { status: 403, body: 'challenge page' } },
    });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({
      kind: 'refused',
      status: 403,
    });
  });

  it('returns the page body, fetched from the checked address with the browser headers', async () => {
    const { deps, lookups, requests } = fakePageFetch({
      pages: { 'https://example.com/soup': { body: '<html>soup</html>' } },
    });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({
      kind: 'ok',
      html: '<html>soup</html>',
    });
    expect(lookups).toEqual(['example.com']);
    expect(requests).toEqual([
      {
        url: 'https://example.com/soup',
        address: PUBLIC_ADDRESS,
        headers: {
          'User-Agent': expect.stringContaining('iPhone'),
          Accept: 'text/html',
        },
      },
    ]);
  });

  it('refuses loopback, private and metadata literals before any connection', async () => {
    // The live resolver: an IP literal resolves to itself without a DNS query.
    const { deps, requests } = fakePageFetch({ pages: () => ({ body: 'internal' }) });
    deps.resolve = resolveHost;
    for (const url of [
      'http://127.0.0.1:3998/internal',
      'http://[::1]:3998/internal',
      'http://169.254.169.254/computeMetadata/v1/',
      'http://10.0.0.5/',
      'http://0x7f.1/',
      'http://[::ffff:127.0.0.1]/',
    ]) {
      expect(await fetchPageHtml(url, deps), url).toEqual({ kind: 'blocked' });
    }
    expect(requests).toEqual([]);
  });

  it('refuses a name with any non-public address before any connection', async () => {
    const { deps, requests } = fakePageFetch({
      dns: {
        'intranet.example': ['10.0.0.5'],
        'localhost': ['127.0.0.1', '::1'],
        'mixed.example': [PUBLIC_ADDRESS, '192.168.1.1'],
      },
      pages: () => ({ body: 'internal' }),
    });
    for (const url of ['http://intranet.example/', 'http://localhost:3001/api', 'https://mixed.example/soup']) {
      expect(await fetchPageHtml(url, deps), url).toEqual({ kind: 'blocked' });
    }
    expect(requests).toEqual([]);
  });

  it('refuses a public page that redirects to a non-public address', async () => {
    const { deps, requests } = fakePageFetch({
      dns: { 'rebind.example': ['127.0.0.1'] },
      pages: {
        'https://example.com/a': redirect('http://169.254.169.254/latest/meta-data/'),
        'https://example.com/b': redirect('https://rebind.example/admin', 307),
      },
    });
    expect(await fetchPageHtml('https://example.com/a', deps)).toEqual({ kind: 'blocked' });
    expect(await fetchPageHtml('https://example.com/b', deps)).toEqual({ kind: 'blocked' });
    expect(requests.map((request) => request.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('follows a redirect chain that stays public, resolving relative locations', async () => {
    const { deps, lookups, requests } = fakePageFetch({
      pages: {
        'http://example.com/soup': redirect('https://example.com/soup', 301),
        'https://example.com/soup': redirect('/recipes/soup?ref=1', 308),
        'https://example.com/recipes/soup?ref=1': redirect('https://cdn.example.org/soup.html', 303),
        'https://cdn.example.org/soup.html': { body: '<main>soup</main>' },
      },
    });
    expect(await fetchPageHtml('http://example.com/soup', deps)).toEqual({
      kind: 'ok',
      html: '<main>soup</main>',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://example.com/soup',
      'https://example.com/soup',
      'https://example.com/recipes/soup?ref=1',
      'https://cdn.example.org/soup.html',
    ]);
    // Every hop is resolved and checked again.
    expect(lookups).toEqual(['example.com', 'example.com', 'example.com', 'cdn.example.org']);
  });

  it(`follows at most ${MAX_PAGE_REDIRECTS} redirects`, async () => {
    const chain = (hops: number) =>
      fakePageFetch({
        pages: (url) => {
          const n = Number(url.pathname.slice(1));
          return n < hops ? redirect(`/${n + 1}`) : { body: 'end' };
        },
      });
    const enough = chain(MAX_PAGE_REDIRECTS);
    expect(await fetchPageHtml('https://example.com/0', enough.deps)).toEqual({ kind: 'ok', html: 'end' });
    expect(enough.requests).toHaveLength(MAX_PAGE_REDIRECTS + 1);
    const tooMany = chain(MAX_PAGE_REDIRECTS + 1);
    expect(await fetchPageHtml('https://example.com/0', tooMany.deps)).toEqual({ kind: 'unreachable' });
    expect(tooMany.requests).toHaveLength(MAX_PAGE_REDIRECTS + 1);
  });

  it('does not follow a redirect to another scheme', async () => {
    const { deps, requests } = fakePageFetch({
      pages: { 'https://example.com/soup': redirect('file:///etc/passwd') },
    });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({ kind: 'unreachable' });
    expect(requests).toHaveLength(1);
  });

  it('treats a redirect status without a Location as a refusal', async () => {
    const { deps } = fakePageFetch({ pages: { 'https://example.com/soup': { status: 302 } } });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({
      kind: 'refused',
      status: 302,
    });
  });

  it('gives up when the site does not answer in time', async () => {
    const { deps } = fakePageFetch({ pages: () => new Promise<FakePage>(() => {}), timeoutMs: 20 });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({ kind: 'unreachable' });
  });

  it('gives up when the body stalls past the timeout', async () => {
    const stalled = new Readable({ read() {} });
    stalled.push('<html>the start');
    const { deps } = fakePageFetch({ pages: () => ({ body: stalled }), timeoutMs: 20 });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({ kind: 'unreachable' });
    expect(stalled.destroyed).toBe(true);
  });

  it(`stops reading at ${MAX_PAGE_HTML_CHARS} characters and keeps the start of the page`, async () => {
    let pushed = 0;
    const endless = new Readable({
      read() {
        pushed += 1;
        this.push(Buffer.alloc(64 * 1024, pushed === 1 ? 'a' : 'b'));
      },
    });
    const { deps } = fakePageFetch({ pages: () => ({ body: endless }) });
    const outcome = await fetchPageHtml('https://example.com/soup', deps);
    expect(outcome.kind).toBe('ok');
    const html = outcome.kind === 'ok' ? outcome.html : '';
    expect(html).toHaveLength(MAX_PAGE_HTML_CHARS);
    expect(html.startsWith('a'.repeat(64 * 1024))).toBe(true);
    expect(endless.destroyed).toBe(true);
    expect(pushed).toBeLessThan(MAX_PAGE_HTML_CHARS / (64 * 1024) + 4);
  });

  it('does not end a capped page on half a surrogate pair', async () => {
    const body = 'a'.repeat(MAX_PAGE_HTML_CHARS - 1) + '🍅' + 'b'.repeat(10);
    const { deps } = fakePageFetch({ pages: () => ({ body }) });
    expect(await fetchPageHtml('https://example.com/soup', deps)).toEqual({
      kind: 'ok',
      html: 'a'.repeat(MAX_PAGE_HTML_CHARS - 1),
    });
  });

  it('decodes UTF-8, or the charset the response declares', async () => {
    const borshch = Buffer.from([0xc1, 0xee, 0xf0, 0xf9]); // "Борщ" in windows-1251
    const { deps } = fakePageFetch({
      pages: {
        'https://example.com/utf8': { body: Buffer.from('Борщ 🍅', 'utf8') },
        'https://example.com/cp1251': {
          headers: { 'Content-Type': 'text/html; charset=windows-1251' },
          body: borshch,
        },
        'https://example.com/unknown': {
          headers: { 'Content-Type': 'text/html; charset=x-made-up' },
          body: Buffer.from('Борщ', 'utf8'),
        },
      },
    });
    expect(await fetchPageHtml('https://example.com/utf8', deps)).toEqual({ kind: 'ok', html: 'Борщ 🍅' });
    expect(await fetchPageHtml('https://example.com/cp1251', deps)).toEqual({ kind: 'ok', html: 'Борщ' });
    expect(await fetchPageHtml('https://example.com/unknown', deps)).toEqual({ kind: 'ok', html: 'Борщ' });
  });
});

const ITALIAN = { ...MINIMAL, lang: 'it' };

const UKRAINIAN = {
  title: 'UK Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'UK tomatoes', quantity: 6 }] }],
  steps: [{ text: 'UK Simmer.' }],
  tags: ['soup'],
  lang: 'uk',
};

function prefixTranslator(detectedLang: string | null): {
  calls: TranslateInput[];
  translator: RecipeTranslator;
} {
  const calls: TranslateInput[] = [];
  const translator: RecipeTranslator = (input) => {
    calls.push(input);
    const outcome: TranslateOutcome = {
      ok: true,
      detectedLang,
      segments: input.segments.map((segment) => ({
        id: segment.id,
        text: `UK ${segment.text}`,
      })),
    };
    return Promise.resolve(outcome);
  };
  return { calls, translator };
}

function restoreEnv(name: 'GEMINI_API_KEY' | 'TRANSLATE_PROVIDER', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** An outcome without its log line or warnings, for tests about translation. */
function core(outcome: ImportOutcome): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...outcome };
  delete rest.log;
  delete rest.warnings;
  return rest;
}

describe('readImportTranslateTo', () => {
  it('accepts a supported UI language, including aliases', () => {
    expect(readImportTranslateTo(undefined)).toEqual({ ok: true });
    expect(readImportTranslateTo('uk')).toEqual({ ok: true, translateTo: 'uk' });
    expect(readImportTranslateTo('  ua  ')).toEqual({ ok: true, translateTo: 'uk' });
    expect(readImportTranslateTo('zh-CN')).toEqual({ ok: true, translateTo: 'zh-Hans' });
  });

  it('rejects a language that is not a supported UI language', () => {
    for (const value of ['fr', 'zh', '', '  ', null, 1]) {
      expect(readImportTranslateTo(value), String(value)).toEqual({ ok: false });
    }
  });
});

describe('import translation', () => {
  it('skips translation when the languages match', async () => {
    const { calls, translator } = prefixTranslator('it');
    const { deps } = fakeImportDeps(JSON.stringify(ITALIAN), translator);
    expect(core(await importFromSource('soup', deps, 'it'))).toEqual({
      kind: 'ok',
      recipe: ITALIAN,
    });
    expect(calls).toHaveLength(0);
  });

  it('applies translation when the languages differ', async () => {
    const { calls, translator } = prefixTranslator('it');
    const { deps } = fakeImportDeps(JSON.stringify(ITALIAN), translator);
    expect(core(await importFromSource('soup', deps, 'uk'))).toEqual({
      kind: 'ok',
      recipe: ITALIAN,
      translation: { kind: 'ok', lang: 'uk', recipe: UKRAINIAN },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe('uk');
    expect(calls[0]?.sourceLang).toBe('it');
  });

  it('labels a missing lang and discards the translation when detection matches', async () => {
    const { calls, translator } = prefixTranslator('uk');
    const { deps } = fakeImportDeps(JSON.stringify(MINIMAL), translator);
    expect(core(await importFromSource('soup', deps, 'uk'))).toEqual({
      kind: 'ok',
      recipe: { ...MINIMAL, lang: 'uk' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('sourceLang');
    expect(calls[0]?.target).toBe('uk');
  });

  it('labels a missing lang and returns the translation when detection differs', async () => {
    const { calls, translator } = prefixTranslator('it');
    const { deps } = fakeImportDeps(JSON.stringify(MINIMAL), translator);
    expect(core(await importFromSource('soup', deps, 'uk'))).toEqual({
      kind: 'ok',
      recipe: ITALIAN,
      translation: { kind: 'ok', lang: 'uk', recipe: UKRAINIAN },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('sourceLang');
  });

  it('discards the translation when bare zh is detected as the UI script', async () => {
    const { calls, translator } = prefixTranslator('zh-Hans');
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, lang: 'zh' }), translator);
    expect(core(await importFromSource('soup', deps, 'zh-Hans'))).toEqual({
      kind: 'ok',
      recipe: { ...MINIMAL, lang: 'zh-Hans' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('sourceLang');
    expect(calls[0]?.target).toBe('zh-Hans');
  });

  it('returns the translation when bare zh is detected as another script', async () => {
    const { calls, translator } = prefixTranslator('zh-Hant');
    const { deps } = fakeImportDeps(JSON.stringify({ ...MINIMAL, lang: 'zh' }), translator);
    const traditional = {
      ...UKRAINIAN,
      lang: 'zh-Hans',
    };
    expect(core(await importFromSource('soup', deps, 'zh-Hans'))).toEqual({
      kind: 'ok',
      recipe: { ...MINIMAL, lang: 'zh-Hant' },
      translation: { kind: 'ok', lang: 'zh-Hans', recipe: traditional },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('sourceLang');
  });

  it('returns the original with a failure flag when translation fails', async () => {
    const translators: RecipeTranslator[] = [
      () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
      () => Promise.reject(new Error('provider down')),
    ];
    for (const translator of translators) {
      const { deps } = fakeImportDeps(JSON.stringify(ITALIAN), translator);
      expect(core(await importFromSource('soup', deps, 'uk'))).toEqual({
        kind: 'ok',
        recipe: ITALIAN,
        translation: { kind: 'failed' },
      });
    }
  });

  it('forwards translateTo from importFromHtml', async () => {
    const { calls, translator } = prefixTranslator('it');
    const { deps, calls: modelCalls } = fakeImportDeps(JSON.stringify(ITALIAN), translator);
    const html =
      '<html><head><script>var tracking = 1;</script></head>' +
      '<body><nav>Home</nav><main><p>Simmer the tomatoes.</p></main></body></html>';
    expect(core(await importFromHtml(html, deps, 'uk'))).toEqual({
      kind: 'ok',
      recipe: ITALIAN,
      translation: { kind: 'ok', lang: 'uk', recipe: UKRAINIAN },
    });
    expect(modelCalls[0]?.contents).toContain('Simmer the tomatoes.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe('uk');
    expect(calls[0]?.sourceLang).toBe('it');
  });

  it('keeps the import when the translation key is missing or the provider is unavailable', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    const savedProvider = process.env.TRANSLATE_PROVIDER;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.TRANSLATE_PROVIDER;
      const missing = fakeImportDeps(JSON.stringify(ITALIAN));
      const missingTranslator = recipeImportDepsFromEnv().translator;
      expect(
        core(
          await importFromSource('soup', { ...missing.deps, translator: missingTranslator }, 'uk'),
        ),
      ).toEqual({
        kind: 'ok',
        recipe: ITALIAN,
        translation: { kind: 'failed' },
      });

      process.env.GEMINI_API_KEY = 'test-key';
      process.env.TRANSLATE_PROVIDER = 'nmt';
      const unavailable = fakeImportDeps(JSON.stringify(ITALIAN));
      const unavailableTranslator = recipeImportDepsFromEnv().translator;
      expect(
        core(
          await importFromSource(
            'soup',
            { ...unavailable.deps, translator: unavailableTranslator },
            'uk',
          ),
        ),
      ).toEqual({
        kind: 'ok',
        recipe: ITALIAN,
        translation: { kind: 'failed' },
      });
    } finally {
      warn.mockRestore();
      restoreEnv('GEMINI_API_KEY', savedKey);
      restoreEnv('TRANSLATE_PROVIDER', savedProvider);
    }
  });
});

describe('generateFromBrief', () => {
  const GENERATED = {
    title: 'Pressure cooker shrimp gumbo',
    servings: 6,
    ingredientSections: [{ items: [{ item: 'shrimp', quantity: 500, unit: 'g' }, { item: 'okra' }] }],
    steps: [{ text: 'Make the roux.' }, { text: 'Pressure cook 8 minutes.' }],
    tags: ['gumbo'],
    lang: 'en',
  };
  const BRIEF = 'shrimp gumbo in a pressure cooker for 6';

  /** The structured call's prompt: the only call without search, the second one with it. */
  async function promptFor(search: boolean): Promise<string> {
    const { deps, calls } = fakeImportDeps(JSON.stringify(GENERATED));
    await generateFromBrief(BRIEF, deps, { search });
    return String(calls[calls.length - 1].contents);
  }

  it('locks the caps', () => {
    expect(MAX_GENERATE_BRIEF_CHARS).toBe(2000);
    expect(MAX_GENERATE_SOURCES).toBe(10);
  });

  it('returns empty_source and does not call the model for a blank brief', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(GENERATED));
    expect(await generateFromBrief('   ', deps, { search: false })).toEqual({
      kind: 'empty_source',
      log: { attempts: [] },
    });
    expect(calls).toHaveLength(0);
  });

  it('makes one call with the brief, the photo schema, and no tools', async () => {
    const generate = fakeImportDeps(JSON.stringify(GENERATED));
    await generateFromBrief(`  ${BRIEF}  `, generate.deps, { search: false });
    const photo = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([{ mediaType: 'image/jpeg', base64: 'AAAA' }], '', photo.deps);

    expect(generate.calls).toHaveLength(1);
    expect(generate.calls[0].model).toBe('test-model');
    const contents = String(generate.calls[0].contents);
    expect(contents.endsWith(`Request:\n${BRIEF}`)).toBe(true);
    const config = generate.calls[0].config ?? {};
    expect(config.responseMimeType).toBe('application/json');
    expect(config.maxOutputTokens).toBe(4096);
    expect(config.responseSchema).toBe(photo.calls[0].config?.responseSchema);
    expect('tools' in config).toBe(false);
    expect('mediaResolution' in config).toBe(false);
  });

  it('orders every field of its schema, times before the lists, and photos get the same order', async () => {
    const generate = fakeImportDeps(JSON.stringify(GENERATED));
    await generateFromBrief(BRIEF, generate.deps, { search: false });
    const page = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromSource('soup', page.deps);
    const photo = fakeImportDeps(JSON.stringify(MINIMAL));
    await importFromImages([{ mediaType: 'image/jpeg', base64: 'AAAA' }], '', photo.deps);
    type OrderedSchema = {
      properties: Record<string, { type: string }>;
      propertyOrdering: string[];
    };
    const schema = generate.calls[0].config?.responseSchema as OrderedSchema;
    const order = schema.propertyOrdering;
    expect([...order].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(order.indexOf('description')).toBeLessThan(order.indexOf('ingredientSections'));
    expect(order.indexOf('prepMinutes')).toBeLessThan(order.indexOf('ingredientSections'));
    expect(order.indexOf('cookMinutes')).toBeLessThan(order.indexOf('ingredientSections'));
    expect(schema.properties[order[order.length - 1]].type).toBe('STRING');
    // The photo request is the one the image-import constitution protects; check it directly.
    expect((photo.calls[0].config?.responseSchema as OrderedSchema).propertyOrdering).toEqual(order);
    // The page schema keeps the same order and only appends its two booleans.
    const pageOrder = (page.calls[0].config?.responseSchema as OrderedSchema).propertyOrdering;
    expect(pageOrder).toEqual([...order, 'instructionsOnPage', 'ingredientsOnPage']);
    // The page order itself is pinned literally in the importFromSource tests.
  });

  it('with search, researches with the Google Search tool first, then writes from the notes', async () => {
    const { deps, calls } = fakeImportDeps('Three pages agree: make a dark roux first.');
    const outcome = await generateFromBrief(BRIEF, deps, { search: true });
    // The fake answers both calls with the notes, so the structured call's reply is not JSON.
    expect(outcome.kind).toBe('parse_error');
    expect(calls).toHaveLength(2);

    const research = calls[0];
    expect(research.config?.tools).toEqual([{ googleSearch: {} }]);
    expect(research.config?.responseSchema).toBeUndefined();
    expect(research.config?.responseMimeType).toBeUndefined();
    expect(research.config?.maxOutputTokens).toBe(2048);
    const researchPrompt = String(research.contents);
    for (const phrase of ['Use Google Search', 'not a recipe of your own', `Request:\n${BRIEF}`]) {
      expect(researchPrompt, phrase).toContain(phrase);
    }

    const write = calls[1];
    expect(write.config?.tools).toBeUndefined();
    expect(write.config?.responseSchema).toBeDefined();
    const writePrompt = String(write.contents);
    expect(writePrompt).toContain('Notes from a web search follow the request');
    expect(writePrompt).toContain(`Request:\n${BRIEF}\n\nNotes from a web search:\nThree pages agree: make a dark roux first.`);
  });

  it('writes without notes when the research call answered nothing', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(GENERATED));
    // The fake answers the research call with JSON too; a blank reply needs its own fake.
    const blank: RecipeImportDeps = {
      ...deps,
      ai: {
        models: {
          generateContent: (params) =>
            calls.length === 0
              ? (calls.push(params), Promise.resolve({ text: '   ' } as never))
              : deps.ai.models.generateContent(params),
        },
      },
    };
    const outcome = await generateFromBrief(BRIEF, blank, { search: true });
    expect(outcome.kind).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(String(calls[1].contents)).not.toContain('Notes from a web search');
    expect(outcome).not.toHaveProperty('grounding');
  });

  it('tells the model to write a recipe, not transcribe one', async () => {
    const prompt = await promptFor(false);
    for (const phrase of [
      'idea for a dish, not a finished recipe',
      'Fill in',
      'Keep every constraint',
      'not about something that can be cooked',
      'NOT_A_RECIPE',
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
    expect(prompt).not.toContain('web search');
    expect(prompt).not.toContain('Never invent');
    expect(await promptFor(true)).toContain('Notes from a web search');
  });

  it('maps the model reply, and refuses a recipe with no ingredients or no steps', async () => {
    for (const reply of [undefined, '', 'Sure!', '42', 'null']) {
      const { deps } = fakeImportDeps(reply);
      expect(await generateFromBrief(BRIEF, deps, { search: false }), String(reply)).toEqual({
        kind: 'parse_error',
        log: { attempts: [{ result: 'parse_error', codes: [] }] },
      });
    }
    const cases: [unknown, ImportOutcome['kind']][] = [
      [{ ...GENERATED, title: 'NOT_A_RECIPE' }, 'not_a_recipe'],
      [{ ...GENERATED, title: ' ' }, 'unusable'],
      [{ ...GENERATED, ingredientSections: [] }, 'unusable'],
      [{ ...GENERATED, steps: [] }, 'unusable'],
      // One step is a whole method for a drink or a dressing; import's MIN_STEPS warning does not apply.
      [{ ...GENERATED, steps: [{ text: 'Shake everything with ice and strain.' }] }, 'ok'],
    ];
    for (const [reply, kind] of cases) {
      const { deps } = fakeImportDeps(JSON.stringify(reply));
      const outcome = await generateFromBrief(BRIEF, deps, { search: false });
      expect(outcome.kind, JSON.stringify(reply)).toBe(kind);
      expect(outcome.log?.attempts.map((a) => a.result)).toEqual([kind]);
    }
    const { deps } = fakeImportDeps(JSON.stringify({ ...GENERATED, servings: 0, photoId: 'x' }));
    expect(await generateFromBrief(BRIEF, deps, { search: false })).toEqual({
      kind: 'ok',
      recipe: { ...GENERATED, servings: 1 },
      warnings: [],
      log: { attempts: [{ result: 'ok', codes: [] }] },
    });
  });

  it('turns a thrown call into model_error with its status only', async () => {
    const error = Object.assign(new Error('SECRET request echo'), { status: 503 });
    let rejected = 0;
    const deps: RecipeImportDeps = {
      model: 'test-model',
      ai: {
        models: {
          generateContent: () => {
            rejected += 1;
            return Promise.reject(error);
          },
        },
      },
      translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
    };
    for (const search of [false, true]) {
      rejected = 0;
      const outcome = await generateFromBrief(BRIEF, deps, { search });
      expect(outcome, String(search)).toEqual({
        kind: 'model_error',
        log: { attempts: [{ result: 'threw', codes: [] }], errorStatus: 503 },
      });
      expect(JSON.stringify(outcome)).not.toContain('SECRET');
      // A research throw ends the import; the structured call is never made.
      expect(rejected).toBe(1);
    }
  });

  it('reads the grounding sources, de-duplicated and capped, and only counts the queries', async () => {
    const chunks = Array.from({ length: 14 }, (_, i) => ({
      web: { uri: `https://example.com/gumbo-${i % 12}`, title: i === 0 ? '  ' : `Gumbo ${i % 12}` },
    }));
    const { deps } = fakeImportDeps(JSON.stringify(GENERATED), undefined, {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'ftp://example.com/x', title: 'not http' } },
          { web: { title: 'no uri' } },
          { web: { uri: 'not a url', title: 'bad' } },
          ...chunks,
        ],
        webSearchQueries: ['pressure cooker shrimp gumbo recipe', 'gumbo roux pressure cooker'],
        searchEntryPoint: { renderedContent: '<div class="chip">gumbo</div>' },
      },
    });
    const outcome = await generateFromBrief(BRIEF, deps, { search: true });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.grounding?.sources).toHaveLength(MAX_GENERATE_SOURCES);
    expect(outcome.grounding?.sources[0]).toEqual({ title: '', url: 'https://example.com/gumbo-0' });
    expect(outcome.grounding?.sources[1]).toEqual({ title: 'Gumbo 1', url: 'https://example.com/gumbo-1' });
    expect(new Set(outcome.grounding?.sources.map((s) => s.url)).size).toBe(MAX_GENERATE_SOURCES);
    expect(outcome.grounding?.searchSuggestions).toBe('<div class="chip">gumbo</div>');
    expect(outcome.grounding).not.toHaveProperty('queries');
    expect(outcome.log?.searchQueries).toBe(2);
    expect(JSON.stringify(outcome)).not.toContain('pressure cooker shrimp gumbo recipe');
  });

  it('lists a page once even when Google issued it several redirect links', async () => {
    const { deps } = fakeImportDeps(JSON.stringify(GENERATED), undefined, {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa', title: 'gumbo.example' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb', title: 'gumbo.example' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ccc', title: 'roux.example' } },
        ],
      },
    });
    const outcome = await generateFromBrief(BRIEF, deps, { search: true });
    expect(outcome.kind === 'ok' && outcome.grounding?.sources).toEqual([
      { title: 'gumbo.example', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa' },
      { title: 'roux.example', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ccc' },
    ]);
  });

  it('keeps every untitled page, since their redirect host names no site', async () => {
    const { deps } = fakeImportDeps(JSON.stringify(GENERATED), undefined, {
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb', title: ' ' } },
        ],
      },
    });
    const outcome = await generateFromBrief(BRIEF, deps, { search: true });
    expect(outcome.kind === 'ok' && outcome.grounding?.sources).toEqual([
      { title: '', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa' },
      { title: '', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb' },
    ]);
  });

  it('counts the searches when the structured call then fails', async () => {
    const metadata = { webSearchQueries: ['a', 'b', 'c'] };
    for (const [reply, kind] of [
      [JSON.stringify({ ...GENERATED, title: 'NOT_A_RECIPE' }), 'not_a_recipe'],
      [JSON.stringify({ ...GENERATED, steps: [] }), 'unusable'],
    ] as const) {
      const { deps } = fakeImportDeps(reply, undefined, { groundingMetadata: metadata });
      const outcome = await generateFromBrief(BRIEF, deps, { search: true });
      expect(outcome.kind).toBe(kind);
      expect(outcome.log?.searchQueries, kind).toBe(3);
    }
    const unsearched = fakeImportDeps(JSON.stringify(GENERATED), undefined, { groundingMetadata: metadata });
    expect((await generateFromBrief(BRIEF, unsearched.deps, { search: false })).log).not.toHaveProperty(
      'searchQueries',
    );
  });

  it('reports no grounding without search, or when Google reported nothing', async () => {
    const metadata = { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }] };
    const unsearched = fakeImportDeps(JSON.stringify(GENERATED), undefined, { groundingMetadata: metadata });
    expect(await generateFromBrief(BRIEF, unsearched.deps, { search: true })).toHaveProperty('grounding');
    expect(await generateFromBrief(BRIEF, unsearched.deps, { search: false })).not.toHaveProperty('grounding');
    const empty = fakeImportDeps(JSON.stringify(GENERATED), undefined, { groundingMetadata: {} });
    expect(await generateFromBrief(BRIEF, empty.deps, { search: true })).not.toHaveProperty('grounding');
    const none = fakeImportDeps(JSON.stringify(GENERATED));
    expect(await generateFromBrief(BRIEF, none.deps, { search: true })).not.toHaveProperty('grounding');
  });

  it('translates like a paste import', async () => {
    const { calls, translator } = prefixTranslator('it');
    const italian = { ...ITALIAN, steps: [{ text: 'Simmer.' }, { text: 'Blend.' }] };
    const ukrainian = { ...UKRAINIAN, steps: [{ text: 'UK Simmer.' }, { text: 'UK Blend.' }] };
    const { deps } = fakeImportDeps(JSON.stringify(italian), translator);
    const outcome = await generateFromBrief('zuppa', deps, { search: false, translateTo: 'uk' });
    expect(outcome.kind).toBe('ok');
    expect(core(outcome)).toEqual({
      kind: 'ok',
      recipe: italian,
      translation: { kind: 'ok', lang: 'uk', recipe: ukrainian },
    });
    expect(calls[0]?.target).toBe('uk');
    expect(calls[0]?.sourceLang).toBe('it');
  });
});
