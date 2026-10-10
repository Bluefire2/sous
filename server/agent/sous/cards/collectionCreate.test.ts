import { describe, expect, it } from 'vitest';
import { replayCards } from '../../request.ts';
import { buildAgentLibrary, type AgentCollection, type AgentRecipe } from '../library.ts';
import {
  collectionCreateHistoryText,
  normalizeCollectionCreate,
  revalidateCollectionCreate,
  type CollectionCreateData,
} from './collectionCreate.ts';

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

function lib(
  recipes: AgentRecipe[],
  collections: AgentCollection[],
  opts: { truncated?: boolean; maxIndexEntries?: number } = {},
) {
  return buildAgentLibrary(recipes, collections, {
    truncated: opts.truncated ?? false,
    maxIndexEntries: opts.maxIndexEntries ?? 500,
    maxIndexChars: 40_000,
  });
}

describe('normalizeCollectionCreate', () => {
  const recipes = [
    recipe({ id: 'r1', title: 'Tomato soup' }),
    recipe({ id: 'r2', title: 'Stew' }),
  ];
  const collections: AgentCollection[] = [
    { id: 'col-a', name: 'Alpha', recipeIds: ['r2'] },
  ];

  it('creates an empty collection when recipe ids are omitted', () => {
    const result = normalizeCollectionCreate({ name: '  Soups  ' }, lib(recipes, collections));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toEqual({
      name: 'Soups',
      recipeIds: [],
      sources: [],
      preview: [],
      total: 0,
    });
    expect(collectionCreateHistoryText(result.data)).toContain('with no recipes');
    expect(collectionCreateHistoryText(result.data)).toContain('Not confirmed');
  });

  it('files explicit ids and records where they leave', () => {
    const result = normalizeCollectionCreate(
      { name: 'Soups', recipeIds: ['r1', 'r2', 'r1'] },
      lib(recipes, collections),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.recipeIds).toEqual(['r1', 'r2']);
    expect(result.data.total).toBe(2);
    expect(result.data.sources).toEqual([
      { id: 'r1', from: { kind: 'unfiled' } },
      { id: 'r2', from: { kind: 'collection', name: 'Alpha' } },
    ]);
    expect(result.data.preview).toEqual([
      { id: 'r1', title: 'Tomato soup', from: { kind: 'unfiled' } },
      { id: 'r2', title: 'Stew', from: { kind: 'collection', name: 'Alpha' } },
    ]);
    expect(collectionCreateHistoryText(result.data)).toContain('with 2 recipes');
  });

  it('rejects a name that already exists and names the collection id', () => {
    const result = normalizeCollectionCreate({ name: 'alpha' }, lib(recipes, collections));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('propose_collection_move');
    expect(result.error).toContain('col-a');
  });

  it('rejects an ambiguous name', () => {
    const ctx = lib(recipes, [
      { id: 'c1', name: 'Dinner', recipeIds: [] },
      { id: 'c2', name: 'dinner', recipeIds: [] },
    ]);
    const result = normalizeCollectionCreate({ name: 'Dinner' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('ambiguous');
    expect(result.error).toContain('c1');
    expect(result.error).toContain('c2');
  });

  it('rejects an unknown recipe id', () => {
    const result = normalizeCollectionCreate(
      { name: 'Soups', recipeIds: ['missing'] },
      lib(recipes, collections),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('unknown recipe id');
  });

  it('treats an empty or null recipe id list as an empty collection', () => {
    for (const recipeIds of [[], null]) {
      const result = normalizeCollectionCreate({ name: 'Soups', recipeIds }, lib(recipes, []));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.recipeIds).toEqual([]);
      expect(result.data.total).toBe(0);
    }
  });

  it('rejects more than 100 explicit ids', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const ctx = lib(
      ids.map((id) => recipe({ id, title: id })),
      [],
    );
    const result = normalizeCollectionCreate({ name: 'Many', recipeIds: ids }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('at most 100');
  });

  it('rejects a blank or over-long name', () => {
    expect(normalizeCollectionCreate({ name: '   ' }, lib(recipes, [])).ok).toBe(false);
    expect(normalizeCollectionCreate({ name: 'x'.repeat(81) }, lib(recipes, [])).ok).toBe(false);
    expect(normalizeCollectionCreate({}, lib(recipes, [])).ok).toBe(false);
  });

  it('refuses when the library load was truncated', () => {
    const ctx = lib(recipes, collections, { truncated: true });
    const result = normalizeCollectionCreate({ name: 'Soups' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('truncated');
  });

  it('allows create when only the index was truncated', () => {
    const ctx = lib(recipes, collections, { truncated: false, maxIndexEntries: 1 });
    expect(ctx.loadTruncated).toBe(false);
    expect(ctx.truncated).toBe(true);
    expect(normalizeCollectionCreate({ name: 'Soups' }, ctx).ok).toBe(true);
  });

  it('refuses when owned collections are already at the cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      recipeIds: [],
    }));
    const result = normalizeCollectionCreate({ name: 'Soups' }, lib(recipes, many));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('cap');
  });
});

describe('revalidateCollectionCreate', () => {
  const full: CollectionCreateData = {
    name: 'Soups',
    recipeIds: ['r1'],
    sources: [{ id: 'r1', from: { kind: 'unfiled' } }],
    preview: [{ id: 'r1', title: 'Tomato soup', from: { kind: 'unfiled' } }],
    total: 1,
  };

  it('accepts a full card whose recipes are still in the library', () => {
    const result = revalidateCollectionCreate(full, lib([recipe({ id: 'r1', title: 'Tomato soup' })], []));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.recipeIds).toEqual(['r1']);
  });

  it('accepts the replay summary that omits recipe ids', () => {
    const summary = {
      name: 'Soups',
      preview: full.preview,
      total: full.total,
    };
    const result = revalidateCollectionCreate(summary, lib([], []));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.total).toBe(1);
    expect(result.data.recipeIds).toEqual([]);
    expect(collectionCreateHistoryText(result.data)).toContain('Soups');
  });

  it('fails when a listed recipe is gone', () => {
    const result = revalidateCollectionCreate(full, lib([], []));
    expect(result.ok).toBe(false);
  });

  it('fails a summary whose total does not match a present id list', () => {
    const result = revalidateCollectionCreate({ ...full, total: 2 }, lib([recipe({ id: 'r1', title: 'Tomato soup' })], []));
    expect(result.ok).toBe(false);
  });
});

describe('replayCards collection_create', () => {
  it('uses revalidate and appends history text', () => {
    const ctx = lib([recipe({ id: 'r1', title: 'Tomato soup' })], []);
    const out = replayCards(
      [
        { role: 'user', content: 'Make a soups collection' },
        {
          role: 'assistant',
          content: 'Here is a proposal.',
          cards: [
            {
              type: 'collection_create',
              v: 1,
              id: 'card-1',
              data: {
                name: 'Soups',
                preview: [{ id: 'r1', title: 'Tomato soup', from: { kind: 'unfiled' } }],
                total: 1,
              },
            },
          ],
        },
      ],
      ctx,
    );
    expect(out[1]?.text).toContain('Proposed creating Soups');
    expect(out[1]?.text).toContain('Not confirmed');
  });
});
