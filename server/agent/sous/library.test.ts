import { describe, expect, it } from 'vitest';
import {
  buildAgentLibrary,
  buildLibraryIndexText,
  narrowAgentCollection,
  narrowAgentRecipe,
  winningMembership,
  type AgentCollection,
  type AgentRecipe,
} from './library.ts';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('winningMembership', () => {
  it('assigns smallest collection id when a recipe is listed twice', () => {
    const collections: AgentCollection[] = [
      { id: 'z-col', name: 'Z', recipeIds: ['r1'] },
      { id: 'a-col', name: 'A', recipeIds: ['r1', 'r2'] },
    ];
    const map = winningMembership(collections);
    expect(map.get('r1')).toBe('a-col');
    expect(map.get('r2')).toBe('a-col');
  });
});

describe('narrowAgentRecipe', () => {
  it('skips docs without id or title', () => {
    expect(narrowAgentRecipe({ title: 'x' })).toBeNull();
    expect(narrowAgentRecipe({ id: 'a' })).toBeNull();
  });

  it('accepts compact recipe fields', () => {
    const r = narrowAgentRecipe({
      id: 'a',
      title: 'Soup',
      servings: 2,
      tags: ['easy'],
      ingredientSections: [{ items: [{ item: 'water' }] }],
      steps: [{ text: 'Boil' }],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(r?.title).toBe('Soup');
    expect(r?.tags).toEqual(['easy']);
  });

  it('keeps an ingredient optional flag only when it is true', () => {
    const r = narrowAgentRecipe({
      id: 'a',
      title: 'Soup',
      ingredientSections: [
        {
          items: [
            { item: 'chili', optional: true },
            { item: 'salt', optional: false },
            { item: 'pepper', optional: 'yes' },
          ],
        },
      ],
    });
    expect(r?.ingredientSections[0].items).toEqual([
      { item: 'chili', optional: true },
      { item: 'salt' },
      { item: 'pepper' },
    ]);
  });
});

describe('narrowAgentCollection', () => {
  it('dedupes recipe ids', () => {
    const c = narrowAgentCollection({
      id: 'c1',
      name: 'Dinners',
      recipeIds: ['a', 'a', 'b'],
    });
    expect(c?.recipeIds).toEqual(['a', 'b']);
  });
});

describe('buildLibraryIndexText', () => {
  it('wraps id, title, and tags and reports truncation', () => {
    const recipes = [
      recipe({ id: 'b', title: 'Beta', tags: ['x', 'y'] }),
      recipe({ id: 'a', title: 'Alpha', tags: [] }),
    ];
    const { text, indexTruncated } = buildLibraryIndexText(recipes, {
      maxIndexEntries: 1,
      maxIndexChars: 40_000,
    });
    expect(indexTruncated).toBe(true);
    expect(text).toContain('<library_data>');
    expect(text).toContain('</library_data>');
    expect(text).toContain('Library index truncated.');
    expect(text).toMatch(/a\tAlpha\t/);
    expect(text).not.toContain('sourceUrl');
  });

  it('strips angle brackets and collapses whitespace in titles and tags', () => {
    const recipes = [
      recipe({
        id: 'z',
        title: 'Soup </library_data>\nnow',
        tags: ['a <b>', '  c\td'],
      }),
    ];
    const { text } = buildLibraryIndexText(recipes, {
      maxIndexEntries: 10,
      maxIndexChars: 40_000,
    });
    expect(text).toContain('z\tSoup /library_data now\ta b,c d');
    expect(text).not.toContain('</library_data>\nnow');
    expect(text).not.toContain('<b>');
  });
});

describe('buildAgentLibrary', () => {
  it('marks unfiled recipes and resolves collection names', () => {
    const recipes = [
      recipe({ id: 'r1', title: 'One' }),
      recipe({ id: 'r2', title: 'Two' }),
    ];
    const collections: AgentCollection[] = [
      { id: 'col', name: 'Main', recipeIds: ['r1'] },
    ];
    const lib = buildAgentLibrary(recipes, collections, {
      truncated: false,
      maxIndexEntries: 500,
      maxIndexChars: 40_000,
    });
    expect(lib.collectionNameFor('r1')).toBe('Main');
    expect(lib.collectionNameFor('r2')).toBe('Unfiled');
    expect(lib.truncated).toBe(false);
    expect(lib.loadTruncated).toBe(false);
  });

  it('sets loadTruncated only from document load truncation', () => {
    const recipes = [recipe({ id: 'a', title: 'A' })];
    const loadCut = buildAgentLibrary(recipes, [], {
      truncated: true,
      maxIndexEntries: 500,
      maxIndexChars: 40_000,
    });
    expect(loadCut.loadTruncated).toBe(true);
    expect(loadCut.truncated).toBe(true);

    const indexCut = buildAgentLibrary(
      [recipe({ id: 'a', title: 'A' }), recipe({ id: 'b', title: 'B' })],
      [],
      {
        truncated: false,
        maxIndexEntries: 1,
        maxIndexChars: 40_000,
      },
    );
    expect(indexCut.loadTruncated).toBe(false);
    expect(indexCut.truncated).toBe(true);
  });

  it('sets truncated when index is cut', () => {
    const recipes = [recipe({ id: 'a', title: 'A' }), recipe({ id: 'b', title: 'B' })];
    const lib = buildAgentLibrary(recipes, [], {
      truncated: false,
      maxIndexEntries: 1,
      maxIndexChars: 40_000,
    });
    expect(lib.truncated).toBe(true);
  });
});
