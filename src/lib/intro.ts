import type { SessionStatus } from './session';

/**
 * Whether Library should ask the server if this member has seen the
 * new-member intro (`docs/plans/new-member-intro.md`, D1): signed in, the
 * rows on screen come from a full pull (owned and shared), the member has no
 * live recipe of their own (shared rows don't count), and no other sheet is
 * open. Existing members have recipes, so they never cause a request.
 *
 * `fullPull` rather than the sync status: `clearLibrary` (sign-out, an
 * expired session) resets it, while the sync status can stay idle with an
 * old `lastSyncedAt` after the session comes back, over an empty library.
 */
export function shouldAskAboutIntro(input: {
  sessionStatus: SessionStatus;
  fullPull: boolean;
  hasOwnRecipe: boolean | undefined;
  sheetClosed: boolean;
}): boolean {
  return (
    input.sessionStatus === 'signedIn' &&
    input.fullPull &&
    input.hasOwnRecipe === false &&
    input.sheetClosed
  );
}
