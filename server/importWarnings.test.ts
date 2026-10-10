import { describe, expect, it } from 'vitest';
import {
  compactImportCheck,
  IMPORT_WARNING_CODES,
  MAX_IMPORT_WARNINGS,
  reconcileImportCheck,
} from './importWarnings.ts';

describe('compactImportCheck', () => {
  it('has the ten codes from the spec', () => {
    expect(IMPORT_WARNING_CODES).toHaveLength(10);
  });

  it('keeps a well-formed record and drops unknown keys', () => {
    expect(
      compactImportCheck({
        at: 1,
        warnings: [{ code: 'UNGROUNDED_INGREDIENT', at: [0, 2], extra: true }, { code: 'TOO_FEW_STEPS' }],
        dismissedAt: 2,
        editedAt: 3,
        name: 'saffron',
      }),
    ).toEqual({
      at: 1,
      warnings: [{ code: 'UNGROUNDED_INGREDIENT', at: [0, 2] }, { code: 'TOO_FEW_STEPS' }],
      dismissedAt: 2,
      editedAt: 3,
    });
  });

  it('drops a warning with an unknown code or a bad position, keeping the rest', () => {
    expect(
      compactImportCheck({
        at: 1,
        warnings: [
          { code: 'FROM_THE_FUTURE' },
          { code: 'UNGROUNDED_INGREDIENT', at: [0.5, 1] },
          { code: 'UNGROUNDED_INGREDIENT', at: [-1, 1] },
          { code: 'UNGROUNDED_INGREDIENT', at: [1] },
          { code: 'MISSING_INGREDIENTS' },
        ],
      }),
    ).toEqual({ at: 1, warnings: [{ code: 'MISSING_INGREDIENTS' }] });
  });

  it('drops a malformed record', () => {
    const tooMany = Array.from({ length: MAX_IMPORT_WARNINGS + 1 }, () => ({ code: 'EMPTY_ITEMS' }));
    for (const raw of [
      undefined,
      null,
      'x',
      [],
      { warnings: [] },
      { at: Number.NaN, warnings: [] },
      { at: 1 },
      { at: 1, warnings: tooMany },
      { at: 1, warnings: [], dismissedAt: 'yes' },
      { at: 1, warnings: [], editedAt: Infinity },
    ]) {
      expect(compactImportCheck(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

describe('reconcileImportCheck (server copy)', () => {
  // The client suite (src/lib/importCheck.test.ts) covers each warning code
  // through the re-export; this pins that a stored document shape fits too.
  it('reconciles a stored recipe document the way recipeStore.save does', () => {
    const stored = {
      id: 'r1',
      title: 'Soup',
      servings: 2,
      ingredientSections: [{ items: [{ item: 'tomatoes' }] }],
      steps: [],
      tags: [],
      serverUpdatedAt: 5,
    };
    const check = { at: 1, warnings: [{ code: 'MISSING_INSTRUCTIONS' as const }] };
    const retagged = { ...stored, tags: ['x'] };
    expect(reconcileImportCheck(check, stored, retagged, 9)).toBe(check);
    expect(reconcileImportCheck(check, stored, { ...stored, steps: [{ text: 'Simmer.' }] }, 9)).toEqual({
      at: 1,
      warnings: [],
      editedAt: 9,
    });
  });
});
