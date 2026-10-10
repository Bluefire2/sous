import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from './library.ts';
import {
  baseToDisplayQuantity,
  combineIngredients,
  normalizeItemName,
} from './ingredients.ts';

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

function lib(...recipes: AgentRecipe[]) {
  return buildAgentLibrary(recipes, [], {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('normalizeItemName', () => {
  it('lowercases, trims, collapses space, drops parentheticals', () => {
    expect(normalizeItemName('  Red Onion (diced)  ')).toBe('red onion');
  });
});

describe('baseToDisplayQuantity', () => {
  it('picks tbsp when total is at least 1 tbsp in US volume', () => {
    expect(baseToDisplayQuantity('us_volume', '', 10)).toEqual({ quantity: 3.33, unit: 'tbsp' });
  });

  it('keeps tsp when largest unit would be below 1', () => {
    expect(baseToDisplayQuantity('us_volume', '', 2)).toEqual({ quantity: 2, unit: 'tsp' });
  });
});

describe('combineIngredients', () => {
  it('scales by requested servings', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'R',
        servings: 4,
        ingredientSections: [{ items: [{ item: 'salt', quantity: 4, unit: 'tsp' }] }],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1', servings: 8 }]);
    expect(lines[0]?.quantity).toBe(2.67);
    expect(lines[0]?.unit).toBe('tbsp');
  });

  it('merges US volume within a family', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [
          {
            items: [
              { item: 'vanilla', quantity: 4, unit: 'tsp' },
              { item: 'Vanilla', quantity: 2, unit: 'tbsp' },
            ],
          },
        ],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBe(3.33);
    expect(lines[0]?.unit).toBe('tbsp');
  });

  it('does not merge across unit families', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [
          {
            items: [
              { item: 'milk', quantity: 1, unit: 'cup' },
              { item: 'milk', quantity: 100, unit: 'ml' },
            ],
          },
        ],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }]);
    expect(lines).toHaveLength(2);
  });

  it('merges count and unitless quantities', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [
          {
            items: [
              { item: 'egg', quantity: 2 },
              { item: 'egg', quantity: 1, unit: 'piece' },
            ],
          },
        ],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBe(3);
    expect(lines[0]?.unit).toBe('piece');
  });

  it('merges no-quantity lines as asNeeded', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [{ items: [{ item: 'salt' }, { item: 'Salt' }] }],
      }),
      recipe({
        id: 'r2',
        title: 'B',
        ingredientSections: [{ items: [{ item: 'salt' }] }],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }, { id: 'r2' }]);
    const salt = lines.find((l) => l.asNeeded);
    expect(salt?.sourceRecipeIds.sort()).toEqual(['r1', 'r2']);
  });

  it('keeps optional ingredients on their own lines, out of required totals', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [{ items: [{ item: 'parmesan', quantity: 200, unit: 'g' }] }],
      }),
      recipe({
        id: 'r2',
        title: 'B',
        ingredientSections: [
          {
            items: [
              { item: 'parmesan', quantity: 50, unit: 'g', optional: true },
              { item: 'basil', optional: true },
              { item: 'chili', quantity: 1, unit: 'tsp', optional: true },
            ],
          },
        ],
      }),
      recipe({
        id: 'r3',
        title: 'C',
        ingredientSections: [
          { items: [{ item: 'basil' }, { item: 'chili', quantity: 2, unit: 'tsp', optional: true }] },
        ],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    const of = (item: string) => lines.filter((l) => l.item === item);
    expect(of('parmesan')).toEqual(
      expect.arrayContaining([
        { item: 'parmesan', quantity: 200, unit: 'g', sourceRecipeIds: ['r1'] },
        { item: 'parmesan', quantity: 50, unit: 'g', optional: true, sourceRecipeIds: ['r2'] },
      ]),
    );
    expect(of('parmesan')).toHaveLength(2);
    expect(of('basil')).toHaveLength(2);
    expect(of('basil').find((l) => l.optional)?.sourceRecipeIds).toEqual(['r2']);
    expect(of('basil').find((l) => !l.optional)?.sourceRecipeIds).toEqual(['r3']);
    expect(of('chili')).toEqual([
      { item: 'chili', quantity: 1, unit: 'tbsp', optional: true, sourceRecipeIds: ['r2', 'r3'] },
    ]);
  });

  it('keeps different unknown units separate', () => {
    const library = lib(
      recipe({
        id: 'r1',
        title: 'A',
        ingredientSections: [
          {
            items: [
              { item: 'pepper', quantity: 1, unit: 'pinch' },
              { item: 'pepper', quantity: 1, unit: 'dash' },
            ],
          },
        ],
      }),
    );
    const { lines } = combineIngredients(library, [{ id: 'r1' }]);
    expect(lines).toHaveLength(2);
  });

  it('reports missing recipe ids', () => {
    const library = lib(recipe({ id: 'r1', title: 'A' }));
    const { missingIds } = combineIngredients(library, [{ id: 'missing' }]);
    expect(missingIds).toEqual(['missing']);
  });
});

describe('combineIngredients for a member who reads in metric', () => {
  const butter = (id: string, quantity: number, unit: string) =>
    recipe({ id, title: id, ingredientSections: [{ items: [{ quantity, unit, item: 'butter' }] }] });

  it('turns pounds and ounces into grams and merges them with grams', () => {
    const library = lib(butter('r1', 1, 'lb'), butter('r2', 200, 'g'), butter('r3', 4, 'oz'));
    const { lines } = combineIngredients(library, [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], { metric: true });
    // 453.6 + 200 + 113.4 = 767 g, read to the nearest 5 g.
    expect(lines).toEqual([{ item: 'butter', quantity: 765, unit: 'g', sourceRecipeIds: ['r1', 'r2', 'r3'] }]);
  });

  it('reads a converted total of a kilogram or more in kg', () => {
    const library = lib(butter('r1', 3, 'lb'));
    expect(combineIngredients(library, [{ id: 'r1' }], { metric: true }).lines[0]).toMatchObject({ quantity: 1.36, unit: 'kg' });
  });

  it('keeps pounds and grams apart, as before, when the member reads as written', () => {
    const library = lib(butter('r1', 1, 'lb'), butter('r2', 200, 'g'));
    const { lines } = combineIngredients(library, [{ id: 'r1' }, { id: 'r2' }]);
    expect(lines.map((line) => line.unit).sort()).toEqual(['g', 'lb']);
  });

  it('leaves volumes alone', () => {
    const library = lib(recipe({ id: 'r1', title: 'r1', ingredientSections: [{ items: [{ quantity: 2, unit: 'cup', item: 'milk' }] }] }));
    expect(combineIngredients(library, [{ id: 'r1' }], { metric: true }).lines[0]).toMatchObject({ quantity: 2, unit: 'cup' });
  });
});
