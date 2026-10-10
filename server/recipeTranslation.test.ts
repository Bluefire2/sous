import { describe, expect, it } from 'vitest';
import { COMMON_UNITS as clientUnits } from '../src/lib/units.ts';
import {
  COMMON_UNITS,
  MAX_TRANSLATE_CHARS,
  MAX_TRANSLATE_SEGMENTS,
  TRANSLATE_RATE_LIMIT,
  TRANSLATE_RATE_WINDOW_MS,
  TRANSLATION_VERSION,
  admitTranslateCall,
  applyTranslation,
  cacheWriteDecision,
  canonicalTranslationSource,
  compactTranslatableRecipe,
  recipeSegments,
  translationCacheHit,
  translationExceedsCaps,
  translationSourceHash,
  type TranslatableRecipe,
} from './recipeTranslation.ts';

const RECIPE: TranslatableRecipe = {
  title: 'Carbonara',
  description: 'Roman pasta',
  notes: 'No cream',
  servings: 2,
  prepMinutes: 10,
  cookMinutes: 20,
  tags: ['pasta'],
  lang: 'it',
  ingredientSections: [
    {
      name: 'Sauce',
      items: [
        { quantity: 200, unit: 'g', item: 'guanciale', note: 'diced' },
        { quantity: 2, unit: 'piece', item: 'eggs' },
        { quantity: 50, unit: 'mazzo', item: 'pecorino', note: 'grated' },
      ],
    },
    {
      items: [{ quantity: 1, unit: 'tsp', item: 'pepper' }],
    },
  ],
  steps: [{ text: 'Boil the pasta' }, { text: 'Toss off the heat' }],
};

const SEGMENT_IDS = [
  'title',
  'description',
  'notes',
  'section.0.name',
  'section.0.item.0.item',
  'section.0.item.0.note',
  'section.0.item.1.item',
  'section.0.item.2.item',
  'section.0.item.2.note',
  'section.0.item.2.unit',
  'section.1.item.0.item',
  'step.0',
  'step.1',
];

function minimalRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Soup',
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    ...overrides,
  };
}

describe('COMMON_UNITS', () => {
  it('matches src/lib/units.ts', () => {
    expect(COMMON_UNITS).toEqual(clientUnits);
  });
});

describe('recipeSegments and applyTranslation', () => {
  it('round-trips text onto the same ids and leaves the source recipe unchanged', () => {
    const before = JSON.stringify(RECIPE);
    const segments = recipeSegments(RECIPE);
    expect(segments.map((segment) => segment.id)).toEqual(SEGMENT_IDS);
    const translated = segments.map((segment) => ({
      id: segment.id,
      text: `T:${segment.text}`,
    }));
    const applied = applyTranslation(RECIPE, translated);
    expect(recipeSegments(applied).map((segment) => segment.id)).toEqual(SEGMENT_IDS);
    expect(recipeSegments(applied).map((segment) => segment.text)).toEqual(
      translated.map((segment) => segment.text),
    );
    expect(JSON.stringify(RECIPE)).toBe(before);
  });

  it('preserves quantities, known units, order, and counts', () => {
    const segments = recipeSegments(RECIPE).map((segment) => ({
      id: segment.id,
      text: `T:${segment.text}`,
    }));
    const applied = applyTranslation(RECIPE, segments);
    expect(applied.servings).toBe(2);
    expect(applied.prepMinutes).toBe(10);
    expect(applied.cookMinutes).toBe(20);
    expect(applied.tags).toEqual(['pasta']);
    expect(applied.lang).toBe('it');
    expect(applied.ingredientSections).toHaveLength(2);
    expect(applied.ingredientSections[0].items).toHaveLength(3);
    expect(applied.ingredientSections[1].items).toHaveLength(1);
    expect(applied.steps).toHaveLength(2);
    expect(applied.ingredientSections[0].items.map((item) => item.quantity)).toEqual([200, 2, 50]);
    expect(applied.ingredientSections[1].items[0].quantity).toBe(1);
    expect(applied.ingredientSections[0].items[0].unit).toBe('g');
    expect(applied.ingredientSections[0].items[1].unit).toBe('piece');
    expect(applied.ingredientSections[1].items[0].unit).toBe('tsp');
    expect(applied.ingredientSections[0].items[2].unit).toBe('T:mazzo');
    expect(applied.ingredientSections[0].name).toBe('T:Sauce');
    expect(applied.steps[0].text).toBe('T:Boil the pasta');
  });

  it('does not translate a known unit even if a stray segment names it', () => {
    const applied = applyTranslation(RECIPE, [
      ...recipeSegments(RECIPE),
      { id: 'section.0.item.0.unit', text: 'cups' },
    ]);
    expect(applied.ingredientSections[0].items[0].unit).toBe('g');
  });

  it('copies the optional flag without making it a segment', () => {
    const recipe: TranslatableRecipe = {
      ...RECIPE,
      ingredientSections: [
        { items: [{ item: 'chili', optional: true }, { item: 'salt' }] },
      ],
    };
    const segments = recipeSegments(recipe);
    expect(segments.map((segment) => segment.id)).toEqual([
      'title',
      'description',
      'notes',
      'section.0.item.0.item',
      'section.0.item.1.item',
      'step.0',
      'step.1',
    ]);
    const applied = applyTranslation(
      recipe,
      segments.map((segment) => ({ id: segment.id, text: `T:${segment.text}` })),
    );
    expect(applied.ingredientSections[0].items).toEqual([
      { item: 'T:chili', optional: true },
      { item: 'T:salt' },
    ]);
  });
});

