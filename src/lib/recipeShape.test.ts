import { describe, expect, it } from 'vitest';
import { compactRecipe } from './compactRecipe';
import { isUsableRecipe, normalizeRecipeDraft } from './recipeShape';
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

const wellFormedProposal = {
  title: '  Pasta  ',
  servings: 2,
  description: 'Quick weeknight dinner.',
  prepMinutes: 5,
  cookMinutes: 15,
  ingredientSections: [
    {
      name: ' Sauce ',
      items: [
        { quantity: 2, unit: ' tbsp ', item: ' olive oil ', note: ' extra virgin ' },
        { item: 'garlic', quantity: 'bad' },
        { item: '' },
        { item: 'tomatoes' },
      ],
    },
    { items: [{ item: 'pasta' }] },
    { name: 'Empty', items: [] },
  ],
  steps: [{ text: ' Boil water. ' }, { text: '' }, { text: 'Drain.' }],
  tags: ['Pasta', 'pasta', 42, '  weeknight  ', ''],
  notes: 'Salt the water.',
  photoId: 'fake-photo',
  sourceUrl: 'https://evil.example',
};

describe('normalizeRecipeDraft', () => {
  it('round-trips a well-formed proposal', () => {
    expect(normalizeRecipeDraft(wellFormedProposal)).toEqual({
      title: 'Pasta',
      servings: 2,
      description: 'Quick weeknight dinner.',
      prepMinutes: 5,
      cookMinutes: 15,
      ingredientSections: [
        {
          name: 'Sauce',
          items: [
            { quantity: 2, unit: 'tbsp', item: 'olive oil', note: 'extra virgin' },
            { item: 'garlic' },
            { item: 'tomatoes' },
          ],
        },
        { items: [{ item: 'pasta' }] },
      ],
      steps: [{ text: 'Boil water.' }, { text: 'Drain.' }],
      tags: ['Pasta', 'pasta', 'weeknight'],
      notes: 'Salt the water.',
    });
  });

  it('keeps a valid step lane and drops a blank or too long one', () => {
    const draft = normalizeRecipeDraft({
      ...wellFormedProposal,
      steps: [
        { text: 'Boil water.', lane: ' Pasta ' },
        { text: 'Fry garlic.', lane: '   ' },
        { text: 'Toss.', lane: 'x'.repeat(25) },
      ],
    });
    expect(draft?.steps).toEqual([
      { text: 'Boil water.', lane: 'Pasta' },
      { text: 'Fry garlic.' },
      { text: 'Toss.' },
    ]);
  });

  it.each([null, [], 'nope', 42])('drops non-object input (%s)', (value) => {
    expect(normalizeRecipeDraft(value)).toBeUndefined();
  });

  it('drops missing title', () => {
    expect(normalizeRecipeDraft({ servings: 2 })).toBeUndefined();
  });

  it('drops whitespace-only title', () => {
    expect(normalizeRecipeDraft({ title: '   ', servings: 2 })).toBeUndefined();
  });

  it('drops string servings', () => {
    expect(normalizeRecipeDraft({ title: 'Soup', servings: 'four' })).toBeUndefined();
  });

  it('drops missing servings', () => {
    expect(normalizeRecipeDraft({ title: 'Soup' })).toBeUndefined();
  });

  it('drops zero servings', () => {
    expect(normalizeRecipeDraft({ title: 'Soup', servings: 0 })).toBeUndefined();
  });

  it('drops negative servings', () => {
    expect(normalizeRecipeDraft({ title: 'Soup', servings: -1 })).toBeUndefined();
  });

  it('keeps title-only drafts with empty arrays', () => {
    expect(normalizeRecipeDraft({ title: 'Draft', servings: 1 })).toEqual({
      title: 'Draft',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
    });
  });

  it('defaults missing ingredientSections and steps to []', () => {
    const draft = normalizeRecipeDraft({ title: 'Draft', servings: 2, tags: ['a'] });
    expect(draft?.ingredientSections).toEqual([]);
    expect(draft?.steps).toEqual([]);
  });

  it('does not copy lang', () => {
    const draft = normalizeRecipeDraft({ ...wellFormedProposal, lang: 'it' });
    expect(draft).toBeDefined();
    expect(draft).not.toHaveProperty('lang');
  });

  it('omits photoId, galleryPhotoIds, and sourceUrl even when present', () => {
    const draft = normalizeRecipeDraft({
      title: 'Draft',
      servings: 1,
      photoId: 'p1',
      galleryPhotoIds: ['g1'],
      sourceUrl: 'https://example.com',
    });
    expect(draft).toBeDefined();
    expect(Object.keys(draft!)).not.toContain('photoId');
    expect(Object.keys(draft!)).not.toContain('galleryPhotoIds');
    expect(Object.keys(draft!)).not.toContain('sourceUrl');
  });

  it('omits absent optional keys rather than setting undefined', () => {
    const draft = normalizeRecipeDraft({ title: 'Draft', servings: 1 });
    expect(Object.keys(draft!).sort()).toEqual(
      ['ingredientSections', 'servings', 'steps', 'tags', 'title'].sort(),
    );
  });
});

describe('isUsableRecipe', () => {
  it('returns true for a valid row', () => {
    expect(isUsableRecipe(required)).toBe(true);
  });

  it.each([
    ['title', { ...required, title: '' }],
    ['tags', { ...required, tags: undefined }],
    ['ingredientSections', { ...required, ingredientSections: undefined }],
    ['steps', { ...required, steps: undefined }],
    ['servings', { ...required, servings: 0 }],
    ['id', { ...required, id: '' }],
  ] as const)('returns false when %s is missing or invalid', (_field, row) => {
    expect(isUsableRecipe(row)).toBe(false);
  });

  it('returns false when description is an object', () => {
    expect(isUsableRecipe({ ...required, description: {} })).toBe(false);
  });

  it('returns false when a section name is an object', () => {
    expect(
      isUsableRecipe({
        ...required,
        ingredientSections: [{ name: {}, items: [{ item: 'salt' }] }],
      }),
    ).toBe(false);
  });

  it('returns false when an item quantity is a string', () => {
    expect(
      isUsableRecipe({
        ...required,
        ingredientSections: [{ items: [{ item: 'salt', quantity: '1' }] }],
      }),
    ).toBe(false);
  });

  it('returns false when galleryPhotoIds is not a string array', () => {
    expect(isUsableRecipe({ ...required, galleryPhotoIds: 'g1' })).toBe(false);
    expect(isUsableRecipe({ ...required, galleryPhotoIds: [1] })).toBe(false);
  });

  it('returns true when galleryPhotoIds is a string array', () => {
    expect(isUsableRecipe({ ...required, galleryPhotoIds: ['g1'] })).toBe(true);
  });

  it('accepts a malformed lang and leaves stripping to compact', () => {
    const malformed = { ...required, lang: 'garbage!!' };
    expect(isUsableRecipe(malformed)).toBe(true);
    expect(isUsableRecipe({ ...required, lang: 12 })).toBe(true);
    expect(compactRecipe(malformed)).not.toHaveProperty('lang');
    expect(compactRecipe({ ...required, lang: 12 } as unknown as Recipe)).not.toHaveProperty(
      'lang',
    );
  });
});
