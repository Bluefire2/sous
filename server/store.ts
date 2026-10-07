import {
  FieldPath,
  Firestore,
  type DocumentReference,
  type Transaction,
} from '@google-cloud/firestore';
import { firestoreConfig } from './env.ts';
import {
  SHARED_PARENT_OWNER_SUB_FIELD,
  type PushRejectReason,
} from './pushReasons.ts';
import { compactImportCheck } from './importWarnings.ts';
import { normalizeLang } from './lang.ts';
import { MAX_DONE_STEPS, compactSteps } from './recipeSteps.ts';
// Re-exported for the agent module, which may import only this file from server/.
export { compactSteps } from './recipeSteps.ts';
import { compactVariantOf } from './recipeVariant.ts';
import { TRANSLATIONS_COLLECTION, translationCacheDocIds } from './recipeTranslation.ts';
import { canViewRecipe } from './shareAuth.ts';
import { isUuid } from './uuid.ts';

export { SHARED_PARENT_OWNER_SUB_FIELD };
export type { PushRejectReason };

export type StoreKind =
  | 'recipes'
  | 'chatMessages'
  | 'cookState'
  | 'photos'
  | 'collections'
  | 'cookLogs';

export type CursorTuple = [number, string];

export type PullCursor = Partial<Record<StoreKind, CursorTuple>>;

export { isUuid };

/** Firestore's ALREADY_EXISTS from `create()`: the Admin SDK's numeric gRPC code 6. */
export function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 6;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

let firestoreClient: Firestore | null = null;

export function getStoreFirestore(): Firestore {
  if (firestoreClient === null) {
    firestoreClient = new Firestore(firestoreConfig());
  }
  return firestoreClient;
}

function getFirestore(): Firestore {
  return getStoreFirestore();
}

function userRef(uid: string) {
  return getFirestore().collection('users').doc(uid);
}

function colRef(uid: string, kind: StoreKind) {
  return userRef(uid).collection(kind);
}

export function gcsDeletesColRef(uid: string) {
  return userRef(uid).collection('gcsDeletes');
}

function gcsDeletesRef(uid: string) {
  return gcsDeletesColRef(uid);
}

export function photoDocRef(uid: string, photoId: string) {
  return colRef(uid, 'photos').doc(photoId);
}

export function recipeDocRef(uid: string, recipeId: string) {
  return colRef(uid, 'recipes').doc(recipeId);
}

export function collectionDocRef(uid: string, collectionId: string) {
  return colRef(uid, 'collections').doc(collectionId);
}

export function collectionsColRef(uid: string) {
  return colRef(uid, 'collections');
}

export function photosColRef(uid: string) {
  return colRef(uid, 'photos');
}

export function readStoredMutationState(
  data: Record<string, unknown> | undefined,
): StoredMutationState | null {
  return readStoredState(data);
}

export interface StoredMutationState {
  updatedAt: number;
  deletedAt?: number;
}

export type CompareMutationResult =
  | { allow: true; undeleting: boolean }
  | {
      allow: false;
      reason: 'stale' | 'already-deleted';
    };

export function compareMutation(
  stored: StoredMutationState | null,
  clientUpdatedAt: number,
  mutation: 'put' | 'tombstone',
): CompareMutationResult {
  const storedAt = stored?.updatedAt ?? 0;
  const isTombstone =
    stored !== null &&
    stored.deletedAt !== undefined &&
    Number.isFinite(stored.deletedAt);

  if (mutation === 'put') {
    if (isTombstone) {
      if (clientUpdatedAt > storedAt) {
        return { allow: true, undeleting: true };
      }
      return { allow: false, reason: 'already-deleted' };
    }
    if (storedAt > clientUpdatedAt) {
      return { allow: false, reason: 'stale' };
    }
    return { allow: true, undeleting: false };
  }

  if (storedAt > clientUpdatedAt) {
    return { allow: false, reason: 'stale' };
  }
  return { allow: true, undeleting: false };
}

