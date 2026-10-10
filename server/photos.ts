import { Storage } from '@google-cloud/storage';
import type { Transaction } from '@google-cloud/firestore';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { firestoreConfig, photoBucket } from './env.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import {
  listLiveIncomingShares,
  readLiveIncomingShare,
  sessionCanViewOwnerPhoto,
  sharingOwnerAdmitted,
} from './grants.ts';
import {
  compareMutation,
  gcsDeletesColRef,
  getStoreFirestore,
  isUuid,
  photoDocRef,
  photosColRef,
  readDocData,
  readStoredMutationState,
  recipeDocRef,
  type CompareMutationResult,
  type StoredMutationState,
} from './store.ts';

export const MAX_PHOTO_BYTES = 2_000_000;

const STALE_UPLOADING_MS = 15 * 60 * 1000;

let storageClient: Storage | null = null;

function getStorage(): Storage {
  if (storageClient === null) {
    storageClient = new Storage({ projectId: firestoreConfig().projectId });
  }
  return storageClient;
}

function gcsObjectPath(uid: string, photoId: string): string {
  return `users/${uid}/${photoId}`;
}

export function assertPhotoId(id: string): boolean {
  return isUuid(id);
}

export function photoUploadDecision(
  stored: StoredMutationState | null,
  clientUpdatedAt: number,
): CompareMutationResult {
  return compareMutation(stored, clientUpdatedAt, 'put');
}

export function isAllowedPhotoContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'image/jpeg' || base === 'image/png';
}

export function isPhotoContentLengthTooLarge(contentLength: number | null): boolean {
  return contentLength !== null && contentLength > MAX_PHOTO_BYTES;
}

export function isPhotoByteCountTooLarge(byteCount: number): boolean {
  return byteCount > MAX_PHOTO_BYTES;
}

function photoStorageUnavailable(): Response {
  return new Response(JSON.stringify({ error: 'Photo storage unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function photoIdFromRequest(req: Request): string | null {
  const pathname = new URL(req.url).pathname;
  const prefix = '/api/photos/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  if (rest === '' || rest.includes('/')) {
    return null;
  }
  return rest;
}

function finiteHeaderMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isLiveMetadata(data: Record<string, unknown> | undefined): boolean {
  if (!data) {
    return false;
  }
  return data.deletedAt === undefined || data.deletedAt === null;
}

function isLivePhoto(data: Record<string, unknown> | undefined): boolean {
  if (!isLiveMetadata(data)) {
    return false;
  }
  return data?.status === 'live';
}

/** Live metadata ⇒ POST intent stops at 200 without GCS (any client timestamp). */
export function photoUploadStopsAtLiveReplay(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return isLivePhoto(metadata);
}

function normalizeContentType(raw: string): string | null {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpeg') {
    return 'image/jpeg';
  }
  if (base === 'image/png') {
    return 'image/png';
  }
  return null;
}

function parseContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function limitByteStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): { stream: Readable; byteCount: Promise<number> } {
  let total = 0;
  let resolveCount: (n: number) => void;
  let rejectCount: (err: Error) => void;
  const byteCount = new Promise<number>((resolve, reject) => {
    resolveCount = resolve;
    rejectCount = reject;
  });
  const nodeSource = Readable.fromWeb(source);
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        callback(new Error('too-large'));
        return;
      }
      callback(null, buf);
    },
    flush(callback) {
      resolveCount(total);
      callback();
    },
  });
  counter.on('error', (err) => {
    if (err instanceof Error && err.message === 'too-large') {
      resolveCount(total);
    } else {
      rejectCount(err instanceof Error ? err : new Error(String(err)));
    }
  });
  nodeSource.on('error', (err) => {
    rejectCount(err instanceof Error ? err : new Error(String(err)));
  });
  nodeSource.pipe(counter);
  return { stream: counter, byteCount };
}

