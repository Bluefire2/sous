import { DEFAULT_LIBRARY_SORT, isLibrarySort, type LibrarySort } from './librarySort';

const STORAGE_KEY = 'cook.librarySearch';

export type LibraryView = { query: string; browseAll: boolean; sort: LibrarySort };

const EMPTY: LibraryView = { query: '', browseAll: false, sort: DEFAULT_LIBRARY_SORT };

/** Search text, scope, and order, kept for this tab so Library remounts restore them. */
export function readPersistedLibraryView(): LibraryView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY;
    }
    const parsed = JSON.parse(raw) as Partial<LibraryView>;
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      browseAll: parsed.browseAll === true,
      sort: isLibrarySort(parsed.sort) ? parsed.sort : DEFAULT_LIBRARY_SORT,
    };
  } catch {
    return EMPTY;
  }
}

/** A view with no search text, no widened scope, and the default order clears the key. */
export function writePersistedLibraryView(view: LibraryView): void {
  try {
    if (view.query === '' && !view.browseAll && view.sort === DEFAULT_LIBRARY_SORT) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // ignore quota / private mode
  }
}

export function clearPersistedLibraryView(): void {
  writePersistedLibraryView(EMPTY);
}

/**
 * Keep the search text and order, and drop the all-collections scope. Opening
 * one list from the index uses this, because Library reads the stored view on
 * mount.
 */
export function persistScopedLibraryView(): void {
  const { query, sort } = readPersistedLibraryView();
  writePersistedLibraryView({ query, browseAll: false, sort });
}
