import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '../i18n';
import { displayTemperatures, ingredientLine, recipeToText, sourceLink, type Translate } from './recipeText';
import type { Recipe } from './types';

function tFor(locale: Locale): Translate {
  return (key, params) => translate(locale, key, params);
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Shakshuka',
    servings: 4,
    ingredientSections: [
      {
        items: [
          { quantity: 2, unit: 'tbsp', item: 'olive oil' },
          { quantity: 0.4, unit: 'kg', item: 'tomatoes', note: 'ripe' },
        ],
      },
      {
        name: 'To serve',
        items: [
          { quantity: 1.5, unit: 'handful', item: 'parsley' },
          { item: 'bread' },
        ],
      },
    ],
    steps: [{ text: 'Warm the oil.' }, { text: 'Add the tomatoes.' }],
    tags: [],
    notes: 'Better the next day.',
    sourceUrl: 'https://example.com/shakshuka?ref=1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('recipeToText', () => {
  it('writes title, servings, sections, numbered steps, notes and the source in English', () => {
    expect(recipeToText(recipe(), 'en', tFor('en'))).toBe(
      [
        'Shakshuka',
        '4 servings',
        '',
        'Ingredients',
        '- 2 tbsp olive oil',
        '- 0.4 kg tomatoes (ripe)',
        '',
        'To serve',
        '- 1½ handful parsley',
        '- bread',
        '',
        'Steps',
        '1. Warm the oil.',
        '2. Add the tomatoes.',
        '',
        'Notes',
        'Better the next day.',
        '',
        'From https://example.com/shakshuka?ref=1',
      ].join('\n'),
    );
  });

  it('takes headings, unit labels, plurals and the decimal comma from the UI language', () => {
    const text = recipeToText(recipe(), 'uk', tFor('uk'));
    expect(text).toBe(
      [
        'Shakshuka',
        '4 порції',
        '',
        'Інгредієнти',
        '- 2 ст. л. olive oil',
        '- 0,4 кг tomatoes (ripe)',
        '',
        'To serve',
        '- 1½ handful parsley',
        '- bread',
        '',
        'Кроки',
        '1. Warm the oil.',
        '2. Add the tomatoes.',
        '',
        'Нотатки',
        'Better the next day.',
        '',
        'Джерело: https://example.com/shakshuka?ref=1',
      ].join('\n'),
    );
  });

  it('uses Chinese headings and unit labels', () => {
    const text = recipeToText(recipe(), 'zh-Hans', tFor('zh-Hans'));
    expect(text).toContain(`${translate('zh-Hans', 'common.ingredients')}\n- 2 汤匙 olive oil`);
    expect(text).toContain('- 0.4 千克 tomatoes (ripe)');
    expect(text).toContain(translate('zh-Hans', 'common.servingsCount', { count: 4 }));
  });

  it('leaves out what the recipe does not have', () => {
    const bare = recipe({
      ingredientSections: [],
      steps: [],
      notes: undefined,
      sourceUrl: undefined,
    });
    expect(recipeToText(bare, 'en', tFor('en'))).toBe('Shakshuka\n4 servings');
  });

  it('treats blank notes, empty sections and a non-web source as missing', () => {
    const text = recipeToText(
      recipe({
        ingredientSections: [{ name: 'Empty', items: [] }, { items: [{ item: 'salt' }] }],
        notes: '  \n ',
        sourceUrl: 'javascript:alert(1)',
      }),
      'en',
      tFor('en'),
    );
    expect(text).toBe(
      ['Shakshuka', '4 servings', '', 'Ingredients', '- salt', '', 'Steps', '1. Warm the oil.', '2. Add the tomatoes.'].join(
        '\n',
      ),
    );
  });

  it('names a lone section when it has a name', () => {
    const text = recipeToText(
      recipe({ ingredientSections: [{ name: 'Dough', items: [{ quantity: 500, unit: 'g', item: 'flour' }] }] }),
      'en',
      tFor('en'),
    );
    expect(text).toContain('Ingredients\nDough\n- 500 g flour');
  });

  it('labels an optional ingredient in the UI language', () => {
    const optional = recipe({
      ingredientSections: [{ items: [{ item: 'chili flakes', optional: true }, { item: 'salt' }] }],
    });
    expect(recipeToText(optional, 'en', tFor('en'))).toContain('- chili flakes · optional\n- salt');
    expect(recipeToText(optional, 'uk', tFor('uk'))).toContain('- chili flakes · за бажанням');
  });

  it('keeps the base quantities whatever servings a cook scaled to', () => {
    // The formatter has no servings input: the text is always the recipe as written.
    const text = recipeToText(recipe({ servings: 2 }), 'en', tFor('en'));
    expect(text).toContain('2 servings');
    expect(text).toContain('- 2 tbsp olive oil');
  });
});

