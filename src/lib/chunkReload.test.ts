import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  lazyScreen,
  loadWithChunkReload,
  shouldReloadForChunkError,
  type ChunkReloadEnv,
} from './chunkReload';

const NOW = 1_800_000_000_000;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

function env(storage: ReturnType<typeof memoryStorage> | null, overrides: Partial<ChunkReloadEnv> = {}) {
  const reload = vi.fn();
  return {
    reload,
    env: { storage: () => storage, reload, now: () => NOW, ...overrides } satisfies ChunkReloadEnv,
  };
}

/** Lets a promise that should stay pending show that it has not settled. */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  const marker = Symbol('pending');
  const result = await Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), 10)),
  ]);
  return result === marker ? 'pending' : (result as 'resolved' | 'rejected');
}

const chromeError = new TypeError(
  'Failed to fetch dynamically imported module: https://sous.kyrylo.lol/assets/Settings-abc123.js',
);

describe('isChunkLoadError', () => {
  it('recognises each browser and the CSS preload wording', () => {
    expect(isChunkLoadError(chromeError)).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/A.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/ImportScreen-x.css'))).toBe(true);
    expect(isChunkLoadError({ message: 'Failed to fetch dynamically imported module: x' })).toBe(true);
  });

  it('leaves other errors alone', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

describe('shouldReloadForChunkError', () => {
  it('allows a first reload, or one after an unparsable mark', () => {
    expect(shouldReloadForChunkError(null, NOW)).toBe(true);
    expect(shouldReloadForChunkError('not a time', NOW)).toBe(true);
  });

  it('blocks while the last reload is recent, and allows it once the guard has passed', () => {
    expect(shouldReloadForChunkError(String(NOW), NOW)).toBe(false);
    expect(shouldReloadForChunkError(String(NOW - CHUNK_RELOAD_GUARD_MS + 1), NOW)).toBe(false);
    expect(shouldReloadForChunkError(String(NOW - CHUNK_RELOAD_GUARD_MS), NOW)).toBe(true);
  });

  it('blocks on a mark from the future (the clock moved back)', () => {
    expect(shouldReloadForChunkError(String(NOW + 1000), NOW)).toBe(false);
  });
});

describe('loadWithChunkReload', () => {
  it('returns the module and clears an earlier reload mark', async () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: String(NOW - 1000) });
    const { env: e, reload } = env(storage);
    await expect(loadWithChunkReload(() => Promise.resolve('screen'), e)).resolves.toBe('screen');
    expect(storage.data.has(CHUNK_RELOAD_KEY)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once on a chunk failure, records it, and stays pending', async () => {
    const storage = memoryStorage();
    const { env: e, reload } = env(storage);
    const result = loadWithChunkReload(() => Promise.reject(chromeError), e);
    expect(await settledState(result)).toBe('pending');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe(String(NOW));
  });

  it('does not reload again after a recent reload: the error reaches the boundary', async () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: String(NOW - 2000) });
    const { env: e, reload } = env(storage);
    await expect(loadWithChunkReload(() => Promise.reject(chromeError), e)).rejects.toBe(chromeError);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.get(CHUNK_RELOAD_KEY)).toBe(String(NOW - 2000));
  });

  it('never reloads for an error that is not a chunk failure', async () => {
    const storage = memoryStorage();
    const { env: e, reload } = env(storage);
    const boom = new Error('render bug');
    await expect(loadWithChunkReload(() => Promise.reject(boom), e)).rejects.toBe(boom);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.size).toBe(0);
  });

  it('does not reload when storage is unavailable or refuses, since nothing would stop a loop', async () => {
    const none = env(null);
    await expect(loadWithChunkReload(() => Promise.reject(chromeError), none.env)).rejects.toBe(chromeError);
    expect(none.reload).not.toHaveBeenCalled();

    const throwing = env(null, {
      storage: () => {
        throw new Error('SecurityError');
      },
    });
    await expect(loadWithChunkReload(() => Promise.reject(chromeError), throwing.env)).rejects.toBe(chromeError);
    expect(throwing.reload).not.toHaveBeenCalled();

    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const quota = env(full);
    await expect(loadWithChunkReload(() => Promise.reject(chromeError), quota.env)).rejects.toBe(chromeError);
    expect(quota.reload).not.toHaveBeenCalled();
  });

  it('still returns the module when clearing the mark fails', async () => {
    const throwing = env(null, {
      storage: () => {
        throw new Error('SecurityError');
      },
    });
    await expect(loadWithChunkReload(() => Promise.resolve(1), throwing.env)).resolves.toBe(1);
  });
});

describe('lazyScreen', () => {
  it('returns a lazy component without calling the loader', () => {
    const load = vi.fn(() => Promise.resolve({ default: () => null }));
    const Screen = lazyScreen(load);
    expect((Screen as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.lazy'));
    expect(load).not.toHaveBeenCalled();
  });
});
