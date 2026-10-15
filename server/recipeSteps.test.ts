import { describe, expect, it } from 'vitest';
import { MAX_LANES, MAX_LANE_CHARS, compactLane, compactSteps } from './recipeSteps.ts';

describe('compactLane', () => {
  it('trims and keeps a label of 1 to MAX_LANE_CHARS characters', () => {
    expect(compactLane('  Sauce ')).toBe('Sauce');
    expect(compactLane('x'.repeat(MAX_LANE_CHARS))).toBe('x'.repeat(MAX_LANE_CHARS));
  });

  it('puts a label on one line', () => {
    expect(compactLane('Sauce\n and\tgarnish')).toBe('Sauce and garnish');
  });

  it('drops a blank, too long, or non-string label', () => {
    expect(compactLane('   ')).toBeUndefined();
    expect(compactLane('x'.repeat(MAX_LANE_CHARS + 1))).toBeUndefined();
    expect(compactLane(3)).toBeUndefined();
    expect(compactLane(null)).toBeUndefined();
  });
});

describe('compactSteps', () => {
  it('keeps the first MAX_LANES lanes and makes steps in later ones shared', () => {
    expect(MAX_LANES).toBe(3);
    expect(
      compactSteps([
        { text: 'a', lane: 'A' },
        { text: 'b', lane: 'B' },
        { text: 'c', lane: 'C' },
        { text: 'd', lane: 'D' },
        { text: 'e', lane: 'A' },
      ]),
    ).toEqual([
      { text: 'a', lane: 'A' },
      { text: 'b', lane: 'B' },
      { text: 'c', lane: 'C' },
      { text: 'd' },
      { text: 'e', lane: 'A' },
    ]);
  });

  it('keeps text and a valid lane, and nothing else', () => {
    expect(
      compactSteps([
        { text: 'Boil water' },
        { text: 'Fry garlic', lane: ' Sauce ', foo: 1 },
        { text: 'Toss', lane: '' },
      ]),
    ).toEqual([{ text: 'Boil water' }, { text: 'Fry garlic', lane: 'Sauce' }, { text: 'Toss' }]);
  });

  it('drops entries that are not objects with string text', () => {
    expect(compactSteps([null, 'text', { text: 3 }, [{ text: 'a' }], { text: 'ok' }])).toEqual([
      { text: 'ok' },
    ]);
  });

  it('gives an empty list for a non-array', () => {
    expect(compactSteps(undefined)).toEqual([]);
    expect(compactSteps({ text: 'a' })).toEqual([]);
  });

  it('keeps text exactly as stored', () => {
    expect(compactSteps([{ text: '  spaced  ' }])).toEqual([{ text: '  spaced  ' }]);
  });
});
