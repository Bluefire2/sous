import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import {
  applyPullChanges,
  mergePullCursor,
  normalizeCollectionChange,
  normalizeRecipeChange,
  pullPage,
  pullSharedPage,
  type PullCursor,
  type PullPage,
  type SharedPullPage,
} from './remote';
import {
  clearLibrary,
  libraryEpoch,
  localWritesOpen,
  markLoaded,
  replaceFromPull,
  replaceFromPullWithShared,
  withSharedRecipeAccess,
  type ItemOrigin,
} from './libraryMemory';
import type { ChatMessage, Collection, CookLog, CookStateRow, Recipe } from './types';

export type SyncOutcome = 'ok' | 'error' | 'offline' | 'signedOut' | 'skipped' | 'superseded';

export interface SyncResult {
  outcome: SyncOutcome;
  pushed: number;
  applied: number;
}

/**
 * Shared authorization scope may change between pages. Retry the shared pull
 * from the first page this many times. Owned pull is not repeated.
 */
export const MAX_SHARED_PULL_ATTEMPTS = 3;

export type PullDependencies = {
  pullPage: (cursor: PullCursor | null) => Promise<PullPage | 'signedOut' | 'error'>;
  pullSharedPage: (
    cursorToken: string | null,
  ) => Promise<SharedPullPage | 'signedOut' | 'error' | 'restart'>;
};

export type SyncFinishedListener = (result: SyncResult) => void;

export interface SyncToastSpec {
  kind: 'success' | 'error';
  message: string;
}

export type SyncStatusKind = 'idle' | 'loading' | 'error' | 'signedOut';

export type SyncStatusSnapshot = {
  status: SyncStatusKind;
  lastSyncedAt: number | null;
};

const VISIBILITY_DEBOUNCE_MS = 30_000;

let lastVisibilitySync = 0;

type Flight = {
  startedEpoch: number;
  sawOpenWrite: boolean;
  promise: Promise<SyncResult>;
};

let flight: Flight | null = null;

/**
 * A sync flight returned `superseded` and its snapshot was not published.
 * Stays set after `flight` is cleared, until a later flight publishes `ok`.
 * A successful write that outlasted the discarded pull still has to reread.
 */
let discardedPull = false;

let snapshot: SyncStatusSnapshot = {
  status: 'idle',
  lastSyncedAt: null,
};
const listeners = new Set<() => void>();
const finishedListeners = new Set<SyncFinishedListener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function emitSyncFinished(result: SyncResult): void {
  for (const listener of finishedListeners) {
    try {
      listener(result);
    } catch (err) {
      console.error(err);
    }
  }
}

