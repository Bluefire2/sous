import { describe, expect, it, vi } from 'vitest';
import { abortedRequest } from '../test/abortedBody.ts';
import {
  MAX_PREFERENCES_BODY_BYTES,
  accountPreferencesFromDoc,
  accountPreferencesGet,
  accountPreferencesPost,
  parseAccountPreferencesInput,
  type AccountPreferences,
  type AccountPreferencesStore,
} from './accountPreferences.ts';

const CTX = { authorizedSub: 'sub-1' };
const NOW = 1_700_000_000_000;

function memoryStore(docs: Record<string, unknown> = {}) {
  const writes: { sub: string; preferences: AccountPreferences }[] = [];
  const store: AccountPreferencesStore = {
    read: vi.fn(async (sub: string) => docs[sub]),
    write: vi.fn(async (sub: string, preferences: AccountPreferences) => {
      writes.push({ sub, preferences });
      docs[sub] = preferences;
    }),
  };
  return { store, writes };
}

function failingStore(): AccountPreferencesStore {
  return {
    read: () => Promise.reject(new Error('14 UNAVAILABLE: SECRET')),
    write: () => Promise.reject(new Error('14 UNAVAILABLE: SECRET')),
  };
}

function post(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/settings/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

describe('parseAccountPreferencesInput', () => {
  it('accepts each unit system and drops other fields', () => {
    expect(parseAccountPreferencesInput({ units: 'metric', extra: 1 })).toEqual({ units: 'metric' });
    expect(parseAccountPreferencesInput({ units: 'asWritten' })).toEqual({ units: 'asWritten' });
  });

  it('refuses rather than repairs', () => {
    for (const bad of [null, [], 'metric', {}, { units: 'imperial' }, { units: 1 }]) {
      expect(parseAccountPreferencesInput(bad)).toBeNull();
    }
  });
});

describe('accountPreferencesFromDoc', () => {
  it('reads the defaults when nothing or something unknown is stored', () => {
    expect(accountPreferencesFromDoc(undefined)).toEqual({ units: 'asWritten' });
    expect(accountPreferencesFromDoc({ units: 'imperial' })).toEqual({ units: 'asWritten' });
    expect(accountPreferencesFromDoc({ units: 'metric', updatedAt: 5 })).toEqual({ units: 'metric' });
  });
});

describe('GET /api/settings/preferences', () => {
  it('answers the session member’s preferences, or the defaults', async () => {
    const { store } = memoryStore({ 'sub-1': { units: 'metric', updatedAt: NOW } });
    const res = await accountPreferencesGet(new Request('http://localhost/'), CTX, store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ preferences: { units: 'metric' } });
    expect(store.read).toHaveBeenCalledWith('sub-1');

    const none = await accountPreferencesGet(new Request('http://localhost/'), { authorizedSub: 'sub-2' }, store);
    expect(await none.json()).toEqual({ preferences: { units: 'asWritten' } });
  });

  it('answers 503 when the store fails', async () => {
    const res = await accountPreferencesGet(new Request('http://localhost/'), CTX, failingStore());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('SECRET');
  });
});

describe('POST /api/settings/preferences', () => {
  it('saves under the session sub with server time, whatever the body says', async () => {
    const { store, writes } = memoryStore();
    const res = await accountPreferencesPost(post({ units: 'metric', sub: 'someone-else', updatedAt: 1 }), CTX, store, () => NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preferences: { units: 'metric' } });
    expect(writes).toEqual([{ sub: 'sub-1', preferences: { units: 'metric', updatedAt: NOW } }]);
  });

  it('answers 400 for bad JSON or an unknown value, without writing', async () => {
    const { store, writes } = memoryStore();
    for (const req of [post(null, '{'), post({ units: 'imperial' })]) {
      const res = await accountPreferencesPost(req, CTX, store);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Bad request', code: 'preferences-bad-request' });
    }
    expect(writes).toEqual([]);
  });

  it('answers 413 for a body over the cap', async () => {
    const res = await accountPreferencesPost(post(null, 'x'.repeat(MAX_PREFERENCES_BODY_BYTES + 1)), CTX, memoryStore().store);
    expect(res.status).toBe(413);
  });

  it('answers 400 when the client hangs up mid-upload', async () => {
    const res = await accountPreferencesPost(abortedRequest('http://localhost/api/settings/preferences'), CTX, memoryStore().store);
    expect(res.status).toBe(400);
  });

  it('answers 503 when the write fails, and never echoes the error', async () => {
    const res = await accountPreferencesPost(post({ units: 'metric' }), CTX, failingStore());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('SECRET');
  });

  it('rethrows anything else without its message', async () => {
    const req = post({ units: 'metric' });
    vi.spyOn(req, 'text').mockRejectedValue(new Error('SECRET-BODY'));
    Object.defineProperty(req, 'body', { get: () => { throw new Error('SECRET-BODY'); } });
    const err = await accountPreferencesPost(req, CTX, memoryStore().store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('SECRET');
  });
});