describe('ingredientLine', () => {
  it('scales the quantity and keeps a custom unit as typed', () => {
    expect(ingredientLine({ quantity: 0.25, unit: 'pinch', item: 'salt' }, 2, 'en', tFor('en'))).toBe(
      '½ pinch salt',
    );
    expect(ingredientLine({ quantity: 1, unit: 'cup', item: 'milk' }, 1, 'ru', tFor('ru'))).toBe(
      `1 ${translate('ru', 'unit.cup')} milk`,
    );
  });

  it('shows a weight in metric, after scaling, with the original beside it', () => {
    const beef = { quantity: 1, unit: 'lb', item: 'ground beef', note: 'thawed' };
    expect(ingredientLine(beef, 1, 'en', tFor('en'), { units: 'metric', storedUnit: 'lb' })).toBe(
      '450 g (1 lb) ground beef (thawed)',
    );
    expect(ingredientLine(beef, 2, 'en', tFor('en'), { units: 'metric', storedUnit: 'lb' })).toBe(
      '900 g (2 lb) ground beef (thawed)',
    );
    expect(ingredientLine({ quantity: 3, unit: 'lb', item: 'pork' }, 1, 'uk', tFor('uk'), { units: 'metric', storedUnit: 'lb' })).toBe(
      `1,4 ${translate('uk', 'unit.kg')} (3 ${translate('uk', 'unit.lb')}) pork`,
    );
    expect(ingredientLine({ quantity: 5, unit: 'lb', item: 'flour' }, 1, 'en', tFor('en'), { units: 'metric', storedUnit: 'lb' })).toBe(
      '2.25 kg (5 lb) flour',
    );
    expect(ingredientLine({ quantity: 14, unit: 'oz', item: 'tomatoes' }, 1, 'zh-Hans', tFor('zh-Hans'), { units: 'metric', storedUnit: 'oz' })).toBe(
      `400 ${translate('zh-Hans', 'unit.g')}（14 ${translate('zh-Hans', 'unit.oz')}） tomatoes`,
    );
  });

  it('decides on the stored unit, not the translated line’s', () => {
    const translated = { quantity: 2, unit: 'фунти', item: 'яловичина' };
    expect(ingredientLine(translated, 1, 'uk', tFor('uk'), { units: 'metric', storedUnit: 'lbs' })).toBe(
      `900 ${translate('uk', 'unit.g')} (2 фунти) яловичина`,
    );
  });

  it('leaves volumes, unitless items, and the as-written setting alone', () => {
    const conversion = { units: 'metric', storedUnit: 'cup' } as const;
    expect(ingredientLine({ quantity: 1, unit: 'cup', item: 'milk' }, 1, 'en', tFor('en'), conversion)).toBe('1 cup milk');
    expect(ingredientLine({ quantity: 8, unit: 'fl oz', item: 'milk' }, 1, 'en', tFor('en'), { units: 'metric', storedUnit: 'fl oz' })).toBe(
      '8 fl oz milk',
    );
    expect(ingredientLine({ item: 'salt', unit: 'oz' }, 1, 'en', tFor('en'), { units: 'metric', storedUnit: 'oz' })).toBe('oz salt');
    expect(ingredientLine({ quantity: 1, unit: 'lb', item: 'beef' }, 1, 'en', tFor('en'), { units: 'asWritten', storedUnit: 'lb' })).toBe(
      '1 lb beef',
    );
  });
});

describe('displayTemperatures', () => {
  it('converts only when metric, through the catalog pattern', () => {
    expect(displayTemperatures('Bake at 350°F.', 'metric', tFor('en'))).toBe('Bake at 180°C (350°F).');
    expect(displayTemperatures('烤箱预热至350°F。', 'metric', tFor('zh-Hans'))).toBe('烤箱预热至180°C（350°F）。');
    expect(displayTemperatures('Bake at 350°F.', 'asWritten', tFor('en'))).toBe('Bake at 350°F.');
  });
});

describe('sourceLink', () => {
  it('accepts only http and https addresses', () => {
    expect(sourceLink('https://example.com/a')?.href).toBe('https://example.com/a');
    expect(sourceLink('http://example.com/')?.hostname).toBe('example.com');
    expect(sourceLink('ftp://example.com/')).toBeUndefined();
    expect(sourceLink('not a url')).toBeUndefined();
    expect(sourceLink(undefined)).toBeUndefined();
  });
});