async function readRecipeLiveInTx(
  tx: Transaction,
  uid: string,
  recipeId: string,
): Promise<boolean> {
  const snap = await tx.get(recipeDocRef(uid, recipeId));
  if (!snap.exists) {
    return false;
  }
  const data = snap.data() as Record<string, unknown>;
  return isLiveMetadata(data);
}

function gcsErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

async function uploadBytesToGcs(
  uid: string,
  photoId: string,
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
): Promise<{ ok: true; size: number } | { ok: false; reason: 'too-large' | 'gcs-error' }> {
  const bucketName = photoBucket();
  if (!bucketName || body === null) {
    return { ok: false, reason: 'gcs-error' };
  }
  const { stream, byteCount } = limitByteStream(body, MAX_PHOTO_BYTES);
  const file = getStorage().bucket(bucketName).file(gcsObjectPath(uid, photoId));
  let preconditionFailed = false;
  try {
    await file.save(stream, {
      contentType,
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (err: unknown) {
    if (gcsErrorCode(err) === 412) {
      preconditionFailed = true;
    } else if (err instanceof Error && err.message === 'too-large') {
      return { ok: false, reason: 'too-large' };
    } else {
      return { ok: false, reason: 'gcs-error' };
    }
  }

  let size: number;
  try {
    size = await byteCount;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'too-large') {
      return { ok: false, reason: 'too-large' };
    }
    if (preconditionFailed) {
      try {
        const [meta] = await file.getMetadata();
        size = Number(meta.size ?? 0);
      } catch {
        return { ok: false, reason: 'gcs-error' };
      }
    } else {
      return { ok: false, reason: 'gcs-error' };
    }
  }

  if (isPhotoByteCountTooLarge(size)) {
    return { ok: false, reason: 'too-large' };
  }
  if (preconditionFailed && size === 0) {
    try {
      const [meta] = await file.getMetadata();
      size = Number(meta.size ?? 0);
    } catch {
      return { ok: false, reason: 'gcs-error' };
    }
  }
  return { ok: true, size };
}

type IntentOutcome =
  | { kind: 'stop'; status: 200 }
  | { kind: 'conflict'; status: 409; error: string }
  | { kind: 'proceed'; contentType: string; sizeHint: number | undefined };

export type UploadIntentPlan =
  | { kind: 'stop' }
  | { kind: 'conflict'; error: 'recipe-deleted' | 'already-deleted' | 'stale' }
  /**
   * The upload is accepted. A `gcsDeletes/{photoId}` row queued by an earlier
   * tombstone of this id is dropped with it: the new bytes go to the same
   * object path, and a later drain must not delete them. Every path that ends
   * with the photo not live (confirm on a dead recipe, a tombstone racing
   * the upload, the stale-`uploading` sweep) queues the row again.
   */
  | { kind: 'proceed'; clearQueuedGcsDelete: true };

/** Pure intent decision for `POST /api/photos/:id`, read inside the intent transaction. */
export function planUploadIntent(
  recipeLive: boolean,
  photoRaw: Record<string, unknown> | undefined,
  clientUpdatedAt: number,
): UploadIntentPlan {
  if (!recipeLive) {
    return { kind: 'conflict', error: 'recipe-deleted' };
  }
  const decision = photoUploadDecision(readStoredMutationState(photoRaw), clientUpdatedAt);
  if (!decision.allow && decision.reason === 'already-deleted') {
    return { kind: 'conflict', error: 'already-deleted' };
  }
  if (photoUploadStopsAtLiveReplay(photoRaw)) {
    return { kind: 'stop' };
  }
  if (!decision.allow) {
    return { kind: 'conflict', error: 'stale' };
  }
  return { kind: 'proceed', clearQueuedGcsDelete: true };
}

async function runUploadIntent(
  uid: string,
  photoId: string,
  recipeId: string,
  clientUpdatedAt: number,
  contentType: string,
  sizeHint: number | undefined,
): Promise<IntentOutcome> {
  return getStoreFirestore().runTransaction(async (tx) => {
    const recipeLive = await readRecipeLiveInTx(tx, uid, recipeId);
    if (!recipeLive) {
      return { kind: 'conflict', status: 409, error: 'recipe-deleted' };
    }

    const photoSnap = await tx.get(photoDocRef(uid, photoId));
    const photoRaw = photoSnap.exists
      ? (photoSnap.data() as Record<string, unknown>)
      : undefined;
    const plan = planUploadIntent(recipeLive, photoRaw, clientUpdatedAt);
    if (plan.kind === 'conflict') {
      return { kind: 'conflict', status: 409, error: plan.error };
    }
    if (plan.kind === 'stop') {
      return { kind: 'stop', status: 200 };
    }

    if (plan.clearQueuedGcsDelete) {
      // Every writer keys the row by photo id (`drainGcsDeletes` also reads
      // `data.photoId`, which is always that same id).
      tx.delete(gcsDeletesColRef(uid).doc(photoId));
    }

    const serverUpdatedAt = Date.now();
    const metadata: Record<string, unknown> = {
      id: photoId,
      recipeId,
      status: 'uploading',
      updatedAt: clientUpdatedAt,
      contentType,
      serverUpdatedAt,
    };
    if (sizeHint !== undefined) {
      metadata.size = sizeHint;
    }
    tx.set(photoDocRef(uid, photoId), metadata, { merge: false });
    return { kind: 'proceed', contentType, sizeHint };
  });
}

async function runUploadConfirm(
  uid: string,
  photoId: string,
  recipeId: string,
  clientUpdatedAt: number,
  contentType: string,
  size: number,
): Promise<{ status: number; error?: string }> {
  return getStoreFirestore().runTransaction(async (tx) => {
    const recipeLive = await readRecipeLiveInTx(tx, uid, recipeId);
    const photoSnap = await tx.get(photoDocRef(uid, photoId));
    const photoRaw = photoSnap.exists
      ? (photoSnap.data() as Record<string, unknown>)
      : undefined;
    const photoLive = isLiveMetadata(photoRaw);
    const photoTombstoned = photoRaw !== undefined && !photoLive;

    if (!recipeLive || photoTombstoned) {
      const serverUpdatedAt = Date.now();
      if (photoLive && photoRaw !== undefined) {
        tx.set(
          photoDocRef(uid, photoId),
          {
            id: photoId,
            updatedAt: clientUpdatedAt,
            deletedAt: clientUpdatedAt,
            serverUpdatedAt,
          },
          { merge: false },
        );
      }
      tx.set(
        gcsDeletesColRef(uid).doc(photoId),
        { photoId, createdAt: Date.now() },
        { merge: true },
      );
      return { status: 409, error: 'recipe-deleted' };
    }

    const serverUpdatedAt = Date.now();
    tx.set(
      photoDocRef(uid, photoId),
      {
        id: photoId,
        recipeId,
        status: 'live',
        updatedAt: clientUpdatedAt,
        contentType,
        size,
        serverUpdatedAt,
      },
      { merge: false },
    );
    return { status: 200 };
  });
}

async function sweepStaleUploading(uid: string): Promise<void> {
  const cutoff = Date.now() - STALE_UPLOADING_MS;
  const snap = await photosColRef(uid).where('status', '==', 'uploading').get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (!isLiveMetadata(data)) {
      continue;
    }
    const serverUpdatedAt =
      typeof data.serverUpdatedAt === 'number' && Number.isFinite(data.serverUpdatedAt)
        ? data.serverUpdatedAt
        : null;
    if (serverUpdatedAt === null || serverUpdatedAt >= cutoff) {
      continue;
    }
    const photoId = doc.id;
    const updatedAt =
      typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt)
        ? data.updatedAt
        : serverUpdatedAt;
    await getStoreFirestore().runTransaction(async (tx) => {
      const fresh = await tx.get(photoDocRef(uid, photoId));
      if (!fresh.exists) {
        return;
      }
      const row = fresh.data() as Record<string, unknown>;
      if (row.status !== 'uploading' || !isLiveMetadata(row)) {
        return;
      }
      const ts =
        typeof row.serverUpdatedAt === 'number' && Number.isFinite(row.serverUpdatedAt)
          ? row.serverUpdatedAt
          : null;
      if (ts === null || ts >= cutoff) {
        return;
      }
      const serverUpdatedAtNow = Date.now();
      tx.set(
        photoDocRef(uid, photoId),
        {
          id: photoId,
          updatedAt,
          deletedAt: updatedAt,
          serverUpdatedAt: serverUpdatedAtNow,
        },
        { merge: false },
      );
      tx.set(
        gcsDeletesColRef(uid).doc(photoId),
        { photoId, createdAt: Date.now() },
        { merge: true },
      );
    });
  }
}

