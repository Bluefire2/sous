import { describe, expect, it } from 'vitest';
import {
  checkImport,
  groundingCorpus,
  hasInstructionLikeContent,
  normalizeForMatch,
  pickBestAttempt,
  readRecipeJsonLd,
  type ImportCheckInput,
} from './importChecks.ts';
import { scanPage } from './pageScan.ts';
import type { ImportedRecipe } from './recipeImport.ts';

const RECIPE: ImportedRecipe = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes' }, { item: 'onion' }, { item: 'garlic' }] }],
  steps: [{ text: 'Chop.' }, { text: 'Simmer.' }],
  tags: [],
};

const CORPUS = normalizeForMatch('Tomato soup. 6 tomatoes, 1 onion, 2 cloves garlic. Chop. Simmer.');

function check(
  overrides: Partial<Omit<ImportCheckInput, 'recipe'>> & { recipe?: Partial<ImportedRecipe> } = {},
) {
  const { recipe, ...rest } = overrides;
  return checkImport({
    selfReport: {},
    sourceHasInstructions: true,
    corpus: CORPUS,
    ...rest,
    recipe: { ...RECIPE, ...recipe },
  });
}

const codes = (result: ReturnType<typeof checkImport>) => result.warnings.map((w) => w.code);

describe('checkImport structural checks', () => {
  it('raises nothing for a complete, grounded recipe', () => {
    expect(check()).toEqual({ warnings: [], failureClass: 'none' });
  });

  it('flags a single step as advisory', () => {
    expect(check({ recipe: { steps: [{ text: 'Simmer.' }] } })).toEqual({
      warnings: [{ code: 'TOO_FEW_STEPS' }],
      failureClass: 'none',
    });
  });

  it('flags missing ingredients as blocking extraction unless the page has none either', () => {
    expect(check({ recipe: { ingredientSections: [] } })).toEqual({
      warnings: [{ code: 'MISSING_INGREDIENTS' }],
      failureClass: 'extraction',
    });
    expect(
      check({ recipe: { ingredientSections: [] }, selfReport: { ingredientsOnPage: false } })
        .failureClass,
    ).toBe('source');
    // JSON-LD lists ingredients, so the model's "none on the page" is wrong.
    expect(
      check({
        recipe: { ingredientSections: [] },
        selfReport: { ingredientsOnPage: false },
        jsonLd: { ingredientCount: 5 },
      }).failureClass,
    ).toBe('extraction');
  });

  it('flags a blank title and blank items the model returned', () => {
    expect(codes(check({ recipe: { title: ' ' }, blankItems: 2 }))).toEqual([
      'MISSING_TITLE',
      'EMPTY_ITEMS',
    ]);
  });
});

describe('checkImport empty steps', () => {
  const empty = { recipe: { steps: [] } };

  it('is a source failure only when the page has no method and the model agrees', () => {
    expect(
      check({ ...empty, sourceHasInstructions: false, selfReport: { instructionsOnPage: false } }),
    ).toEqual({ warnings: [{ code: 'INSTRUCTIONS_NOT_ON_PAGE' }], failureClass: 'source' });
  });

  it('is a dropped method when the page has one, whatever the model says', () => {
    for (const instructionsOnPage of [true, false, undefined]) {
      expect(check({ ...empty, selfReport: { instructionsOnPage } })).toEqual({
        warnings: [{ code: 'INSTRUCTIONS_DROPPED' }],
        failureClass: 'extraction',
      });
    }
  });

  it('is only missing, and retryable, when the signals disagree', () => {
    for (const instructionsOnPage of [true, undefined]) {
      expect(
        check({ ...empty, sourceHasInstructions: false, selfReport: { instructionsOnPage } }),
      ).toEqual({ warnings: [{ code: 'MISSING_INSTRUCTIONS' }], failureClass: 'extraction' });
    }
  });

  it('classes as extraction when any blocking warning could be the model', () => {
    const result = check({
      recipe: { steps: [], ingredientSections: [] },
      sourceHasInstructions: false,
      selfReport: { instructionsOnPage: false },
    });
    expect(codes(result)).toEqual(['INSTRUCTIONS_NOT_ON_PAGE', 'MISSING_INGREDIENTS']);
    expect(result.failureClass).toBe('extraction');
  });

  it('does not also raise a step count mismatch', () => {
    expect(codes(check({ ...empty, jsonLd: { stepCount: 6 } }))).toEqual(['INSTRUCTIONS_DROPPED']);
  });
});

