import { describe, expect, it } from 'vitest';
import {
  importHref,
  libraryHref,
  libraryPathFromState,
  libraryReturnPath,
  missingCollectionAction,
  newRecipeHref,
} from './collectionHref';

const SAMPLE_COLLECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('libraryHref', () => {
  it('returns / when the id is missing or empty', () => {
    expect(libraryHref(undefined)).toBe('/');
    expect(libraryHref('')).toBe('/');
  });

  it('uses the collection path for a uuid id', () => {
    expect(libraryHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}`,
    );
  });

  it('encodes the id into a collection path', () => {
    expect(libraryHref('a/b')).toBe('/collections/a%2Fb');
  });
});

describe('libraryReturnPath', () => {
  it('keeps the home library and a collection library', () => {
    expect(libraryReturnPath('/')).toBe('/');
    expect(libraryReturnPath(`/collections/${SAMPLE_COLLECTION_ID}`)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}`,
    );
  });

  it('sends anything else home', () => {
    expect(libraryReturnPath(undefined)).toBe('/');
    expect(libraryReturnPath('/collections')).toBe('/');
    expect(libraryReturnPath(`/collections/${SAMPLE_COLLECTION_ID}/import`)).toBe('/');
    expect(libraryReturnPath('/settings')).toBe('/');
  });
});

describe('libraryPathFromState', () => {
  it('returns a library path carried as from', () => {
    expect(libraryPathFromState({ from: '/' })).toBe('/');
    expect(libraryPathFromState({ from: `/collections/${SAMPLE_COLLECTION_ID}` })).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}`,
    );
  });

  it('returns undefined without state or for a path that is not a library', () => {
    expect(libraryPathFromState(null)).toBeUndefined();
    expect(libraryPathFromState(undefined)).toBeUndefined();
    expect(libraryPathFromState({})).toBeUndefined();
    expect(libraryPathFromState({ from: 'library' })).toBeUndefined();
    expect(libraryPathFromState({ from: '/collections' })).toBeUndefined();
    expect(libraryPathFromState({ from: '/settings' })).toBeUndefined();
  });
});

describe('importHref', () => {
  it('returns /import when the id is missing or empty', () => {
    expect(importHref(undefined)).toBe('/import');
    expect(importHref('')).toBe('/import');
  });

  it('nests import under the collection path', () => {
    expect(importHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}/import`,
    );
    expect(importHref('a/b')).toBe('/collections/a%2Fb/import');
  });
});

describe('missingCollectionAction', () => {
  const gone = {
    collectionId: 'gone',
    collectionIds: ['kept'] as readonly string[] | undefined,
    snapshotConfirmed: true,
    hold: false,
  };
  const stay = { redirectHome: false, resetCollectionSheets: false };

  it('replace-navigates when a full pull published a library without that id', () => {
    expect(missingCollectionAction(gone)).toEqual({
      redirectHome: true,
      resetCollectionSheets: true,
    });
    expect(missingCollectionAction({ ...gone, collectionIds: [] })).toEqual({
      redirectHome: true,
      resetCollectionSheets: true,
    });
  });

  it('does nothing on the default library or when the id is still listed', () => {
    expect(missingCollectionAction({ ...gone, collectionId: undefined })).toEqual(stay);
    expect(missingCollectionAction({ ...gone, collectionId: '' })).toEqual(stay);
    expect(missingCollectionAction({ ...gone, collectionIds: ['gone', 'kept'] })).toEqual(stay);
  });

  it('waits until the library has loaded', () => {
    expect(missingCollectionAction({ ...gone, collectionIds: undefined })).toEqual(stay);
  });

  it('does not redirect an owned-only or not-yet-published snapshot', () => {
    expect(missingCollectionAction({ ...gone, snapshotConfirmed: false })).toEqual({
      redirectHome: false,
      resetCollectionSheets: true,
    });
  });

  it('holds the redirect and the sheets for this collection delete or leave', () => {
    expect(missingCollectionAction({ ...gone, hold: true })).toEqual(stay);
  });
});

describe('newRecipeHref', () => {
  it('returns /recipe/new when the id is missing or empty', () => {
    expect(newRecipeHref(undefined)).toBe('/recipe/new');
    expect(newRecipeHref('')).toBe('/recipe/new');
  });

  it('nests new recipe under the collection path', () => {
    expect(newRecipeHref(SAMPLE_COLLECTION_ID)).toBe(
      `/collections/${SAMPLE_COLLECTION_ID}/recipe/new`,
    );
    expect(newRecipeHref('a/b')).toBe('/collections/a%2Fb/recipe/new');
  });
});