export function encodePullCursor(cursor: PullCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePullCursor(raw: string | null | undefined): PullCursor {
  if (raw === null || raw === undefined || raw === '') {
    return {};
  }
  try {
    const buf = Buffer.from(raw, 'base64url');
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (!isPlainObject(parsed)) {
      return {};
    }
    const out: PullCursor = {};
    const kinds: StoreKind[] = [
      'recipes',
      'chatMessages',
      'cookState',
      'photos',
      'collections',
      'cookLogs',
    ];
    for (const kind of kinds) {
      const entry = parsed[kind];
      if (!Array.isArray(entry) || entry.length !== 2) {
        continue;
      }
      const ts = finiteNumber(entry[0]);
      const id = entry[1];
      if (ts === undefined || !isUuid(id)) {
        continue;
      }
      out[kind] = [ts, id];
    }
    return out;
  } catch {
    return {};
  }
}

export function chunkForBatch<T>(items: T[], maxSize: number): T[][] {
  if (maxSize < 1) {
    throw new Error('maxSize must be >= 1');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxSize) {
    chunks.push(items.slice(i, i + maxSize));
  }
  return chunks;
}

/** Split so the sum of per-item write costs stays ≤ maxCost (Firestore tx cap). */
export function chunkByCost<T>(
  items: T[],
  costOf: (item: T) => number,
  maxCost: number,
): T[][] {
  if (maxCost < 1) {
    throw new Error('maxCost must be >= 1');
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  let cost = 0;
  for (const item of items) {
    const itemCost = costOf(item);
    if (itemCost > maxCost) {
      throw new Error('item cost exceeds maxCost');
    }
    if (current.length > 0 && cost + itemCost > maxCost) {
      chunks.push(current);
      current = [];
      cost = 0;
    }
    current.push(item);
    cost += itemCost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function compactRecipeFields(recipe: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    id: recipe.id,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    // Only `text` and a valid `lane` survive (`server/recipeSteps.ts`).
    steps: compactSteps(recipe.steps),
    tags: recipe.tags,
  };
  for (const key of [
    'description',
    'sourceUrl',
    'prepMinutes',
    'cookMinutes',
    'notes',
    'photoId',
  ] as const) {
    if (recipe[key] !== undefined) {
      next[key] = recipe[key];
    }
  }
  const lang = normalizeLang(recipe.lang);
  if (lang !== undefined) {
    next.lang = lang;
  }
  const galleryPhotoIds = compactGalleryPhotoIds(
    recipe.galleryPhotoIds,
    typeof recipe.photoId === 'string' ? recipe.photoId : undefined,
  );
  if (galleryPhotoIds !== undefined) {
    next.galleryPhotoIds = galleryPhotoIds;
  }
  // Malformed is dropped, not rejected (`validateRecipePut` never checks it),
  // so a put from an older or newer client still saves.
  const importCheck = compactImportCheck(recipe.importCheck);
  if (importCheck !== undefined) {
    next.importCheck = importCheck;
  }
  const variantOf = compactVariantOf(recipe.variantOf, recipe.id);
  if (variantOf !== undefined) {
    next.variantOf = variantOf;
  }
  return next;
}

export const MAX_NAMED_COLLECTIONS = 50;
export const MAX_COLLECTION_RECIPE_IDS = 500;
export const MAX_COLLECTION_NAME_LENGTH = 80;

export function compactCollectionFields(
  collection: Record<string, unknown>,
): Record<string, unknown> {
  const recipeIds: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(collection.recipeIds)) {
    for (const id of collection.recipeIds) {
      if (typeof id !== 'string' || id === '' || seen.has(id)) {
        continue;
      }
      seen.add(id);
      recipeIds.push(id);
      if (recipeIds.length >= MAX_COLLECTION_RECIPE_IDS) {
        break;
      }
    }
  }
  const name =
    typeof collection.name === 'string' ? collection.name.trim() : '';
  return {
    id: collection.id,
    name,
    recipeIds,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

/**
 * Live collections that still list `recipeId`. A collection saved after the
 * recipe delete keeps other edits; `updatedAt` is raised so the membership
 * put is not rejected as stale. Tombstones and docs that do not list the id
 * are skipped.
 */
export function collectionsToScrub(
  docs: Record<string, unknown>[],
  recipeId: string,
  at: number,
): Record<string, unknown>[] {
  const next: Record<string, unknown>[] = [];
  for (const doc of docs) {
    if (!isLiveDoc(doc)) {
      continue;
    }
    const recipeIds = Array.isArray(doc.recipeIds) ? doc.recipeIds : [];
    if (!recipeIds.includes(recipeId)) {
      continue;
    }
    const stored = readStoredMutationState(doc);
    const writeAt = Math.max(at, stored?.updatedAt ?? 0);
    next.push(
      compactCollectionFields({
        ...doc,
        recipeIds: recipeIds.filter((id) => id !== recipeId),
        updatedAt: writeAt,
      }),
    );
  }
  return next;
}

export function collectionDocsFromQuerySnap(
  docs: ReadonlyArray<{ id: string; data: () => Record<string, unknown> | undefined }>,
): Record<string, unknown>[] {
  return docs.map((doc) => ({ ...(doc.data() ?? {}), id: doc.id }));
}

export async function applyCollectionMembershipScrubs(
  docs: Record<string, unknown>[],
  recipeId: string,
  at: number,
  write: (
    id: string,
    payload: Record<string, unknown>,
    writeAt: number,
  ) => Promise<unknown>,
): Promise<void> {
  for (const payload of collectionsToScrub(docs, recipeId, at)) {
    const id = payload.id;
    const writeAt = finiteNumber(payload.updatedAt);
    if (typeof id !== 'string' || writeAt === undefined) {
      continue;
    }
    await write(id, payload, writeAt);
  }
}

const MAX_GALLERY_PHOTOS = 8;

function compactGalleryPhotoIds(
  ids: unknown,
  coverId: string | undefined,
): string[] | undefined {
  if (!Array.isArray(ids) || ids.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || id === coverId || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_GALLERY_PHOTOS) {
      break;
    }
  }
  return next.length > 0 ? next : undefined;
}

export const MAX_COOK_LOG_PHOTOS = 8;
export const MAX_COOK_LOG_TEXT = 10_000;
export const MAX_COOK_LOG_SERVINGS = 1000;

/** Same rule as the client's `isCookedOn`; `server/` cannot import `src/`. */
export function isCookedOn(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function compactCookLogText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Must keep the same keys as the client's `compactCookLog`. */
export function compactCookLogFields(log: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {
    id: log.id,
    recipeId: log.recipeId,
    cookedOn: log.cookedOn,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
  if (finiteNumber(log.rating) !== undefined) {
    next.rating = log.rating;
  }
  if (finiteNumber(log.servings) !== undefined) {
    next.servings = log.servings;
  }
  const notes = compactCookLogText(log.notes);
  if (notes !== undefined) {
    next.notes = notes;
  }
  const lessons = compactCookLogText(log.lessons);
  if (lessons !== undefined) {
    next.lessons = lessons;
  }
  if (Array.isArray(log.photoIds)) {
    const seen = new Set<string>();
    const photoIds: string[] = [];
    for (const id of log.photoIds) {
      if (typeof id !== 'string' || id === '' || seen.has(id)) {
        continue;
      }
      seen.add(id);
      photoIds.push(id);
      if (photoIds.length >= MAX_COOK_LOG_PHOTOS) {
        break;
      }
    }
    if (photoIds.length > 0) {
      next.photoIds = photoIds;
    }
  }
  return next;
}

/** An entry cannot move between recipes: its photos stay owned by the first one. */
export function cookLogMovesRecipe(
  storedRaw: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): boolean {
  return storedRaw !== null && isLiveDoc(storedRaw) && storedRaw.recipeId !== payload.recipeId;
}

/**
 * Cascade tombstone time for children that must die with the recipe even when
 * edited later (a back-dated cook log, or a device with a fast clock). Safe
 * because the `putDoc` parent check refuses any put under a deleted recipe.
 * `null` means already a tombstone: skip, and do not re-queue `gcsDeletes`.
 */
export function forcedTombstoneAt(
  at: number,
  stored: StoredMutationState | null,
): number | null {
  if (stored?.deletedAt !== undefined && Number.isFinite(stored.deletedAt)) {
    return null;
  }
  return Math.max(at, stored?.updatedAt ?? 0);
}

export interface CascadeChildJob {
  kind: StoreKind;
  id: string;
  forced: boolean;
}

/**
 * Every photo here belongs to the recipe being deleted, and the photos route
 * refuses uploads for a dead recipe, so photos are forced like cook logs.
 * Chat and cookState keep plain last-write-wins.
 */
export function cascadeChildJobs(children: {
  chatIds: string[];
  cookStateIds: string[];
  cookLogIds: string[];
  photoIds: string[];
}): CascadeChildJob[] {
  return [
    ...children.chatIds.map((id) => ({ kind: 'chatMessages' as StoreKind, id, forced: false })),
    ...children.cookStateIds.map((id) => ({ kind: 'cookState' as StoreKind, id, forced: false })),
    ...children.cookLogIds.map((id) => ({ kind: 'cookLogs' as StoreKind, id, forced: true })),
    ...children.photoIds.map((id) => ({ kind: 'photos' as StoreKind, id, forced: true })),
  ];
}

/** A photo tombstone also writes its `gcsDeletes` doc. */
export function cascadeJobCost(job: Pick<CascadeChildJob, 'kind'>): number {
  return job.kind === 'photos' ? 2 : 1;
}

export function cascadeTombstoneAt(
  job: Pick<CascadeChildJob, 'forced'>,
  at: number,
  stored: StoredMutationState | null,
): number | null {
  if (job.forced) {
    return forcedTombstoneAt(at, stored);
  }
  return compareMutation(stored, at, 'tombstone').allow ? at : null;
}

export type MutationResult =
  | { applied: true; serverUpdatedAt: number }
  | {
      applied: false;
      reason?: PushRejectReason;
      current?: Record<string, unknown>;
    };

export function isLiveDoc(data: Record<string, unknown> | undefined): boolean {
  if (!data) {
    return false;
  }
  return data.deletedAt === undefined || data.deletedAt === null;
}

function readStoredState(data: Record<string, unknown> | undefined): StoredMutationState | null {
  if (!data) {
    return null;
  }
  const updatedAt = finiteNumber(data.updatedAt);
  if (updatedAt === undefined) {
    return null;
  }
  const deletedAt = finiteNumber(data.deletedAt);
  return deletedAt !== undefined
    ? { updatedAt, deletedAt }
    : { updatedAt };
}

function tombstonePayload(
  id: string,
  clientUpdatedAt: number,
  serverUpdatedAt: number,
): Record<string, unknown> {
  return {
    id,
    updatedAt: clientUpdatedAt,
    deletedAt: clientUpdatedAt,
    serverUpdatedAt,
  };
}

export type SharedParentCandidate = {
  share: Record<string, unknown> | undefined;
  grantId: string;
  collection: Record<string, unknown> | undefined;
  recipe: Record<string, unknown> | undefined;
};

/**
 * Owner sub from one incoming-share candidate, or null when that candidate
 * does not authorize `recipeId`. The owner is read from the share document.
 */
export function sharedParentOwnerFromCandidate(
  recipeId: string,
  candidate: SharedParentCandidate,
): string | null {
  const data = candidate.share;
  if (!isLiveDoc(data)) {
    return null;
  }
  const ownerSub = data?.ownerSub;
  const collectionId = data?.collectionId;
  if (
    typeof ownerSub !== 'string' ||
    ownerSub === '' ||
    typeof collectionId !== 'string' ||
    !isUuid(collectionId)
  ) {
    return null;
  }
  const share = { grantId: candidate.grantId, ownerSub, collectionId };
  if (!canViewRecipe(recipeId, share, candidate.collection, candidate.recipe)) {
    return null;
  }
  return ownerSub;
}

/**
 * Marker stored on a chat or cook put. A live owned parent stores nothing,
 * even if a share owner was also discovered. Otherwise the marker is that
 * server-discovered owner, or null when there isn't one.
 */
export function sharedParentMarkerForWrite(
  ownedParentLive: boolean,
  discoveredOwnerSub: string | null,
): string | null {
  if (ownedParentLive) {
    return null;
  }
  if (typeof discoveredOwnerSub !== 'string' || discoveredOwnerSub === '') {
    return null;
  }
  return discoveredOwnerSub;
}

/**
 * Chat/cook document body. Strips client provenance, uid, sub, and deletedAt.
 * `sharedParentOwnerSub` is set only from `sharedParentOwnerSub` argument,
 * which the caller derives on the server. `putDoc` writes this with merge
 * false, so omitting the field clears a previously stored marker.
 */
export function chatOrCookPutBody(
  payload: Record<string, unknown>,
  id: string,
  clientUpdatedAt: number,
  serverUpdatedAt: number,
  sharedParentOwnerSub: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...payload,
    id,
    updatedAt: clientUpdatedAt,
    serverUpdatedAt,
  };
  delete body.deletedAt;
  delete body.uid;
  delete body.sub;
  delete body[SHARED_PARENT_OWNER_SUB_FIELD];
  if (sharedParentOwnerSub !== null && sharedParentOwnerSub !== '') {
    body[SHARED_PARENT_OWNER_SUB_FIELD] = sharedParentOwnerSub;
  }
  return body;
}

/**
 * Live chat/cook owned-pull shape. Domain fields pass through.
 * `sharedParentOwnerSub` is wire metadata only when it is a non-empty string.
 */
export function chatCookPullFields(doc: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...doc };
  delete copy.serverUpdatedAt;
  delete copy.deletedAt;
  const owner = copy[SHARED_PARENT_OWNER_SUB_FIELD];
  delete copy[SHARED_PARENT_OWNER_SUB_FIELD];
  if (typeof owner === 'string' && owner !== '') {
    copy[SHARED_PARENT_OWNER_SUB_FIELD] = owner;
  }
  return copy;
}

/**
 * Collection tombstone. `updatedAt` and `deletedAt` stay on the client clock.
 * `grantCascadeAt` is the server order used to revoke grants; it is not a
 * client LWW field and must not be copied into `updatedAt` or `deletedAt`.
 */
export function collectionDeletePayload(
  id: string,
  clientUpdatedAt: number,
  serverUpdatedAt: number,
  grantCascadeAt?: number,
): Record<string, unknown> {
  const payload = tombstonePayload(id, clientUpdatedAt, serverUpdatedAt);
  if (grantCascadeAt !== undefined) {
    payload.grantCascadeAt = grantCascadeAt;
  }
  return payload;
}

/**
 * Shared-recipe owner when the session can view `recipeId` through a live
 * incoming share. The owner is the `ownerSub` stored on that share. Returns
 * null when no share authorizes the recipe. Callers must check an owned
 * parent first; a live owned recipe takes precedence over this result.
 */
export type SharedParentLookupIo = {
  /** The viewer's incoming shares; only `ownerSub`'s when it is non-null. */
  listShares: (
    ownerSub: string | null,
  ) => Promise<Array<{ grantId: string; data: Record<string, unknown> }>>;
  readCollection: (
    ownerSub: string,
    collectionId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  readRecipe: (
    ownerSub: string,
    recipeId: string,
  ) => Promise<Record<string, unknown> | undefined>;
};

/**
 * Finds the owner whose live share authorizes `recipeId` as a chat/cook
 * parent. `hintOwnerSub` must be a server-written `sharedParentOwnerSub`; it
 * only narrows which shares are checked first, and every candidate still
 * passes the full share → collection → listed recipe → live recipe chain.
 */
export async function findSharedParentOwner(
  recipeId: string,
  hintOwnerSub: string | null,
  io: SharedParentLookupIo,
): Promise<string | null> {
  const checked = new Set<string>();
  const scan = async (
    shares: Array<{ grantId: string; data: Record<string, unknown> }>,
  ): Promise<string | null> => {
    for (const { grantId, data } of shares) {
      if (checked.has(grantId)) {
        continue;
      }
      checked.add(grantId);
      if (!isLiveDoc(data)) {
        continue;
      }
      const ownerSub = data.ownerSub;
      const collectionId = data.collectionId;
      if (
        typeof ownerSub !== 'string' ||
        ownerSub === '' ||
        typeof collectionId !== 'string' ||
        !isUuid(collectionId)
      ) {
        continue;
      }
      const collection = await io.readCollection(ownerSub, collectionId);
      const ids = Array.isArray(collection?.recipeIds) ? collection.recipeIds : [];
      if (!ids.includes(recipeId)) {
        continue;
      }
      const recipe = await io.readRecipe(ownerSub, recipeId);
      const owner = sharedParentOwnerFromCandidate(recipeId, {
        share: data,
        grantId,
        collection,
        recipe,
      });
      if (owner !== null) {
        return owner;
      }
    }
    return null;
  };
  if (hintOwnerSub !== null && hintOwnerSub !== '') {
    const hinted = await scan(
      (await io.listShares(hintOwnerSub)).filter(
        ({ data }) => data.ownerSub === hintOwnerSub,
      ),
    );
    if (hinted !== null) {
      return hinted;
    }
  }
  return scan(await io.listShares(null));
}

export function storedSharedParentOwner(
  row: Record<string, unknown> | undefined | null,
): string | null {
  const marker = row?.[SHARED_PARENT_OWNER_SUB_FIELD];
  return typeof marker === 'string' && marker !== '' ? marker : null;
}

export async function sharedParentLive(
  tx: Transaction,
  sessionSub: string,
  recipeId: string,
  hintOwnerSub: string | null,
): Promise<string | null> {
  const items = getFirestore()
    .collection('incomingShares')
    .doc(sessionSub)
    .collection('items');
  const readData = async (ref: DocumentReference) => {
    const snap = await tx.get(ref);
    return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
  };
  return findSharedParentOwner(recipeId, hintOwnerSub, {
    listShares: async (ownerSub) => {
      const snap = await tx.get(
        ownerSub === null ? items : items.where('ownerSub', '==', ownerSub),
      );
      return snap.docs.map((doc) => ({
        grantId: doc.id,
        data: doc.data() as Record<string, unknown>,
      }));
    },
    readCollection: (ownerSub, collectionId) =>
      readData(collectionDocRef(ownerSub, collectionId)),
    readRecipe: (ownerSub, id) => readData(recipeDocRef(ownerSub, id)),
  });
}

async function readRecipeLive(
  tx: Transaction,
  uid: string,
  recipeId: string,
): Promise<boolean> {
  const snap = await tx.get(colRef(uid, 'recipes').doc(recipeId));
  if (!snap.exists) {
    return false;
  }
  const data = snap.data() as Record<string, unknown>;
  return isLiveDoc(data);
}

export async function upsertUser(
  uid: string,
  profile: { email: string; name?: string },
): Promise<void> {
  const ref = userRef(uid);
  const now = Date.now();
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = userProfileUpsertFields(profile, now, !snap.exists);
    tx.set(ref, base, { merge: true });
  });
}

/** The `emailLower` a stored profile is missing, or null when it already matches or has no email. */
export function emailLowerBackfill(profile: Record<string, unknown>): string | null {
  const email = profile.email;
  if (typeof email !== 'string' || email.trim() === '') {
    return null;
  }
  const lower = email.trim().toLowerCase();
  return profile.emailLower === lower ? null : lower;
}

export function userProfileUpsertFields(
  profile: { email: string; name?: string },
  now: number,
  isNew: boolean,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    email: profile.email,
    emailLower: profile.email.trim().toLowerCase(),
    lastSeenAt: now,
  };
  if (profile.name !== undefined) {
    fields.name = profile.name;
  }
  if (isNew) {
    fields.createdAt = now;
  }
  return fields;
}

export async function listChangedSince(
  uid: string,
  kind: StoreKind,
  cursor: CursorTuple | null | undefined,
  limit: number,
): Promise<{
  docs: Record<string, unknown>[];
  cursor: CursorTuple | null;
  hasMore: boolean;
}> {
  let query = colRef(uid, kind)
    .orderBy('serverUpdatedAt')
    .orderBy(FieldPath.documentId())
    .limit(limit + 1);
  if (cursor) {
    query = query.startAfter(cursor[0], cursor[1]);
  }
  const fetched = await query.get();
  const hasMore = fetched.docs.length > limit;
  const slice = hasMore ? fetched.docs.slice(0, limit) : fetched.docs;
  const docs = slice.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return { id: doc.id, ...data };
  });
  let nextCursor: CursorTuple | null = null;
  if (slice.length > 0) {
    const last = slice[slice.length - 1];
    const data = last.data() as Record<string, unknown>;
    const ts = finiteNumber(data.serverUpdatedAt);
    if (ts !== undefined) {
      nextCursor = [ts, last.id];
    }
  }
  return { docs, cursor: nextCursor, hasMore };
}