describe('checkImport count cross-checks', () => {
  it('flags ingredients only below the JSON-LD count less max(2, 20%)', () => {
    // 3 extracted: 5 - 2 = 3 is not fewer; 6 - 2 = 4 is.
    expect(codes(check({ jsonLd: { ingredientCount: 5 } }))).toEqual([]);
    expect(codes(check({ jsonLd: { ingredientCount: 6 } }))).toEqual(['INGREDIENT_COUNT_MISMATCH']);
    // 20 listed: slack is 4, so 16 pass and 15 flag.
    const items = (n: number) => [{ items: Array.from({ length: n }, () => ({ item: 'tomatoes' })) }];
    expect(codes(check({ recipe: { ingredientSections: items(16) }, jsonLd: { ingredientCount: 20 } })))
      .toEqual([]);
    expect(codes(check({ recipe: { ingredientSections: items(15) }, jsonLd: { ingredientCount: 20 } })))
      .toEqual(['INGREDIENT_COUNT_MISMATCH']);
  });

  it('never flags more ingredients or steps than the JSON-LD', () => {
    expect(codes(check({ jsonLd: { ingredientCount: 1, stepCount: 1 } }))).toEqual([]);
  });

  it('flags steps only below half the JSON-LD count', () => {
    expect(codes(check({ jsonLd: { stepCount: 4 } }))).toEqual([]);
    expect(codes(check({ jsonLd: { stepCount: 5 } }))).toEqual(['STEP_COUNT_MISMATCH']);
  });

  it('skips the counts without JSON-LD', () => {
    expect(codes(check({ jsonLd: null }))).toEqual([]);
    expect(codes(check({ jsonLd: {} }))).toEqual([]);
  });
});

