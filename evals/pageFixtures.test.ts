import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkImport } from '../server/importChecks.ts';
import {
  extractRecipeSource,
  htmlCheckContext,
  normalizeImportedRecipe,
  type ImportedRecipe,
} from '../server/recipeImport.ts';

// Offline companion to recipeImport.eval.ts: runs the deterministic
// extraction step (no Gemini) over every cached page. Only the website page
// fixtures; import-handwritten/ is out of scope here (see evals/AGENTS.md).

const evalsRoot = dirname(fileURLToPath(import.meta.url));
const PAGE_DIRS = ['import', 'import-sites'] as const;
const MAX_SOURCE_CHARS = 60_000;

type Expected = { path: 'jsonld' } | { path: 'text'; mustContain: string[] };

/**
 * Which branch of extractRecipeSource each page takes. `jsonld` means the
 * function returned a whole Recipe object that parses. A page that moves
 * between that branch and stripped text is a behaviour change worth a look,
 * so update this map deliberately. A new page fixture needs an entry.
 */
const EXPECTED: Record<string, Expected> = {
  'import/beef-noodle-soup': { path: 'jsonld' },
  'import/beef-stew': { path: 'jsonld' },
  'import/gumbo': { path: 'jsonld' },
  'import-sites/atk-chicken-noodle-soup': { path: 'jsonld' },
  'import-sites/bbcgoodfood-bolognese': { path: 'jsonld' },
  'import-sites/cookpad-bbq-chicken': { path: 'jsonld' },
  'import-sites/delish-marry-me-chicken': { path: 'jsonld' },
  // Over MAX_SOURCE_CHARS with its 150 reviews; the extractor drops them.
  'import-sites/foodcom-banana-bread': { path: 'jsonld' },
  'import-sites/giallozafferano-carbonara': { path: 'jsonld' },
  'import-sites/hebbarskitchen-paneer-butter-masala': { path: 'jsonld' },
  'import-sites/indianhealthyrecipes-chicken-biryani': { path: 'jsonld' },
  'import-sites/justonecookbook-okonomiyaki': { path: 'jsonld' },
  'import-sites/kingarthur-sandwich-bread': { path: 'jsonld' },
  // `<script type=application/ld+json>`, with the type attribute unquoted.
  'import-sites/loveandlemons-guacamole': { path: 'jsonld' },
  'import-sites/marmiton-boeuf-bourguignon': { path: 'jsonld' },
  'import-sites/natashaskitchen-borscht': { path: 'jsonld' },
  'import-sites/nytcooking-chocolate-chip-cookies': { path: 'jsonld' },
  'import-sites/ottolenghi-shakshuka': { path: 'jsonld' },
  'import-sites/patijinich-chicken-tinga': { path: 'jsonld' },
  'import-sites/recipetineats-chicken-chow-mein': { path: 'jsonld' },
  'import-sites/seriouseats-chocolate-chip-cookies': { path: 'jsonld' },
  'import-sites/spendwithpennies-beef-stew': { path: 'jsonld' },
  'import-sites/tasty-garlic-parmesan-pasta': { path: 'jsonld' },
  'import-sites/wikibooks-pancake': { path: 'text', mustContain: ['flour', 'egg'] },
  'import-sites/woksoflife-ma-po-tofu': { path: 'jsonld' },
};

function pageFixtures(): string[] {
  const found: string[] = [];
  for (const dir of PAGE_DIRS) {
    for (const name of readdirSync(join(evalsRoot, dir))) {
      if (existsSync(join(evalsRoot, dir, name, 'page.html'))) {
        found.push(`${dir}/${name}`);
      }
    }
  }
  return found.sort();
}

function parsedRecipeNode(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRecipeType(type: unknown): boolean {
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

describe('extractRecipeSource over cached page fixtures', () => {
  it('every page fixture has an expected entry, and every entry has a page', () => {
    expect(pageFixtures()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    it(`${fixture} extracts via ${expected.path}`, () => {
      const html = readFileSync(join(evalsRoot, fixture, 'page.html'), 'utf8');
      const source = extractRecipeSource(html);

      expect(source.trim()).not.toBe('');
      expect(source.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);

      const node = parsedRecipeNode(source);
      if (expected.path === 'jsonld') {
        expect(node, 'JSON-LD source should be a whole Recipe object').not.toBeNull();
        expect(isRecipeType(node?.['@type'])).toBe(true);
        expect(typeof node?.name).toBe('string');
        expect(node).toHaveProperty('recipeIngredient');
        expect(node).toHaveProperty('recipeInstructions');
      } else {
        expect(node).toBeNull();
        expect(source).not.toMatch(/<script|<style/i);
        const lower = source.toLowerCase();
        for (const word of expected.mustContain) {
          expect(lower).toContain(word);
        }
      }
    });
  }
});

// Offline calibration of the import checks (docs/plans/import-reliability.md,
// Verification). A false warning costs more trust than a missed one, so every
// cached page that has a recipe must raise no source warning, and each page
// golden checked against its own page must raise nothing at all.

type PageClass = { class: 'source' | 'extraction' | 'ok'; why: string };

function pageClass(fixture: string): PageClass | null {
  const path = join(evalsRoot, fixture, 'class.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PageClass) : null;
}

const EMPTY_STEPS: ImportedRecipe = {
  title: 'Recipe',
  servings: 1,
  ingredientSections: [],
  steps: [],
  tags: [],
};

describe('import checks over cached page fixtures', () => {
  for (const fixture of Object.keys(EXPECTED)) {
    const expectedClass = pageClass(fixture)?.class ?? 'ok';
    it(`${fixture} (${expectedClass}) ${expectedClass === 'source' ? 'raises' : 'raises no'} source warning for empty steps`, () => {
      const context = htmlCheckContext(readFileSync(join(evalsRoot, fixture, 'page.html'), 'utf8'));
      const result = checkImport({
        recipe: EMPTY_STEPS,
        selfReport: { instructionsOnPage: false, ingredientsOnPage: false },
        jsonLd: context.jsonLd,
        sourceHasInstructions: context.sourceHasInstructions,
        corpus: context.corpus,
      });
      const codes = result.warnings.map((w) => w.code);
      if (expectedClass === 'source') {
        expect(codes).toContain('INSTRUCTIONS_NOT_ON_PAGE');
      } else {
        expect(codes).not.toContain('INSTRUCTIONS_NOT_ON_PAGE');
      }
    });
  }

  for (const fixture of Object.keys(EXPECTED)) {
    const goldenPath = join(evalsRoot, fixture, 'golden.json');
    if (!existsSync(goldenPath)) continue;
    it(`${fixture} golden raises no warnings against its own page`, () => {
      const golden = normalizeImportedRecipe(JSON.parse(readFileSync(goldenPath, 'utf8')));
      expect(golden).not.toBeNull();
      const context = htmlCheckContext(readFileSync(join(evalsRoot, fixture, 'page.html'), 'utf8'));
      const result = checkImport({
        recipe: golden as ImportedRecipe,
        selfReport: { instructionsOnPage: true, ingredientsOnPage: true },
        jsonLd: context.jsonLd,
        sourceHasInstructions: context.sourceHasInstructions,
        corpus: context.corpus,
      });
      expect(result.warnings).toEqual([]);
    });
  }
});