export async function readDocData(
  uid: string,
  kind: StoreKind,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await colRef(uid, kind).doc(id).get();
  if (!snap.exists) {
    return undefined;
  }
  return snap.data() as Record<string, unknown>;
}

/** Batched `readDocData`. Results line up with `ids`, including duplicates. */
export async function readDocsData(
  uid: string,
  kind: StoreKind,
  ids: readonly string[],
): Promise<Array<Record<string, unknown> | undefined>> {
  const out: Array<Record<string, unknown> | undefined> = [];
  for (const chunk of chunkForBatch([...ids], 100)) {
    const snaps = await getFirestore().getAll(
      ...chunk.map((id) => colRef(uid, kind).doc(id)),
    );
    for (const snap of snaps) {
      out.push(snap?.exists ? (snap.data() as Record<string, unknown>) : undefined);
    }
  }
  return out;
}

/**
 * Keep ids whose recipe docs are missing (same-batch create) or live.
 * Drop ids whose recipe docs are tombstones so a stale collection.put
 * cannot briefly re-list a deleted recipe.
 */
export function recipeIdsWithoutTombstones(
  recipeIds: readonly string[],
  tombstonedRecipeIds: ReadonlySet<string>,
): string[] {
  return recipeIds.filter((id) => !tombstonedRecipeIds.has(id));
}

