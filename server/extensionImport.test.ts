import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionImport, isExtensionOrigin } from './extensionImport.ts';
import { fakeImportDeps } from '../test/fakeGemini.ts';
import {
  IMPORT_BAD_LANGUAGE_CODE,
  IMPORT_BAD_LANGUAGE_ERROR,
  type RecipeImportDeps,
} from './recipeImport.ts';
import * as recipeImport from './recipeImport.ts';
import { SESSION_HEADER_NAME, signSession } from './session.ts';
import * as sync from './sync.ts';
import { TRANSLATE_FAILED, type TranslateInput, type TranslateOutcome } from './translate.ts';
import { abortedRequest } from '../test/abortedBody.ts';
import { endlessBody } from '../test/endlessBody.ts';
import {
  LLM_DAILY_BUDGET_MICRO_USD,
  memoryLlmUsageStore,
  setLlmBudgetForTest,
  utcDayKey,
} from './llmBudget.ts';

// Model routes admit against the daily budget; keep it off Firestore.
let llmUsage: ReturnType<typeof memoryLlmUsageStore>;
beforeEach(() => {
  llmUsage = memoryLlmUsageStore();
  setLlmBudgetForTest({ store: llmUsage });
});
afterEach(() => setLlmBudgetForTest(null));

// Spied rather than replaced: the assertion that matters is that empty html
// short-circuits *before* the import pipeline. Without this the tests pass with
// the guard deleted, because an empty source answers with the same 422.
vi.mock('./recipeImport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recipeImport.ts')>();
  return {
    ...actual,
    importFromHtml: vi.fn(actual.importFromHtml),
  };
});

vi.mock('./sync.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync.ts')>();
  return {
    ...actual,
    applyPushOp: vi.fn(actual.applyPushOp),
  };
});

const realApplyPushOp = vi.mocked(sync.applyPushOp).getMockImplementation();

const SESSION_ENV = {
  SESSION_SECRET: 'test-secret-for-session-hmac',
  ALLOWED_EMAILS: 'allowed@example.com',
};

function authedRequest(body: unknown): Request {
  const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
  return new Request('http://localhost/api/extension/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_HEADER_NAME]: token,
    },
    body: JSON.stringify(body),
  });
}

describe('isExtensionOrigin', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';

  it('accepts a real extension origin', () => {
    expect(isExtensionOrigin(`chrome-extension://${id}`)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const origin of [
      null,
      '',
      'https://sous.kyrylo.lol',
      'http://localhost:5173',
      `chrome-extension://${id.slice(0, 31)}`,
      `chrome-extension://${id}q`,
      `chrome-extension://${id.toUpperCase()}`,
      `chrome-extension://${id}/popup.html`,
      `chrome-extension://${id} https://evil.example`,
      `moz-extension://${id}`,
      `chrome-extension://${id.slice(0, 30)}12`,
    ]) {
      expect(isExtensionOrigin(origin)).toBe(false);
    }
  });
});

describe('extensionImport html is required', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectRejectedUnread(body: unknown): Promise<void> {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(recipeImport.importFromHtml).mockClear();
    const { deps, calls } = fakeImportDeps(undefined);
    const response = await extensionImport(authedRequest(body), deps);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Could not read that page.',
      code: 'import-unreadable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recipeImport.importFromHtml).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  }

  it('rejects missing html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example' });
  });

  it('rejects empty html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example', html: '' });
  });

  it('rejects whitespace html without fetching or extracting', async () => {
    await expectRejectedUnread({ url: 'https://apnews.com/article/example', html: '  \n\t  ' });
  });
});

describe('extensionImport maps import outcomes', () => {
  const url = 'https://example.com/soup';
  const page = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';

  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  async function post(html: string, reply: string | undefined) {
    const { deps, calls } = fakeImportDeps(reply);
    const response = await extensionImport(authedRequest({ url, html }), deps);
    return { status: response.status, body: (await response.json()) as unknown, calls };
  }

  it('answers a page with no text as unreadable, without calling the model', async () => {
    const result = await post('<html><body><script>x()</script></body></html>', '{}');
    expect(result).toMatchObject({
      status: 422,
      body: { error: 'Could not read that page.', code: 'import-unreadable' },
    });
    expect(result.calls).toHaveLength(0);
  });

  it('answers NOT_A_RECIPE with 422', async () => {
    expect(await post(page, JSON.stringify({ title: 'NOT_A_RECIPE' }))).toMatchObject({
      status: 422,
      body: { error: "Couldn't find a recipe in that content.", code: 'import-no-recipe' },
    });
  });

  it('answers unparseable model output with 502', async () => {
    expect(await post(page, 'not json')).toMatchObject({
      status: 502,
      body: { error: 'Extraction failed — no structured result.', code: 'import-extract-failed' },
    });
  });

  it('answers a recipe with no title as unusable', async () => {
    expect(await post(page, JSON.stringify({ title: ' ', servings: 2 }))).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.', code: 'import-unusable' },
    });
  });

  it('answers a recipe too large to push as unusable', async () => {
    const huge = JSON.stringify({ title: 'Soup', servings: 2, notes: 'x'.repeat(200_000) });
    expect(await post(page, huge)).toMatchObject({
      status: 502,
      body: { error: 'Extraction produced an unusable recipe.', code: 'import-unusable' },
    });
  });
});

