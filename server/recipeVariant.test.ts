import { describe, expect, it } from 'vitest';
import { compactVariantOf } from './recipeVariant.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ORIGINAL = '22222222-2222-4222-8222-222222222222';

describe('compactVariantOf', () => {
  it.each([
    ['a recipe id', ORIGINAL, ORIGINAL],
    ['a backup clone id (UUIDv8)', '33333333-3333-8333-8333-333333333333', '33333333-3333-8333-8333-333333333333'],
    ['not a UUID', 'original', undefined],
    ['the recipe itself', ID, undefined],
    ['a number', 42, undefined],
    ['missing', undefined, undefined],
  ])('%s', (_label, value, expected) => {
    expect(compactVariantOf(value, ID)).toBe(expected);
  });
});
