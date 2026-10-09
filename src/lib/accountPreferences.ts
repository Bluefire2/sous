import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { getSessionSnapshot, invalidateSession, onSessionReset, subscribeSession } from './session';
import { UNIT_SYSTEMS, type UnitSystem } from './unitConversion';

/**
 * Account preferences (`docs/plans/measurement-units.md`): today only the
 * measurement units a recipe screen shows. They live on the account
 * (`/api/settings/preferences`), so every device agrees; the last value is
 * cached in localStorage under the member's `sub`, so a recipe opens in the
 * right units before the read returns.
 *
 * React reads `units` through `useUnitSystem` (`docs/constitutions/client-state.md`,
 * principle 3): the getter returns a primitive, and the store re-reads it when
 * the session changes, so one account never sees another's choice.
 */

export const UNITS_CACHE_KEY = 'cook.units';

function isUnitSystem(value: unknown): value is UnitSystem {
  return typeof value === 'string' && (UNIT_SYSTEMS as readonly string[]).includes(value);
}

/** `{ preferences }` from the server as the unit system, or null for any other body. */
export function parsePreferencesUnits(data: unknown): UnitSystem | null {
  if (typeof data !== 'object' || data === null || !('preferences' in data)) return null;
  const preferences = (data as { preferences: unknown }).preferences;
  if (typeof preferences !== 'object' || preferences === null) return null;
  const units = (preferences as { units?: unknown }).units;
  return isUnitSystem(units) ? units : null;
}

/** A 401 signs the session out; anything else is the caller's to word. */
function failure(response: Response): Error {
  if (response.status === 401) {
    invalidateSession();
    return new Error(t('error.sessionExpired'));
  }
  return new Error(t('error.requestFailed', { status: response.status }));
}

export async function fetchUnitSystem(): Promise<UnitSystem> {
  const response = await fetch('/api/settings/preferences', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw failure(response);
  const units = parsePreferencesUnits(await response.json().catch(() => null));
  if (units === null) throw new Error(t('error.requestFailed', { status: response.status }));
  return units;
}

export async function saveUnitSystem(units: UnitSystem): Promise<UnitSystem> {
  const response = await fetch('/api/settings/preferences', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ units }),
  });
  if (!response.ok) throw failure(response);
  const saved = parsePreferencesUnits(await response.json().catch(() => null));
  if (saved === null) throw new Error(t('error.requestFailed', { status: response.status }));
  return saved;
}

function readCache(sub: string): UnitSystem | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNITS_CACHE_KEY) ?? 'null') as { sub?: unknown; units?: unknown } | null;
    return parsed !== null && parsed.sub === sub && isUnitSystem(parsed.units) ? parsed.units : null;
  } catch {
    return null;
  }
}

function writeCache(sub: string, units: UnitSystem): void {
  try {
    localStorage.setItem(UNITS_CACHE_KEY, JSON.stringify({ sub, units }));
  } catch {
    // Best effort: the account keeps the real value.
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(UNITS_CACHE_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Whose units `units` are; null when signed out. */
let unitsSub: string | null = null;
let units: UnitSystem = 'asWritten';
/** The `sub` whose server value has been read (or is being read). */
let loadedFor: string | null = null;
/** Bumped by every save, so an older read or a failed older save cannot undo a newer choice. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function currentSub(): string | null {
  return getSessionSnapshot().user?.sub ?? null;
}

/** Points the store at the session's account, from the cache, when the account changed. */
function followSession(): void {
  const sub = currentSub();
  if (sub === unitsSub) return;
  unitsSub = sub;
  units = sub === null ? 'asWritten' : (readCache(sub) ?? 'asWritten');
}

function set(sub: string, next: UnitSystem): void {
  writeCache(sub, next);
  if (unitsSub !== sub || units === next) return;
  units = next;
  emit();
}

async function load(sub: string): Promise<void> {
  loadedFor = sub;
  const started = generation;
  try {
    const fetched = await fetchUnitSystem();
    if (generation === started && currentSub() === sub) set(sub, fetched);
  } catch {
    // Keep the cached value; the next subscribe or session change tries again.
    if (loadedFor === sub) loadedFor = null;
  }
}

function loadIfNeeded(): void {
  const sub = currentSub();
  if (sub !== null && loadedFor !== sub) void load(sub);
}

/** A failed read is tried again when the tab comes back or the device reconnects. */
function retryWhenVisible(): void {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') loadIfNeeded();
}

export function subscribeUnitSystem(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeSession = subscribeSession(() => {
    followSession();
    loadIfNeeded();
    listener();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('online', retryWhenVisible);
    document.addEventListener('visibilitychange', retryWhenVisible);
  }
  loadIfNeeded();
  return () => {
    listeners.delete(listener);
    unsubscribeSession();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', retryWhenVisible);
      document.removeEventListener('visibilitychange', retryWhenVisible);
    }
  };
}

export function getUnitSystem(): UnitSystem {
  followSession();
  return units;
}

/** Saves go out one at a time, so the server keeps the last choice, not the last to arrive. */
let saveQueue: Promise<unknown> = Promise.resolve();

/**
 * Shows `next` at once and saves it to the account. A failed save puts the
 * previous value back and re-reads the account, unless a newer choice was
 * made meanwhile, and throws for the caller to show.
 */
export async function setUnitSystem(next: UnitSystem): Promise<void> {
  followSession();
  const sub = unitsSub;
  if (sub === null) return;
  const previous = units;
  const mine = ++generation;
  set(sub, next);
  const saving = saveQueue.then(() => saveUnitSystem(next));
  saveQueue = saving.catch(() => {});
  try {
    await saving;
  } catch (err) {
    if (generation === mine) {
      set(sub, previous);
      // The server may hold either value now; its answer is the truth.
      loadedFor = null;
      loadIfNeeded();
    }
    throw err;
  }
}

/** The member's measurement units; 'asWritten' when signed out. */
export function useUnitSystem(): UnitSystem {
  return useSyncExternalStore(subscribeUnitSystem, getUnitSystem, getUnitSystem);
}

onSessionReset(() => {
  clearCache();
  unitsSub = null;
  units = 'asWritten';
  loadedFor = null;
  generation += 1;
  emit();
});
