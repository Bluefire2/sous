import { describe, expect, it } from 'vitest';
import { isUsableRecipe } from '../../src/lib/recipeShape.ts';
import { recipeDocBody, validatePushOp } from '../store.ts';
import {
  fieldErrorText,
  mergeRecipeChanges,
  variantFromParent,
  newRecipePayload,
  validateNewRecipe,
  validateRecipeChanges,
} from './recipeInput.ts';

const ID = '0b6f6a6e-3a3c-4c55-9a59-3f0c8c1d2e4f';

const FULL = {
  title: '  Leek and potato soup ',
  description: 'Silky and quick.',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 30,
  ingredientSections: [
    { items: [{ item: 'leeks', quantity: 3 }, { item: 'potatoes', quantity: 500, unit: 'g', note: 'peeled' }] },
    { name: 'To serve', items: [{ item: 'crème fraîche', unit: '' }, { item: 'chives', optional: true }] },
  ],
  steps: [{ text: 'Sweat the leeks.' }, { text: 'Add potatoes and stock; simmer.' }],
  tags: ['soup', ' soup', 'vegetarian'],
  notes: 'Freezes well.',
  sourceUrl: 'https://example.com/leek-soup',
  lang: 'en-GB',
};

function errorsOf(result: { ok: boolean; errors?: { path: string }[] }): string[] {
  return result.ok ? [] : (result.errors ?? []).map((e) => e.path);
}

