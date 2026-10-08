import { useCallback, useSyncExternalStore } from 'react';
import { clearLibrary } from './libraryMemory';
import { clearPersistedLibraryPaging } from './libraryPaging';
import { clearPersistedLibraryView } from './librarySearchMemory';

const SESSION_CACHE_KEY = 'cook.session';

export type SessionUser = { sub: string; email: string; name?: string; isOwner?: boolean };

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut' | 'offline';

export type FetchSessionResult =
  | { status: 'signedIn'; user: SessionUser }
  | { status: 'signedOut' }
  | { status: 'offline'; user: SessionUser | null };

export type SessionSnapshot = {
  user: SessionUser | null;
  status: SessionStatus;
};

let snapshot: SessionSnapshot = { user: null, status: 'loading' };
const listeners = new Set<() => void>();
const sessionResetListeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function sameUser(a: SessionUser | null, b: SessionUser | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.sub === b.sub && a.email === b.email && a.name === b.name && a.isOwner === b.isOwner;
}

/**
 * Replaces the snapshot only when status or user changed, so a refetch that
 * returns the same session does not re-render every useSession reader.
 */
function publish(next: SessionSnapshot): void {
  if (next.status === snapshot.status && sameUser(next.user, snapshot.user)) {
    return;
  }
  snapshot = next;
  emit();
}

function readCachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as SessionUser;
    // Only sub/email are required; stale isOwner can reveal a link at most — admin routes enforce server-side.
    if (typeof parsed.sub === 'string' && typeof parsed.email === 'string') {
      return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return null;
}

export function onSessionReset(listener: () => void): () => void {
  sessionResetListeners.add(listener);
  return () => {
    sessionResetListeners.delete(listener);
  };
}

function notifySessionReset(): void {
  for (const listener of sessionResetListeners) {
    try {
      listener();
    } catch {
      // isolate listener failures
    }
  }
}

export function invalidateSession(): void {
  localStorage.removeItem(SESSION_CACHE_KEY);
  publish({ user: null, status: 'signedOut' });
  clearLibrary();
  clearPersistedLibraryView();
  clearPersistedLibraryPaging();
  notifySessionReset();
}

let sessionRequest: Promise<FetchSessionResult> | null = null;

async function loadSession(): Promise<FetchSessionResult> {
  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 403) {
      invalidateSession();
      return { status: 'signedOut' };
    }
    if (!response.ok) {
      const cached = readCachedUser();
      publish({ user: cached, status: 'offline' });
      return { status: 'offline', user: cached };
    }
    const data = (await response.json()) as { user: SessionUser | null };
    if (data.user) {
      localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(data.user));
      publish({ user: data.user, status: 'signedIn' });
      return { status: 'signedIn', user: data.user };
    }
    invalidateSession();
    return { status: 'signedOut' };
  } catch {
    const cached = readCachedUser();
    publish({ user: cached, status: 'offline' });
    return { status: 'offline', user: cached };
  }
}

/**
 * One network read at a time. A tab return and a reconnect can ask together,
 * and the boot read in main.tsx can still be in flight; they share this
 * promise. A later call, after it settles, hits the network again.
 * A non-ok response or a thrown fetch stays offline (cached user kept).
 * Only 401, 403, and a signed-in body with no user sign the reader out.
 */
export function fetchSession(): Promise<FetchSessionResult> {
  if (sessionRequest) {
    return sessionRequest;
  }
  let resolve!: (result: FetchSessionResult) => void;
  let reject!: (reason: unknown) => void;
  const request = new Promise<FetchSessionResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  sessionRequest = request;
  // Drop the slot before resolving so a caller that continues after await
  // starts a new read. Clearing in finally runs too late: that continuation
  // is queued ahead of it and would reuse the finished promise.
  const finish = (settle: () => void) => {
    if (sessionRequest === request) {
      sessionRequest = null;
    }
    settle();
  };
  void loadSession().then(
    (result) => finish(() => resolve(result)),
    (reason: unknown) => finish(() => reject(reason)),
  );
  return request;
}

/**
 * Registered once from main, like the sync triggers. Each mounted useSession
 * used to add its own pair, so one tab return fetched the session once per
 * open screen.
 */
export function setupSessionTriggers(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void fetchSession();
    }
  });
  window.addEventListener('online', () => {
    void fetchSession();
  });
}

export function signInHref(returnTo: string): string {
  return `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // best-effort server sign-out
  }
  invalidateSession();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

export function useSession(): {
  user: SessionUser | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
} {
  const current = useSyncExternalStore(subscribeSession, getSessionSnapshot);

  const refresh = useCallback(async () => {
    await fetchSession();
  }, []);

  return { user: current.user, status: current.status, refresh };
}
