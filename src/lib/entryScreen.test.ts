import { describe, expect, it } from 'vitest';
import { entryScreenFor } from './entryScreen';

describe('entryScreenFor', () => {
  it('maps the library paths to Library', () => {
    expect(entryScreenFor('/')).toBe('library');
    expect(entryScreenFor('/collections/abc')).toBe('library');
    expect(entryScreenFor('/collections/abc/')).toBe('library');
  });

  it('maps a recipe to RecipeView, but not the new-recipe form or deeper recipe paths', () => {
    expect(entryScreenFor('/recipe/00000000-0000-4000-8000-000000000101')).toBe('recipe');
    expect(entryScreenFor('/recipe/new')).toBeNull();
    expect(entryScreenFor('/recipe/abc/edit')).toBeNull();
    expect(entryScreenFor('/recipe/abc/cooks/new')).toBeNull();
  });

  it('maps the public pages', () => {
    expect(entryScreenFor('/p/token')).toBe('publicLink');
    expect(entryScreenFor('/p/token/r/abc')).toBe('publicRecipe');
    expect(entryScreenFor('/p')).toBeNull();
  });

  it('preloads nothing for any other route', () => {
    for (const path of ['/collections', '/collections/abc/import', '/import', '/settings', '/admin', '/assistant', '/cooks', '/nope']) {
      expect(entryScreenFor(path)).toBeNull();
    }
  });
});