export function onSyncFinished(listener: SyncFinishedListener): () => void {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

/** Publishes only a real change, so a repeated status does not re-render readers. */
function setSnapshot(partial: Partial<SyncStatusSnapshot>): void {
  const keys = Object.keys(partial) as (keyof SyncStatusSnapshot)[];
  if (keys.every((key) => Object.is(partial[key], snapshot[key]))) {
    return;
  }
  snapshot = { ...snapshot, ...partial };
  emit();
}

/** Pure. The single source of truth for "should we toast, and with what". */
export function decideSyncToast(result: SyncResult): SyncToastSpec | null {
  if (result.outcome === 'error') {
    return { kind: 'error', message: t('sync.refreshFailed') };
  }
  if (
    result.outcome === 'offline' ||
    result.outcome === 'signedOut' ||
    result.outcome === 'skipped' ||
    result.outcome === 'superseded'
  ) {
    return null;
  }
  if (result.applied > 0) {
    return { kind: 'success', message: t('sync.updated') };
  }
  return null;
}

export async function pullAll(
  dependencies: PullDependencies,
  epochAtStart = libraryEpoch(),
  sawOpenWrite = localWritesOpen() > 0,
): Promise<SyncResult> {
  const stale = (): boolean =>
    sawOpenWrite || localWritesOpen() > 0 || libraryEpoch() !== epochAtStart;
  const superseded = (): SyncResult => ({ outcome: 'superseded', pushed: 0, applied: 0 });
  const acc = {
    recipes: new Map<string, Recipe>(),
    collections: new Map<string, Collection>(),
    chat: new Map<string, ChatMessage>(),
    cook: new Map<string, CookStateRow>(),
    cookLogs: new Map<string, CookLog>(),
    remotePhotoIds: new Set<string>(),
    chatParentOrigins: new Map<string, string>(),
    cookParentOrigins: new Map<string, string>(),
  };
  let cursor: PullCursor = {};
  let pages = 0;
  try {
    while (true) {
      const page = await dependencies.pullPage(pages === 0 ? null : cursor);
      if (page === 'signedOut') {
        clearLibrary();
        return { outcome: 'signedOut', pushed: 0, applied: 0 };
      }
      if (page === 'error') {
        return { outcome: 'error', pushed: 0, applied: 0 };
      }
      applyPullChanges(acc, page.changes);
      cursor = mergePullCursor(cursor, page.cursor);
      pages += 1;
      if (!page.hasMore) {
        break;
      }
    }
  } catch {
    return { outcome: 'error', pushed: 0, applied: 0 };
  }

  let sharedRecipes = new Map<string, Recipe>();
  let sharedCollections = new Map<string, Collection>();
  let sharedPhotos = new Set<string>();
  let recipeOrigins = new Map<string, ItemOrigin>();
  let collectionOrigins = new Map<string, ItemOrigin>();
  let sharedCursor: string | null = null;
  let sharedPages = 0;
  let sharedAttempt = 1;
  const discardSharedAttempt = (): void => {
    sharedRecipes = new Map();
    sharedCollections = new Map();
    sharedPhotos = new Set();
    recipeOrigins = new Map();
    collectionOrigins = new Map();
    sharedCursor = null;
    sharedPages = 0;
  };
  try {
    while (true) {
      const page = await dependencies.pullSharedPage(
        sharedPages === 0 ? null : sharedCursor,
      );
      if (page === 'signedOut') {
        clearLibrary();
        return { outcome: 'signedOut', pushed: 0, applied: 0 };
      }
      if (page === 'error') {
        if (stale()) return superseded();
        replaceFromPull(acc);
        return { outcome: 'error', pushed: 0, applied: 0 };
      }
      if (page === 'restart') {
        if (sharedAttempt >= MAX_SHARED_PULL_ATTEMPTS) {
          if (stale()) return superseded();
          replaceFromPull(acc);
          return { outcome: 'error', pushed: 0, applied: 0 };
        }
        sharedAttempt += 1;
        discardSharedAttempt();
        continue;
      }
      for (const raw of page.changes.collections) {
        const id = raw.id as string;
        const normalized = normalizeCollectionChange(raw);
        if (normalized === 'tombstone') {
          continue;
        }
        sharedCollections.set(id, normalized);
        if (typeof raw.ownerSub === 'string' && raw.ownerSub !== '') {
          collectionOrigins.set(id, {
            kind: 'shared',
            ownerSub: raw.ownerSub,
            ...(typeof raw.ownerEmail === 'string' && raw.ownerEmail !== ''
              ? { ownerEmail: raw.ownerEmail }
              : {}),
            access: raw.role === 'editor' ? 'editor' : 'viewer',
          });
        }
      }
      for (const raw of page.changes.recipes) {
        const id = raw.id as string;
        const normalized = normalizeRecipeChange(raw);
        if (normalized === 'tombstone') {
          continue;
        }
        sharedRecipes.set(id, normalized);
        if (typeof raw.ownerSub === 'string' && raw.ownerSub !== '') {
          recipeOrigins.set(id, { kind: 'shared', ownerSub: raw.ownerSub });
        }
      }
      for (const raw of page.changes.photos) {
        const id = raw.id as string;
        if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
          continue;
        }
        sharedPhotos.add(id);
      }
      sharedCursor = page.cursorToken;
      sharedPages += 1;
      if (!page.hasMore) {
        break;
      }
    }
  } catch {
    if (stale()) return superseded();
    replaceFromPull(acc);
    return { outcome: 'error', pushed: 0, applied: 0 };
  }

  if (stale()) return superseded();
  replaceFromPullWithShared(
    acc,
    {
      recipes: sharedRecipes,
      collections: sharedCollections,
      remotePhotoIds: sharedPhotos,
      recipeOrigins: withSharedRecipeAccess(
        recipeOrigins,
        sharedCollections,
        collectionOrigins,
      ),
      collectionOrigins,
    },
  );
  return { outcome: 'ok', pushed: 0, applied: 0 };
}

