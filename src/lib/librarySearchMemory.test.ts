import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedLibraryView,
  persistScopedLibraryView,
  readPersistedLibraryView,
  writePersistedLibraryView,
} from './librarySearchMemory';

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

describe('librarySearchMemory', () => {
  it('round-trips the query, scope, and order', () => {
    writePersistedLibraryView({ query: 'pasta', browseAll: true, sort: 'title' });
    expect(readPersistedLibraryView()).toEqual({ query: 'pasta', browseAll: true, sort: 'title' });
  });

  it('keeps the scope when the query is empty', () => {
    writePersistedLibraryView({ query: '', browseAll: true, sort: 'updated' });
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: true, sort: 'updated' });
  });

  it('keeps a chosen order on its own', () => {
    writePersistedLibraryView({ query: '', browseAll: false, sort: 'cooked' });
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: false, sort: 'cooked' });
  });

  it('removes the key for an empty, unwidened view in the default order', () => {
    writePersistedLibraryView({ query: 'pasta', browseAll: false, sort: 'created' });
    writePersistedLibraryView({ query: '', browseAll: false, sort: 'updated' });
    expect(store.size).toBe(0);
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: false, sort: 'updated' });
  });

  it('keeps the query and order and drops the all-collections scope', () => {
    writePersistedLibraryView({ query: 'pasta', browseAll: true, sort: 'title' });
    persistScopedLibraryView();
    expect(readPersistedLibraryView()).toEqual({ query: 'pasta', browseAll: false, sort: 'title' });
  });

  it('clear removes a stored view, including its order', () => {
    writePersistedLibraryView({ query: 'cake', browseAll: true, sort: 'cooked' });
    clearPersistedLibraryView();
    expect(store.size).toBe(0);
    expect(readPersistedLibraryView().sort).toBe('updated');
  });

  it('ignores a corrupt stored value', () => {
    store.set('cook.librarySearch', 'not json');
    expect(readPersistedLibraryView()).toEqual({ query: '', browseAll: false, sort: 'updated' });
  });

  it('reads a view stored without an order, or with an unknown one, in the default order', () => {
    store.set('cook.librarySearch', JSON.stringify({ query: 'pie', browseAll: false }));
    expect(readPersistedLibraryView()).toEqual({ query: 'pie', browseAll: false, sort: 'updated' });
    store.set('cook.librarySearch', JSON.stringify({ query: 'pie', browseAll: false, sort: 'rating' }));
    expect(readPersistedLibraryView().sort).toBe('updated');
  });
});
