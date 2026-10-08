/**
 * Save a copy from a recipe link (`docs/plans/recipe-links.md`):
 * `POST /api/public/save { token }`, cookie session, admitted member. The
 * token rides in the body, never the URL.
 *
 * The copy is the saver's own recipe, Unfiled, with no tie to the original
 * beyond `savedFrom` (the sharer's display name and when). One copy per member
 * per link: its id is derived from the saver and the link, so a second save
 * finds the first copy (`already`); a copy the saver deleted is written
 * again. Photos are copied server-side into the saver's tree; a photo that
 * fails to copy is left off the copy rather than failing the save.
 *
 * One `event: 'recipe_link_save'` log line per request holds the `sub`, the
 * result or status, photo counts, and timing. Never the token, the recipe, or
 * a name. `/privacy` describes it; change it with it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sharingOwnerAdmitted } from './grants.ts';
import { errorJson } from './grantsHttp.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
  type RequireMemberResult,
} from './membership.ts';
import { copyPhotoBetweenOwners } from './photos.ts';
import { hashPublicToken, isPublicTokenShape, publicRecipeBody } from './publicLinks.ts';
import {
  readRecipeLink,
  resolveRecipeLink,
  type LiveRecipeLink,
  type RecipeLinkReadDependencies,
} from './recipeLinks.ts';
import {
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  nextRecipeUpdatedAt,
  readDocData,
  recipeDocBody,
  recipeDocRef,
  updateOwnRecipe,
} from './store.ts';

const BODY_LIMIT = 2_000;

export const MAX_RECIPE_LINK_SAVES_PER_HOUR = 30;
const SAVE_WINDOW_MS = 60 * 60 * 1000;
const saveBuckets = new Map<string, number[]>();

/**
 * A sliding window per member, per instance: the same rule as
 * `admitTranslateCall`, kept here because this module must not import
 * translation code (`scripts/invariants.test.ts`).
 */
