import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeImportDeps } from '../test/fakeGemini.ts';
import { fakePageFetch } from '../test/fakePageFetch.ts';
import {
  IMPORT_IMAGE_TYPES,
  importPost,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_IMPORT_IMAGES,
} from './importRoute.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  type RecipeImportDeps,
} from './recipeImport.ts';
import * as recipeImport from './recipeImport.ts';
import { TRANSLATE_FAILED, type TranslateInput, type TranslateOutcome } from './translate.ts';

// The route fetches pages over the live network; send it through a fake one
// (`test/fakePageFetch.ts`) so `fetchPageHtml`'s own checks still run.
const network = vi.hoisted(() => ({
  deps: undefined as import('./recipeImport.ts').PageFetchDeps | undefined,
}));
vi.mock('./recipeImport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recipeImport.ts')>();
  return {
    ...actual,
    fetchPageHtml: (url: string) => actual.fetchPageHtml(url, network.deps),
  };
});

const RECIPE = {
  title: 'Tomato soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
  steps: [{ text: 'Simmer.' }, { text: 'Blend.' }],
  tags: ['soup'],
};

const PAGE = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';

interface PostOptions {
  /** Sent as is instead of `JSON.stringify(body)`. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Replaces the fake built from `reply`. */
  deps?: RecipeImportDeps;
  translator?: (input: TranslateInput) => Promise<TranslateOutcome>;
}

async function post(
  body: unknown,
  reply: string | undefined = JSON.stringify(RECIPE),
  options: PostOptions = {},
) {
  const { deps, calls } = fakeImportDeps(reply, options.translator);
  const req = new Request('http://localhost/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.rawBody ?? JSON.stringify(body),
  });
  const response = await importPost(req, { authorizedSub: 'sub-1' }, options.deps ?? deps);
  return { status: response.status, body: (await response.json()) as unknown, calls };
}

function prefixTranslator(detectedLang: string | null) {
  return (input: TranslateInput): Promise<TranslateOutcome> =>
    Promise.resolve({
      ok: true,
      detectedLang,
      segments: input.segments.map((segment) => ({
        id: segment.id,
        text: `UK ${segment.text}`,
      })),
    });
}

function image(mediaType: string, magic: readonly number[], n: number) {
  const bytes = Buffer.alloc(n);
  Buffer.from(magic).copy(bytes);
  return { mediaType, base64: bytes.toString('base64') };
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_MAGIC = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];

const jpeg = (n = 64) => image('image/jpeg', JPEG_MAGIC, n);
const png = (n = 64) => image('image/png', PNG_MAGIC, n);
const webp = (n = 64) => image('image/webp', WEBP_MAGIC, n);

function sentParts(calls: { contents: unknown }[]) {
  return (calls[0].contents as Content[])[0].parts ?? [];
}

function rejectingDeps(message: string, status?: number): RecipeImportDeps {
  const error = status === undefined ? new Error(message) : Object.assign(new Error(message), { status });
  return {
    model: 'test-model',
    ai: { models: { generateContent: () => Promise.reject(error) } },
    translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
  };
}

/** Every URL answers with this page. */
function serve(body: string, status = 200) {
  network.deps = fakePageFetch({ pages: () => ({ status, body }) }).deps;
}

// Every request writes an import log line; keep it out of the test output.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Until a test serves a page, every connection is refused.
  network.deps = fakePageFetch({ pages: {} }).deps;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The `event: 'import'` lines written so far, raw and parsed. */
function importLogLines(): { raw: string; entry: Record<string, unknown> }[] {
  return vi
    .mocked(console.log)
    .mock.calls.map(([message]) => String(message))
    .filter((raw) => raw.startsWith('{"event":"import"'))
    .map((raw) => ({ raw, entry: JSON.parse(raw) as Record<string, unknown> }));
}