describe('validateNewRecipe', () => {
  it('accepts a full recipe, trimming text and deduplicating tags', () => {
    const result = validateNewRecipe(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recipe.title).toBe('Leek and potato soup');
    expect(result.recipe.tags).toEqual(['soup', 'vegetarian']);
    expect(result.recipe.lang).toBe('en');
    expect(result.recipe.ingredientSections[1]).toEqual({
      name: 'To serve',
      items: [{ item: 'crème fraîche' }, { item: 'chives', optional: true }],
    });
  });

  it('stores an ingredient optional flag only as true and rejects a non-boolean', () => {
    const withOptional = (optional: unknown) =>
      validateNewRecipe({ ...FULL, ingredientSections: [{ items: [{ item: 'chives', optional }] }] });
    const off = withOptional(false);
    expect(off.ok && off.recipe.ingredientSections[0].items[0]).toEqual({ item: 'chives' });
    expect(errorsOf(withOptional('yes'))).toEqual(['ingredientSections[0].items[0].optional']);
  });

  it('every accepted payload passes the push validator and the client shape check', () => {
    const minimal = { title: 'Toast', servings: 1, ingredientSections: [], steps: [] };
    for (const input of [FULL, minimal]) {
      const validated = validateNewRecipe(input);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const built = newRecipePayload(validated.recipe, ID, 1_700_000_000_000);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(validatePushOp({ kind: 'recipe.put', payload: built.payload }).ok).toBe(true);
      expect(isUsableRecipe(recipeDocBody(built.payload, ID, 1_700_000_000_000, 1))).toBe(true);
      expect(built.payload.createdAt).toBe(1_700_000_000_000);
      expect(built.payload.updatedAt).toBe(1_700_000_000_000);
    }
  });

  it('names the path of each bad field instead of repairing it', () => {
    const result = validateNewRecipe({
      ...FULL,
      title: '',
      servings: 0,
      prepMinutes: -1,
      ingredientSections: [
        { items: [{ item: 'ok' }] },
        { items: [{ item: ' ' }, { item: 'flour', quantity: 0 }, { item: 'x', unit: 'u'.repeat(33) }] },
        { items: [] },
      ],
      steps: [{ text: 'fine' }, 'Stir.'],
      tags: ['t'.repeat(41)],
      sourceUrl: 'javascript:alert(1)',
      lang: 'not a language',
      photoId: 'p1',
    });
    expect(errorsOf(result).sort()).toEqual(
      [
        'title',
        'servings',
        'prepMinutes',
        'ingredientSections[1].items[0].item',
        'ingredientSections[1].items[1].quantity',
        'ingredientSections[1].items[2].unit',
        'ingredientSections[2].items',
        'steps[1]',
        'tags[0]',
        'sourceUrl',
        'lang',
        'photoId',
      ].sort(),
    );
  });

  it('enforces the counts and the payload cap', () => {
    const items = Array.from({ length: 201 }, () => ({ item: 'x' }));
    expect(errorsOf(validateNewRecipe({ ...FULL, ingredientSections: [{ items }] }))).toEqual([
      'ingredientSections[0].items',
    ]);
    const steps = Array.from({ length: 201 }, () => ({ text: 'x' }));
    expect(errorsOf(validateNewRecipe({ ...FULL, steps }))).toEqual(['steps']);
    const tags = Array.from({ length: 31 }, (_, i) => `t${i}`);
    expect(errorsOf(validateNewRecipe({ ...FULL, tags }))).toEqual(['tags']);
    expect(errorsOf(validateNewRecipe({ ...FULL, servings: 1001 }))).toEqual(['servings']);
    const big = Array.from({ length: 45 }, () => ({ text: 'y'.repeat(4900) }));
    const validated = validateNewRecipe({ ...FULL, steps: big });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(newRecipePayload(validated.recipe, ID, 1).ok).toBe(false);
  });

  it('formats errors one per line with their path', () => {
    const result = validateNewRecipe({ title: 3, servings: 2, ingredientSections: [], steps: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fieldErrorText(result.errors)).toBe('title must be a string');
  });
});

describe('validateRecipeChanges', () => {
  it('accepts a partial change and null for clearable fields', () => {
    expect(validateRecipeChanges({ servings: 6, notes: null, description: '  ' })).toEqual({
      ok: true,
      changes: { servings: 6, notes: null, description: null },
    });
  });

  it('rejects clearing a required field, unknown fields, and an empty change', () => {
    expect(errorsOf(validateRecipeChanges({ title: null, steps: null, photoId: 'p', lang: 'en' }))).toEqual([
      'changes.photoId',
      'changes.lang',
      'changes.title',
      'changes.steps',
    ]);
    expect(errorsOf(validateRecipeChanges({}))).toEqual(['changes']);
    expect(errorsOf(validateRecipeChanges('x'))).toEqual(['changes']);
  });

  it('names nested paths', () => {
    expect(
      errorsOf(validateRecipeChanges({ ingredientSections: [{ items: [{ item: 'a' }] }, { items: [{ qty: 1 }] }] })),
    ).toEqual(['changes.ingredientSections[1].items[0].qty', 'changes.ingredientSections[1].items[0].item']);
  });
});

describe('variantFromParent', () => {
  const PARENT = '66666666-6666-4666-8666-666666666666';
  const ORIGINAL = '77777777-7777-4777-8777-777777777777';

  it("uses the parent's group original, else the parent, and its language", () => {
    expect(variantFromParent({ id: PARENT, lang: 'it-IT' })).toEqual({ variantOf: PARENT, lang: 'it' });
    expect(variantFromParent({ id: PARENT, variantOf: ORIGINAL })).toEqual({ variantOf: ORIGINAL });
  });

  it('ignores a malformed stored variantOf or lang', () => {
    expect(variantFromParent({ id: PARENT, variantOf: 'nope', lang: 'garbage!!' })).toEqual({ variantOf: PARENT });
    expect(variantFromParent({ id: PARENT, variantOf: PARENT })).toEqual({ variantOf: PARENT });
  });
});

describe('mergeRecipeChanges', () => {
  const stored = {
    id: ID,
    createdAt: 100,
    updatedAt: 200,
    serverUpdatedAt: 201,
    title: 'Lasagne',
    description: 'Rich.',
    servings: 6,
    prepMinutes: 30,
    cookMinutes: 60,
    ingredientSections: [{ items: [{ item: 'milk' }, { item: 'pasta sheets' }] }],
    steps: [],
    tags: ['pasta'],
    notes: 'Rest 10 minutes.',
    sourceUrl: 'https://example.com/lasagne',
    photoId: '11111111-1111-4111-8111-111111111111',
    galleryPhotoIds: ['22222222-2222-4222-8222-222222222222'],
    lang: 'en',
    importCheck: { at: 100, warnings: [{ code: 'MISSING_INSTRUCTIONS' }, { code: 'INGREDIENT_COUNT_MISMATCH' }] },
    variantOf: '33333333-3333-4333-8333-333333333333',
  };

  it('replaces the changed fields and keeps identity, photos, source, language, variant group', () => {
    const merged = mergeRecipeChanges(stored, { title: 'Dairy-free lasagne', servings: 4 }, 300);
    expect(merged).toMatchObject({
      id: ID,
      createdAt: 100,
      updatedAt: 300,
      title: 'Dairy-free lasagne',
      servings: 4,
      sourceUrl: stored.sourceUrl,
      photoId: stored.photoId,
      galleryPhotoIds: stored.galleryPhotoIds,
      lang: 'en',
      variantOf: stored.variantOf,
      notes: stored.notes,
      tags: ['pasta'],
    });
    expect(merged).not.toHaveProperty('serverUpdatedAt');
  });

  it('null clears an optional field', () => {
    const merged = mergeRecipeChanges(stored, { notes: null, cookMinutes: null }, 300);
    expect(merged).not.toHaveProperty('notes');
    expect(merged).not.toHaveProperty('cookMinutes');
    expect(merged?.description).toBe('Rich.');
  });

  it('reconciles the import check as recipeStore.save does', () => {
    const withSteps = mergeRecipeChanges(stored, { steps: [{ text: 'Layer and bake.' }] }, 300);
    expect(withSteps?.importCheck).toEqual({
      at: 100,
      warnings: [{ code: 'INGREDIENT_COUNT_MISMATCH' }],
      editedAt: 300,
    });
    const retagged = mergeRecipeChanges(stored, { tags: ['pasta', 'bake'] }, 300);
    expect(retagged?.importCheck).toEqual(stored.importCheck);
  });

  it('a merged recipe still passes the client shape check', () => {
    const merged = mergeRecipeChanges(stored, { ingredientSections: [{ items: [{ item: 'oat milk' }] }] }, 300);
    expect(merged).not.toBeNull();
    expect(isUsableRecipe(recipeDocBody(merged!, ID, 300, 301))).toBe(true);
  });

  it('is null when the result would be too large', () => {
    const steps = Array.from({ length: 45 }, () => ({ text: 'y'.repeat(4900) }));
    expect(mergeRecipeChanges(stored, { steps }, 300)).toBeNull();
  });
});