describe('checkImport grounding', () => {
  const sections = (...names: string[]) => [{ items: names.map((item) => ({ item })) }];

  it('reports an ingredient the page never names, by position', () => {
    const result = check({
      recipe: { ingredientSections: [...sections('tomatoes', 'onion'), ...sections('garlic', 'saffron')] },
    });
    expect(result).toEqual({
      warnings: [{ code: 'UNGROUNDED_INGREDIENT', at: [1, 1] }],
      failureClass: 'none',
    });
  });

  it('ignores quantities, units, stopwords and plurals', () => {
    const corpus = normalizeForMatch('Ingredients: 2 tomato, a red onion, cloves of garlic');
    expect(
      codes(check({ corpus, recipe: { ingredientSections: sections('3 cups chopped fresh tomatoes', 'onions', 'garlic cloves') } })),
    ).toEqual([]);
  });

  describe('irregular English plurals', () => {
    const pairs: [string, string][] = [
      ['strawberries', 'strawberry'],
      ['bay leaves', 'bay leaf'],
      ['halves', 'half'],
      ['loaves', 'loaf'],
      ['knives', 'knife'],
    ];
    // Two grounded fillers keep the "more than half ungrounded" skip from hiding a failure.
    const grounded = (item: string, page: string) =>
      check({
        corpus: normalizeForMatch(`${page}, flour, butter, sugar`),
        recipe: { ingredientSections: sections(item, 'flour', 'butter', 'sugar') },
      });

    for (const [plural, singular] of pairs) {
      it(`grounds ${plural} on a page that says ${singular}`, () => {
        expect(codes(grounded(plural, `2 ${singular}`))).toEqual([]);
      });
      it(`grounds ${singular} on a page that says ${plural}`, () => {
        expect(codes(grounded(singular, `2 ${plural}`))).toEqual([]);
      });
    }

    it('still reports an ingredient the page never names', () => {
      expect(grounded('saffron', '2 strawberries and bay leaf').warnings).toEqual([
        { code: 'UNGROUNDED_INGREDIENT', at: [0, 0] },
      ]);
    });
  });

  it('matches across diacritics both ways', () => {
    const corpus = normalizeForMatch('Ajouter la crème fraîche et le jalapeno');
    expect(
      codes(check({ corpus, recipe: { ingredientSections: sections('creme fraiche', 'jalapeño') } })),
    ).toEqual([]);
  });

  it('matches CJK by substring, without word boundaries', () => {
    const corpus = normalizeForMatch('材料：豆腐一块，牛肉末100克，郫县豆瓣酱一勺。做法：……');
    expect(
      codes(check({ corpus, recipe: { ingredientSections: sections('豆腐', '牛肉末', '豆瓣酱') } })),
    ).toEqual([]);
    expect(
      check({ corpus, recipe: { ingredientSections: sections('豆腐', '牛肉末', '豆瓣酱', '藏红花') } })
        .warnings,
    ).toEqual([{ code: 'UNGROUNDED_INGREDIENT', at: [0, 3] }]);
  });

  it('tolerates Cyrillic case endings', () => {
    const corpus = normalizeForMatch('Мука — 200 г, картофель 3 шт.');
    expect(
      codes(check({ corpus, recipe: { ingredientSections: sections('муки', 'картофеля', 'мука') } })),
    ).toEqual([]);
  });

  it('reports at most three', () => {
    const many = sections('tomatoes', 'onion', 'garlic', 'stock', 'salt', 'saffron', 'truffle', 'caviar', 'gold');
    const corpus = normalizeForMatch('tomatoes onion garlic stock salt');
    const result = check({ corpus, recipe: { ingredientSections: many } });
    expect(result.warnings).toEqual([
      { code: 'UNGROUNDED_INGREDIENT', at: [0, 5] },
      { code: 'UNGROUNDED_INGREDIENT', at: [0, 6] },
      { code: 'UNGROUNDED_INGREDIENT', at: [0, 7] },
    ]);
  });

  it('skips entirely when more than half look ungrounded, or there is no corpus', () => {
    const corpus = normalizeForMatch('tomatoes');
    expect(codes(check({ corpus, recipe: { ingredientSections: sections('tomatoes', 'saffron', 'truffle') } })))
      .toEqual([]);
    expect(codes(check({ corpus: '', recipe: { ingredientSections: sections('saffron') } }))).toEqual([]);
  });

  it('cannot judge an item made only of units and stopwords', () => {
    expect(codes(check({ recipe: { ingredientSections: sections('tomatoes', 'onion', 'garlic', 'to taste') } })))
      .toEqual([]);
  });
});

describe('readRecipeJsonLd', () => {
  const ld = (node: object) =>
    scanPage(`<script type="application/ld+json">${JSON.stringify(node)}</script>`);

  it('counts ingredients and steps, flattening sections', () => {
    const jsonLd = readRecipeJsonLd(
      ld({
        '@type': 'Recipe',
        name: 'Pie',
        recipeIngredient: ['flour', ' ', 'butter'],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: 'Crust',
            itemListElement: [
              { '@type': 'HowToStep', text: 'Rub.' },
              { '@type': 'HowToStep', text: 'Chill.' },
            ],
          },
          { '@type': 'HowToStep', text: 'Bake.' },
          'Cool.',
        ],
      }),
    );
    expect(jsonLd).toMatchObject({ ingredientCount: 2, stepCount: 4, hasInstructions: true });
    expect(jsonLd?.text).toContain('butter');
  });

  it('leaves a count out when the list is absent or one block of text', () => {
    const jsonLd = readRecipeJsonLd(
      ld({ '@type': 'Recipe', name: 'Pie', recipeInstructions: 'Mix. Bake. Cool.' }),
    );
    expect(jsonLd).not.toHaveProperty('ingredientCount');
    expect(jsonLd).not.toHaveProperty('stepCount');
    expect(jsonLd?.hasInstructions).toBe(true);
  });

  it('is null without a Recipe node', () => {
    expect(readRecipeJsonLd(scanPage('<p>Soup</p>'))).toBeNull();
  });
});

