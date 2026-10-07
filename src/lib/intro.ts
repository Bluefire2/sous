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

/**
 * Per page load and per sub: whether the first full pull on screen had no
 * live recipe of the member's own, and none has appeared since. The intro is
 * for arriving at an empty library, so a member who deletes their last
 * recipe mid-session never gets it. Written only from an effect, never read
 * in render.
 */
const arrivedEmpty = new Map<string, boolean>();

/**
 * Records the library Library sees. The first call per sub sets the arrival;
 * a later recipe of their own ends an empty arrival for good, so importing
 * one and deleting it can't open the intro.
 */
export function noteLibraryOnArrival(sub: string, hasOwnRecipe: boolean): void {
  if (hasOwnRecipe) arrivedEmpty.set(sub, false);
  else if (!arrivedEmpty.has(sub)) arrivedEmpty.set(sub, true);
}

/** Whether `sub`'s library had no recipe of their own when it first loaded on this page, and has had none since. */
export function arrivedWithoutOwnRecipe(sub: string): boolean {
  return arrivedEmpty.get(sub) === true;
}

/** Test isolation. */
export function resetIntroArrivalForTests(): void {
  arrivedEmpty.clear();
}