/**
 * Only newly listed ids need a tombstone read; existing membership was checked
 * on its prior put and relies on the recipe-delete cascade. If that cascade
 * fails after tombstoning, retrying recipe.delete is what scrubs the stored id.
 */
export function addedCollectionRecipeIds(
  existing: Record<string, unknown> | undefined,
  nextRecipeIds: readonly string[],
): string[] {
  if (!isLiveDoc(existing) || !Array.isArray(existing?.recipeIds)) {
    return [...nextRecipeIds];
  }
  const previous = new Set(
    existing.recipeIds.filter((id): id is string => typeof id === 'string'),
  );
  return nextRecipeIds.filter((id) => !previous.has(id));
}

export async function readTombstonedRecipeIds(
  uid: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const tombstoned = new Set<string>();
  if (unique.length === 0) {
    return tombstoned;
  }
  for (const chunk of chunkForBatch(unique, 100)) {
    const snaps = await getFirestore().getAll(
      ...chunk.map((id) => colRef(uid, 'recipes').doc(id)),
      { fieldMask: ['deletedAt'] },
    );
    chunk.forEach((id, i) => {
      const snap = snaps[i];
      if (
        snap?.exists &&
        !isLiveDoc(snap.data() as Record<string, unknown>)
      ) {
        tombstoned.add(id);
      }
    });
  }
  return tombstoned;
}

export const LIST_LIVE_DOCS_PAGE_SIZE = 200;

export type ListLiveDocsLimits = {
  maxDocs: number;
  maxBytes: number;
};

export type ListLiveDocsAccumulator = {
  docs: Record<string, unknown>[];
  totalBytes: number;
  truncated: boolean;
  done: boolean;
};

export function createListLiveDocsAccumulator(): ListLiveDocsAccumulator {
  return { docs: [], totalBytes: 0, truncated: false, done: false };
}

export type ListLiveDocsCandidate = {
  live: boolean;
  doc: Record<string, unknown>;
  jsonBytes: number;
};

