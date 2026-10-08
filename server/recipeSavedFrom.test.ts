import { describe, expect, it } from 'vitest';
import { compactSavedFrom, MAX_SAVED_FROM_NAME_CHARS, savedFromName } from './recipeSavedFrom.ts';

describe('compactSavedFrom', () => {
  it('keeps a name and a time', () => {
    expect(compactSavedFrom({ name: ' Ada ', savedAt: 5 })).toEqual({ name: 'Ada', savedAt: 5 });
  });

  it('keeps a time without a name', () => {
    expect(compactSavedFrom({ savedAt: 5 })).toEqual({ savedAt: 5 });
    expect(compactSavedFrom({ name: '   ', savedAt: 5 })).toEqual({ savedAt: 5 });
    expect(compactSavedFrom({ name: 7, savedAt: 5 })).toEqual({ savedAt: 5 });
  });

  it('drops unknown keys', () => {
    expect(compactSavedFrom({ savedAt: 5, ownerSub: 'x' })).toEqual({ savedAt: 5 });
  });

  it('drops malformed values', () => {
    for (const raw of [
      undefined,
      null,
      'x',
      [],
      {},
      { savedAt: 0 },
      { savedAt: -1 },
      { savedAt: Number.NaN },
      { savedAt: '5' },
    ]) {
      expect(compactSavedFrom(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

describe('savedFromName', () => {
  it('caps long names', () => {
    const long = 'a'.repeat(MAX_SAVED_FROM_NAME_CHARS + 20);
    expect(savedFromName(long)).toHaveLength(MAX_SAVED_FROM_NAME_CHARS);
  });
});
