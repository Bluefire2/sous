import { describe, expect, it } from 'vitest';
import { startWakeLock, type WakeLockEnv, type WakeLockHandle } from './wakeLockController';

class FakeSentinel implements WakeLockHandle {
  released = false;
  releaseCalls = 0;
  release(): Promise<void> {
    this.releaseCalls++;
    this.released = true;
    return Promise.resolve();
  }
}

interface Pending {
  resolve: (sentinel: FakeSentinel) => void;
  reject: (error: Error) => void;
}

function fakeApi() {
  const pending: Pending[] = [];
  const api = {
    requests: 0,
    pending,
    request(type: 'screen'): Promise<WakeLockHandle> {
      expect(type).toBe('screen');
      api.requests++;
      return new Promise<WakeLockHandle>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };
  return api;
}

function fakeDocument() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: 'visible',
    listeners,
    addEventListener(_type: 'visibilitychange', listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'visibilitychange', listener: () => void) {
      listeners.delete(listener);
    },
    setVisibility(state: 'visible' | 'hidden') {
      this.visibilityState = state;
      for (const listener of listeners) listener();
    },
  };
}

/** Lets the controller's awaits run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup() {
  const api = fakeApi();
  const doc = fakeDocument();
  const env: WakeLockEnv = { wakeLock: api, document: doc };
  return { api, doc, env };
}

describe('startWakeLock', () => {
  it('does nothing without the Wake Lock API, and stop is safe', () => {
    const doc = fakeDocument();
    const stop = startWakeLock({ wakeLock: undefined, document: doc });
    expect(doc.listeners.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it('requests once on start and releases on stop', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    expect(api.requests).toBe(1);
    expect(doc.listeners.size).toBe(1);
    const lock = new FakeSentinel();
    api.pending[0].resolve(lock);
    await flush();
    expect(lock.releaseCalls).toBe(0);
    stop();
    expect(lock.releaseCalls).toBe(1);
  });

  it('releases a lock granted after stop at once and never keeps it', async () => {
    const { api, env } = setup();
    const stop = startWakeLock(env);
    stop();
    const late = new FakeSentinel();
    api.pending[0].resolve(late);
    await flush();
    expect(late.releaseCalls).toBe(1);
  });

  it('keeps one lock when hide and show overlap a pending request', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    expect(api.requests).toBe(2);
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    api.pending[0].resolve(first);
    await flush();
    api.pending[1].resolve(second);
    await flush();
    expect(first.releaseCalls).toBe(1);
    expect(second.releaseCalls).toBe(0);
    stop();
    expect(second.releaseCalls).toBe(1);
    expect([first, second].every((lock) => lock.released)).toBe(true);
  });

  it('makes no new request while a live lock is held', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    api.pending[0].resolve(new FakeSentinel());
    await flush();
    doc.setVisibility('visible');
    await flush();
    expect(api.requests).toBe(1);
    stop();
  });

  it('requests again on a visible event after the browser released the lock', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    const lock = new FakeSentinel();
    api.pending[0].resolve(lock);
    await flush();
    lock.released = true;
    doc.setVisibility('hidden');
    expect(api.requests).toBe(1);
    doc.setVisibility('visible');
    expect(api.requests).toBe(2);
    const again = new FakeSentinel();
    api.pending[1].resolve(again);
    await flush();
    stop();
    expect(again.releaseCalls).toBe(1);
  });

  it('swallows a denied request, and a later visible event can still acquire', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    api.pending[0].reject(new Error('NotAllowedError'));
    await flush();
    doc.setVisibility('visible');
    expect(api.requests).toBe(2);
    const lock = new FakeSentinel();
    api.pending[1].resolve(lock);
    await flush();
    stop();
    expect(lock.releaseCalls).toBe(1);
  });

  it('stop removes the listener, so later visible events request nothing', async () => {
    const { api, doc, env } = setup();
    const stop = startWakeLock(env);
    api.pending[0].resolve(new FakeSentinel());
    await flush();
    stop();
    expect(doc.listeners.size).toBe(0);
    doc.setVisibility('visible');
    expect(api.requests).toBe(1);
  });
});
