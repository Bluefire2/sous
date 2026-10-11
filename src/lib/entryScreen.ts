import { matchPath } from 'react-router-dom';
import { routePaths } from './routePaths';

/** The screens a tab most often opens on, which App.tsx preloads before render. */
export type EntryScreen = 'library' | 'recipe' | 'publicLink' | 'publicRecipe';

const ENTRY_PATTERNS: ReadonlyArray<readonly [string, EntryScreen | null]> = [
  [routePaths.home, 'library'],
  [routePaths.collection, 'library'],
  // Before /recipe/:id, which would also match it; Routes ranks it first too.
  [routePaths.newRecipe, null],
  ['/recipe/:id', 'recipe'],
  ['/p/:token', 'publicLink'],
  ['/p/:token/r/:recipeId', 'publicRecipe'],
];

/**
 * Which of those screens `pathname` opens, or null for any other route. The
 * patterns are App.tsx's routes for these screens (docs/plans/route-code-splitting.md).
 */
export function entryScreenFor(pathname: string): EntryScreen | null {
  for (const [pattern, screen] of ENTRY_PATTERNS) {
    if (matchPath(pattern, pathname) !== null) return screen;
  }
  return null;
}
