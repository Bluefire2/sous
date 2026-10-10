import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureRequestBody } from '../../server/featureRequestShape.ts';
import { t } from '../i18n';
import { sendFeatureRequest } from './featureRequestApi';
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

const suggestion: FeatureRequestBody = {
  id: '00000000-0000-4000-8000-000000000000',
  text: 'Meal plans',
  contactOk: true,
  from: 'library',
  locale: 'en',
  standalone: false,
};

describe('sendFeatureRequest', () => {
  it('posts the suggestion as JSON and resolves on 204', async () => {
    const fetchMock = respond(204, null);
    await expect(sendFeatureRequest(suggestion)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/feature-request');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual(suggestion);
  });

  it('401 invalidates the session', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    await expect(sendFeatureRequest(suggestion)).rejects.toThrow(t('error.sessionExpired'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('429 says to try again later', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(429, { code: 'feature-request-rate-limited' });
    await expect(sendFeatureRequest(suggestion)).rejects.toThrow(t('suggest.rateLimited'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('other failures say the suggestion was not sent', async () => {
    respond(503, {});
    await expect(sendFeatureRequest(suggestion)).rejects.toThrow(t('suggest.sendFailed'));
  });

  it('a network error says the suggestion was not sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendFeatureRequest(suggestion)).rejects.toThrow(t('suggest.sendFailed'));
  });
});