async function runOnce(epochAtStart: number, sawOpenWrite: boolean): Promise<SyncResult> {
  const sessionRaw = localStorage.getItem('cook.session');
  if (!sessionRaw) {
    clearLibrary();
    setSnapshot({ status: 'signedOut' });
    return { outcome: 'signedOut', pushed: 0, applied: 0 };
  }
  setSnapshot({ status: 'loading' });
  try {
    const result = await pullAll({ pullPage, pullSharedPage }, epochAtStart, sawOpenWrite);
    if (result.outcome === 'signedOut') {
      setSnapshot({ status: 'signedOut' });
      return result;
    }
    if (result.outcome === 'superseded') {
      setSnapshot({ status: 'idle' });
      return result;
    }
    if (result.outcome === 'error') {
      markLoaded();
      setSnapshot({ status: 'error' });
      return result;
    }
    setSnapshot({ status: 'idle', lastSyncedAt: Date.now() });
    return result;
  } catch (err) {
    console.error(err);
    markLoaded();
    setSnapshot({ status: 'error' });
    return { outcome: 'error', pushed: 0, applied: 0 };
  }
}

function startFlight(): Promise<SyncResult> {
  if (flight) {
    return flight.promise;
  }
  const startedEpoch = libraryEpoch();
  const sawOpenWrite = localWritesOpen() > 0;
  const promise = (async () => {
    const result = await runOnce(startedEpoch, sawOpenWrite);
    if (result.outcome === 'superseded') {
      discardedPull = true;
    } else {
      // The dropped snapshot is no longer the last word: this flight published,
      // failed, or signed out. Leaving the flag set would turn every later
      // successful write into another full pull and another refresh error.
      discardedPull = false;
    }
    emitSyncFinished(result);
    return result;
  })();
  const current: Flight = { startedEpoch, sawOpenWrite, promise };
  flight = current;
  const clear = () => {
    if (flight === current) {
      flight = null;
    }
  };
  void promise.then(clear, clear);
  return promise;
}

/**
 * True when a pull read (or may still read) library state from before this
 * write. An in-flight pull must not publish. A pull that already returned
 * `superseded` and cleared `flight` still counts, until a later sync finishes
 * with any other outcome.
 */
export function localWriteOverlapsPull(writeEpoch: number): boolean {
  return (
    discardedPull ||
    (flight !== null && (flight.startedEpoch < writeEpoch || flight.sawOpenWrite))
  );
}

/** Drops the sticky discarded-pull flag. Tests isolate module state with this. */
export function resetDiscardedPullForTests(): void {
  discardedPull = false;
}

/**
 * Pull after a local write has finished. Waits out any pull that overlapped
 * the write, then reads the server again so a tombstone committed during
 * the write is what the library shows.
 */
export async function pullAfterLocalWrite(writeEpoch: number): Promise<SyncOutcome> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    while (flight && (flight.startedEpoch < writeEpoch || flight.sawOpenWrite)) {
      await flight.promise;
    }
    if (localWritesOpen() > 0) {
      // Another write is still open. Leave `discardedPull` set so the last
      // successful write starts the reread this call is skipping.
      return 'superseded';
    }
    const current = flight;
    const result = current ? await current.promise : await startFlight();
    if (result.outcome !== 'superseded') {
      return result.outcome;
    }
    if (libraryEpoch() !== writeEpoch) {
      return 'superseded';
    }
  }
  return 'error';
}

export function sync(): Promise<void> {
  return startFlight().then(() => undefined);
}

export function triggerSyncAfterSession(_sub: string): void {
  void sync();
}

export function setupSyncTriggers(): void {
  window.addEventListener('online', () => {
    void sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    const now = Date.now();
    if (now - lastVisibilitySync < VISIBILITY_DEBOUNCE_MS) {
      return;
    }
    lastVisibilitySync = now;
    void sync();
  });
}

export function notifyImportComplete(): void {
  void sync();
}

export async function resyncFromServer(): Promise<void> {
  await sync();
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncStatusSnapshot(): SyncStatusSnapshot {
  return snapshot;
}

export function useSyncStatus(): SyncStatusSnapshot {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatusSnapshot);
}
