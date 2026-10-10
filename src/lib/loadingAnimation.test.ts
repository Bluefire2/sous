import { describe, expect, it } from 'vitest';
import { pickAnimationIndex } from './loadingAnimation';

describe('pickAnimationIndex', () => {
  it('spreads the first pick over every index', () => {
    expect(pickAnimationIndex(10, null, () => 0)).toBe(0);
    expect(pickAnimationIndex(10, null, () => 0.55)).toBe(5);
    expect(pickAnimationIndex(10, null, () => 0.9999)).toBe(9);
  });

  it('never repeats the previous pick', () => {
    for (let previous = 0; previous < 10; previous++) {
      const seen = new Set<number>();
      for (let step = 0; step < 9; step++) {
        seen.add(pickAnimationIndex(10, previous, () => step / 9));
      }
      expect(seen.has(previous)).toBe(false);
      // The other nine are all still reachable.
      expect(seen.size).toBe(9);
    }
  });

  it('stays in range when random returns 1', () => {
    expect(pickAnimationIndex(10, null, () => 1)).toBe(9);
    expect(pickAnimationIndex(10, 9, () => 1)).toBe(8);
    expect(pickAnimationIndex(10, 3, () => 1)).toBe(9);
  });

  it('ignores a previous pick that is out of range', () => {
    expect(pickAnimationIndex(10, 12, () => 0.95)).toBe(9);
    expect(pickAnimationIndex(10, -1, () => 0)).toBe(0);
  });

  it('returns the only index when there is one', () => {
    expect(pickAnimationIndex(1, 0)).toBe(0);
    expect(pickAnimationIndex(0, null)).toBe(0);
  });
});
