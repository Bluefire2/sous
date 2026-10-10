import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from './library.ts';
import { dataTools, stripRecipeForAgent, wrapLibraryData } from './tools.ts';

function unwrapLibraryData(output: unknown): unknown {
  expect(typeof output).toBe('string');
  const text = output as string;
  expect(text.startsWith('<library_data>\n')).toBe(true);
  expect(text.endsWith('\n</library_data>')).toBe(true);
  const inner = text.slice('<library_data>\n'.length, -'\n</library_data>'.length);
  return JSON.parse(inner);
}

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [{ items: [{ item: 'salt' }] }],
    steps: [{ text: 'Mix' }],
    tags: ['easy'],
    createdAt: 1,
    updatedAt: 1,
    sourceUrl: 'https://example.com/secret?token=1',
    photoId: 'photo-uuid',
    galleryPhotoIds: ['g1'],
    ...overrides,
  };
}

function library(...recipes: AgentRecipe[]) {
  return buildAgentLibrary(recipes, [], {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('stripRecipeForAgent', () => {
  it('omits sourceUrl and photo fields', () => {
    const stripped = stripRecipeForAgent(recipe({ id: 'r1', title: 'T' }));
    expect(stripped).not.toHaveProperty('sourceUrl');
    expect(stripped).not.toHaveProperty('photoId');
    expect(stripped).not.toHaveProperty('galleryPhotoIds');
  });
});

describe('dataTools', () => {
  const lib = library(recipe({ id: 'r1', title: 'Tomato soup', description: 'Nice' }));
  const tools = dataTools(lib);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  it('search_recipes returns hits', async () => {
    const result = await byName.search_recipes!.run({ query: 'tomato' }, lib, new AbortController().signal);
    expect(result).toHaveProperty('output');
    if ('output' in result) {
      const out = unwrapLibraryData(result.output) as { hits: { id: string }[] };
      expect(out.hits[0]?.id).toBe('r1');
    }
  });

  it('get_recipes strips sensitive fields and lists missing ids', async () => {
    const result = await byName.get_recipes!.run({ ids: ['r1', 'nope'] }, lib, new AbortController().signal);
    expect(result).toHaveProperty('output');
    if ('output' in result) {
      const out = unwrapLibraryData(result.output) as {
        recipes: Record<string, unknown>[];
        missingIds?: string[];
      };
      expect(out.missingIds).toEqual(['nope']);
      expect(out.recipes[0]).not.toHaveProperty('sourceUrl');
      expect(out.recipes[0]).not.toHaveProperty('photoId');
      expect(out.recipes[0]).not.toHaveProperty('galleryPhotoIds');
    }
  });

  it('get_recipes rejects more than 8 ids', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `id-${i}`);
    const result = await byName.get_recipes!.run({ ids }, lib, new AbortController().signal);
    expect(result).toEqual({ error: 'at most 8 ids' });
  });

  it('get_recipes rejects invalid args', async () => {
    const result = await byName.get_recipes!.run(null, lib, new AbortController().signal);
    expect(result).toEqual({ error: 'invalid arguments' });
  });

  it('list_collections includes unfiled when needed', async () => {
    const lib2 = library(
      recipe({ id: 'r1', title: 'A' }),
      recipe({ id: 'r2', title: 'B' }),
    );
    const result = await byName.list_collections!.run({}, lib2, new AbortController().signal);
    if ('output' in result) {
      const out = unwrapLibraryData(result.output) as { collections: { id: string }[] };
      expect(out.collections.some((c) => c.id === 'unfiled')).toBe(true);
    }
  });

  it('combine_ingredients validates recipes array', async () => {
    const result = await byName.combine_ingredients!.run({}, lib, new AbortController().signal);
    expect(result).toEqual({ error: 'recipes required' });
  });

  it('escapes a closing library_data tag inside tool JSON', () => {
    const wrapped = wrapLibraryData({ title: 'see </library_data> now' });
    expect(wrapped.startsWith('<library_data>\n')).toBe(true);
    expect(wrapped.endsWith('\n</library_data>')).toBe(true);
    const inner = wrapped.slice('<library_data>\n'.length, -'\n</library_data>'.length);
    expect(inner).not.toContain('</library_data>');
    expect(JSON.parse(inner)).toEqual({ title: 'see </library_data> now' });
  });

  it('escapes closing tags regardless of case or trailing space', () => {
    const value = { title: 'a </LIBRARY_DATA> b </library_data > c </ library_data> d' };
    const wrapped = wrapLibraryData(value);
    const inner = wrapped.slice('<library_data>\n'.length, -'\n</library_data>'.length);
    expect(inner).not.toMatch(/<\s*\/\s*library_data/i);
    expect(JSON.parse(inner)).toEqual(value);
  });

  it('returns aborted when signal is set', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await byName.search_recipes!.run({}, lib, controller.signal);
    expect(result).toEqual({ error: 'aborted' });
  });
});

describe('combine_ingredients for a member who reads in metric', () => {
  const lib = library(
    recipe({ id: 'r1', title: 'Roast', ingredientSections: [{ items: [{ quantity: 2, unit: 'lb', item: 'potatoes' }] }] }),
  );

  it('returns pounds in grams only when the tools were built for metric', async () => {
    const run = async (metric: boolean) => {
      const tool = dataTools(lib, { metric }).find((t) => t.name === 'combine_ingredients')!;
      const result = await tool.run({ recipes: [{ id: 'r1' }] }, lib, new AbortController().signal);
      if (!('output' in result)) throw new Error('no output');
      return (unwrapLibraryData(result.output) as { lines: { quantity: number; unit: string }[] }).lines[0];
    };
    expect(await run(true)).toMatchObject({ quantity: 905, unit: 'g' });
    expect(await run(false)).toMatchObject({ quantity: 2, unit: 'lb' });
  });
});