describe('extensionImport translateTo', () => {
  const url = 'https://example.com/soup';
  const page = '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>';
  const italian = {
    title: 'Tomato soup',
    servings: 4,
    ingredientSections: [{ items: [{ item: 'tomatoes', quantity: 6 }] }],
    steps: [{ text: 'Simmer.' }],
    tags: ['soup'],
    lang: 'it',
  };

  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
    vi.mocked(recipeImport.importFromHtml).mockClear();
    vi.mocked(sync.applyPushOp).mockReset();
    vi.mocked(sync.applyPushOp).mockResolvedValue({ applied: true });
  });

  afterEach(() => {
    vi.mocked(sync.applyPushOp).mockReset();
    if (realApplyPushOp) {
      vi.mocked(sync.applyPushOp).mockImplementation(realApplyPushOp);
    }
  });

  function prefixTranslator(): (input: TranslateInput) => Promise<TranslateOutcome> {
    return (input) =>
      Promise.resolve({
        ok: true,
        detectedLang: 'it',
        segments: input.segments.map((segment) => ({
          id: segment.id,
          text: `UK ${segment.text}`,
        })),
      });
  }

  it('rejects an unsupported translateTo before extraction', async () => {
    const { deps, calls } = fakeImportDeps(JSON.stringify(italian));
    const response = await extensionImport(
      authedRequest({ url, html: page, translateTo: 'fr' }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: IMPORT_BAD_LANGUAGE_ERROR,
      code: IMPORT_BAD_LANGUAGE_CODE,
    });
    expect(recipeImport.importFromHtml).not.toHaveBeenCalled();
    expect(sync.applyPushOp).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('forwards translateTo and saves the translation', async () => {
    const { deps } = fakeImportDeps(JSON.stringify(italian), prefixTranslator());
    const response = await extensionImport(
      authedRequest({ url, html: page, translateTo: 'uk' }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      title: 'UK Tomato soup',
      translated: true,
    });
    // The route passes a metered copy of the deps (server/llmBudget.ts).
    expect(recipeImport.importFromHtml).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ model: deps.model, translator: deps.translator }),
      'uk',
    );
    expect(sync.applyPushOp).toHaveBeenCalledWith('sub-1', {
      kind: 'recipe.put',
      payload: expect.objectContaining({
        title: 'UK Tomato soup',
        lang: 'uk',
        sourceUrl: url,
      }),
    });
  });

  it('saves the original when translation fails', async () => {
    const { deps } = fakeImportDeps(JSON.stringify(italian), () =>
      Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
    );
    const response = await extensionImport(
      authedRequest({ url, html: page, translateTo: 'uk' }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      title: 'Tomato soup',
      translated: false,
    });
    // The route passes a metered copy of the deps (server/llmBudget.ts).
    expect(recipeImport.importFromHtml).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ model: deps.model, translator: deps.translator }),
      'uk',
    );
    expect(sync.applyPushOp).toHaveBeenCalledWith('sub-1', {
      kind: 'recipe.put',
      payload: expect.objectContaining({
        title: 'Tomato soup',
        lang: 'it',
        sourceUrl: url,
      }),
    });
  });
});

function importLogEntries(log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return log.mock.calls
    .map(([message]) => String(message))
    .filter((raw) => raw.startsWith('{"event":"import"'))
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

describe('extensionImport log line', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the account and the tab address without its query, and the outcome', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakeImportDeps(JSON.stringify({ title: 'NOT_A_RECIPE' }));
    const response = await extensionImport(
      authedRequest({
        url: 'https://example.com/soup?unlocked_article_code=k-99',
        html: '<html><body><main><p>Simmer the tomatoes.</p></main></body></html>',
      }),
      deps,
    );
    expect(response.status).toBe(422);
    expect(importLogEntries(log)).toEqual([
      {
        event: 'import',
        sub: 'sub-1',
        via: 'extension',
        url: 'https://example.com/soup',
        host: 'example.com',
        source: 'text',
        attempts: ['not_a_recipe'],
        outcome: 'not_a_recipe',
        status: 422,
        ms: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('k-99');
  });

  it('logs a recipe too large to push as unusable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const huge = JSON.stringify({ title: 'Soup', servings: 2, notes: 'x'.repeat(200_000) });
    const { deps } = fakeImportDeps(huge);
    await extensionImport(
      authedRequest({ url: 'https://example.com/soup', html: '<main><p>Soup.</p></main>' }),
      deps,
    );
    expect(importLogEntries(log)).toEqual([
      expect.objectContaining({ via: 'extension', outcome: 'unusable', status: 502 }),
    ]);
  });
});

