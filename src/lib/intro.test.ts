import { afterEach, describe, expect, it } from 'vitest';
import {
  arrivedWithoutOwnRecipe,
  noteLibraryOnArrival,
  resetIntroArrivalForTests,
  shouldAskAboutIntro,
} from './intro';

const ready = {
  sessionStatus: 'signedIn' as const,
  fullPull: true,
  hasOwnRecipe: false,
  sheetClosed: true,
};

describe('shouldAskAboutIntro', () => {
  it('asks for a fully pulled, signed-in library with no recipe of the member’s own', () => {
    expect(shouldAskAboutIntro(ready)).toBe(true);
  });

  it('does not ask when the member has a recipe of their own, or while loading', () => {
    expect(shouldAskAboutIntro({ ...ready, hasOwnRecipe: true })).toBe(false);
    expect(shouldAskAboutIntro({ ...ready, hasOwnRecipe: undefined })).toBe(false);
  });

  it('does not ask until a full pull is on screen', () => {
    // A cleared library (sign-out, expired session) or an owned-only publish.
    expect(shouldAskAboutIntro({ ...ready, fullPull: false })).toBe(false);
  });

  it('does not ask unless signed in', () => {
    for (const sessionStatus of ['loading', 'signedOut', 'offline'] as const) {
      expect(shouldAskAboutIntro({ ...ready, sessionStatus })).toBe(false);
    }
  });

  it('waits while another sheet is open', () => {
    expect(shouldAskAboutIntro({ ...ready, sheetClosed: false })).toBe(false);
  });
});

describe('library on arrival', () => {
  afterEach(() => {
    resetIntroArrivalForTests();
  });

  it('keeps an empty arrival while the library stays empty', () => {
    noteLibraryOnArrival('a', false);
    noteLibraryOnArrival('a', false);
    expect(arrivedWithoutOwnRecipe('a')).toBe(true);
  });

  it('deleting the last recipe later does not make an arrival empty', () => {
    noteLibraryOnArrival('b', true);
    noteLibraryOnArrival('b', false);
    expect(arrivedWithoutOwnRecipe('b')).toBe(false);
  });

  it('an empty arrival ends once the member has a recipe of their own', () => {
    // Arrived empty, dodged the intro (another sheet, or left Library before
    // the answer), imported a recipe, then deleted it.
    noteLibraryOnArrival('c', false);
    noteLibraryOnArrival('c', true);
    noteLibraryOnArrival('c', false);
    expect(arrivedWithoutOwnRecipe('c')).toBe(false);
  });

  it('is false for a sub not seen yet', () => {
    expect(arrivedWithoutOwnRecipe('d')).toBe(false);
  });
});
