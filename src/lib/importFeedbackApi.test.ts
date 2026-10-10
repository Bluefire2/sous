import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportFeedbackReport } from '../../server/importFeedbackShape.ts';
import { t } from '../i18n';
import { sendImportFeedback } from './importFeedbackApi';
import * as session from './session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const report: ImportFeedbackReport = {
  id: '00000000-0000-4000-8000-000000000000',
  trigger: 'failed',
  via: 'url',
  url: 'https://example.com/r',
  locale: 'en',
};

describe('sendImportFeedback', () => {
  it('posts the report as JSON and resolves on 204', async () => {
    const fetchMock = respond(204, null);
    await expect(sendImportFeedback(report)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/import-feedback');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual(report);
  });

  it('401 invalidates the session', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    await expect(sendImportFeedback(report)).rejects.toThrow(t('error.sessionExpired'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('other failures say the report was not sent', async () => {
    respond(503, {});
    await expect(sendImportFeedback(report)).rejects.toThrow(t('importFeedback.sendFailed'));
  });

  it('a network error says the report was not sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendImportFeedback(report)).rejects.toThrow(t('importFeedback.sendFailed'));
  });
});
