import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';

const session = vi.hoisted(() => ({
  user: null as { sub: string; email: string } | null,
  listeners: new Set<() => void>(),
  resets: new Set<() => void>(),
  invalidate: vi.fn(),
}));

vi.mock('./session', () => ({
  getSessionSnapshot: () => ({ user: session.user, status: session.user === null ? 'signedOut' : 'signedIn' }),
  subscribeSession: (listener: () => void) => {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },
  onSessionReset: (listener: () => void) => {
    session.resets.add(listener);
    return () => session.resets.delete(listener);
  },
  invalidateSession: session.invalidate,
}));

const {
  UNITS_CACHE_KEY,
  fetchUnitSystem,
  getUnitSystem,
  parsePreferencesUnits,
  saveUnitSystem,
  setUnitSystem,
  subscribeUnitSystem,
} = await import('./accountPreferences');

function signIn(sub: string | null): void {
  session.user = sub === null ? null : { sub, email: `${sub}@example.com` };
  for (const listener of [...session.listeners]) listener();
}

function resetSession(): void {
  session.user = null;
  for (const listener of [...session.resets]) listener();
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

type Reply = { status: number; body: unknown } | Error;

/** Answers GETs and POSTs from the queues, in order, and records each POST body. */
function server(gets: Reply[], posts: Reply[] = []) {
  const posted: unknown[] = [];
  const respond = (reply: Reply | undefined) => {
    if (reply === undefined) throw new Error('unexpected request');
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  };
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return respond(posts.shift());
    }
    return respond(gets.shift());
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posted };
}

const ok = (units: string): Reply => ({ status: 200, body: { preferences: { units } } });

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
  session.invalidate.mockClear();
});

describe('parsePreferencesUnits', () => {
  it('reads a known unit system and refuses anything else', () => {
    expect(parsePreferencesUnits({ preferences: { units: 'metric' } })).toBe('metric');
    expect(parsePreferencesUnits({ preferences: { units: 'asWritten' } })).toBe('asWritten');
    for (const bad of [null, {}, { preferences: null }, { preferences: { units: 'imperial' } }]) {
      expect(parsePreferencesUnits(bad)).toBeNull();
    }
  });
});

describe('fetchUnitSystem and saveUnitSystem', () => {
  it('read and write the account preference', async () => {
    const { fetchMock, posted } = server([ok('metric')], [ok('asWritten')]);
    expect(await fetchUnitSystem()).toBe('metric');
    expect(await saveUnitSystem('asWritten')).toBe('asWritten');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/settings/preferences', '/api/settings/preferences']);
    expect(posted).toEqual([{ units: 'asWritten' }]);
  });

  it('sign out on 401 only', async () => {
    server([{ status: 503, body: {} }, { status: 200, body: {} }], [{ status: 401, body: {} }]);
    await expect(fetchUnitSystem()).rejects.toThrow();
    await expect(fetchUnitSystem()).rejects.toThrow();
    expect(session.invalidate).not.toHaveBeenCalled();
    await expect(saveUnitSystem('metric')).rejects.toThrow(t('error.sessionExpired'));
    expect(session.invalidate).toHaveBeenCalled();
  });
});

