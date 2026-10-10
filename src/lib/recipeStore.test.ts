import { describe, expect, it } from 'vitest';
import { compactRecipe } from './recipeStore';
import type { Recipe } from './types';

const required: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('compactRecipe', () => {
  it('omits optional keys that are undefined', () => {
    const compacted = compactRecipe({
      ...required,
      description: undefined,
      sourceUrl: undefined,
      prepMinutes: undefined,
      cookMinutes: undefined,
      notes: undefined,
      photoId: undefined,
      galleryPhotoIds: undefined,
      lang: undefined,
      importCheck: undefined,
      variantOf: undefined,
      savedFrom: undefined,
    });

    expect(compacted).toEqual(required);
    expect(Object.keys(compacted).sort()).toEqual(
      [
        'createdAt',
        'id',
        'ingredientSections',
        'servings',
        'steps',
        'tags',
        'title',
        'updatedAt',
      ].sort(),
    );
  });

  it('keeps optional keys that are present', () => {
    const compacted = compactRecipe({
      ...required,
      description: 'Hot.',
      sourceUrl: 'https://example.com/soup',
      prepMinutes: 5,
      cookMinutes: 20,
      notes: 'Salt late.',
      photoId: 'p1',
      galleryPhotoIds: ['g1', 'g2'],
      lang: 'it',
      importCheck: { at: 3, warnings: [{ code: 'TOO_FEW_STEPS' }] },
      variantOf: ORIGINAL,
      savedFrom: { name: 'Ada', savedAt: 4 },
    });

    expect(compacted.description).toBe('Hot.');
    expect(compacted.sourceUrl).toBe('https://example.com/soup');
    expect(compacted.prepMinutes).toBe(5);
    expect(compacted.cookMinutes).toBe(20);
    expect(compacted.notes).toBe('Salt late.');
    expect(compacted.photoId).toBe('p1');
    expect(compacted.galleryPhotoIds).toEqual(['g1', 'g2']);
    expect(compacted.lang).toBe('it');
    expect(compacted.importCheck).toEqual({ at: 3, warnings: [{ code: 'TOO_FEW_STEPS' }] });
    expect(compacted.variantOf).toBe(ORIGINAL);
    expect(compacted.savedFrom).toEqual({ name: 'Ada', savedAt: 4 });
  });

  it('drops a malformed savedFrom without dropping the recipe', () => {
    expect(
      compactRecipe({ ...required, savedFrom: { savedAt: 'x' } as unknown as Recipe['savedFrom'] }),
    ).toEqual(required);
  });

  it('drops a malformed variantOf without dropping the recipe', () => {
    expect(compactRecipe({ ...required, variantOf: 'not-a-recipe-id' })).toEqual(required);
    const own = { ...required, id: ORIGINAL };
    expect(compactRecipe({ ...own, variantOf: ORIGINAL })).toEqual(own);
  });

  it('drops a malformed importCheck without dropping the recipe', () => {
    const malformed = { at: 'later', warnings: [] } as unknown as Recipe['importCheck'];
    expect(compactRecipe({ ...required, importCheck: malformed })).toEqual(required);
  });

  it('stores lang only when normalizeLang yields a tag', () => {
    expect(compactRecipe({ ...required, lang: 'it-IT' }).lang).toBe('it');
    expect(compactRecipe({ ...required, lang: 'zh-CN' }).lang).toBe('zh-Hans');
    expect(compactRecipe({ ...required, lang: 'garbage!!' })).not.toHaveProperty('lang');
  });

  it('omits an empty gallery and strips the cover id from it', () => {
    expect(
      compactRecipe({
        ...required,
        photoId: 'p1',
        galleryPhotoIds: [],
      }).galleryPhotoIds,
    ).toBeUndefined();
    expect(
      compactRecipe({
        ...required,
        photoId: 'p1',
        galleryPhotoIds: ['p1', 'g1', 'g1'],
      }).galleryPhotoIds,
    ).toEqual(['g1']);
  });
});