describe('compactTranslatableRecipe', () => {
  it('keeps translatable structure and drops identity and photos', () => {
    const compacted = compactTranslatableRecipe({
      ...RECIPE,
      id: '550e8400-e29b-41d4-a716-446655440000',
      createdAt: 1,
      updatedAt: 2,
      photoId: '550e8400-e29b-41d4-a716-446655440001',
      galleryPhotoIds: ['550e8400-e29b-41d4-a716-446655440002'],
      sourceUrl: 'https://example.com/carbonara',
    });
    expect(compacted).toEqual(RECIPE);
  });

  it('keeps an ingredient optional flag only when it is true', () => {
    const compacted = compactTranslatableRecipe({
      ...minimalRecipe(),
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
    expect(compacted?.ingredientSections[0].items).toEqual([
      { item: 'chili', optional: true },
      { item: 'salt' },
      { item: 'pepper' },
    ]);
  });

  it('rejects a recipe that is not translatable structure', () => {
    expect(compactTranslatableRecipe({ title: '  ', servings: 1, ingredientSections: [], steps: [], tags: [] })).toBeNull();
    expect(compactTranslatableRecipe({ ...minimalRecipe(), ingredientSections: [{ items: [{ item: 1 }] }] })).toBeNull();
  });
});

describe('translationExceedsCaps', () => {
  it('allows 200 segments and 20k characters and rejects one past either cap', () => {
    const atSegmentCap = [
      { text: 'title' },
      ...Array.from({ length: MAX_TRANSLATE_SEGMENTS - 1 }, () => ({ text: 'a' })),
    ];
    expect(atSegmentCap).toHaveLength(MAX_TRANSLATE_SEGMENTS);
    expect(translationExceedsCaps(atSegmentCap)).toBe(false);
    expect(translationExceedsCaps([...atSegmentCap, { text: 'b' }])).toBe(true);

    const atCharCap = [{ text: 'y'.repeat(MAX_TRANSLATE_CHARS) }];
    expect(translationExceedsCaps(atCharCap)).toBe(false);
    expect(translationExceedsCaps([{ text: 'y'.repeat(MAX_TRANSLATE_CHARS + 1) }])).toBe(true);
  });
});

describe('translation cache hash', () => {
  it('hits only when the stored hash matches, and a text change is a miss', () => {
    const segments = recipeSegments(RECIPE);
    const hash = translationSourceHash(segments);
    expect(canonicalTranslationSource(segments)).toContain(String(TRANSLATION_VERSION));
    expect(translationSourceHash(segments)).toBe(hash);
    expect(translationCacheHit({ hash }, hash)).toBe(true);
    expect(translationCacheHit(null, hash)).toBe(false);
    expect(translationCacheHit({ hash: 'other' }, hash)).toBe(false);
    const changed = recipeSegments({ ...RECIPE, title: `${RECIPE.title}!` });
    expect(translationCacheHit({ hash }, translationSourceHash(changed))).toBe(false);
  });
});

describe('cacheWriteDecision', () => {
  it('writes only for a live recipe doc', () => {
    expect(cacheWriteDecision({ title: 'Soup' })).toBe('write');
    expect(cacheWriteDecision({ title: 'Soup', deletedAt: null })).toBe('write');
  });

  it('skips a tombstone', () => {
    expect(cacheWriteDecision({ title: 'Soup', deletedAt: 10 })).toBe('skip');
  });

  it('skips a missing doc, which is also a shared or unknown recipe id', () => {
    expect(cacheWriteDecision(null)).toBe('skip');
    expect(cacheWriteDecision(undefined)).toBe('skip');
  });
});

describe('admitTranslateCall', () => {
  it('allows 60 calls per member per hour and then one more when the window expires', () => {
    const buckets = new Map<string, number[]>();
    const start = 10_000;
    for (let i = 0; i < TRANSLATE_RATE_LIMIT; i += 1) {
      expect(admitTranslateCall(buckets, 'member', start)).toBe(true);
    }
    expect(buckets.get('member')).toHaveLength(TRANSLATE_RATE_LIMIT);
    expect(admitTranslateCall(buckets, 'member', start)).toBe(false);
    expect(buckets.get('member')).toHaveLength(TRANSLATE_RATE_LIMIT);
    expect(admitTranslateCall(buckets, 'member', start + TRANSLATE_RATE_WINDOW_MS - 1)).toBe(false);
    expect(admitTranslateCall(buckets, 'other', start)).toBe(true);
    expect(admitTranslateCall(buckets, 'member', start + TRANSLATE_RATE_WINDOW_MS)).toBe(true);
  });

  it('drops a timestamp once it is windowMs old', () => {
    const buckets = new Map<string, number[]>();
    expect(admitTranslateCall(buckets, 'member', 0, 1, 1000)).toBe(true);
    expect(admitTranslateCall(buckets, 'member', 999, 1, 1000)).toBe(false);
    expect(admitTranslateCall(buckets, 'member', 1000, 1, 1000)).toBe(true);
  });
});