describe('extensionImport body size', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 413 and stops reading a body over the limit, and logs it as too_large', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(recipeImport.importFromHtml).mockClear();
    const endless = endlessBody();
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
    const { deps, calls } = fakeImportDeps(undefined);
    const response = await extensionImport(
      new Request('http://localhost/api/extension/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SESSION_HEADER_NAME]: token },
        body: endless.body,
        duplex: 'half',
      } as RequestInit),
      deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Page was too large to import.',
      code: 'import-too-large',
    });
    expect(endless.cancelled()).toBe(false);
    expect(endless.read()).toBeLessThan(5_000_000);
    expect(recipeImport.importFromHtml).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(importLogEntries(log)).toEqual([
      expect.objectContaining({ via: 'extension', outcome: 'too_large', status: 413 }),
    ]);
  });
});

describe('extensionImport warnings', () => {
  const url = 'https://example.com/soup';

  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
    vi.mocked(sync.applyPushOp).mockReset();
    vi.mocked(sync.applyPushOp).mockResolvedValue({ applied: true });
  });

  afterEach(() => {
    vi.mocked(sync.applyPushOp).mockReset();
    if (realApplyPushOp) {
      vi.mocked(sync.applyPushOp).mockImplementation(realApplyPushOp);
    }
  });

  it('answers a Gemini throw as import-model-failed, with no error text in the body or the log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: RecipeImportDeps = {
      model: 'test-model',
      ai: {
        models: {
          generateContent: () =>
            Promise.reject(Object.assign(new Error('SECRET logged-in page text'), { status: 503 })),
        },
      },
      translator: () => Promise.resolve({ ok: false, code: TRANSLATE_FAILED }),
    };
    const response = await extensionImport(
      authedRequest({ url, html: '<main><p>Simmer the tomatoes.</p></main>' }),
      deps,
    );
    expect(response.status).toBe(502);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ code: 'import-model-failed' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(sync.applyPushOp).not.toHaveBeenCalled();
    expect(importLogEntries(log)).toEqual([
      expect.objectContaining({
        via: 'extension',
        attempts: ['threw'],
        outcome: 'model_error',
        errorStatus: 503,
        status: 502,
      }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });

  it('saves the warnings on the recipe as importCheck', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakeImportDeps(
      JSON.stringify({
        title: 'Tomato soup',
        servings: 4,
        ingredientSections: [{ items: [{ item: 'tomatoes' }] }],
        steps: [],
        tags: [],
        instructionsOnPage: false,
      }),
    );
    const response = await extensionImport(
      authedRequest({ url, html: '<main><p>You need tomatoes. Watch the video.</p></main>' }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(sync.applyPushOp).toHaveBeenCalledWith('sub-1', {
      kind: 'recipe.put',
      payload: expect.objectContaining({
        importCheck: { at: expect.any(Number), warnings: [{ code: 'INSTRUCTIONS_NOT_ON_PAGE' }] },
      }),
    });
  });

  it('saves a clean import without importCheck', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakeImportDeps(
      JSON.stringify({
        title: 'Tomato soup',
        servings: 4,
        ingredientSections: [{ items: [{ item: 'tomatoes' }] }],
        steps: [{ text: 'Simmer.' }, { text: 'Blend.' }],
        tags: [],
      }),
    );
    await extensionImport(
      authedRequest({ url, html: '<main><p>Simmer the tomatoes. Blend.</p></main>' }),
      deps,
    );
    const payload = vi.mocked(sync.applyPushOp).mock.calls[0][1].payload;
    expect(payload).not.toHaveProperty('importCheck');
  });
});

describe('extensionImport when the client hangs up mid-upload', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 400 and logs aborted, never a 500, a throw, or the error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recipeImport.importFromHtml).mockClear();
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
    const response = await extensionImport(
      abortedRequest('http://localhost/api/extension/import', { [SESSION_HEADER_NAME]: token }),
      fakeImportDeps(undefined).deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'bad-request' });
    expect(recipeImport.importFromHtml).not.toHaveBeenCalled();
    expect(importLogEntries(log)).toEqual([
      { event: 'import', sub: 'sub-1', via: 'extension', outcome: 'aborted', status: 400, ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a body it cannot start reading as bad_request, not aborted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = authedRequest({ url: 'https://example.com/soup', html: '<main>Soup.</main>' });
    req.body?.getReader();
    const response = await extensionImport(req, fakeImportDeps(undefined).deps);
    expect(response.status).toBe(400);
    expect(importLogEntries(log)).toEqual([
      expect.objectContaining({ outcome: 'bad_request', status: 400 }),
    ]);
  });
});

describe('extensionImport daily AI budget', () => {
  beforeEach(() => {
    Object.assign(process.env, SESSION_ENV);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses over the budget, readable by the extension, without calling the model', async () => {
    llmUsage.spent.set(`sub-1/${utcDayKey(Date.now())}`, LLM_DAILY_BUDGET_MICRO_USD);
    const { deps, calls } = fakeImportDeps('{}');
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const req = authedRequest({ url: 'https://example.com/soup', html: '<p>Simmer.</p>' });
    req.headers.set('origin', origin);
    const response = await extensionImport(req, deps);
    expect(response.status).toBe(429);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(await response.json()).toMatchObject({ code: 'llm-budget-exceeded' });
    expect(calls).toHaveLength(0);
  });
});