/** Fold for live-doc paging caps. Kept docs are appended in place; tombstones pass `live: false`. */
export function foldListLiveDocsCandidate(
  acc: ListLiveDocsAccumulator,
  candidate: ListLiveDocsCandidate,
  limits: ListLiveDocsLimits,
): ListLiveDocsAccumulator {
  if (acc.done || !candidate.live) {
    return acc;
  }
  if (acc.docs.length >= limits.maxDocs) {
    return { ...acc, truncated: true, done: true };
  }
  if (acc.totalBytes + candidate.jsonBytes > limits.maxBytes) {
    return { ...acc, truncated: true, done: true };
  }
  acc.docs.push(candidate.doc);
  acc.totalBytes += candidate.jsonBytes;
  return acc;
}

function liveDocJsonBytes(doc: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

function listLiveDocsPayload(
  kind: 'recipes' | 'collections',
  id: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'recipes') {
    return compactRecipeFields({ ...raw, id });
  }
  return { ...raw, id };
}

export async function listLiveDocs(
  uid: string,
  kind: 'recipes' | 'collections',
  limits: ListLiveDocsLimits,
): Promise<{ docs: Record<string, unknown>[]; truncated: boolean }> {
  let acc = createListLiveDocsAccumulator();
  let lastId: string | undefined;
  while (!acc.done) {
    let query = colRef(uid, kind)
      .orderBy(FieldPath.documentId())
      .limit(LIST_LIVE_DOCS_PAGE_SIZE);
    if (lastId !== undefined) {
      query = query.startAfter(lastId);
    }
    const fetched = await query.get();
    if (fetched.empty) {
      break;
    }
    for (const snap of fetched.docs) {
      lastId = snap.id;
      const raw = snap.data() as Record<string, unknown>;
      if (!isLiveDoc(raw)) {
        continue;
      }
      const doc = listLiveDocsPayload(kind, snap.id, raw);
      acc = foldListLiveDocsCandidate(
        acc,
        { live: true, doc, jsonBytes: liveDocJsonBytes(doc) },
        limits,
      );
      if (acc.done) {
        break;
      }
    }
    if (acc.done || fetched.size < LIST_LIVE_DOCS_PAGE_SIZE) {
      break;
    }
  }
  return { docs: acc.docs, truncated: acc.truncated };
}

/** Pages until `cap + 1` live docs or exhausted. Tombstones do not count. */
export async function countLiveNamedCollections(
  uid: string,
  cap: number = MAX_NAMED_COLLECTIONS,
): Promise<number> {
  let live = 0;
  let lastId: string | undefined;
  while (true) {
    let query = colRef(uid, 'collections').orderBy(FieldPath.documentId()).limit(50);
    if (lastId !== undefined) {
      query = query.startAfter(lastId);
    }
    const fetched = await query.get();
    if (fetched.empty) {
      return live;
    }
    for (const doc of fetched.docs) {
      lastId = doc.id;
      if (isLiveDoc(doc.data() as Record<string, unknown>)) {
        live += 1;
        if (live > cap) {
          return live;
        }
      }
    }
    if (fetched.size < 50) {
      return live;
    }
  }
}

/**
 * The stored recipe document: the compacted fields plus identity and both
 * clocks. `putDoc` and `updateOwnRecipe` both build it here, so a sync push
 * and an MCP edit write the same shape.
 */
export function recipeDocBody(
  payload: Record<string, unknown>,
  id: string,
  updatedAt: number,
  serverUpdatedAt: number,
): Record<string, unknown> {
  return {
    ...compactRecipeFields(payload),
    id,
    updatedAt,
    serverUpdatedAt,
  };
}

/**
 * `updatedAt` for a server-side edit: now, or one past the stored clock when
 * that is ahead (a device with a fast clock). The edit always wins LWW against
 * what it replaced, and the server never plants a time from a client.
 */
export function nextRecipeUpdatedAt(storedUpdatedAt: number, now: number): number {
  return Math.max(now, storedUpdatedAt + 1);
}

export type OwnRecipeUpdateDecision =
  | { kind: 'ok'; stored: Record<string, unknown>; storedUpdatedAt: number }
  | { kind: 'not_found' }
  | { kind: 'conflict'; version: number };

/**
 * Whether an edit of the caller's own recipe at `expectedVersion` may go
 * ahead. A missing or tombstoned doc is `not_found` (a shared recipe's id is
 * missing from the caller's tree, so it lands here too). A stored `updatedAt`
 * other than the version the editor read is `conflict`, with the current one.
 */
export function ownRecipeUpdateDecision(
  storedRaw: Record<string, unknown> | undefined,
  expectedVersion: number,
): OwnRecipeUpdateDecision {
  if (storedRaw === undefined || !isLiveDoc(storedRaw)) {
    return { kind: 'not_found' };
  }
  const storedUpdatedAt = finiteNumber(storedRaw.updatedAt);
  if (storedUpdatedAt === undefined) {
    return { kind: 'not_found' };
  }
  if (storedUpdatedAt !== expectedVersion) {
    return { kind: 'conflict', version: storedUpdatedAt };
  }
  return { kind: 'ok', stored: storedRaw, storedUpdatedAt };
}

export type OwnRecipeUpdateResult =
  | { kind: 'ok'; doc: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'conflict'; version: number }
  | { kind: 'too_large' };

/**
 * Edits one live recipe in the caller's own tree (`users/{uid}/recipes/{id}`)
 * in one transaction: read, `ownRecipeUpdateDecision`, then `apply(stored,
 * updatedAt)` builds the new payload and it is written whole (`merge: false`)
 * through `recipeDocBody`. `apply` returns null when the result is too large
 * to store. Never touches another member's tree, collections, or photos.
 */
export async function updateOwnRecipe(
  uid: string,
  id: string,
  expectedVersion: number,
  apply: (stored: Record<string, unknown>, updatedAt: number) => Record<string, unknown> | null,
): Promise<OwnRecipeUpdateResult> {
  const ref = colRef(uid, 'recipes').doc(id);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const decision = ownRecipeUpdateDecision(
      snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
      expectedVersion,
    );
    if (decision.kind !== 'ok') {
      return decision;
    }
    const serverUpdatedAt = Date.now();
    const updatedAt = nextRecipeUpdatedAt(decision.storedUpdatedAt, serverUpdatedAt);
    const payload = apply(decision.stored, updatedAt);
    if (payload === null) {
      return { kind: 'too_large' };
    }
    const doc = recipeDocBody(payload, id, updatedAt, serverUpdatedAt);
    tx.set(ref, doc, { merge: false });
    return { kind: 'ok', doc };
  });
}

