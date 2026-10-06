import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importFeedbackPost,
  readImportFeedback,
  resetImportFeedbackRateLimitForTest,
  type ImportFeedbackDeps,
} from './importFeedback.ts';

const UUID = '00000000-0000-4000-8000-000000000000';
const NOW = 1_700_000_000_000;
const CTX = { authorizedSub: 'sub-1' };

function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUndefined);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasUndefined);
  return false;
}

function fakeDeps() {
  const create = vi.fn<ImportFeedbackDeps['create']>(async () => {});
  const deps: ImportFeedbackDeps = { create, now: () => NOW };
  return { deps, create };
}

function request(body: unknown, rawBody?: string): Request {
  return new Request('http://localhost/api/import-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  resetImportFeedbackRateLimitForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

describe('readImportFeedback', () => {
  it('rejects a body that is not an object', () => {
    expect(readImportFeedback(null)).toStrictEqual({ kind: 'bad' });
    expect(readImportFeedback([])).toStrictEqual({ kind: 'bad' });
    expect(readImportFeedback('x')).toStrictEqual({ kind: 'bad' });
  });

  it('rejects an unknown trigger or via', () => {
    expect(readImportFeedback({ id: UUID, trigger: 'meh', via: 'url' })).toStrictEqual({ kind: 'bad' });
    expect(readImportFeedback({ id: UUID, trigger: 'failed', via: 'fax' })).toStrictEqual({
      kind: 'bad',
    });
  });

  it('reads a thumbs up as its via and host only', () => {
    expect(
      readImportFeedback({ trigger: 'up', via: 'url', url: 'https://www.example.com/r?x=1' }),
    ).toStrictEqual({ kind: 'up', via: 'url', host: 'www.example.com' });
    expect(readImportFeedback({ trigger: 'up', via: 'paste' })).toStrictEqual({
      kind: 'up',
      via: 'paste',
    });
  });

  it('rejects a report without a UUID id', () => {
    expect(readImportFeedback({ trigger: 'failed', via: 'url' })).toStrictEqual({ kind: 'bad' });
    expect(readImportFeedback({ id: 'a/b', trigger: 'failed', via: 'url' })).toStrictEqual({
      kind: 'bad',
    });
  });

  it('reads a minimal report', () => {
    expect(
      readImportFeedback({ id: UUID, trigger: 'failed', via: 'url', locale: 'en' }),
    ).toStrictEqual({
      kind: 'report',
      id: UUID,
      fields: { trigger: 'failed', via: 'url', locale: 'en' },
    });
  });

  it('drops malformed fields and keeps the report', () => {
    const parsed = readImportFeedback({
      id: UUID,
      trigger: 'warnings',
      via: 'paste',
      url: 'javascript:alert(1)',
      photos: 3,
      error: { code: 'BAD CODE', status: 99, siteStatus: 403, message: 7 },
      result: { recipeJson: 5, warnings: [{ code: 'NOPE' }, { code: 'MISSING_TITLE' }] },
      comment: 42,
      locale: 'xx',
      sub: 'evil',
    });
    expect(parsed).toStrictEqual({
      kind: 'report',
      id: UUID,
      fields: {
        trigger: 'warnings',
        via: 'paste',
        error: { siteStatus: 403 },
        result: { warnings: [{ code: 'MISSING_TITLE' }] },
      },
    });
    expect(hasUndefined(parsed)).toBe(false);
  });

  it('keeps pastedText only for paste and generate, and photos only for photos', () => {
    const url = readImportFeedback({ id: UUID, trigger: 'failed', via: 'url', pastedText: 'x' });
    expect(url.kind === 'report' && 'pastedText' in url.fields).toBe(false);
    const paste = readImportFeedback({ id: UUID, trigger: 'failed', via: 'paste', photos: 2 });
    expect(paste.kind === 'report' && 'photos' in paste.fields).toBe(false);
    const generate = readImportFeedback({
      id: UUID,
      trigger: 'down',
      via: 'generate',
      pastedText: 'gumbo in a pressure cooker',
      photos: 2,
    });
    expect(generate.kind === 'report' && generate.fields).toMatchObject({
      via: 'generate',
      pastedText: 'gumbo in a pressure cooker',
    });
    expect(generate.kind === 'report' && 'photos' in generate.fields).toBe(false);
  });

  it('truncates pasted text and recipe JSON as a backstop', () => {
    const parsed = readImportFeedback({
      id: UUID,
      trigger: 'warnings',
      via: 'paste',
      pastedText: 'x'.repeat(150_001),
      result: { recipeJson: 'y'.repeat(200_001) },
    });
    if (parsed.kind !== 'report') throw new Error('expected a report');
    expect(parsed.fields.pastedText?.length).toBe(150_000);
    expect(parsed.fields.pastedTruncated).toBe(true);
    expect(parsed.fields.result?.recipeJson?.length).toBe(200_000);
    expect(parsed.fields.result?.recipeTruncated).toBe(true);
  });

  it('strips credentials inside recipeJson, parsable or cut', () => {
    const read = (recipeJson: string) => {
      const parsed = readImportFeedback({ id: UUID, trigger: 'down', via: 'url', result: { recipeJson } });
      if (parsed.kind !== 'report') throw new Error('expected a report');
      return parsed.fields.result?.recipeJson;
    };
    expect(read('{"title":"Cake","sourceUrl":"https://user:s3cret@recipes.example/cake?x=1"}')).toBe(
      '{"title":"Cake","sourceUrl":"https://recipes.example/cake?x=1"}',
    );
    expect(read('{"title":"Cake","sourceUrl":"https://user:s3cret@rec')).toBe(
      '{"title":"Cake","sourceUrl":"https://rec',
    );
  });

  it('strips credentials from the url', () => {
    const parsed = readImportFeedback({
      id: UUID,
      trigger: 'failed',
      via: 'url',
      url: 'https://u:p@example.com/r?id=1',
    });
    expect(parsed.kind === 'report' && parsed.fields.url).toBe('https://example.com/r?id=1');
  });

  it('trims, drops, and caps the comment', () => {
    const read = (comment: string) => {
      const parsed = readImportFeedback({ id: UUID, trigger: 'down', via: 'url', comment });
      if (parsed.kind !== 'report') throw new Error('expected a report');
      return parsed.fields;
    };
    expect(read('  note  ').comment).toBe('note');
    expect('comment' in read('   ')).toBe(false);
    expect(read('a'.repeat(2500)).comment?.length).toBe(2000);
  });

  it('omits an error or result with nothing valid in it', () => {
    const parsed = readImportFeedback({
      id: UUID,
      trigger: 'failed',
      via: 'url',
      error: { code: 'x y' },
      result: { translationFailed: 'yes' },
    });
    if (parsed.kind !== 'report') throw new Error('expected a report');
    expect('error' in parsed.fields).toBe(false);
    expect('result' in parsed.fields).toBe(false);
  });
});

describe('importFeedbackPost', () => {
  it('stores a valid report under the session sub', async () => {
    const { deps, create } = fakeDeps();
    const response = await importFeedbackPost(
      request({
        id: UUID,
        trigger: 'failed',
        via: 'url',
        url: 'https://example.com/r',
        locale: 'en',
        sub: 'evil',
      }),
      CTX,
      deps,
    );
    expect(response.status).toBe(204);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(UUID, {
      v: 1,
      sub: 'sub-1',
      createdAt: NOW,
      expireAt: new Date(NOW + 180 * 86_400_000),
      trigger: 'failed',
      via: 'url',
      url: 'https://example.com/r',
      locale: 'en',
    });
  });

  it('stores nothing for a thumbs up', async () => {
    const { deps, create } = fakeDeps();
    const response = await importFeedbackPost(
      request({ trigger: 'up', via: 'url', url: 'https://example.com/r' }),
      CTX,
      deps,
    );
    expect(response.status).toBe(204);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a body over 512 KiB', async () => {
    const { deps } = fakeDeps();
    const response = await importFeedbackPost(
      request(undefined, 'x'.repeat(512 * 1024 + 1)),
      CTX,
      deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'feedback-too-large' });
  });

  it('rejects bad JSON and a bad trigger', async () => {
    const { deps } = fakeDeps();
    const broken = await importFeedbackPost(request(undefined, '{'), CTX, deps);
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ code: 'feedback-bad-request' });
    const meh = await importFeedbackPost(request({ id: UUID, trigger: 'meh', via: 'url' }), CTX, deps);
    expect(meh.status).toBe(400);
    expect(await meh.json()).toMatchObject({ code: 'feedback-bad-request' });
  });

  it('treats ALREADY_EXISTS as success', async () => {
    const { deps, create } = fakeDeps();
    create.mockRejectedValueOnce(Object.assign(new Error('6 ALREADY_EXISTS: x'), { code: 6 }));
    const response = await importFeedbackPost(
      request({ id: UUID, trigger: 'failed', via: 'url' }),
      CTX,
      deps,
    );
    expect(response.status).toBe(204);
  });

  it('answers 503 on a store failure and logs only its code', async () => {
    const { deps, create } = fakeDeps();
    create.mockRejectedValueOnce(
      Object.assign(new Error('14 UNAVAILABLE: secret text'), { code: 14 }),
    );
    const response = await importFeedbackPost(
      request({ id: UUID, trigger: 'failed', via: 'url' }),
      CTX,
      deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ error: 'Store unavailable' });
    const [line] = loggedLines();
    expect(JSON.parse(line)).toMatchObject({ errorCode: 14, status: 503 });
    expect(line).not.toContain('secret text');
  });

  it('rethrows anything unexpected without its message', async () => {
    const { deps } = fakeDeps();
    const req = new Request('http://localhost/api/import-feedback', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error('secret text'));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const err = await importFeedbackPost(req, CTX, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith('Import failed:')).toBe(true);
    expect((err as Error).message).not.toContain('secret text');
    expect(JSON.parse(loggedLines()[0])).toMatchObject({ status: 500 });
  });

  it('rate-limits each sub to 20 an hour', async () => {
    const { deps } = fakeDeps();
    const post = (sub: string) =>
      importFeedbackPost(
        request({ id: crypto.randomUUID(), trigger: 'failed', via: 'url' }),
        { authorizedSub: sub },
        deps,
      );
    for (let i = 0; i < 20; i++) {
      expect((await post('sub-1')).status).toBe(204);
    }
    const limited = await post('sub-1');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'feedback-rate-limited' });
    expect((await post('sub-2')).status).toBe(204);
  });

  it('logs one line with no path, text, or comment', async () => {
    const { deps } = fakeDeps();
    await importFeedbackPost(
      request({
        id: UUID,
        trigger: 'warnings',
        via: 'url',
        url: 'https://www.example.com/path/secret?q=1',
        comment: 'my note',
        result: { recipeJson: '{"title":"Soup"}', warnings: [{ code: 'MISSING_TITLE' }] },
      }),
      CTX,
      deps,
    );
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    const { ms, ...rest } = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(typeof ms).toBe('number');
    expect(rest).toStrictEqual({
      event: 'import_feedback',
      sub: 'sub-1',
      trigger: 'warnings',
      via: 'url',
      host: 'www.example.com',
      codes: ['MISSING_TITLE'],
      hasComment: true,
      status: 204,
    });
    for (const secret of ['/path/secret', 'q=1', 'my note', 'Soup']) {
      expect(lines[0]).not.toContain(secret);
    }
  });
});
