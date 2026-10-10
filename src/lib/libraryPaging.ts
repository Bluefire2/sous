import type { LibrarySort } from './librarySort';

/** How many recipe cards Library renders at first, and how many each Show more adds. */
export const LIBRARY_PAGE_SIZE = 20;

const STORAGE_KEY = 'cook.libraryShown';

/** How far down one list the person has paged. `key` names the list. */
export type LibraryPaging = { key: string; count: number };

/**
 * Names the list on screen: the collection, the scope, the search as it is
 * matched (trimmed, lower case), and the order. Paging is kept per list, so a
 * different list starts again at one page.
 */
export function libraryListKey({
  collectionId,
  browseAll,
  query,
  sort,
}: {
  collectionId: string | undefined;
  browseAll: boolean;
  query: string;
  sort: LibrarySort;
}): string {
  return JSON.stringify([collectionId ?? '', browseAll, query.trim().toLowerCase(), sort]);
}

/** How many cards the list named by `key` shows. */
export function shownCount(paging: LibraryPaging, key: string): number {
  return paging.key === key ? paging.count : LIBRARY_PAGE_SIZE;
}

/** One more page of the list named by `key`, starting from what it shows now. */
export function showMore(paging: LibraryPaging, key: string): LibraryPaging {
  return { key, count: shownCount(paging, key) + LIBRARY_PAGE_SIZE };
}

function isPageCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > LIBRARY_PAGE_SIZE &&
    value % LIBRARY_PAGE_SIZE === 0
  );
}

/**
 * What this tab last paged to, so Back from a recipe returns to the same
 * length of list. Anything unreadable is one page of no list.
 */
export function readPersistedLibraryPaging(): LibraryPaging {
  const none = { key: '', count: LIBRARY_PAGE_SIZE };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return none;
    }
    const parsed = JSON.parse(raw) as Partial<LibraryPaging>;
    if (typeof parsed.key !== 'string' || !isPageCount(parsed.count)) {
      return none;
    }
    return { key: parsed.key, count: parsed.count };
  } catch {
    return none;
  }
}

/** One page is the default, so it clears the key. */
export function writePersistedLibraryPaging(paging: LibraryPaging): void {
  try {
    if (!isPageCount(paging.count)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(paging));
  } catch {
    // ignore quota / private mode
  }
}

/** The key holds the search text, so sign-out drops it with the view. */
export function clearPersistedLibraryPaging(): void {
  writePersistedLibraryPaging({ key: '', count: LIBRARY_PAGE_SIZE });
}
