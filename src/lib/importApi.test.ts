import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { IMPORT_JPEG_QUALITY, IMPORT_MAX_EDGE_PX } from './image';
import {
  checkImportPhotoBytes,
  fitImportPhotos,
  IMPORT_PHOTO_LIMIT_ERROR,
  importRecipe,
  MAX_GENERATE_BRIEF_CHARS,
  MAX_IMPORT_PHOTO_BYTES,
  MAX_IMPORT_PHOTOS,
  MAX_IMPORT_PHOTOS_BASE64_CHARS,
  readImportGrounding,
} from './importApi';
import * as session from './session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof respond>): unknown {
  return JSON.parse(String(fetchMock.mock.calls[0][1].body));
}

/** Base64 of `bytes` decoded bytes, with the padding real base64 would have. */
function base64Of(bytes: number): string {
  const tail = ['', 'AA==', 'AAA='][bytes % 3];
  return 'A'.repeat(Math.floor(bytes / 3) * 4) + tail;
}

const photo = (base64: string) => ({ mediaType: 'image/jpeg', base64 });

describe('importRecipe', () => {
  it('posts photos and notes as JSON', async () => {
    const fetchMock = respond(200, { recipe: { title: 'Pie', servings: 1 } });
    const images = [{ mediaType: 'image/jpeg', base64: 'AAAA' }];
    const recipe = await importRecipe({ images, text: 'notes' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/import');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(sentBody(fetchMock)).toEqual({ images, text: 'notes' });
    expect(recipe).toEqual({
      recipe: {
        title: 'Pie',
        servings: 1,
        tags: [],
        ingredientSections: [],
        steps: [],
      },
    });
  });

  it('sends no images key for text import', async () => {
    const fetchMock = respond(200, { recipe: { title: 'Soup', servings: 1 } });
    await importRecipe({ text: 'soup' });
    expect('images' in (sentBody(fetchMock) as object)).toBe(false);
  });

  it("surfaces the server's photo error", async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(413, { error: 'Those photos are too large.' });
    await expect(importRecipe({ images: [photo('AAAA')] })).rejects.toThrow(
      'Those photos are too large.',
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('keeps known warning codes and drops the rest', async () => {
    respond(200, {
      recipe: { title: 'Soup', servings: 1 },
      warnings: [
        { code: 'INSTRUCTIONS_NOT_ON_PAGE' },
        { code: 'FROM_A_NEWER_SERVER' },
        { code: 'UNGROUNDED_INGREDIENT', at: [0, 2] },
        'junk',
      ],
    });
    expect((await importRecipe({ text: 'soup' })).warnings).toEqual([
      { code: 'INSTRUCTIONS_NOT_ON_PAGE' },
      { code: 'UNGROUNDED_INGREDIENT', at: [0, 2] },
    ]);

    respond(200, { recipe: { title: 'Soup', servings: 1 }, warnings: 'nope' });
    expect(await importRecipe({ text: 'soup' })).not.toHaveProperty('warnings');
  });

  it('shows the catalog text for a model failure', async () => {
    respond(502, { error: "Couldn't read that recipe — try again.", code: 'import-model-failed' });
    await expect(importRecipe({ url: 'https://example.com' })).rejects.toThrow(
      "Couldn't read that recipe — try again.",
    );
  });

  it('invalidates the session on 401', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, { error: 'Unauthorized' });
    await expect(importRecipe({ images: [photo('AAAA')] })).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('attaches code, status, and siteStatus to a failed import', async () => {
    const body = {
      error: 'The site refused the request (403). Try pasting the recipe text instead.',
      code: 'import-refused',
      status: 403,
    };
    respond(422, body);
    const err = await importRecipe({ url: 'https://example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'import-refused', status: 422, siteStatus: 403 });
    expect((err as Error).message).toBe(
      serverErrorText(body, 'error.importFailedStatus', { status: 422 }),
    );
  });

  it('a failure without a JSON body carries only its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Internal Server Error', { status: 500 })),
    );
    const err = await importRecipe({ url: 'https://example.com' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500 });
    expect('code' in (err as object)).toBe(false);
    expect('siteStatus' in (err as object)).toBe(false);
  });

  it('a 401 carries no status', async () => {
    vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    const err = await importRecipe({ url: 'https://example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect('status' in (err as object)).toBe(false);
  });
});

describe('checkImportPhotoBytes', () => {
  it('caps one photo at 3 MB decoded', () => {
    expect(MAX_IMPORT_PHOTO_BYTES).toBe(3 * 1024 * 1024);
    expect(checkImportPhotoBytes([], photo(base64Of(MAX_IMPORT_PHOTO_BYTES)))).toBe('ok');
    expect(checkImportPhotoBytes([], photo(base64Of(MAX_IMPORT_PHOTO_BYTES + 1)))).toBe(
      'photo_too_large',
    );
  });

  it('caps the photos together below the request body cap', () => {
    expect(MAX_IMPORT_PHOTOS_BASE64_CHARS).toBeLessThan(12 * 1024 * 1024);
    const current = [photo('A'.repeat(MAX_IMPORT_PHOTOS_BASE64_CHARS - 4))];
    expect(checkImportPhotoBytes(current, photo('AAAA'))).toBe('ok');
    expect(checkImportPhotoBytes(current, photo('AAAAAAAA'))).toBe('total_too_large');
  });

  it('reports an oversized photo as too large on its own', () => {
    const huge = photo('A'.repeat(MAX_IMPORT_PHOTOS_BASE64_CHARS + 4));
    expect(checkImportPhotoBytes([], huge)).toBe('photo_too_large');
  });
});

describe('fitImportPhotos', () => {
  it('keeps the leading picks that fit under the cap', () => {
    expect(fitImportPhotos(0, ['a', 'b'])).toEqual({ accepted: ['a', 'b'], overflow: false });
    expect(fitImportPhotos(3, ['d', 'e'])).toEqual({ accepted: ['d'], overflow: true });
    expect(fitImportPhotos(4, ['e'])).toEqual({ accepted: [], overflow: true });
    expect(fitImportPhotos(0, ['a', 'b', 'c', 'd', 'e'])).toEqual({
      accepted: ['a', 'b', 'c', 'd'],
      overflow: true,
    });
    expect(fitImportPhotos(1, [])).toEqual({ accepted: [], overflow: false });
  });
});

describe('import photo limits', () => {
  it('locks the constitution numbers', () => {
    expect(MAX_IMPORT_PHOTOS).toBe(4);
    expect(IMPORT_MAX_EDGE_PX).toBe(2048);
    expect(IMPORT_JPEG_QUALITY).toBe(0.85);
    expect(IMPORT_PHOTO_LIMIT_ERROR).toBe('Up to 4 photos.');
  });
});

describe('importRecipe from a brief', () => {
  it('posts the brief and the search flag', async () => {
    const fetchMock = respond(200, { recipe: { title: 'Gumbo', servings: 6 } });
    await importRecipe({ brief: 'shrimp gumbo', search: true, translateTo: 'en' });
    expect(sentBody(fetchMock)).toEqual({ brief: 'shrimp gumbo', search: true, translateTo: 'en' });
  });

  it('keeps well-formed grounding sources and the chip', async () => {
    respond(200, {
      recipe: { title: 'Gumbo', servings: 6 },
      grounding: {
        sources: [
          { title: 'Gumbo', url: 'https://example.com/gumbo' },
          { title: 'bad scheme', url: 'javascript:alert(1)' },
          { title: 7, url: 'https://example.com/no-title' },
          'nonsense',
          { title: 'Roux', url: 'https://example.org/roux' },
        ],
        searchSuggestions: '<div>chip</div>',
      },
    });
    const result = await importRecipe({ brief: 'shrimp gumbo', search: true });
    expect(result.grounding).toEqual({
      sources: [
        { title: 'Gumbo', url: 'https://example.com/gumbo' },
        { title: 'Roux', url: 'https://example.org/roux' },
      ],
      searchSuggestions: '<div>chip</div>',
    });
  });

  it('omits grounding when the server sent none, or nothing usable', async () => {
    respond(200, { recipe: { title: 'Gumbo', servings: 6 } });
    expect(await importRecipe({ brief: 'gumbo' })).not.toHaveProperty('grounding');
    respond(200, { recipe: { title: 'Gumbo', servings: 6 }, grounding: { sources: [], searchSuggestions: '  ' } });
    expect(await importRecipe({ brief: 'gumbo', search: true })).not.toHaveProperty('grounding');
    respond(200, { recipe: { title: 'Gumbo', servings: 6 }, grounding: 'x' });
    expect(await importRecipe({ brief: 'gumbo', search: true })).not.toHaveProperty('grounding');
  });

  it('keeps an untitled source for the preview to label', () => {
    expect(readImportGrounding({ sources: [{ title: '', url: 'https://example.com/a' }] })).toEqual({
      sources: [{ title: '', url: 'https://example.com/a' }],
    });
  });

  it('caps the sources at ten', () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({ title: `S${i}`, url: `https://example.com/${i}` }));
    expect(readImportGrounding({ sources })?.sources).toHaveLength(10);
  });

  it('shows the catalog text for the brief errors', async () => {
    for (const [code, key] of [
      ['import-brief-too-long', 'error.importBriefTooLong'],
      ['import-search-rate-limited', 'error.importSearchRateLimited'],
      ['import-no-recipe-brief', 'error.importNoRecipeBrief'],
      ['import-generate-failed', 'error.importGenerateFailed'],
    ] as const) {
      expect(serverErrorText({ code, error: 'server words' }, 'error.importFailed')).toBe(t(key));
    }
  });

  it('locks the brief cap', () => {
    expect(MAX_GENERATE_BRIEF_CHARS).toBe(2000);
  });
});