export function admitRecipeLinkSave(
  buckets: Map<string, number[]>,
  sub: string,
  now: number,
  limit = MAX_RECIPE_LINK_SAVES_PER_HOUR,
  windowMs = SAVE_WINDOW_MS,
): boolean {
  const fresh = (buckets.get(sub) ?? []).filter((at) => now - at < windowMs);
  if (fresh.length >= limit) {
    buckets.set(sub, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(sub, fresh);
  return true;
}

/** For tests. */
export function resetRecipeLinkSaveRateLimit(): void {
  saveBuckets.clear();
}

/**
 * The copy's id: a pure function of the saver and the link (`sha256(token)`),
 * the same construction as a backup clone id (`src/lib/backupImportRemap.ts`
 * `cloneUuid`), in its own namespace.
 */
export function recipeCopyId(saverSub: string, linkId: string): string {
  const bytes = createHash('sha256')
    .update(`sous-recipe-link-copy\u0000${saverSub}\u0000${linkId}`)
    .digest()
    .subarray(0, 16);
  // RFC 9562 version 8 plus the RFC variant bits. isUuid requires both.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PhotoCopy = { srcPhotoId: string; dstPhotoId: string };

export type RecipeCopyPlan =
  | { kind: 'already'; recipeId: string }
  | {
      kind: 'write';
      recipeId: string;
      updatedAt: number;
      payload: Record<string, unknown>;
      photos: PhotoCopy[];
    };

/**
 * What saving does, given the copy's stored doc (if any). A live copy is
 * `already`. Otherwise the payload is the original's visitor fields (no
 * import check, no `variantOf`, no `savedFrom` of its own) on the copy's id,
 * with every photo on a new id and `savedFrom` set. A copy the saver deleted
 * is written one past its tombstone, so last-write-wins lets it back.
 */
export function planRecipeCopy(input: {
  recipeId: string;
  original: Record<string, unknown>;
  ownerName: string | undefined;
  stored: Record<string, unknown> | undefined;
  now: number;
  newPhotoId: () => string;
}): RecipeCopyPlan {
  if (input.stored !== undefined && isLiveDoc(input.stored)) {
    return { kind: 'already', recipeId: input.recipeId };
  }
  const storedUpdatedAt =
    typeof input.stored?.updatedAt === 'number' && Number.isFinite(input.stored.updatedAt)
      ? input.stored.updatedAt
      : 0;
  const updatedAt = nextRecipeUpdatedAt(storedUpdatedAt, input.now);
  const payload = publicRecipeBody(input.original);
  payload.id = input.recipeId;
  payload.createdAt = input.now;
  payload.updatedAt = updatedAt;
  delete payload.photoId;
  delete payload.galleryPhotoIds;

  const photos: PhotoCopy[] = [];
  const copyOf = (srcPhotoId: unknown): string | undefined => {
    if (!isUuid(srcPhotoId)) return undefined;
    const existing = photos.find((photo) => photo.srcPhotoId === srcPhotoId);
    if (existing) return existing.dstPhotoId;
    const dstPhotoId = input.newPhotoId();
    photos.push({ srcPhotoId, dstPhotoId });
    return dstPhotoId;
  };
  const cover = copyOf(input.original.photoId);
  if (cover !== undefined) {
    payload.photoId = cover;
  }
  if (Array.isArray(input.original.galleryPhotoIds)) {
    const gallery: string[] = [];
    for (const id of input.original.galleryPhotoIds) {
      if (id === input.original.photoId) continue;
      const copied = copyOf(id);
      if (copied !== undefined && !gallery.includes(copied)) gallery.push(copied);
    }
    if (gallery.length > 0) {
      payload.galleryPhotoIds = gallery;
    }
  }
  const savedFrom: Record<string, unknown> = { savedAt: input.now };
  if (input.ownerName !== undefined) {
    savedFrom.name = input.ownerName;
  }
  payload.savedFrom = savedFrom;
  return { kind: 'write', recipeId: input.recipeId, updatedAt, payload, photos };
}

/** The copy's payload without the photos that did not copy. */
export function withoutPhotos(
  stored: Record<string, unknown>,
  failed: ReadonlySet<string>,
): Record<string, unknown> {
  const next = { ...stored };
  if (typeof next.photoId === 'string' && failed.has(next.photoId)) {
    delete next.photoId;
  }
  if (Array.isArray(next.galleryPhotoIds)) {
    const kept = next.galleryPhotoIds.filter((id) => !failed.has(String(id)));
    if (kept.length > 0) {
      next.galleryPhotoIds = kept;
    } else {
      delete next.galleryPhotoIds;
    }
  }
  return next;
}

export type RecipeLinkSaveResult = 'saved' | 'already' | 'own';

export type RecipeLinkSaveOutcome =
  | { kind: 'dead' }
  | { kind: 'ok'; recipeId: string; result: RecipeLinkSaveResult; photos: number; photosCopied: number };

export type RecipeLinkSaveDependencies = RecipeLinkReadDependencies & {
  /** Writes the copy (or finds it) in one transaction. */
  writeCopy: (
    saverSub: string,
    live: LiveRecipeLink,
    now: number,
  ) => Promise<RecipeCopyPlan>;
  copyPhoto: typeof copyPhotoBetweenOwners;
  /** Leaves the photos that did not copy off the copy. */
  dropPhotos: (
    saverSub: string,
    recipeId: string,
    version: number,
    failed: ReadonlySet<string>,
  ) => Promise<void>;
};

/** Resolves the link and saves the copy. Throws on store errors. */
export async function saveFromRecipeLink(
  saverSub: string,
  token: string,
  now: number,
  deps: RecipeLinkSaveDependencies,
): Promise<RecipeLinkSaveOutcome> {
  const live = await resolveRecipeLink(token, deps);
  if (live === null) {
    return { kind: 'dead' };
  }
  if (live.link.ownerSub === saverSub) {
    return { kind: 'ok', recipeId: live.link.recipeId, result: 'own', photos: 0, photosCopied: 0 };
  }
  const plan = await deps.writeCopy(saverSub, live, now);
  if (plan.kind === 'already') {
    return { kind: 'ok', recipeId: plan.recipeId, result: 'already', photos: 0, photosCopied: 0 };
  }
  const failed = new Set<string>();
  for (const photo of plan.photos) {
    const copied = await deps.copyPhoto({
      srcUid: live.link.ownerSub,
      srcPhotoId: photo.srcPhotoId,
      dstUid: saverSub,
      dstPhotoId: photo.dstPhotoId,
      dstRecipeId: plan.recipeId,
    });
    if (!copied) failed.add(photo.dstPhotoId);
  }
  if (failed.size > 0) {
    await deps.dropPhotos(saverSub, plan.recipeId, plan.updatedAt, failed);
  }
  return {
    kind: 'ok',
    recipeId: plan.recipeId,
    result: 'saved',
    photos: plan.photos.length,
    photosCopied: plan.photos.length - failed.size,
  };
}

async function writeCopyFirestore(
  saverSub: string,
  live: LiveRecipeLink,
  now: number,
): Promise<RecipeCopyPlan> {
  const recipeId = recipeCopyId(saverSub, hashPublicToken(live.link.token));
  const ref = recipeDocRef(saverSub, recipeId);
  return getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const plan = planRecipeCopy({
      recipeId,
      original: live.recipe,
      ownerName: live.link.ownerName,
      stored: snap.exists ? (snap.data() as Record<string, unknown>) : undefined,
      now,
      newPhotoId: randomUUID,
    });
    if (plan.kind === 'write') {
      tx.set(ref, recipeDocBody(plan.payload, recipeId, plan.updatedAt, Date.now()), {
        merge: false,
      });
    }
    return plan;
  });
}

async function dropPhotosFirestore(
  saverSub: string,
  recipeId: string,
  version: number,
  failed: ReadonlySet<string>,
): Promise<void> {
  // A conflict means the saver already edited the copy; their edit stands.
  await updateOwnRecipe(saverSub, recipeId, version, (stored) => withoutPhotos(stored, failed));
}

const liveSaveDependencies: RecipeLinkSaveDependencies = {
  readRecipeLink,
  ownerAdmitted: sharingOwnerAdmitted,
  readRecipe: (ownerSub, recipeId) => readDocData(ownerSub, 'recipes', recipeId),
  writeCopy: writeCopyFirestore,
  copyPhoto: copyPhotoBetweenOwners,
  dropPhotos: dropPhotosFirestore,
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type RecipeLinkSaveHttpDependencies = RecipeLinkSaveDependencies & {
  requireMember: (req: Request) => Promise<RequireMemberResult>;
  now: () => number;
};

type SaveLogEntry = {
  sub?: string;
  status?: number;
  result?: RecipeLinkSaveResult;
  photos?: number;
  photosCopied?: number;
  ms?: number;
};

function okJson(recipeId: string, result: RecipeLinkSaveResult): Response {
  return new Response(JSON.stringify({ recipeId, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readToken(req: Request): Promise<string | null> {
  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const token = (body as Record<string, unknown>).token;
    return isPublicTokenShape(token) ? token : null;
  } catch {
    return null;
  }
}

/** 200 `{ recipeId, result: 'saved' | 'already' | 'own' }`, 404 dead, 429 too many. */
export async function handleRecipeLinkSavePost(
  req: Request,
  deps: RecipeLinkSaveHttpDependencies,
): Promise<Response> {
  const started = Date.now();
  const entry: SaveLogEntry = {};
  const respond = (response: Response): Response => {
    entry.status = response.status;
    return response;
  };
  try {
    const access = await deps.requireMember(req);
    if (access.kind === 'denied') {
      return respond(membershipUnauthorized());
    }
    if (access.kind === 'unknown') {
      return respond(membershipUnavailable());
    }
    entry.sub = access.sub;
    const token = await readToken(req);
    if (token === null) {
      return respond(errorJson('bad-request', 'Bad request', 400));
    }
    const now = deps.now();
    if (!admitRecipeLinkSave(saveBuckets, access.sub, now)) {
      return respond(errorJson('recipe-save-rate-limited', 'Too many saves', 429));
    }
    let outcome: RecipeLinkSaveOutcome;
    try {
      outcome = await saveFromRecipeLink(access.sub, token, now, deps);
    } catch (err) {
      console.error('recipeLinkSave store error:', err instanceof Error ? err.name : 'unknown');
      return respond(storeUnavailable());
    }
    if (outcome.kind === 'dead') {
      return respond(errorJson('not-found', 'Not found', 404));
    }
    entry.result = outcome.result;
    entry.photos = outcome.photos;
    entry.photosCopied = outcome.photosCopied;
    return respond(okJson(outcome.recipeId, outcome.result));
  } finally {
    entry.ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'recipe_link_save', ...entry }));
  }
}

export const recipeLinkSavePost = (req: Request) =>
  handleRecipeLinkSavePost(req, {
    ...liveSaveDependencies,
    requireMember,
    now: () => Date.now(),
  });
