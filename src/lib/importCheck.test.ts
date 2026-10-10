import { describe, expect, it } from 'vitest';
import { reconcileImportCheck, showsImportWarnings, type ImportCheck } from './importCheck';
import type { Recipe } from './types';

const BEFORE: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }, { item: 'saffron' }] }],
  steps: [],
  tags: [],
};

const CHECK: ImportCheck = {
  at: 1,
  warnings: [
    { code: 'INSTRUCTIONS_NOT_ON_PAGE' },
    { code: 'INGREDIENT_COUNT_MISMATCH' },
    { code: 'UNGROUNDED_INGREDIENT', at: [0, 1] },
  ],
};

describe('reconcileImportCheck', () => {
  it('returns the same record when no content changed', () => {
    const retagged: Recipe = { ...BEFORE, tags: ['new'], photoId: 'p1' };
    expect(reconcileImportCheck(CHECK, BEFORE, retagged, 9)).toBe(CHECK);
    expect(reconcileImportCheck(undefined, BEFORE, { ...BEFORE, title: 'x' }, 9)).toBeUndefined();
  });

  it('does not read key order or undefined fields as an edit', () => {
    const reordered: Recipe = {
      ...BEFORE,
      description: undefined,
      ingredientSections: [{ items: [{ quantity: 6, item: 'tomatoes' }, { item: 'saffron', note: undefined }] }],
    };
    expect(reconcileImportCheck(CHECK, BEFORE, reordered, 9)).toBe(CHECK);
  });

  it('a dismissal is not an edit', () => {
    const dismissed = { ...CHECK, dismissedAt: 5 };
    expect(reconcileImportCheck(dismissed, BEFORE, BEFORE, 9)).toBe(dismissed);
  });

  it('sets editedAt once and keeps dismissedAt', () => {
    const first = reconcileImportCheck({ ...CHECK, dismissedAt: 5 }, BEFORE, { ...BEFORE, notes: 'n' }, 9);
    expect(first).toMatchObject({ editedAt: 9, dismissedAt: 5 });
    const second = reconcileImportCheck(first, { ...BEFORE, notes: 'n' }, { ...BEFORE, notes: 'm' }, 12);
    expect(second?.editedAt).toBe(9);
  });

  it('drops a missing-steps warning once steps exist, keeping the rest', () => {
    const next = reconcileImportCheck(CHECK, BEFORE, { ...BEFORE, steps: [{ text: 'Simmer.' }] }, 9);
    expect(next?.warnings).toEqual([
      { code: 'INGREDIENT_COUNT_MISMATCH' },
      { code: 'UNGROUNDED_INGREDIENT', at: [0, 1] },
    ]);
  });

  it('drops position warnings and a satisfied count when the ingredients change', () => {
    const more: Recipe = {
      ...BEFORE,
      ingredientSections: [{ items: [...BEFORE.ingredientSections[0].items, { item: 'onion' }] }],
    };
    expect(reconcileImportCheck(CHECK, BEFORE, more, 9)?.warnings).toEqual([
      { code: 'INSTRUCTIONS_NOT_ON_PAGE' },
    ]);
  });

  it('keeps an emptied record so the fix still counts as an edit', () => {
    const fixed: Recipe = {
      ...BEFORE,
      steps: [{ text: 'a' }, { text: 'b' }],
      ingredientSections: [{ items: [{ item: 'tomatoes' }, { item: 'onion' }, { item: 'basil' }] }],
    };
    expect(reconcileImportCheck(CHECK, BEFORE, fixed, 9)).toEqual({ at: 1, warnings: [], editedAt: 9 });
  });

  it('drops TOO_FEW_STEPS only at the minimum', () => {
    const check: ImportCheck = { at: 1, warnings: [{ code: 'TOO_FEW_STEPS' }] };
    const one = { ...BEFORE, steps: [{ text: 'a' }] };
    expect(reconcileImportCheck(check, one, { ...one, title: 'x' }, 9)?.warnings).toEqual(check.warnings);
    expect(reconcileImportCheck(check, one, { ...one, steps: [{ text: 'a' }, { text: 'b' }] }, 9)?.warnings)
      .toEqual([]);
  });
});

describe('showsImportWarnings', () => {
  it('shows to an editor while warnings remain and none were dismissed', () => {
    expect(showsImportWarnings(CHECK, true)).toBe(true);
    expect(showsImportWarnings(CHECK, false)).toBe(false);
    expect(showsImportWarnings({ ...CHECK, dismissedAt: 2 }, true)).toBe(false);
    expect(showsImportWarnings({ at: 1, warnings: [] }, true)).toBe(false);
    expect(showsImportWarnings(undefined, true)).toBe(false);
  });
});