describe('hasInstructionLikeContent', () => {
  const page = (body: string) => ({ scan: scanPage(`<html><body>${body}</body></html>`) });

  it('finds an ordered list of two or more in the primary region', () => {
    expect(hasInstructionLikeContent(page('<main><ol><li>Chop</li><li>Simmer</li></ol></main>'))).toBe(true);
    expect(hasInstructionLikeContent(page('<main><ol><li>Chop</li></ol></main>'))).toBe(false);
    // A related-posts list outside the article does not count.
    expect(
      hasInstructionLikeContent(
        page(`<article>${'<p>Story text.</p>'.repeat(20)}</article><aside><ol><li>a</li><li>b</li></ol></aside>`),
      ),
    ).toBe(false);
  });

  it('finds a method heading in several languages', () => {
    for (const heading of ['Instructions', 'Method:', 'How to make it', 'Приготовление', 'Спосіб приготування', '做法', 'Préparation', 'Zubereitung']) {
      expect(hasInstructionLikeContent(page(`<h2>${heading}</h2><p>…</p>`)), heading).toBe(true);
    }
    expect(hasInstructionLikeContent(page('<h2>Ingredients</h2><p>flour</p>'))).toBe(false);
  });

  it('finds a block marked as instructions, but not an empty placeholder', () => {
    const steps = 'Chop the onion and soften it in butter for ten minutes.';
    expect(hasInstructionLikeContent(page(`<div class="wprm-recipe-instructions">${steps}</div>`))).toBe(true);
    expect(hasInstructionLikeContent(page('<div class="recipe-instructions"></div><p>Loading…</p>'))).toBe(false);
  });

  it('finds "Step 1" and inline numbered steps', () => {
    expect(hasInstructionLikeContent(page('<p>Step 1: chop. Step 2: fry.</p>'))).toBe(true);
    expect(hasInstructionLikeContent(page('<p>1. Chop the onion. 2. Fry it.</p>'))).toBe(true);
    expect(hasInstructionLikeContent(page('<p>Serves 1. Lovely.</p>'))).toBe(false);
  });

  it('trusts JSON-LD instructions', () => {
    expect(hasInstructionLikeContent({ ...page('<p>Video only</p>'), jsonLd: { node: {}, hasInstructions: true, text: '' } }))
      .toBe(true);
  });

  it('reads pasted text by line', () => {
    expect(hasInstructionLikeContent({ text: 'Soup\nDirections\nBoil it.' })).toBe(true);
    expect(hasInstructionLikeContent({ text: 'Soup\n1) Boil\n2) Serve' })).toBe(true);
    expect(hasInstructionLikeContent({ text: 'Soup\n6 tomatoes\n1 onion' })).toBe(false);
  });
});

describe('groundingCorpus', () => {
  it('holds the whole page text plus the JSON-LD, which stripping would drop', () => {
    const scan = scanPage(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Recipe',
        recipeIngredient: ['saffron &amp; salt'],
      })}</script><nav>Menu</nav><main><p>Crème brûlée</p></main>`,
    );
    const corpus = groundingCorpus({ scan, jsonLd: readRecipeJsonLd(scan) });
    expect(corpus).toContain('saffron & salt');
    expect(corpus).toContain('menu');
    expect(corpus).toContain('creme brulee');
  });
});

describe('pickBestAttempt', () => {
  const attempt = (steps: number, blocking: number, advisory = 0) => ({
    recipe: { steps: Array.from({ length: steps }, () => ({ text: 's' })) },
    warnings: [
      ...Array.from({ length: blocking }, () => ({ code: 'MISSING_INGREDIENTS' as const })),
      ...Array.from({ length: advisory }, () => ({ code: 'TOO_FEW_STEPS' as const })),
    ],
  });

  it('prefers fewer blocking warnings, then more steps, then the earliest', () => {
    const a = attempt(5, 1);
    const b = attempt(1, 0, 3);
    expect(pickBestAttempt([a, b])).toBe(b);
    const c = attempt(2, 1);
    const d = attempt(3, 1);
    expect(pickBestAttempt([c, d])).toBe(d);
    const e = attempt(3, 1);
    expect(pickBestAttempt([d, e])).toBe(d);
  });
});