export async function putDoc(
  uid: string,
  kind: StoreKind,
  id: string,
  payload: Record<string, unknown>,
  clientUpdatedAt: number,
): Promise<MutationResult> {
  const ref = colRef(uid, kind).doc(id);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);

    const cmp = compareMutation(stored, clientUpdatedAt, 'put');
    if (!cmp.allow) {
      return {
        applied: false,
        reason: cmp.reason === 'already-deleted' ? 'already-deleted' : undefined,
        current: storedRaw ?? undefined,
      };
    }

    if (kind === 'cookLogs' && cookLogMovesRecipe(storedRaw, payload)) {
      return { applied: false, reason: 'invalid' };
    }

    let parentRecipeId: string | null = null;
    if (kind === 'chatMessages' || kind === 'cookLogs') {
      const recipeId = payload.recipeId;
      if (typeof recipeId !== 'string') {
        return { applied: false, reason: 'invalid' };
      }
      parentRecipeId = recipeId;
    } else if (kind === 'cookState') {
      parentRecipeId = id;
    } else if (kind === 'photos') {
      const recipeId = payload.recipeId;
      if (typeof recipeId !== 'string') {
        return { applied: false, reason: 'invalid' };
      }
      parentRecipeId = recipeId;
    }

    let ownedParentLive = parentRecipeId === null;
    let discoveredOwnerSub: string | null = null;
    if (parentRecipeId !== null) {
      ownedParentLive = await readRecipeLive(tx, uid, parentRecipeId);
      if (!ownedParentLive) {
        // Photo bytes and cook logs (which own photos) stay owned-parent-only.
        // Never fall back to a share.
        if (kind === 'photos' || kind === 'cookLogs') {
          return { applied: false, reason: 'recipe-deleted' };
        }
        let hintOwnerSub = storedSharedParentOwner(storedRaw);
        if (hintOwnerSub === null && kind === 'chatMessages') {
          const cookSnap = await tx.get(colRef(uid, 'cookState').doc(parentRecipeId));
          hintOwnerSub = storedSharedParentOwner(
            cookSnap.exists ? (cookSnap.data() as Record<string, unknown>) : undefined,
          );
        }
        discoveredOwnerSub = await sharedParentLive(
          tx,
          uid,
          parentRecipeId,
          hintOwnerSub,
        );
        if (sharedParentMarkerForWrite(false, discoveredOwnerSub) === null) {
          return { applied: false, reason: 'recipe-deleted' };
        }
      }
    }

    const serverUpdatedAt = Date.now();
    let body: Record<string, unknown>;
    if (kind === 'recipes') {
      body = recipeDocBody(payload, id, clientUpdatedAt, serverUpdatedAt);
      if (cmp.undeleting) {
        // deletedAt cleared by omission
      }
    } else if (kind === 'chatMessages' || kind === 'cookState') {
      body = chatOrCookPutBody(
        payload,
        id,
        clientUpdatedAt,
        serverUpdatedAt,
        sharedParentMarkerForWrite(ownedParentLive, discoveredOwnerSub),
      );
    } else {
      body = {
        ...payload,
        id,
        updatedAt: clientUpdatedAt,
        serverUpdatedAt,
      };
      delete body.deletedAt;
      delete body.uid;
      delete body.sub;
    }

    tx.set(ref, body, { merge: false });
    return { applied: true, serverUpdatedAt };
  });
}

export async function tombstoneDoc(
  uid: string,
  kind: StoreKind,
  id: string,
  clientUpdatedAt: number,
): Promise<MutationResult> {
  const ref = colRef(uid, kind).doc(id);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);

    const cmp = compareMutation(stored, clientUpdatedAt, 'tombstone');
    if (!cmp.allow) {
      return {
        applied: false,
        current: storedRaw ?? undefined,
      };
    }

    const serverUpdatedAt = Date.now();
    tx.set(ref, tombstonePayload(id, clientUpdatedAt, serverUpdatedAt), { merge: false });
    return { applied: true, serverUpdatedAt };
  });
}

export async function tombstonePhotoWithGcs(
  uid: string,
  photoId: string,
  at: number,
): Promise<MutationResult> {
  const serverUpdatedAt = Date.now();
  return getFirestore().runTransaction(async (tx) => {
    const photoRef = colRef(uid, 'photos').doc(photoId);
    const snap = await tx.get(photoRef);
    const storedRaw = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const stored = readStoredState(storedRaw ?? undefined);
    const cmp = compareMutation(stored, at, 'tombstone');
    if (!cmp.allow) {
      return {
        applied: false,
        current: storedRaw ?? undefined,
      };
    }
    tx.set(photoRef, tombstonePayload(photoId, at, serverUpdatedAt), { merge: false });
    tx.set(
      gcsDeletesRef(uid).doc(photoId),
      { photoId, createdAt: Date.now() },
      { merge: true },
    );
    return { applied: true, serverUpdatedAt };
  });
}

export async function cascadeRecipeDelete(
  uid: string,
  recipeId: string,
  at: number,
): Promise<{ photoIds: string[]; gcsPending: boolean }> {
  let recipePhotoId: string | undefined;
  const recipeGalleryIds: string[] = [];

  await getFirestore().runTransaction(async (tx) => {
    const recipeRef = colRef(uid, 'recipes').doc(recipeId);
    const snap = await tx.get(recipeRef);
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      if (isLiveDoc(data) && isUuid(data.photoId)) {
        recipePhotoId = data.photoId as string;
      }
      if (isLiveDoc(data) && Array.isArray(data.galleryPhotoIds)) {
        for (const pid of data.galleryPhotoIds) {
          if (isUuid(pid)) {
            recipeGalleryIds.push(pid);
          }
        }
      }
      const stored = readStoredState(data);
      const cmp = compareMutation(stored, at, 'tombstone');
      if (cmp.allow) {
        const serverUpdatedAt = Date.now();
        tx.set(recipeRef, tombstonePayload(recipeId, at, serverUpdatedAt), { merge: false });
      }
    } else {
      const serverUpdatedAt = Date.now();
      tx.set(recipeRef, tombstonePayload(recipeId, at, serverUpdatedAt), { merge: false });
    }
    // Derived cache, not a sync doc. Delete on every branch after the one
    // read: tombstone applied, stale reject, and missing doc. A missing
    // cache doc is a no-op. Firestore rejects any read after these writes.
    for (const docId of translationCacheDocIds(recipeId)) {
      tx.delete(userRef(uid).collection(TRANSLATIONS_COLLECTION).doc(docId));
    }
  });

  const photoIds = new Set<string>();
  if (recipePhotoId !== undefined) {
    photoIds.add(recipePhotoId);
  }
  for (const pid of recipeGalleryIds) {
    photoIds.add(pid);
  }

  const chatSnap = await colRef(uid, 'chatMessages').where('recipeId', '==', recipeId).get();
  const chatIds: string[] = [];
  for (const doc of chatSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      chatIds.push(doc.id);
      for (const pid of (data.photoIds as string[] | undefined) ?? []) {
        if (isUuid(pid)) {
          photoIds.add(pid);
        }
      }
    }
  }

  const cookRef = colRef(uid, 'cookState').doc(recipeId);
  const cookSnap = await cookRef.get();
  const cookIds: string[] = [];
  if (cookSnap.exists) {
    const data = cookSnap.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      cookIds.push(recipeId);
    }
  }

  const cookLogSnap = await colRef(uid, 'cookLogs').where('recipeId', '==', recipeId).get();
  const cookLogIds: string[] = [];
  for (const doc of cookLogSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      cookLogIds.push(doc.id);
      for (const pid of (data.photoIds as string[] | undefined) ?? []) {
        if (isUuid(pid)) {
          photoIds.add(pid);
        }
      }
    }
  }

  const photosSnap = await colRef(uid, 'photos').where('recipeId', '==', recipeId).get();
  for (const doc of photosSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (isLiveDoc(data)) {
      photoIds.add(doc.id);
    }
  }

  const childJobs = cascadeChildJobs({
    chatIds,
    cookStateIds: cookIds,
    cookLogIds,
    photoIds: [...photoIds],
  });

  for (const chunk of chunkByCost(childJobs, cascadeJobCost, 400)) {
    const serverUpdatedAt = Date.now();
    await getFirestore().runTransaction((tx) =>
      tombstoneChunk(
        tx,
        chunk,
        tombstoneRefs(uid),
        (stored) => chunk.map((job, i) => cascadeTombstoneAt(job, at, stored[i])),
        serverUpdatedAt,
      ),
    );
  }

  // Query and puts are separate steps, not one transaction. putDoc
  // re-checks last-write-wins. At most 50 live collections, so serial
  // writes are fine. Native single-field indexes cover array-contains
  // on `recipeIds` (no firestore.indexes.json in this repo).
  const collectionSnap = await colRef(uid, 'collections')
    .where('recipeIds', 'array-contains', recipeId)
    .get();
  await applyCollectionMembershipScrubs(
    collectionDocsFromQuerySnap(collectionSnap.docs),
    recipeId,
    at,
    (id, payload, writeAt) => putDoc(uid, 'collections', id, payload, writeAt),
  );

  return { photoIds: [...photoIds], gcsPending: photoIds.size > 0 };
}

