import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIntroSeen, introSeenFor, markIntroSeen, resetIntroAnswersForTests } from './introApi';
import * as session from './session';

afterEach(() => {
  resetIntroAnswersForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body?: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchIntroSeen', () => {
  it('reads seen from a 200', async () => {
    const fetchMock = respond(200, { seen: true });
    await expect(fetchIntroSeen()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/intro');
    expect(init.credentials).toBe('same-origin');
    respond(200, { seen: false });
    await expect(fetchIntroSeen()).resolves.toBe(false);
  });

  it('is unknown for 503, a bad body, or a network error', async () => {
    respond(503, { error: 'Store unavailable' });
    await expect(fetchIntroSeen()).resolves.toBeNull();
    respond(200, { seen: 'no' });
    await expect(fetchIntroSeen()).resolves.toBeNull();
    // A 200 that isn't JSON (an HTML page from a proxy, say).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    await expect(fetchIntroSeen()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    await expect(fetchIntroSeen()).resolves.toBeNull();
  });

  it('401 invalidates the session and is unknown', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    await expect(fetchIntroSeen()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('introSeenFor', () => {
  it('asks once per sub per page load, unknown included', async () => {
    const fetchMock = respond(503, {});
    await expect(introSeenFor('a')).resolves.toBeNull();
    await expect(introSeenFor('a')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await introSeenFor('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('markIntroSeen', () => {
  it('posts and answers seen for the rest of the page load, even if the post fails', async () => {
    const fetchMock = respond(503, {});
    markIntroSeen('a');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/intro/seen');
    expect(init.method).toBe('POST');
    await expect(introSeenFor('a')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 401 on the post invalidates the session', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    markIntroSeen('a');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});
