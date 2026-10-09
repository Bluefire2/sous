/** A screen wake lock as the controller needs it (a `WakeLockSentinel`). */
export interface WakeLockHandle {
  readonly released: boolean;
  release(): Promise<void>;
}

/** What the controller touches, passed in so it can be tested without a DOM. */
export interface WakeLockEnv {
  wakeLock: { request(type: 'screen'): Promise<WakeLockHandle> } | undefined;
  document: {
    readonly visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

/**
 * Holds a screen wake lock until the returned stop function runs. The rules:
 *
 * - With no Wake Lock API it does nothing, and stop is a no-op.
 * - It requests once at start and again whenever the page becomes visible,
 *   because the browser releases the lock on tab switch or screen off.
 * - No request is made while a live (unreleased) lock is held.
 * - A request that is denied is ignored; a later visible event tries again.
 * - A lock granted after stop is released at once and never kept.
 * - Two requests can overlap (hide and show while the first is pending). A
 *   lock that lands releases the one it replaces, so at most one is kept.
 * - Stop removes the listener and releases the lock it holds.
 */
export function startWakeLock(env: WakeLockEnv): () => void {
  const api = env.wakeLock;
  if (api === undefined) {
    return () => {};
  }
  let held: WakeLockHandle | null = null;
  let stopped = false;

  const request = async () => {
    if (held !== null && !held.released) return;
    let next: WakeLockHandle;
    try {
      next = await api.request('screen');
    } catch {
      // Denied (e.g. low battery mode) — nothing to do.
      return;
    }
    if (stopped) {
      void next.release();
      return;
    }
    const previous = held;
    held = next;
    if (previous !== null && previous !== next) {
      void previous.release();
    }
  };

  const onVisibilityChange = () => {
    if (env.document.visibilityState === 'visible') void request();
  };

  void request();
  env.document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    stopped = true;
    env.document.removeEventListener('visibilitychange', onVisibilityChange);
    void held?.release();
    held = null;
  };
}