export async function drainGcsDeletes(uid: string): Promise<void> {
  if (photoBucket() === null) {
    return;
  }

  await sweepStaleUploading(uid);

  const pending = await gcsDeletesColRef(uid).get();
  const bucketName = photoBucket();
  if (!bucketName) {
    return;
  }
  const bucket = getStorage().bucket(bucketName);

  for (const doc of pending.docs) {
    const data = doc.data() as { photoId?: string };
    const photoId = typeof data.photoId === 'string' ? data.photoId : doc.id;
    if (!isUuid(photoId)) {
      await doc.ref.delete();
      continue;
    }
    const file = bucket.file(gcsObjectPath(uid, photoId));
    try {
      await file.delete({ ignoreNotFound: true });
    } catch {
      // leave gcsDeletes row for a later drain
      continue;
    }
    try {
      await doc.ref.delete();
    } catch {
      // object already gone; row may retry
    }
  }
}

/**
 * Copies one live photo of `srcUid` into `dstUid`'s tree as `dstPhotoId` on
 * the live recipe `dstRecipeId`, for a copy saved from a recipe link
 * (`server/recipeLinkSave.ts`). The same intent and confirm steps as an
 * upload, with a server-side GCS copy in between, so a crash leaves an
 * `uploading` row for the stale sweep. True when the photo is live in the
 * destination afterwards. Never throws: a failed copy is false, and the
 * caller leaves the photo off the recipe.
 */
