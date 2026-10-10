import { lazy, type ComponentType } from 'react';

/**
 * Route screens load as separate chunks (docs/plans/route-code-splitting.md).
 * A tab opened before a deploy still asks for the old hashed file names, which
 * the new build no longer has. Reloading fetches the new `index.html` and its
 * chunks, so a failed chunk load reloads the page once. The time of that
 * reload is kept in this tab's sessionStorage: while it is recent, a second
 * failure is not reloaded again but thrown to the ErrorBoundary, so a chunk
 * that stays missing can never reload-loop. A screen that loads clears it.
 */

export const CHUNK_RELOAD_KEY = 'sous.chunkReloadAt';

/** A reload newer than this blocks another one. */
export const CHUNK_RELOAD_GUARD_MS = 5 * 60 * 1000;

type ChunkReloadStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ChunkReloadEnv = {
  /** Null when the browser refuses storage: no guard, so no reload. */
  storage: () => ChunkReloadStorage | null;
  reload: () => void;
  now: () => number;
};

// Chrome, Firefox and Safari word a failed dynamic import differently. Vite's
// preload helper adds its own message when a chunk's CSS fails to load, and
// rethrows it into the same import (when nothing cancels `vite:preloadError`).
const CHUNK_LOAD_MESSAGE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** True for the errors a missing or unreachable chunk produces. */
export function isChunkLoadError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
  return CHUNK_LOAD_MESSAGE.test(message);
}

/**
 * Whether a chunk failure may reload, given the stored time of the last one.
 * A missing or unparsable value allows it; a time in the future (the clock
 * moved back) blocks it, as a recent one does.
 */
export function shouldReloadForChunkError(stored: string | null, now: number): boolean {
  if (stored === null) return true;
  const last = Number(stored);
  if (!Number.isFinite(last)) return true;
  if (last > now) return false;
  return now - last >= CHUNK_RELOAD_GUARD_MS;
}

/**
 * Records the reload and reports whether to do it. False when storage is
 * unavailable or the write fails: a reload that cannot be recorded could loop.
 */
function claimReload(env: ChunkReloadEnv): boolean {
  try {
    const storage = env.storage();
    if (storage === null) return false;
    const now = env.now();
    if (!shouldReloadForChunkError(storage.getItem(CHUNK_RELOAD_KEY), now)) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

function clearReloadMark(env: ChunkReloadEnv): void {
  try {
    const storage = env.storage();
    if (storage !== null && storage.getItem(CHUNK_RELOAD_KEY) !== null) {
      storage.removeItem(CHUNK_RELOAD_KEY);
    }
  } catch {
    // Storage refused: nothing was recorded either.
  }
}

/**
 * Runs `load`. On a chunk-load failure that may reload, reloads and returns a
 * promise that never settles, so Suspense keeps its fallback until the page
 * goes. Any other failure, or one the guard blocks, rejects as before.
 */
export async function loadWithChunkReload<T>(load: () => Promise<T>, env: ChunkReloadEnv): Promise<T> {
  let loaded: T;
  try {
    loaded = await load();
  } catch (err) {
    if (isChunkLoadError(err) && claimReload(env)) {
      env.reload();
      return new Promise<T>(() => {});
    }
    throw err;
  }
  clearReloadMark(env);
  return loaded;
}

const browserEnv: ChunkReloadEnv = {
  storage: () => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  },
  reload: () => window.location.reload(),
  now: () => Date.now(),
};

/** `React.lazy` for a route screen (no props), with the one-time reload above. */
export function lazyScreen(load: () => Promise<{ default: ComponentType }>) {
  return lazy(() => loadWithChunkReload(load, browserEnv));
}
