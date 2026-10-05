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
 * live recipe of the member's own. The intro is for arriving at an empty
 * library, so a member who deletes their last recipe mid-session never gets
 * it. Written only from an effect, never read in render.
 */
const arrivedEmpty = new Map<string, boolean>();

/** Records the library on arrival; only the first call per sub counts. */
export function noteLibraryOnArrival(sub: string, hasOwnRecipe: boolean): void {
  if (!arrivedEmpty.has(sub)) arrivedEmpty.set(sub, !hasOwnRecipe);
}

/** Whether `sub`'s library had no recipe of their own when it first loaded on this page. */
export function arrivedWithoutOwnRecipe(sub: string): boolean {
  return arrivedEmpty.get(sub) === true;
}

/** Test isolation. */
export function resetIntroArrivalForTests(): void {
  arrivedEmpty.clear();
}
