import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importLogLine,
  loggableUrl,
  noteImportOutcome,
  sanitizedImportError,
  thrownStatus,
  withImportLog,
  type ImportLogEntry,
} from './importLog.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loggableUrl', () => {
  it('keeps origin and path, and drops the query string, fragment, and credentials', () => {
    expect(
      loggableUrl('https://user:secret@cooking.example.com/recipes/42-stew?user_id=abc&code=x#step-2'),
    ).toEqual({ url: 'https://cooking.example.com/recipes/42-stew', host: 'cooking.example.com' });
  });

  it('keeps a non-default port in the url', () => {
    expect(loggableUrl(' http://example.com:8080/soup ')).toEqual({
      url: 'http://example.com:8080/soup',
      host: 'example.com',
    });
  });

  it('logs nothing for anything that is not an http(s) URL', () => {
    for (const raw of [undefined, 42, '', 'not a url', 'ftp://example.com/x', 'javascript:alert(1)']) {
      expect(loggableUrl(raw)).toBeUndefined();
    }
  });
});

describe('thrownStatus', () => {
  it('reads an integer HTTP status from an error', () => {
    expect(thrownStatus(Object.assign(new Error('quota'), { status: 429 }))).toBe(429);
  });

  it('ignores a missing, non-numeric, or out-of-range status', () => {
    for (const err of [
      new Error('x'),
      Object.assign(new Error('x'), { status: '429' }),
      Object.assign(new Error('x'), { status: 42 }),
      Object.assign(new Error('x'), { status: 503.5 }),
      'boom',
      null,
    ]) {
      expect(thrownStatus(err)).toBeUndefined();
    }
  });
});

describe('noteImportOutcome', () => {
  it('records counts and the translation result for a recipe', () => {
    const entry: ImportLogEntry = {};
    noteImportOutcome(entry, {
      kind: 'ok',
      recipe: {
        title: 'Soup',
        servings: 2,
        ingredientSections: [{ items: [{ item: 'a' }, { item: 'b' }] }, { items: [{ item: 'c' }] }],
        steps: [],
        tags: [],
      },
      translation: { kind: 'failed' },
      warnings: [],
    });
    expect(entry).toEqual({ outcome: 'ok', ingredients: 3, steps: 0, translation: 'failed' });
  });

  it('records only the kind for a failure', () => {
    const entry: ImportLogEntry = {};
    noteImportOutcome(entry, { kind: 'parse_error' });
    expect(entry).toEqual({ outcome: 'parse_error' });
  });

  it('records how the page was read, each attempt, and the warning codes, never positions', () => {
    const entry: ImportLogEntry = {};
    noteImportOutcome(entry, {
      kind: 'ok',
      recipe: {
        title: 'Soup',
        servings: 2,
        ingredientSections: [{ items: [{ item: 'saffron' }] }],
        steps: [],
        tags: [],
      },
      warnings: [
        { code: 'INSTRUCTIONS_NOT_ON_PAGE' },
        { code: 'UNGROUNDED_INGREDIENT', at: [0, 0] },
      ],
      log: {
        source: 'text',
        attempts: [{ result: 'warn', codes: ['INSTRUCTIONS_NOT_ON_PAGE', 'UNGROUNDED_INGREDIENT'] }],
      },
    });
    expect(entry).toEqual({
      outcome: 'ok',
      source: 'text',
      attempts: ['warn'],
      codes: ['INSTRUCTIONS_NOT_ON_PAGE', 'UNGROUNDED_INGREDIENT'],
      ingredients: 1,
      steps: 0,
    });
    expect(JSON.stringify(entry)).not.toContain('saffron');
  });

  it('records a model error with its status', () => {
    const entry: ImportLogEntry = {};
    noteImportOutcome(entry, {
      kind: 'model_error',
      log: { source: 'jsonld', attempts: [{ result: 'threw', codes: [] }], errorStatus: 503 },
    });
    expect(entry).toEqual({
      outcome: 'model_error',
      source: 'jsonld',
      attempts: ['threw'],
      errorStatus: 503,
    });
  });
});

describe('importLogLine', () => {
  it('is one JSON object tagged as an import event, without undefined fields', () => {
    const line = importLogLine({ sub: 's', via: 'paste', outcome: 'ok', url: undefined });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ event: 'import', sub: 's', via: 'paste', outcome: 'ok' });
  });
});

describe('withImportLog', () => {
  it('logs the status and duration once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await withImportLog({ sub: 's' }, () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: 'import',
      sub: 's',
      status: 204,
      ms: expect.any(Number),
    });
  });

  it('logs a throw with its status but not its message, and rethrows it sanitized', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = Object.assign(new Error('SECRET request echo'), { status: 503 });
    const thrown = await withImportLog({ sub: 's' }, () => Promise.reject(err)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(err);
    expect((thrown as Error).message).toBe('Import failed: Error (status 503); message withheld');
    expect(String((thrown as Error).stack)).not.toContain('SECRET');
    expect((thrown as Error).cause).toBeUndefined();
    const line = String(log.mock.calls[0][0]);
    expect(line).not.toContain('SECRET');
    expect(JSON.parse(line)).toMatchObject({ outcome: 'threw', errorStatus: 503, status: 500 });
  });
});

describe('sanitizedImportError', () => {
  it('keeps a plain class name and status and drops everything else', () => {
    class ApiError extends Error {
      status = 429;
    }
    const err = new ApiError('quota exceeded for {"contents":"SECRET pasted recipe"}');
    err.name = 'ApiError';
    const safe = sanitizedImportError(err);
    expect(safe.message).toBe('Import failed: ApiError (status 429); message withheld');
    expect(String(safe.stack)).not.toContain('SECRET');
  });

  it('does not trust an odd class name or a non-error value', () => {
    const odd = new Error('x');
    odd.name = 'SECRET text: with spaces';
    expect(sanitizedImportError(odd).message).toBe('Import failed: Error; message withheld');
    expect(sanitizedImportError('SECRET string').message).toBe(
      'Import failed: string; message withheld',
    );
  });
});
