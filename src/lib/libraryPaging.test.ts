import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedLibraryPaging,
  LIBRARY_PAGE_SIZE,
  libraryListKey,
  readPersistedLibraryPaging,
  showMore,
  shownCount,
  writePersistedLibraryPaging,
} from './libraryPaging';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const list = (over: Partial<Parameters<typeof libraryListKey>[0]> = {}) =>
  libraryListKey({ collectionId: undefined, browseAll: false, query: '', sort: 'updated', ...over });

describe('libraryListKey', () => {
  it('matches the search the way the list does', () => {
    expect(list({ query: '  Pasta ' })).toBe(list({ query: 'pasta' }));
  });

  it('tells apart the collection, the scope, the search, and the order', () => {
    const keys = new Set([
      list(),
      list({ collectionId: 'c1' }),
      list({ browseAll: true }),
      list({ query: 'soup' }),
      list({ sort: 'title' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('does not run a collection id into the search', () => {
    expect(list({ collectionId: 'a', query: 'b' })).not.toBe(list({ collectionId: 'ab', query: '' }));
  });
});

describe('paging', () => {
  it('shows one page of a list it has not paged', () => {
    expect(shownCount({ key: list({ query: 'soup' }), count: 60 }, list())).toBe(LIBRARY_PAGE_SIZE);
  });

  it('adds a page at a time to the same list', () => {
    const key = list();
    const once = showMore({ key: '', count: LIBRARY_PAGE_SIZE }, key);
    expect(shownCount(once, key)).toBe(2 * LIBRARY_PAGE_SIZE);
    expect(shownCount(showMore(once, key), key)).toBe(3 * LIBRARY_PAGE_SIZE);
  });

  it('starts another list again from one page', () => {
    const paged = { key: list(), count: 3 * LIBRARY_PAGE_SIZE };
    expect(showMore(paged, list({ sort: 'title' }))).toEqual({
      key: list({ sort: 'title' }),
      count: 2 * LIBRARY_PAGE_SIZE,
    });
  });
});

describe('persisted paging', () => {
  it('round-trips a paged list', () => {
    writePersistedLibraryPaging({ key: list(), count: 40 });
    expect(readPersistedLibraryPaging()).toEqual({ key: list(), count: 40 });
  });

  it('clears the key at one page', () => {
    writePersistedLibraryPaging({ key: list(), count: 40 });
    writePersistedLibraryPaging({ key: list(), count: LIBRARY_PAGE_SIZE });
    expect(store.size).toBe(0);
  });

  it('clears on sign-out', () => {
    writePersistedLibraryPaging({ key: list({ query: 'soup' }), count: 60 });
    clearPersistedLibraryPaging();
    expect(store.size).toBe(0);
    expect(readPersistedLibraryPaging()).toEqual({ key: '', count: LIBRARY_PAGE_SIZE });
  });

  it.each([
    ['not JSON', '{'],
    ['no key', JSON.stringify({ count: 40 })],
    ['a count that is not a whole page', JSON.stringify({ key: 'k', count: 30 })],
    ['a count of one page or less', JSON.stringify({ key: 'k', count: 0 })],
    ['a count that is not a number', JSON.stringify({ key: 'k', count: '40' })],
  ])('reads %s as one page', (_label, raw) => {
    store.set('cook.libraryShown', raw);
    expect(readPersistedLibraryPaging()).toEqual({ key: '', count: LIBRARY_PAGE_SIZE });
  });

  it('reads one page when storage throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => writePersistedLibraryPaging({ key: list(), count: 40 })).not.toThrow();
    expect(readPersistedLibraryPaging()).toEqual({ key: '', count: LIBRARY_PAGE_SIZE });
  });
});
