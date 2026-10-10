/**
 * Account preferences (`docs/plans/measurement-units.md`): display choices a
 * member makes once and gets on every device. Today only `units`, whether
 * the recipe screen shows US weights and °F as written or in metric. The
 * conversion happens in the client; the stored recipe never changes.
 *
 * Stored at `users/{sub}/settings/preferences`, beside the kitchen profile
 * and separate from it (its POST replaces its whole document), so deleting
 * `users/{sub}` removes it. Not synced, not in backups, not on MCP.
 *
 * `GET /api/settings/preferences` answers `{ preferences }` (the defaults
 * when none are saved); `POST` replaces them. Both are gated by
 * `withMembership`.
 */
import { sanitizedError } from './importLog.ts';
import {
  RequestBodyError,
  readBoundedText,
  storeUnavailable,
  type MembershipHandlerContext,
} from './membership.ts';
import { getStoreFirestore } from './store.ts';

/** Mirrored in `src/lib/accountPreferences.ts`. */
export const UNIT_SYSTEMS = ['asWritten', 'metric'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export const MAX_PREFERENCES_BODY_BYTES = 1024;

export interface AccountPreferencesFields {
  units: UnitSystem;
}

export interface AccountPreferences extends AccountPreferencesFields {
  updatedAt: number;
}

export const DEFAULT_PREFERENCES: AccountPreferencesFields = { units: 'asWritten' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitSystem(value: unknown): value is UnitSystem {
  return typeof value === 'string' && (UNIT_SYSTEMS as readonly string[]).includes(value);
}

/** A request body as preferences, or null. Strict: a missing or unknown value is refused. */
export function parseAccountPreferencesInput(body: unknown): AccountPreferencesFields | null {
  if (!isPlainObject(body) || !isUnitSystem(body.units)) return null;
  return { units: body.units };
}

/** A stored document as preferences. Lenient: anything unknown reads as the default. */
export function accountPreferencesFromDoc(data: unknown): AccountPreferencesFields {
  if (!isPlainObject(data)) return { ...DEFAULT_PREFERENCES };
  return { units: isUnitSystem(data.units) ? data.units : DEFAULT_PREFERENCES.units };
}

export interface AccountPreferencesStore {
  /** The stored document's data, or undefined when there is none. */
  read(sub: string): Promise<unknown>;
  write(sub: string, preferences: AccountPreferences): Promise<void>;
}

function preferencesDoc(sub: string) {
  return getStoreFirestore().collection('users').doc(sub).collection('settings').doc('preferences');
}

export const firestoreAccountPreferencesStore: AccountPreferencesStore = {
  read: async (sub) => {
    const snap = await preferencesDoc(sub).get();
    return snap.exists ? snap.data() : undefined;
  },
  write: async (sub, preferences) => {
    await preferencesDoc(sub).set(preferences);
  },
};

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function badRequest(): Response {
  return noStoreJson({ error: 'Bad request', code: 'preferences-bad-request' }, 400);
}

export async function accountPreferencesGet(
  _req: Request,
  ctx: MembershipHandlerContext,
  store: AccountPreferencesStore = firestoreAccountPreferencesStore,
): Promise<Response> {
  let preferences: AccountPreferencesFields;
  try {
    preferences = accountPreferencesFromDoc(await store.read(ctx.authorizedSub));
  } catch {
    return storeUnavailable();
  }
  return noStoreJson({ preferences });
}

export async function accountPreferencesPost(
  req: Request,
  ctx: MembershipHandlerContext,
  store: AccountPreferencesStore = firestoreAccountPreferencesStore,
  now: () => number = Date.now,
): Promise<Response> {
  try {
    let raw: string | null;
    try {
      raw = await readBoundedText(req, MAX_PREFERENCES_BODY_BYTES);
    } catch (err) {
      if (err instanceof RequestBodyError) return badRequest();
      throw err;
    }
    if (raw === null) return noStoreJson({ error: 'Too large', code: 'preferences-too-large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest();
    }
    const fields = parseAccountPreferencesInput(body);
    if (fields === null) return badRequest();
    try {
      await store.write(ctx.authorizedSub, { ...fields, updatedAt: now() });
    } catch {
      return storeUnavailable();
    }
    return noStoreJson({ preferences: fields });
  } catch (err) {
    // The dispatcher logs whatever escapes, and a message could quote the body.
    throw sanitizedError('Preferences save failed', err);
  }
}