export async function copyPhotoBetweenOwners(input: {
  srcUid: string;
  srcPhotoId: string;
  dstUid: string;
  dstPhotoId: string;
  dstRecipeId: string;
}): Promise<boolean> {
  const bucketName = photoBucket();
  if (!bucketName || !isUuid(input.srcPhotoId) || !isUuid(input.dstPhotoId)) {
    return false;
  }
  try {
    const source = await readDocData(input.srcUid, 'photos', input.srcPhotoId);
    if (!isLivePhoto(source)) {
      return false;
    }
    const contentType = normalizeContentType(String(source?.contentType ?? ''));
    if (contentType === null) {
      return false;
    }
    const sizeHint =
      typeof source?.size === 'number' && Number.isFinite(source.size) ? source.size : undefined;
    const at = Date.now();
    const intent = await runUploadIntent(
      input.dstUid,
      input.dstPhotoId,
      input.dstRecipeId,
      at,
      contentType,
      sizeHint,
    );
    if (intent.kind === 'stop') {
      return true;
    }
    if (intent.kind === 'conflict') {
      return false;
    }
    const bucket = getStorage().bucket(bucketName);
    const destination = bucket.file(gcsObjectPath(input.dstUid, input.dstPhotoId));
    try {
      await bucket.file(gcsObjectPath(input.srcUid, input.srcPhotoId)).copy(destination, {
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err: unknown) {
      // 412: the object is already there (a retried copy); confirm it below.
      if (gcsErrorCode(err) !== 412) {
        return false;
      }
    }
    const [meta] = await destination.getMetadata();
    const size = Number(meta.size ?? sizeHint ?? 0);
    if (!Number.isFinite(size) || size <= 0 || isPhotoByteCountTooLarge(size)) {
      return false;
    }
    const confirmed = await runUploadConfirm(
      input.dstUid,
      input.dstPhotoId,
      input.dstRecipeId,
      at,
      contentType,
      size,
    );
    return confirmed.status === 200;
  } catch {
    return false;
  }
}

export async function photosPost(req: Request): Promise<Response> {
  if (photoBucket() === null) {
    return photoStorageUnavailable();
  }

  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
  const photoId = photoIdFromRequest(req);
  if (photoId === null || !assertPhotoId(photoId)) {
    return jsonError('Bad request', 400);
  }

  const updatedAtRaw = req.headers.get('x-photo-updated-at');
  const clientUpdatedAt = finiteHeaderMs(updatedAtRaw);
  const recipeIdRaw = req.headers.get('x-recipe-id');
  if (clientUpdatedAt === null || recipeIdRaw === null || !isUuid(recipeIdRaw.trim())) {
    return jsonError('Bad request', 400);
  }
  const recipeId = recipeIdRaw.trim();

  const contentTypeRaw = req.headers.get('content-type');
  if (contentTypeRaw === null) {
    return jsonError('Bad request', 400);
  }
  const contentType = normalizeContentType(contentTypeRaw);
  if (contentType === null) {
    return jsonError('Bad request', 400);
  }

  const contentLength = parseContentLength(req);
  if (isPhotoContentLengthTooLarge(contentLength)) {
    return jsonError('Payload too large', 413);
  }

  const uid = access.sub;
  const sizeHint = contentLength ?? undefined;

  const intent = await runUploadIntent(
    uid,
    photoId,
    recipeId,
    clientUpdatedAt,
    contentType,
    sizeHint,
  );

  if (intent.kind === 'conflict') {
    await drainGcsDeletes(uid);
    return jsonError(intent.error, intent.status);
  }
  if (intent.kind === 'stop') {
    await drainGcsDeletes(uid);
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  const upload = await uploadBytesToGcs(uid, photoId, req.body, contentType);
  if (!upload.ok) {
    if (upload.reason === 'too-large') {
      await drainGcsDeletes(uid);
      return jsonError('Payload too large', 413);
    }
    await drainGcsDeletes(uid);
    return photoStorageUnavailable();
  }

  const confirm = await runUploadConfirm(
    uid,
    photoId,
    recipeId,
    clientUpdatedAt,
    contentType,
    upload.size,
  );

  await drainGcsDeletes(uid);

  if (confirm.status === 409 && confirm.error) {
    return jsonError(confirm.error, 409);
  }
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('photosPost store error:', err);
    return storeUnavailable();
  }
}

export type PhotoDownload =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'missing' }
  | { kind: 'too-large' }
  | { kind: 'failed'; status: number };

/**
 * Reads a response body up to `maxBytes`. A longer body is cancelled and
 * reported as too large, so the rest of the object is never buffered.
 */
export async function readCappedBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: 'too-large' }> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return { ok: true, bytes: Buffer.concat(chunks) };
      }
      if (value === undefined || value.byteLength === 0) {
        continue;
      }
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: 'too-large' };
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Maps a media response to bytes, missing, too large, or a failed status. */
export async function photoBytesFromResponse(
  response: Response,
  maxBytes: number,
): Promise<PhotoDownload> {
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: 'missing' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'failed', status: response.status };
  }
  const declared = declaredContentLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel();
    return { kind: 'too-large' };
  }
  if (response.body === null) {
    return { kind: 'bytes', bytes: Buffer.alloc(0) };
  }
  const read = await readCappedBytes(response.body, maxBytes);
  if (!read.ok) {
    return { kind: 'too-large' };
  }
  return { kind: 'bytes', bytes: read.bytes };
}