describe('POST /api/import', () => {
  it('returns the normalized recipe for pasted text, without sourceUrl', async () => {
    const result = await post(
      { text: '  Tomato soup: simmer.  ' },
      JSON.stringify({ ...RECIPE, servings: 0, photoId: 'x' }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ recipe: { ...RECIPE, servings: 1 } });
    expect(result.calls[0].contents).toContain('Tomato soup: simmer.');
  });

  it('returns the normalized recipe and sourceUrl for a URL', async () => {
    serve(PAGE);
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({
      status: 200,
      body: { recipe: { ...RECIPE, sourceUrl: 'https://example.com/soup' } },
    });
    expect(result.calls[0].contents).toContain('Simmer the tomatoes.');
  });

  it('prefers the URL when both are given', async () => {
    serve(PAGE);
    const result = await post({ url: 'https://example.com/soup', text: 'Other text' });
    expect(result.calls[0].contents).not.toContain('Other text');
  });

  it('rejects a request with nothing to import', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const result = await post(body);
      expect(result).toMatchObject({
        status: 400,
        body: { error: 'Provide a URL, recipe text, or photos.', code: 'import-empty' },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('rejects a page with no readable text like an empty request', async () => {
    serve('<html><body><script>x()</script></body></html>');
    const result = await post({ url: 'https://example.com/soup' });
    expect(result).toMatchObject({
      status: 400,
      body: { error: 'Provide a URL, recipe text, or photos.', code: 'import-empty' },
    });
    expect(result.calls).toHaveLength(0);
  });

  it('maps fetch failures to 422 with the existing copy', async () => {
    expect(await post({ url: 'soup' })).toMatchObject({
      status: 422,
      body: { error: 'That does not look like a web address.', code: 'import-bad-url' },
    });
    expect(await post({ url: 'ftp://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Only http and https URLs are supported.', code: 'import-bad-scheme' },
    });

    network.deps = fakePageFetch({ pages: {} }).deps;
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: { error: 'Could not reach that URL.', code: 'import-unreachable' },
    });

    // A non-public address answers exactly like an unreachable site.
    serve(PAGE);
    for (const url of ['http://127.0.0.1:3998/internal', 'http://169.254.169.254/computeMetadata/v1/']) {
      expect(await post({ url }), url).toEqual({
        status: 422,
        body: { error: 'Could not reach that URL.', code: 'import-unreachable' },
        calls: [],
      });
    }

    serve('challenge', 403);
    expect(await post({ url: 'https://example.com/soup' })).toMatchObject({
      status: 422,
      body: {
        error: 'The site refused the request (403). Try pasting the recipe text instead.',
        code: 'import-refused',
        status: 403,
      },
    });
  });

  it('maps model outcomes to the existing statuses', async () => {
    expect(await post({ text: 'a poem' }, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in that content.", code: 'import-no-recipe' },
    });
    expect(await post({ text: 'soup' }, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.', code: 'import-extract-failed' },
    });
    expect(await post({ text: 'soup' }, JSON.stringify({ servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.', code: 'import-unusable' },
    });
  });

  it('rejects an unsupported translateTo', async () => {
    for (const translateTo of ['fr', 'zh', '']) {
      const result = await post({ text: 'Tomato soup', translateTo });
      expect(result, translateTo).toMatchObject({
        status: 400,
        body: { error: IMPORT_BAD_LANGUAGE_ERROR, code: IMPORT_BAD_LANGUAGE_CODE },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('forwards translateTo and serializes the translation', async () => {
    const source = vi.spyOn(recipeImport, 'importFromSource');
    const html = vi.spyOn(recipeImport, 'importFromHtml');
    const italian = { ...RECIPE, lang: 'it' };
    const ukrainian = {
      title: 'UK Tomato soup',
      servings: 4,
      ingredientSections: [{ items: [{ item: 'UK tomatoes', quantity: 6 }] }],
      steps: [{ text: 'UK Simmer.' }, { text: 'UK Blend.' }],
      tags: ['soup'],
      lang: 'uk',
    };
    try {
      const text = await post(
        { text: 'Tomato soup', translateTo: 'ua' },
        JSON.stringify(italian),
        { translator: prefixTranslator('it') },
      );
      expect(text.status).toBe(200);
      expect(text.body).toEqual({
        recipe: italian,
        translation: { lang: 'uk', recipe: ukrainian },
      });
      expect(source).toHaveBeenCalledWith('Tomato soup', expect.anything(), 'uk');

      serve(PAGE);
      const url = await post(
        { url: 'https://example.com/soup', translateTo: 'uk' },
        JSON.stringify(italian),
        { translator: prefixTranslator('it') },
      );
      expect(url.status).toBe(200);
      expect(url.body).toEqual({
        recipe: { ...italian, sourceUrl: 'https://example.com/soup' },
        translation: {
          lang: 'uk',
          recipe: { ...ukrainian, sourceUrl: 'https://example.com/soup' },
        },
      });
      expect(html).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'uk');
    } finally {
      source.mockRestore();
      html.mockRestore();
    }
  });

  it('serializes a translation failure without failing the import', async () => {
    const result = await post({ text: 'Tomato soup', translateTo: 'uk' }, JSON.stringify({
      ...RECIPE,
      lang: 'it',
    }), { translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }) });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      recipe: { ...RECIPE, lang: 'it' },
      translationFailed: true,
    });
  });
});

describe('POST /api/import with photos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locks the constitution numbers', () => {
    expect(MAX_IMPORT_IMAGES).toBe(4);
    expect(MAX_IMPORT_IMAGE_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_IMPORT_BODY_BYTES).toBe(12 * 1024 * 1024);
    expect([...IMPORT_IMAGE_TYPES].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('imports from photos without sourceUrl', async () => {
    const images = [jpeg(), png()];
    const result = await post({ images }, JSON.stringify({ ...RECIPE, servings: 0 }));
    expect(result.status).toBe(200);
    const recipe = (result.body as { recipe: Record<string, unknown> }).recipe;
    expect(recipe).toEqual({ ...RECIPE, servings: 1 });
    expect('sourceUrl' in recipe).toBe(false);
    const parts = sentParts(result.calls);
    expect(parts).toHaveLength(3);
    expect(parts.slice(0, 2)).toEqual(
      images.map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.base64 } })),
    );
    expect(typeof parts[2].text).toBe('string');
  });

  it('passes text as notes alongside photos', async () => {
    const result = await post({ images: [jpeg()], text: "Nan's pie" });
    expect(result.status).toBe(200);
    const parts = sentParts(result.calls);
    expect(parts[parts.length - 1].text).toContain("Nan's pie");
  });

  it('prefers the URL and ignores photos', async () => {
    serve(PAGE);
    const images = Array.from({ length: 5 }, () => jpeg());
    const result = await post({ url: 'https://example.com/soup', images });
    expect(result.status).toBe(200);
    expect(typeof result.calls[0].contents).toBe('string');
    expect(result.calls[0].contents).toContain('Simmer the tomatoes.');
  });

  it('treats an empty images array as absent', async () => {
    const withText = await post({ images: [], text: 'soup' });
    expect(withText.status).toBe(200);
    expect(typeof withText.calls[0].contents).toBe('string');

    expect(await post({ images: [] })).toMatchObject({
      status: 400,
      body: { error: 'Provide a URL, recipe text, or photos.' },
    });
  });

  it('rejects more than 4 photos', async () => {
    const valid = await post({ images: Array.from({ length: 5 }, () => jpeg()) });
    expect(valid).toMatchObject({ status: 400, body: { error: 'Up to 4 photos.' } });
    expect(valid.calls).toHaveLength(0);

    const gifs = Array.from({ length: 5 }, () => ({ ...jpeg(), mediaType: 'image/gif' }));
    const wrongType = await post({ images: gifs });
    expect(wrongType).toMatchObject({ status: 400, body: { error: 'Up to 4 photos.' } });
    expect(wrongType.calls).toHaveLength(0);
  });

  it('rejects other image types', async () => {
    for (const mediaType of ['image/gif', 'image/heic', 'application/pdf']) {
      const result = await post({ images: [{ ...jpeg(), mediaType }] });
      expect(result, mediaType).toMatchObject({
        status: 400,
        body: { error: 'Photos must be JPEG, PNG, or WebP.' },
      });
      expect(result.calls).toHaveLength(0);
    }

    const upper = await post({ images: [{ ...jpeg(), mediaType: 'IMAGE/JPEG' }] });
    expect(upper.status).toBe(200);
    expect(sentParts(upper.calls)[0].inlineData?.mimeType).toBe('image/jpeg');
  });

  it('rejects photos it cannot read', async () => {
    const cases: [string, unknown][] = [
      ['a string', 'x'],
      ['an object', {}],
      ['a null element', [null]],
      ['no base64', [{ mediaType: 'image/jpeg' }]],
      ['numeric base64', [{ mediaType: 'image/jpeg', base64: 7 }]],
      ['empty base64', [{ mediaType: 'image/jpeg', base64: '' }]],
      ['a data URL', [{ mediaType: 'image/jpeg', base64: `data:image/jpeg;base64,${jpeg().base64}` }]],
      ['base64url', [{ mediaType: 'image/jpeg', base64: jpeg().base64.replace(/\//g, '_') }]],
      ['PNG bytes labelled JPEG', [{ ...png(), mediaType: 'image/jpeg' }]],
      ['too short for WebP', [{ mediaType: 'image/webp', base64: '/9j/' }]],
    ];
    for (const [label, images] of cases) {
      const result = await post({ images });
      expect(result, label).toMatchObject({
        status: 400,
        body: { error: "Those photos couldn't be read." },
      });
      expect(result.calls, label).toHaveLength(0);
    }
  });

  it('accepts WebP by its magic bytes', async () => {
    expect((await post({ images: [webp()] })).status).toBe(200);
  });

  it('caps each photo at 3 MB decoded', async () => {
    const atCap = await post({ images: [jpeg(MAX_IMPORT_IMAGE_BYTES)] });
    expect(atCap.status).toBe(200);

    const over = await post({ images: [jpeg(MAX_IMPORT_IMAGE_BYTES + 1)] });
    expect(over).toMatchObject({ status: 413, body: { error: 'Those photos are too large.' } });
    expect(over.calls).toHaveLength(0);
  });

  it('accepts four typical photos', async () => {
    const result = await post({ images: Array.from({ length: 4 }, () => jpeg(2 * 1024 * 1024)) });
    expect(result.status).toBe(200);
    expect(sentParts(result.calls).filter((part) => part.inlineData)).toHaveLength(4);
  });

  it('rejects four photos at the per-photo cap by body size', async () => {
    const result = await post({
      images: Array.from({ length: 4 }, () => jpeg(MAX_IMPORT_IMAGE_BYTES)),
    });
    expect(result).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(result.calls).toHaveLength(0);
  });

  it('caps the request body at 12 MB', async () => {
    const declared = await post(undefined, undefined, {
      rawBody: '{}',
      headers: { 'Content-Length': String(MAX_IMPORT_BODY_BYTES + 1) },
    });
    expect(declared).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(declared.calls).toHaveLength(0);

    const rawBody = JSON.stringify({ text: 'x'.repeat(MAX_IMPORT_BODY_BYTES) });
    expect(rawBody.length).toBeGreaterThan(MAX_IMPORT_BODY_BYTES);
    const streamed = await post(undefined, undefined, { rawBody });
    expect(streamed).toMatchObject({
      status: 413,
      body: { error: "That's too large to import — try fewer photos." },
    });
    expect(streamed.calls).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    for (const rawBody of ['not json', '', '[]', '"x"']) {
      const result = await post(undefined, undefined, { rawBody });
      expect(result, JSON.stringify(rawBody)).toMatchObject({
        status: 400,
        body: { error: 'Bad request' },
      });
      expect(result.calls).toHaveLength(0);
    }
  });

  it('maps photo outcomes to photo copy', async () => {
    const images = [jpeg()];
    expect(await post({ images }, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in those photos." },
    });
    expect(await post({ images }, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.' },
    });
    expect(await post({ images }, JSON.stringify({ servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.' },
    });
  });

  it('reports a Gemini failure on photos as 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await post({ images: [jpeg()] }, undefined, {
      deps: rejectingDeps('upstream down'),
    });
    expect(result).toMatchObject({
      status: 502,
      body: { error: "Couldn't read those photos — try again." },
    });
  });

  it('never logs photo data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    Buffer.from(JPEG_MAGIC).copy(bytes);
    const photo = { mediaType: 'image/jpeg', base64: bytes.toString('base64') };
    const secret = 'SECRET-UPSTREAM-DETAIL';

    const logged = () =>
      [...log.mock.calls, ...error.mock.calls]
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : `${String(arg)} ${JSON.stringify(arg)}`));
    const expectNoPhotoData = () => {
      for (const text of logged()) {
        expect(text).not.toContain(secret);
        for (let i = 0; i + 16 <= photo.base64.length; i++) {
          if (text.includes(photo.base64.slice(i, i + 16))) {
            throw new Error(`logged a slice of the photo at ${i}`);
          }
        }
      }
    };

    expect((await post({ images: [photo] })).status).toBe(200);
    expect(importLogLines().map((line) => line.entry)).toEqual([
      {
        event: 'import',
        sub: 'sub-1',
        via: 'photos',
        photos: 1,
        bytes: 4096,
        outcome: 'ok',
        ingredients: 1,
        steps: 2,
        status: 200,
        ms: expect.any(Number),
      },
    ]);
    expect(error).not.toHaveBeenCalled();
    expectNoPhotoData();

    log.mockClear();
    const failed = await post({ images: [photo] }, undefined, { deps: rejectingDeps(secret, 503) });
    expect(failed.status).toBe(502);
    expect(importLogLines().map((line) => line.entry)).toEqual([
      expect.objectContaining({
        via: 'photos',
        photos: 1,
        bytes: 4096,
        outcome: 'threw',
        errorStatus: 503,
        status: 502,
      }),
    ]);
    expect(error).not.toHaveBeenCalled();
    expectNoPhotoData();
  });
});

