import { describe, expect, it } from 'vitest';
import { pickRandom } from './randomRecipe';

describe('pickRandom', () => {
  it('maps the random number onto the ids', () => {
    expect(pickRandom(['a', 'b', 'c'], undefined, () => 0)).toBe('a');
    expect(pickRandom(['a', 'b', 'c'], undefined, () => 0.99)).toBe('c');
  });

  it('never repeats the previous pick', () => {
    for (const r of [0, 0.5, 0.99]) {
      expect(pickRandom(['a', 'b'], 'a', () => r)).toBe('b');
    }
  });

  it('repeats the only id', () => {
    expect(pickRandom(['a'], 'a')).toBe('a');
  });
});
