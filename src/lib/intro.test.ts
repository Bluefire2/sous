import { describe, expect, it } from 'vitest';
import { shouldAskAboutIntro } from './intro';

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