describe('the units store', () => {
  it('is as written and reads nothing while signed out', () => {
    const { fetchMock } = server([]);
    const unsubscribe = subscribeUnitSystem(() => {});
    expect(getUnitSystem()).toBe('asWritten');
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('loads the account’s value on subscribe and caches it under the sub', async () => {
    server([ok('metric')]);
    signIn('a');
    const listener = vi.fn();
    const unsubscribe = subscribeUnitSystem(listener);
    expect(getUnitSystem()).toBe('asWritten');
    await settle();
    expect(getUnitSystem()).toBe('metric');
    expect(listener).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(UNITS_CACHE_KEY) ?? '')).toEqual({ sub: 'a', units: 'metric' });
    unsubscribe();
  });

  it('starts from the cache for the same account and ignores another account’s', () => {
    server([new Error('offline'), new Error('offline')]);
    localStorage.setItem(UNITS_CACHE_KEY, JSON.stringify({ sub: 'a', units: 'metric' }));
    signIn('a');
    expect(getUnitSystem()).toBe('metric');
    signIn('b');
    expect(getUnitSystem()).toBe('asWritten');
  });

  it('shows a choice at once and keeps it when the save succeeds', async () => {
    const { posted } = server([ok('asWritten')], [ok('metric')]);
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await settle();
    const saving = setUnitSystem('metric');
    expect(getUnitSystem()).toBe('metric');
    await saving;
    expect(getUnitSystem()).toBe('metric');
    expect(posted).toEqual([{ units: 'metric' }]);
    unsubscribe();
  });

  it('puts the old value back and re-reads the account when the save fails', async () => {
    const { fetchMock } = server([ok('asWritten'), ok('asWritten')], [{ status: 503, body: {} }]);
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await settle();
    await expect(setUnitSystem('metric')).rejects.toThrow();
    expect(getUnitSystem()).toBe('asWritten');
    await settle();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2);
    unsubscribe();
  });

  it('sends saves one at a time, in the order they were chosen', async () => {
    const answers: (() => void)[] = [];
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ preferences: { units: 'asWritten' } })));
        const units = (JSON.parse(String(init.body)) as { units: string }).units;
        posted.push(units);
        return new Promise<Response>((resolve) =>
          answers.push(() => resolve(new Response(JSON.stringify({ preferences: { units } })))),
        );
      }),
    );
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await settle();
    const first = setUnitSystem('metric');
    const second = setUnitSystem('asWritten');
    await settle();
    expect(posted).toEqual(['metric']);
    answers[0]?.();
    await first;
    await settle();
    expect(posted).toEqual(['metric', 'asWritten']);
    answers[1]?.();
    await second;
    expect(getUnitSystem()).toBe('asWritten');
    unsubscribe();
  });

  it('never lets a failed older save undo a newer choice', async () => {
    let failFirst: (err: Error) => void = () => {};
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(new Response(JSON.stringify({ preferences: { units: 'asWritten' } })));
      const units = (JSON.parse(String(init.body)) as { units: string }).units;
      if (units === 'metric') return new Promise<Response>((_resolve, reject) => (failFirst = reject));
      return Promise.resolve(new Response(JSON.stringify({ preferences: { units } })));
    });
    vi.stubGlobal('fetch', fetchMock);
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await settle();
    const first = setUnitSystem('metric');
    const second = setUnitSystem('asWritten');
    await settle();
    failFirst(new Error('network'));
    await expect(first).rejects.toThrow();
    await second;
    expect(getUnitSystem()).toBe('asWritten');
    unsubscribe();
  });

  it('ignores a read that returns after a newer choice', async () => {
    let answerRead: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.resolve(new Response(JSON.stringify({ preferences: { units: 'metric' } })))
          : new Promise<Response>((resolve) => (answerRead = resolve)),
      ),
    );
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await setUnitSystem('metric');
    answerRead(new Response(JSON.stringify({ preferences: { units: 'asWritten' } })));
    await settle();
    expect(getUnitSystem()).toBe('metric');
    unsubscribe();
  });

  it('retries a failed read when the device reconnects, while any screen still listens', async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    server([new Error('offline'), ok('metric')]);
    signIn('a');
    const first = subscribeUnitSystem(() => {});
    const second = subscribeUnitSystem(() => {});
    await settle();
    expect(getUnitSystem()).toBe('asWritten');
    first();
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(getUnitSystem()).toBe('metric');
    second();
  });

  it('forgets the value and the cache on session reset', async () => {
    server([ok('metric')]);
    signIn('a');
    const unsubscribe = subscribeUnitSystem(() => {});
    await settle();
    expect(getUnitSystem()).toBe('metric');
    resetSession();
    expect(getUnitSystem()).toBe('asWritten');
    expect(localStorage.getItem(UNITS_CACHE_KEY)).toBeNull();
    unsubscribe();
  });
});
