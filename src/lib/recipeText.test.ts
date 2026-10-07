import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '../i18n';
import { ingredientLine, recipeToText, sourceLink, type Translate } from './recipeText';
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

describe('recipeToText with lanes (docs/plans/parallel-steps.md)', () => {
  it('heads a block of parallel steps and prefixes each with its lane', () => {
    const text = recipeToText(
      recipe({
        steps: [
          { text: 'Boil water.' },
          { text: 'Fry garlic.', lane: 'Sauce' },
          { text: 'Cook pasta.', lane: 'Pasta' },
          { text: 'Toss.' },
        ],
        notes: undefined,
        sourceUrl: undefined,
      }),
      'en',
      tFor('en'),
    );
    expect(text.endsWith(
      ['Steps', '1. Boil water.', 'At the same time', '2. [Sauce] Fry garlic.', '3. [Pasta] Cook pasta.', '4. Toss.'].join('\n'),
    )).toBe(true);
  });
});

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