function gcsMediaUrl(baseUrl: string, bucket: string, objectPath: string): string {
  return `${baseUrl.replace(/\/$/, '')}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

/**
 * Downloads one object without the storage library's read stream. That
 * stream's error path destroys teeny-request's process-wide keep-alive
 * agent and aborts every other GCS call in the process. The body is capped
 * at MAX_PHOTO_BYTES, the same limit as an upload.
 */
async function downloadPhotoBytes(bucket: string, objectPath: string): Promise<PhotoDownload> {
  const storage = getStorage();
  const url = gcsMediaUrl(storage.baseUrl, bucket, objectPath);
  const token = await storage.authClient.getAccessToken();
  if (token == null || token === '') {
    throw new Error('GCS photo download failed');
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Encoding': 'identity',
    },
  });
  return photoBytesFromResponse(response, MAX_PHOTO_BYTES);
}

export async function photosGet(req: Request): Promise<Response> {
  if (photoBucket() === null) {
    return photoStorageUnavailable();
  }

  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
  const photoId = photoIdFromRequest(req);
  if (photoId === null || !assertPhotoId(photoId)) {
    return jsonError('Bad request', 400);
  }

  const ownerParam = new URL(req.url).searchParams.get('owner');
  const uid =
    ownerParam === null || ownerParam === '' || ownerParam === access.sub
      ? access.sub
      : ownerParam;
  if (uid !== access.sub) {
    const allowed = await sessionCanViewOwnerPhoto({
      viewerSub: access.sub,
      ownerSub: uid,
      photoId,
      listLiveIncomingShares,
      readLiveIncomingShare,
      ownerAdmitted: sharingOwnerAdmitted,
      readDocData,
    });
    if (!allowed) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  return await storedPhotoResponse(uid, photoId, req.method);
  } catch (err) {
    console.error('photosGet store error:', err);
    return storeUnavailable();
  }
}

/**
 * One live photo of `uid` from GCS, or 404 (413 over MAX_PHOTO_BYTES). HEAD
 * reads only metadata; GET downloads the capped object (`downloadPhotoBytes`),
 * never the storage library's read stream. The caller has already decided
 * the request may read it. Throws on store and download errors.
 */
export async function storedPhotoResponse(
  uid: string,
  photoId: string,
  method: string,
): Promise<Response> {
  const snap = await photoDocRef(uid, photoId).get();
  if (!snap.exists) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const data = snap.data() as Record<string, unknown>;
  if (!isLivePhoto(data)) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const contentType =
    typeof data.contentType === 'string' && data.contentType !== ''
      ? data.contentType
      : 'application/octet-stream';

  const bucketName = photoBucket();
  if (!bucketName) {
    return photoStorageUnavailable();
  }

  const file = getStorage().bucket(bucketName).file(gcsObjectPath(uid, photoId));
  const [exists] = await file.exists();
  if (!exists) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
  };
  const size =
    typeof data.size === 'number' && Number.isFinite(data.size) ? data.size : null;
  if (size !== null && isPhotoByteCountTooLarge(size)) {
    return jsonError('Payload too large', 413);
  }
  if (size !== null) {
    headers['Content-Length'] = String(size);
  }

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  const downloaded = await downloadPhotoBytes(bucketName, gcsObjectPath(uid, photoId));
  if (downloaded.kind === 'missing') {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (downloaded.kind === 'too-large') {
    return jsonError('Payload too large', 413);
  }
  if (downloaded.kind === 'failed') {
    throw Object.assign(new Error('GCS photo download failed'), { status: downloaded.status });
  }
  headers['Content-Length'] = String(downloaded.bytes.length);
  return new Response(downloaded.bytes, { status: 200, headers });
}
