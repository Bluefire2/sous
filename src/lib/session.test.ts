import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, getSessionSnapshot, invalidateSession, onSessionReset, subscribeSession } from './session';

const clearLibraryMock = vi.fn();

vi.mock('./libraryMemory', () => ({
  clearLibrary: () => clearLibraryMock(),
}));

beforeEach(() => {
  clearLibraryMock.mockClear();
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('onSessionReset', () => {
  it('notifies listeners when invalidateSession runs', () => {
    const seen: number[] = [];
    const unsub = onSessionReset(() => {
      seen.push(1);
    });
    invalidateSession();
    expect(seen).toEqual([1]);
    unsub();
  });

  it('stops notifying after unsubscribe', () => {
    const seen: number[] = [];
    const unsub = onSessionReset(() => {
      seen.push(1);
    });
    unsub();
    invalidateSession();
    expect(seen).toEqual([]);
  });

  it('runs clearLibrary before reset listeners and isolates throwing listeners', () => {
    const order: string[] = [];
    clearLibraryMock.mockImplementation(() => {
      order.push('clearLibrary');
    });
    onSessionReset(() => {
      order.push('first');
    });
    onSessionReset(() => {
      order.push('throw');
      throw new Error('boom');
    });
    onSessionReset(() => {
      order.push('second');
    });
    invalidateSession();
    expect(order).toEqual(['clearLibrary', 'first', 'throw', 'second']);
  });
});

describe('fetchSession', () => {
  const user = { sub: 'sub-1', email: 'cook@example.com', isOwner: false };

  function respond(status: number, body?: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
      ),
    );
  }

  it('signs in from a user body and caches it', async () => {
    respond(200, { user });
    expect(await fetchSession()).toEqual({ status: 'signedIn', user });
    expect(getSessionSnapshot()).toEqual({ status: 'signedIn', user });
    expect(JSON.parse(localStorage.getItem('cook.session') ?? 'null')).toEqual(user);
  });

  it('signs out on 401 and 403, clearing the cache and the library', async () => {
    for (const status of [401, 403]) {
      localStorage.setItem('cook.session', JSON.stringify(user));
      clearLibraryMock.mockClear();
      respond(status);
      expect(await fetchSession()).toEqual({ status: 'signedOut' });
      expect(localStorage.getItem('cook.session')).toBeNull();
      expect(clearLibraryMock).toHaveBeenCalledTimes(1);
    }
  });

  it('signs out on a 200 with no user', async () => {
    respond(200, { user: null });
    expect(await fetchSession()).toEqual({ status: 'signedOut' });
    expect(getSessionSnapshot().status).toBe('signedOut');
  });

  it('keeps the cached user offline on a 503 or a network failure, never signing out', async () => {
    localStorage.setItem('cook.session', JSON.stringify(user));
    respond(503, { error: 'Membership unavailable' });
    expect(await fetchSession()).toEqual({ status: 'offline', user });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    clearLibraryMock.mockClear();
    expect(await fetchSession()).toEqual({ status: 'offline', user });
    expect(clearLibraryMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('cook.session')).not.toBeNull();
  });

  it('is offline with no user when the cache is missing or corrupt', async () => {
    localStorage.setItem('cook.session', '{not json');
    respond(502);
    expect(await fetchSession()).toEqual({ status: 'offline', user: null });
    localStorage.setItem('cook.session', JSON.stringify({ sub: 'only-sub' }));
    expect(await fetchSession()).toEqual({ status: 'offline', user: null });
  });

  it('does not notify readers when a refetch returns the same session', async () => {
    respond(200, { user });
    await fetchSession();
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);
    const before = getSessionSnapshot();
    await fetchSession();
    expect(listener).not.toHaveBeenCalled();
    expect(getSessionSnapshot()).toBe(before);

    respond(200, { user: { ...user, isOwner: true } });
    await fetchSession();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('shares one request between concurrent callers; a caller after it settles starts a new one', async () => {
    const releases: (() => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(new Response(JSON.stringify({ user }), { status: 200 })));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = fetchSession();
    const second = fetchSession();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A continuation of the first read asks again: that must be a new request,
    // not the finished promise (the ordering session.ts comments on).
    const again = first.then(() => fetchSession());
    releases[0]();
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[1]();
    expect(await again).toEqual({ status: 'signedIn', user });
  });
});
