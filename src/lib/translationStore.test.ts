import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLibrary, getRecipe, upsertRecipe } from './libraryMemory';
import { recipeStore } from './recipeStore';
import * as session from './session';
import { installSharedRows } from './testLibrary';
import {
  clearTranslations,
  displayRecipe,
  effectiveLang,
  effectiveRecipeLang,
  getCachedTranslation,
  getDetectedLang,
  isTranslated,
  showOriginal,
  translateRecipe,
  translatedTarget,
} from './translationStore';
import type { Recipe } from './types';

afterEach(() => {
  clearTranslations();
  clearLibrary();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    title: 'Carbonara',
    servings: 2,
    ingredientSections: [{ items: [{ item: 'guanciale' }] }],
    steps: [{ text: 'Fry it.' }],
    tags: [],
    lang: 'it',
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function translatedBody(title: string, detectedLang: string | null = 'it'): string {
  return JSON.stringify({
    detectedLang,
    recipe: {
      title,
      servings: 2,
      ingredientSections: [{ items: [{ item: 'гуанчале' }] }],
      steps: [{ text: 'Смажити.' }],
      tags: [],
      lang: 'it',
    },
  });
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  expect(fetchMock.mock.calls[call]?.[0]).toBe('/api/translate');
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('effectiveLang', () => {
  const updatedAt = 10;

  it('keeps a detection that agrees with the stored label', () => {
    expect(
      effectiveLang({ storedLang: 'it', detectedLang: 'it', detectedAt: updatedAt, updatedAt }),
    ).toBe('it');
  });

  it('prefers a detection that disagrees with the stored label', () => {
    expect(
      effectiveLang({ storedLang: 'it', detectedLang: 'uk', detectedAt: updatedAt, updatedAt }),
    ).toBe('uk');
  });

  it('discards a detection recorded before the current edit', () => {
    expect(
      effectiveLang({ storedLang: 'it', detectedLang: 'uk', detectedAt: updatedAt - 1, updatedAt }),
    ).toBe('it');
    expect(effectiveLang({ detectedLang: 'uk', detectedAt: updatedAt - 1, updatedAt })).toBeUndefined();
  });

  it('uses a detection when the recipe has no label', () => {
    expect(effectiveLang({ detectedLang: 'uk', detectedAt: updatedAt, updatedAt })).toBe('uk');
  });

  it('is undefined when both the label and the detection are missing', () => {
    expect(effectiveLang({ updatedAt })).toBeUndefined();
    expect(effectiveLang({ storedLang: undefined, detectedAt: updatedAt, updatedAt })).toBeUndefined();
  });
});

describe('translateRecipe', () => {
  it('does not call again when the same version is already cached', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return new Response(translatedBody(`T${n}`), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = recipe();
    upsertRecipe(source);

    const first = await translateRecipe(source, 'uk');
    const second = await translateRecipe(source, 'uk');

    expect(first.title).toBe('T1');
    expect(second.title).toBe('T1');
    expect(second.id).toBe(source.id);
    expect(second.updatedAt).toBe(source.updatedAt);
    expect(second.lang).toBe('it');
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = postedBody(fetchMock);
    expect(body.recipeId).toBe(source.id);
    expect(body.target).toBe('uk');
    // The stored label is not sent as a hint; detection comes from the text.
    expect(body).not.toHaveProperty('sourceLang');
    expect(getDetectedLang(source.id, source.updatedAt)).toBe('it');
    expect(getRecipe(source.id)?.title).toBe('Carbonara');
    expect(getRecipe(source.id)?.lang).toBe('it');
    expect(source.title).toBe('Carbonara');
  });

  it('keeps each stored step lane on the translated text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(translatedBody('Карбонара'), { status: 200 })),
    );
    const source = recipe({ id: 'recipe-laned', steps: [{ text: 'Fry it.', lane: 'Sauce' }] });
    upsertRecipe(source);

    const display = await translateRecipe(source, 'uk');

    expect(display.steps).toEqual([{ text: 'Смажити.', lane: 'Sauce' }]);
  });

  it('misses the cache when updatedAt changes', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return new Response(translatedBody(`T${n}`), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = recipe();

    const first = await translateRecipe(source, 'uk');
    const edited = { ...source, updatedAt: source.updatedAt + 1, title: 'Edited carbonara' };
    const second = await translateRecipe(edited, 'uk');

    expect(first.title).toBe('T1');
    expect(second.title).toBe('T2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCachedTranslation(source.id, 'uk', source.updatedAt)?.title).toBe('T1');
    expect(getCachedTranslation(source.id, 'uk', edited.updatedAt)?.title).toBe('T2');
    expect(postedBody(fetchMock, 1).recipeId).toBe(source.id);
    const sent = postedBody(fetchMock, 1).recipe as { title: string };
    expect(sent.title).toBe('Edited carbonara');
  });

  it('omits recipeId for a shared recipe', async () => {
    const fetchMock = vi.fn(async () => new Response(translatedBody('Їхня'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = recipe({ id: 'shared-1', title: 'Theirs' });
    installSharedRows({
      recipes: new Map([[source.id, source]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([[source.id, { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map(),
    });
    expect(recipeStore.isShared(source.id)).toBe(true);

    const display = await translateRecipe(source, 'uk');

    expect(display.title).toBe('Їхня');
    expect(display.lang).toBe('it');
    const body = postedBody(fetchMock);
    expect(body).not.toHaveProperty('recipeId');
    expect(body.target).toBe('uk');
    expect(getRecipe(source.id)?.title).toBe('Theirs');
    expect(getRecipe(source.id)?.lang).toBe('it');
  });

  it('returns the toggle to original when updatedAt changes and does not auto-translate', async () => {
    const fetchMock = vi.fn(async () => new Response(translatedBody('Карбонара'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = recipe();

    await translateRecipe(source, 'uk');
    expect(isTranslated(source.id, source.updatedAt)).toBe(true);
    expect(translatedTarget(source.id, source.updatedAt)).toBe('uk');
    expect(displayRecipe(source, 'uk').title).toBe('Карбонара');

    const edited = { ...source, updatedAt: source.updatedAt + 1 };
    expect(isTranslated(edited.id, edited.updatedAt)).toBe(false);
    expect(translatedTarget(edited.id, edited.updatedAt)).toBeUndefined();
    expect(displayRecipe(edited, 'uk')).toBe(edited);
    expect(isTranslated(source.id, source.updatedAt)).toBe(true);
    expect(getDetectedLang(source.id, source.updatedAt)).toBe('it');
    expect(getDetectedLang(edited.id, edited.updatedAt)).toBeUndefined();
    expect(effectiveRecipeLang({ ...source, lang: 'fr' })).toBe('it');
    expect(effectiveRecipeLang({ ...edited, lang: 'fr' })).toBe('fr');

    showOriginal(source.id);
    expect(isTranslated(source.id, source.updatedAt)).toBe(false);
    expect(displayRecipe(source, 'uk').title).toBe('Carbonara');
    expect(getCachedTranslation(source.id, 'uk', source.updatedAt)?.title).toBe('Карбонара');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('invalidates the session on 401 and does not cache', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })),
    );
    const source = recipe();

    await expect(translateRecipe(source, 'uk')).rejects.toThrow(/sign in/i);
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(isTranslated(source.id, source.updatedAt)).toBe(false);
    expect(getDetectedLang(source.id, source.updatedAt)).toBeUndefined();
    expect(getCachedTranslation(source.id, 'uk', source.updatedAt)).toBeUndefined();
  });
});