describe('POST /api/import log line', () => {
  it('logs a URL import with the account and the address, never its query or the recipe', async () => {
    serve(PAGE);
    const result = await post({ url: 'https://example.com/soup?user_id=u-77&code=c-88#step-2' });
    expect(result.status).toBe(200);
    const lines = importLogLines();
    expect(lines.map((line) => line.entry)).toEqual([
      {
        event: 'import',
        sub: 'sub-1',
        via: 'url',
        url: 'https://example.com/soup',
        host: 'example.com',
        fetch: 'ok',
        source: 'text',
        attempts: ['ok'],
        outcome: 'ok',
        ingredients: 1,
        steps: 2,
        status: 200,
        ms: expect.any(Number),
      },
    ]);
    for (const leaked of ['u-77', 'c-88', 'step-2', 'Tomato', 'tomatoes', 'Simmer']) {
      expect(lines[0].raw).not.toContain(leaked);
    }
  });

  it('logs a site that refused the fetch, with its status', async () => {
    serve('blocked', 403);
    expect((await post({ url: 'https://example.com/soup' })).status).toBe(422);
    expect(importLogLines().map((line) => line.entry)).toEqual([
      expect.objectContaining({
        via: 'url',
        url: 'https://example.com/soup',
        fetch: 'refused',
        siteStatus: 403,
        outcome: 'fetch_failed',
        status: 422,
      }),
    ]);
  });

  it('logs a refused address as blocked, without the address it resolved to', async () => {
    network.deps = fakePageFetch({ dns: { 'intranet.example': ['10.20.30.40'] }, pages: {} }).deps;
    expect((await post({ url: 'https://intranet.example/admin?token=t-99' })).status).toBe(422);
    const lines = importLogLines();
    expect(lines.map((line) => line.entry)).toEqual([
      expect.objectContaining({
        via: 'url',
        url: 'https://intranet.example/admin',
        fetch: 'blocked',
        outcome: 'fetch_failed',
        status: 422,
      }),
    ]);
    for (const leaked of ['10.20.30.40', 't-99']) {
      expect(lines[0].raw).not.toContain(leaked);
    }
  });

  it('logs a recipe with no steps as ok with steps 0', async () => {
    serve(PAGE);
    await post({ url: 'https://example.com/soup' }, JSON.stringify({ ...RECIPE, steps: [] }));
    expect(importLogLines()[0].entry).toMatchObject({ outcome: 'ok', ingredients: 1, steps: 0 });
  });

  it('logs a Gemini throw on a URL import as model_error with its status, and answers 502', async () => {
    serve(PAGE);
    const result = await post({ url: 'https://example.com/soup' }, undefined, {
      deps: rejectingDeps('SECRET upstream detail', 429),
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: 'import-model-failed' });
    expect(JSON.stringify(result.body)).not.toContain('SECRET');
    const lines = importLogLines();
    expect(lines.map((line) => line.entry)).toEqual([
      expect.objectContaining({
        via: 'url',
        fetch: 'ok',
        source: 'text',
        attempts: ['threw'],
        outcome: 'model_error',
        errorStatus: 429,
        status: 502,
      }),
    ]);
    expect(lines[0].raw).not.toContain('SECRET');
  });

  it('logs the warning codes on a URL import, and sends them to the client', async () => {
    serve('<main><h1>Soup</h1><p>You need tomatoes. Watch the video.</p></main>');
    const result = await post(
      { url: 'https://example.com/soup' },
      JSON.stringify({ ...RECIPE, steps: [], instructionsOnPage: false }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ warnings: [{ code: 'INSTRUCTIONS_NOT_ON_PAGE' }] });
    expect(importLogLines()[0].entry).toMatchObject({
      source: 'text',
      attempts: ['warn'],
      codes: ['INSTRUCTIONS_NOT_ON_PAGE'],
    });
  });

  it('logs pasted text without the text', async () => {
    await post({ text: 'Grandma secret soup: simmer.' });
    const lines = importLogLines();
    expect(lines.map((line) => line.entry)).toEqual([
      expect.objectContaining({ sub: 'sub-1', via: 'paste', outcome: 'ok', status: 200 }),
    ]);
    expect(lines[0].entry).not.toHaveProperty('url');
    expect(lines[0].raw).not.toContain('Grandma');
  });

  it('logs a request it could not read', async () => {
    await post(undefined, undefined, { rawBody: '{' });
    expect(importLogLines().map((line) => line.entry)).toEqual([
      expect.objectContaining({ sub: 'sub-1', outcome: 'bad_request', status: 400 }),
    ]);
  });
});