export type TombstoneSnapshot = {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
};

export type TombstoneTx<Ref> = {
  getAll: (...refs: Ref[]) => Promise<TombstoneSnapshot[]>;
  set: (ref: Ref, data: Record<string, unknown>, options: { merge: boolean }) => void;
};

export type TombstoneRefs<Ref> = {
  doc: (job: { kind: StoreKind; id: string }) => Ref;
  gcsDelete: (photoId: string) => Ref;
};

function tombstoneRefs(uid: string): TombstoneRefs<DocumentReference> {
  return {
    doc: (job) => colRef(uid, job.kind).doc(job.id),
    gcsDelete: (photoId) => gcsDeletesRef(uid).doc(photoId),
  };
}

/**
 * Tombstone one chunk of docs inside a transaction. Firestore transactions
 * reject any read after a write ("Firestore transactions require all reads
 * to be executed before all writes"), so the whole chunk is read with one
 * getAll first. `writeAts` sees every stored state in the chunk and returns
 * each job's tombstone time, or null to leave that doc. A photo tombstone
 * also queues its `gcsDeletes` doc.
 */
export async function tombstoneChunk<Ref, Job extends { kind: StoreKind; id: string }>(
  tx: TombstoneTx<Ref>,
  jobs: Job[],
  refs: TombstoneRefs<Ref>,
  writeAts: (stored: Array<StoredMutationState | null>) => Array<number | null>,
  serverUpdatedAt: number,
): Promise<void> {
  const docRefs = jobs.map((job) => refs.doc(job));
  const snaps = await tx.getAll(...docRefs);
  const decided = writeAts(
    snaps.map((snap) => readStoredState(snap.exists ? snap.data() : undefined)),
  );
  jobs.forEach((job, i) => {
    const writeAt = decided[i];
    if (writeAt === null) {
      return;
    }
    tx.set(docRefs[i], tombstonePayload(job.id, writeAt, serverUpdatedAt), { merge: false });
    if (job.kind === 'photos') {
      tx.set(refs.gcsDelete(job.id), { photoId: job.id, createdAt: Date.now() }, { merge: true });
    }
  });
}

export type ChatClearMessage = { id: string; photoIds: string[] };

/**
 * Messages a clear at `at` tombstones: live and created at or before `at`.
 * A message created after the clear is not listed, so its photos are kept.
 * A photo id is listed once, under the first message that names it.
 */
export function chatMessagesToClear(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
  at: number,
): ChatClearMessage[] {
  const seen = new Set<string>();
  const messages: ChatClearMessage[] = [];
  for (const { id, data } of docs) {
    const createdAt = finiteNumber(data.createdAt);
    if (createdAt === undefined || createdAt > at || !isLiveDoc(data)) {
      continue;
    }
    const photoIds: string[] = [];
    for (const pid of Array.isArray(data.photoIds) ? data.photoIds : []) {
      if (isUuid(pid) && !seen.has(pid)) {
        seen.add(pid);
        photoIds.push(pid);
      }
    }
    messages.push({ id, photoIds });
  }
  return messages;
}

/** A message and its photos share a transaction; a photo also writes `gcsDeletes`. */
export function chatClearMessageCost(message: ChatClearMessage): number {
  return 1 + message.photoIds.length * cascadeJobCost({ kind: 'photos' });
}

export type ChatClearJob = {
  kind: 'chatMessages' | 'photos';
  id: string;
  /** Index in the chunk of the message job this photo belongs to (its own index for a message). */
  message: number;
};

export function chatClearJobs(messages: ChatClearMessage[]): ChatClearJob[] {
  const jobs: ChatClearJob[] = [];
  for (const message of messages) {
    const index = jobs.length;
    jobs.push({ kind: 'chatMessages', id: message.id, message: index });
    for (const photoId of message.photoIds) {
      jobs.push({ kind: 'photos', id: photoId, message: index });
    }
  }
  return jobs;
}

/**
 * Plain last-write-wins at `at` for every job, except that a photo is
 * tombstoned only when its message is: a message stored newer than the clear
 * keeps its photos.
 */
export function chatClearWriteAts(
  jobs: ChatClearJob[],
  stored: Array<StoredMutationState | null>,
  at: number,
): Array<number | null> {
  const allowed = (i: number) => compareMutation(stored[i], at, 'tombstone').allow;
  return jobs.map((job, i) => (allowed(job.message) && allowed(i) ? at : null));
}

/**
 * A thread's messages and their photos are tombstoned together, one
 * transaction per chunk, so a failure leaves each chunk either cleared with
 * its photos or untouched. Only a thread above one chunk can clear partially.
 */
export async function clearChatForRecipe(
  uid: string,
  recipeId: string,
  at: number,
): Promise<void> {
  const messagesSnap = await colRef(uid, 'chatMessages')
    .where('recipeId', '==', recipeId)
    .get();
  const messages = chatMessagesToClear(
    messagesSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
    at,
  );

  for (const chunk of chunkByCost(messages, chatClearMessageCost, 400)) {
    const jobs = chatClearJobs(chunk);
    const serverUpdatedAt = Date.now();
    await getFirestore().runTransaction((tx) =>
      tombstoneChunk(
        tx,
        jobs,
        tombstoneRefs(uid),
        (stored) => chatClearWriteAts(jobs, stored, at),
        serverUpdatedAt,
      ),
    );
  }
}

// --- push op validation (pure) ---

export type PushOpKind =
  | 'recipe.put'
  | 'recipe.delete'
  | 'chat.put'
  | 'chat.clearForRecipe'
  | 'cookState.put'
  | 'photo.delete'
  | 'collection.put'
  | 'collection.delete'
  | 'cookLog.put'
  | 'cookLog.delete';

