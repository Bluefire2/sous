import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { importHref, libraryHref, newRecipeHref } from './collectionHref';
import { routePaths } from './routePaths';

// Same shape as AppRoutes in src/App.tsx: the two list paths share one
// Library layout route, everything else is a sibling.
const routes = [
  {
    id: 'library',
    children: [
      { id: 'home', path: routePaths.home },
      { id: 'collection', path: routePaths.collection },
    ],
  },
  { id: 'collectionsIndex', path: routePaths.collectionsIndex },
  { id: 'collectionsUnknown', path: routePaths.collectionsUnknown },
  { id: 'collectionImport', path: routePaths.collectionImport },
  { id: 'collectionNewRecipe', path: routePaths.collectionNewRecipe },
  { id: 'import', path: routePaths.import },
  { id: 'newRecipe', path: routePaths.newRecipe },
];

function match(pathname: string) {
  const matches = matchRoutes(routes, pathname);
  return {
    ids: matches?.map((m) => m.route.id) ?? [],
    // A parent layout route sees the params of its matched child.
    params: matches?.[0]?.params ?? {},
  };
}

describe('routePaths', () => {
  it('serves / and /collections/:id from the Library layout', () => {
    expect(match('/').ids).toEqual(['library', 'home']);
    expect(match('/collections/abc').ids).toEqual(['library', 'collection']);
    expect(match('/collections/abc').params).toEqual({ collectionId: 'abc' });
  });

  it('keeps import and new-recipe paths outside the Library layout', () => {
    expect(match('/collections/abc/import').ids).toEqual(['collectionImport']);
    expect(match('/collections/abc/recipe/new').ids).toEqual(['collectionNewRecipe']);
    expect(match('/import').ids).toEqual(['import']);
    expect(match('/recipe/new').ids).toEqual(['newRecipe']);
  });

  it('matches /collections as the index and other /collections/* as the fallback', () => {
    expect(match('/collections').ids).toEqual(['collectionsIndex']);
    expect(match('/collections/abc/nope').ids).toEqual(['collectionsUnknown']);
  });

  it('does not treat a legacy ?c= query as a collection', () => {
    expect(match('/').params).toEqual({});
  });

  it('matches the paths the href helpers build', () => {
    for (const id of ['abc', 'a/b', 'weird id']) {
      const library = match(libraryHref(id));
      expect(library.ids).toEqual(['library', 'collection']);
      expect(library.params).toEqual({ collectionId: id });
      expect(match(importHref(id)).ids).toEqual(['collectionImport']);
      expect(match(newRecipeHref(id)).ids).toEqual(['collectionNewRecipe']);
    }
    expect(match(libraryHref(undefined)).ids).toEqual(['library', 'home']);
    expect(match(importHref(undefined)).ids).toEqual(['import']);
    expect(match(newRecipeHref(undefined)).ids).toEqual(['newRecipe']);
  });
});