export interface PushOpBase {
  kind: PushOpKind;
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Raw `lang` longer than this is rejected. A shorter value is normalized or dropped. */
export const MAX_RECIPE_LANG_CHARS = 32;

function validateRecipePut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id)) {
    return false;
  }
  if (typeof payload.title !== 'string' || payload.title.trim() === '') {
    return false;
  }
  const servings = finiteNumber(payload.servings);
  if (servings === undefined) {
    return false;
  }
  if (!Array.isArray(payload.ingredientSections) || !Array.isArray(payload.steps)) {
    return false;
  }
  if (!Array.isArray(payload.tags)) {
    return false;
  }
  if (finiteNumber(payload.createdAt) === undefined || finiteNumber(payload.updatedAt) === undefined) {
    return false;
  }
  if (payload.galleryPhotoIds !== undefined) {
    if (
      !Array.isArray(payload.galleryPhotoIds) ||
      payload.galleryPhotoIds.length > MAX_GALLERY_PHOTOS
    ) {
      return false;
    }
    for (const pid of payload.galleryPhotoIds) {
      if (!isUuid(pid)) {
        return false;
      }
    }
  }
  if (payload.lang !== undefined) {
    if (typeof payload.lang !== 'string' || payload.lang.length > MAX_RECIPE_LANG_CHARS) {
      return false;
    }
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

function validateRecipeDelete(payload: unknown): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

function validateChatPut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id) || !isUuid(payload.recipeId)) {
    return false;
  }
  if (payload.role !== 'user' && payload.role !== 'assistant') {
    return false;
  }
  if (typeof payload.content !== 'string') {
    return false;
  }
  if (payload.content.length > 20_000) {
    return false;
  }
  if (finiteNumber(payload.createdAt) === undefined) {
    return false;
  }
  if (payload.photoIds !== undefined) {
    if (!Array.isArray(payload.photoIds) || payload.photoIds.length > 8) {
      return false;
    }
    for (const pid of payload.photoIds) {
      if (!isUuid(pid)) {
        return false;
      }
    }
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

function validateClearForRecipe(payload: unknown): payload is { recipeId: string; at: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const at = finiteNumber(payload.at);
  return isUuid(payload.recipeId) && at !== undefined;
}

function validateCookStatePut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.recipeId)) {
    return false;
  }
  const fields = [
    'servings',
    'currentStep',
    'updatedAt',
    'recipeUpdatedAt',
  ] as const;
  for (const field of fields) {
    if (finiteNumber(payload[field]) === undefined) {
      return false;
    }
  }
  if (!Array.isArray(payload.checkedKeys)) {
    return false;
  }
  if (payload.checkedKeys.length > 500) {
    return false;
  }
  for (const key of payload.checkedKeys) {
    if (typeof key !== 'string') {
      return false;
    }
  }
  // Optional: steps done ahead of `currentStep` in a parallel block
  // (`docs/plans/parallel-steps.md`). Absent on older clients.
  if (payload.doneSteps !== undefined) {
    if (!Array.isArray(payload.doneSteps) || payload.doneSteps.length > MAX_DONE_STEPS) {
      return false;
    }
    for (const index of payload.doneSteps) {
      if (!Number.isInteger(index) || (index as number) < 0) {
        return false;
      }
    }
  }
  return true;
}

function validatePhotoDelete(payload: unknown): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

function validateCollectionPut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id)) {
    return false;
  }
  if (typeof payload.name !== 'string') {
    return false;
  }
  const name = payload.name.trim();
  if (name === '' || name.length > MAX_COLLECTION_NAME_LENGTH) {
    return false;
  }
  if (!Array.isArray(payload.recipeIds) || payload.recipeIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of payload.recipeIds) {
    if (!isUuid(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  if (finiteNumber(payload.createdAt) === undefined || finiteNumber(payload.updatedAt) === undefined) {
    return false;
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

function validateCollectionDelete(payload: unknown): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

function isOptionalCookLogText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_COOK_LOG_TEXT);
}

/**
 * The client's `isUsableCookLog` enforces exactly these rules; a row accepted
 * here but rejected there would be dropped on pull while still owning photos.
 */
export function validateCookLogPut(payload: unknown): payload is Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return false;
  }
  if (!isUuid(payload.id) || !isUuid(payload.recipeId)) {
    return false;
  }
  if (!isCookedOn(payload.cookedOn)) {
    return false;
  }
  if (finiteNumber(payload.createdAt) === undefined || finiteNumber(payload.updatedAt) === undefined) {
    return false;
  }
  if (payload.rating !== undefined) {
    const rating = finiteNumber(payload.rating);
    if (rating === undefined || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return false;
    }
  }
  if (payload.servings !== undefined) {
    const servings = finiteNumber(payload.servings);
    if (servings === undefined || servings <= 0 || servings > MAX_COOK_LOG_SERVINGS) {
      return false;
    }
  }
  if (!isOptionalCookLogText(payload.notes) || !isOptionalCookLogText(payload.lessons)) {
    return false;
  }
  if (payload.photoIds !== undefined) {
    if (!Array.isArray(payload.photoIds) || payload.photoIds.length > MAX_COOK_LOG_PHOTOS) {
      return false;
    }
    const seen = new Set<string>();
    for (const pid of payload.photoIds) {
      if (!isUuid(pid) || seen.has(pid)) {
        return false;
      }
      seen.add(pid);
    }
  }
  if (jsonSize(payload) >= 200_000) {
    return false;
  }
  return true;
}

export function validateCookLogDelete(
  payload: unknown,
): payload is { id: string; updatedAt: number } {
  if (!isPlainObject(payload)) {
    return false;
  }
  const updatedAt = finiteNumber(payload.updatedAt);
  return isUuid(payload.id) && updatedAt !== undefined;
}

export function validatePushOp(op: unknown): { ok: true; op: { kind: PushOpKind; payload: unknown } } | { ok: false } {
  if (!isPlainObject(op)) {
    return { ok: false };
  }
  const kind = op.kind;
  if (typeof kind !== 'string') {
    return { ok: false };
  }
  const payload = op.payload;
  switch (kind) {
    case 'recipe.put':
      return validateRecipePut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'recipe.delete':
      return validateRecipeDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'chat.put':
      return validateChatPut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'chat.clearForRecipe':
      return validateClearForRecipe(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'cookState.put':
      return validateCookStatePut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'photo.delete':
      return validatePhotoDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'collection.put':
      return validateCollectionPut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'collection.delete':
      return validateCollectionDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'cookLog.put':
      return validateCookLogPut(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    case 'cookLog.delete':
      return validateCookLogDelete(payload) ? { ok: true, op: { kind, payload } } : { ok: false };
    default:
      return { ok: false };
  }
}

export function isKnownPushKind(kind: unknown): kind is PushOpKind {
  return (
    kind === 'recipe.put' ||
    kind === 'recipe.delete' ||
    kind === 'chat.put' ||
    kind === 'chat.clearForRecipe' ||
    kind === 'cookState.put' ||
    kind === 'photo.delete' ||
    kind === 'collection.put' ||
    kind === 'collection.delete' ||
    kind === 'cookLog.put' ||
    kind === 'cookLog.delete'
  );
}

export function messageIdsToClearAtBoundary(
  messages: { id: string; createdAt: number }[],
  at: number,
): string[] {
  return messages.filter((m) => m.createdAt <= at).map((m) => m.id);
}
