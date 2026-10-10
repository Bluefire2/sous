import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { compactCollection } from './compactCollection';
import { compactCookLog, isUsableCookLog } from './cookLogShape';
import { compactRecipe } from './compactRecipe';
import { MAX_PUSH_OPS, type PushOp } from './pushOps';
import {
  isDiscardedPushReason,
  SHARED_PARENT_OWNER_SUB_FIELD,
  type DiscardedPushReason,
} from './pushReasons';
import { invalidateSession } from './session';
import { normalizeStepProgress } from './stepLanes';
import type { ChatMessage, Collection, CookLog, CookStateRow, Recipe } from './types';
import { clearLibrary } from './libraryMemory';

export { SHARED_PARENT_OWNER_SUB_FIELD };

export type PullCursor = Partial<
  Record<
    'recipes' | 'chatMessages' | 'cookState' | 'photos' | 'collections' | 'cookLogs',
    [number, string]
  >
>;

export type PullChanges = {
  recipes: Record<string, unknown>[];
  chatMessages: Record<string, unknown>[];
  cookState: Record<string, unknown>[];
  photos: Record<string, unknown>[];
  collections?: Record<string, unknown>[];
  cookLogs?: Record<string, unknown>[];
};

export type PullPage = {
  changes: PullChanges;
  cursor: PullCursor;
  hasMore: boolean;
};

export type RemoteResult =
  | 'ok'
  | 'signedOut'
  | 'error'
  | DiscardedPushReason;

function jsonHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' };
}

export function mergePullCursor(prev: PullCursor, next: PullCursor): PullCursor {
  return { ...prev, ...next };
}

function encodePullCursor(cursor: PullCursor): string {
  const json = JSON.stringify(cursor);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readErrorStatus(response: Response): Promise<'signedOut' | 'error'> {
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return 'signedOut';
  }
  return 'error';
}

export async function pullPage(cursor: PullCursor | null): Promise<PullPage | 'signedOut' | 'error'> {
  const params = new URLSearchParams({ limit: '200' });
  if (cursor !== null && Object.keys(cursor).length > 0) {
    params.set('cursor', encodePullCursor(cursor));
  }
  let response: Response;
  try {
    response = await fetch(`/api/sync/pull?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return 'error';
  }
  if (!response.ok) {
    return readErrorStatus(response);
  }
  const body = (await response.json()) as {
    changes?: PullChanges;
    cursor?: PullCursor;
    hasMore?: boolean;
  };
  if (!body.changes) {
    return 'error';
  }
  return {
    changes: body.changes,
    cursor: body.cursor ?? {},
    hasMore: Boolean(body.hasMore),
  };
}

/**
 * A 200 still carries per-op verdicts. `stale`, `already-deleted` and
 * `recipe-deleted` are ordinary last-write-wins/cascade outcomes, but
 * `invalid`, `unknown`, and `cap` mean the server threw the write away —
 * report those so callers roll back instead of claiming a save that never
 * landed. `cap` is the live-collection limit, not a malformed payload.
 */
export function firstPushRejection(body: unknown): DiscardedPushReason | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return null;
  }
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { applied, reason } = entry as { applied?: unknown; reason?: unknown };
    if (applied === false && typeof reason === 'string' && isDiscardedPushReason(reason)) {
      return reason;
    }
  }
  return null;
}

/** A hung push holds the library epoch until it settles. Bound that wait. */
const DEFAULT_PUSH_TIMEOUT_MS = 30_000;

let pushTimeoutMs = DEFAULT_PUSH_TIMEOUT_MS;

/** Test isolation. Production pushes abort after 30 seconds. */
export function setPushTimeoutForTests(ms: number): void {
  pushTimeoutMs = ms;
}

export function resetPushTimeoutForTests(): void {
  pushTimeoutMs = DEFAULT_PUSH_TIMEOUT_MS;
}

function pushAbortSignal(): AbortSignal {
  return AbortSignal.timeout(pushTimeoutMs);
}

export async function pushOps(ops: PushOp[]): Promise<RemoteResult> {
  for (let offset = 0; offset < ops.length; offset += MAX_PUSH_OPS) {
    const batch = ops.slice(offset, offset + MAX_PUSH_OPS);
    let response: Response;
    try {
      response = await fetch('/api/sync/push', {
        method: 'POST',
        credentials: 'same-origin',
        headers: jsonHeaders(),
        body: JSON.stringify({ ops: batch }),
        signal: pushAbortSignal(),
      });
    } catch {
      return 'error';
    }
    if (!response.ok) {
      return readErrorStatus(response);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return 'error';
    }
    const rejected = firstPushRejection(body);
    if (rejected !== null) {
      return rejected;
    }
  }
  return 'ok';
}

const PHOTO_UPLOAD_JPEG = 'image/jpeg';
const PHOTO_UPLOAD_PNG = 'image/png';

export async function resolvePhotoUploadContentType(
  blob: Blob,
): Promise<'image/jpeg' | 'image/png' | null> {
  const declared = blob.type;
  if (declared === PHOTO_UPLOAD_JPEG || declared === PHOTO_UPLOAD_PNG) {
    return declared;
  }
  if (declared !== '' && declared !== 'application/octet-stream') {
    return null;
  }
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return PHOTO_UPLOAD_PNG;
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return PHOTO_UPLOAD_JPEG;
  }
  return PHOTO_UPLOAD_JPEG;
}

export async function postPhoto(
  id: string,
  recipeId: string,
  updatedAt: number,
  blob: Blob,
): Promise<RemoteResult | 'unavailable'> {
  const contentType = await resolvePhotoUploadContentType(blob);
  if (contentType === null) {
    return 'error';
  }
  let response: Response;
  try {
    response = await fetch(`/api/photos/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': contentType,
        'x-photo-updated-at': String(updatedAt),
        'x-recipe-id': recipeId,
      },
      body: blob,
      signal: pushAbortSignal(),
    });
  } catch {
    return 'error';
  }
  if (response.status === 200) {
    return 'ok';
  }
  if (response.status === 503) {
    return 'unavailable';
  }
  return readErrorStatus(response);
}

/** `missing` is a 404. `unavailable` is a network error or any other non-OK status. */
export type PhotoFetchOutcome = Blob | 'missing' | 'unavailable' | 'signedOut';

export async function fetchPhotoBlobOutcome(
  id: string,
  ownerSub?: string,
): Promise<PhotoFetchOutcome> {
  let response: Response;
  try {
    const params = ownerSub ? `?owner=${encodeURIComponent(ownerSub)}` : '';
    response = await fetch(`/api/photos/${encodeURIComponent(id)}${params}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return 'unavailable';
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return 'signedOut';
  }
  if (response.status === 404) {
    return 'missing';
  }
  if (!response.ok) {
    return 'unavailable';
  }
  return response.blob();
}

export async function fetchPhotoBlob(
  id: string,
  ownerSub?: string,
): Promise<Blob | null | 'signedOut'> {
  const outcome = await fetchPhotoBlobOutcome(id, ownerSub);
  if (outcome === 'missing' || outcome === 'unavailable') {
    return null;
  }
  return outcome;
}

export function normalizeRecipeChange(raw: Record<string, unknown>): Recipe | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return compactRecipe(raw as unknown as Recipe);
}

export function normalizeChatChange(raw: Record<string, unknown>): ChatMessage | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  const message: ChatMessage = {
    id: raw.id as string,
    recipeId: raw.recipeId as string,
    role: raw.role as 'user' | 'assistant',
    content: raw.content as string,
    createdAt: raw.createdAt as number,
  };
  if (Array.isArray(raw.photoIds)) {
    message.photoIds = raw.photoIds as string[];
  }
  if (raw.proposedRecipe !== undefined) {
    message.proposedRecipe = raw.proposedRecipe as ChatMessage['proposedRecipe'];
  }
  return message;
}

/** A finite cook-progress clock, or `undefined` when the wire value cannot be compared. */
export function finiteCookUpdatedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeCookChange(
  raw: Record<string, unknown>,
): CookStateRow | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  const row: CookStateRow = {
    recipeId: raw.recipeId as string,
    servings: raw.servings as number,
    currentStep: raw.currentStep as number,
    checkedKeys: raw.checkedKeys as string[],
    recipeUpdatedAt: raw.recipeUpdatedAt as number,
  };
  // Steps done ahead of `currentStep` in a parallel block
  // (`docs/plans/parallel-steps.md`). Kept only when non-empty, so a row
  // without them has exactly the old key set.
  if (Array.isArray(raw.doneSteps) && typeof row.currentStep === 'number') {
    const progress = normalizeStepProgress({
      currentStep: row.currentStep,
      doneSteps: raw.doneSteps,
    });
    row.currentStep = progress.currentStep;
    if (progress.doneSteps.length > 0) {
      row.doneSteps = progress.doneSteps;
    }
  }
  const updatedAt = finiteCookUpdatedAt(raw.updatedAt);
  if (updatedAt !== undefined) {
    row.updatedAt = updatedAt;
  }
  return row;
}

/**
 * An unusable live row is dropped like a tombstone: nothing in the UI can
 * render it, and keeping it would hand a malformed entry to the next backup.
 */
export function normalizeCookLogChange(raw: Record<string, unknown>): CookLog | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  if (!isUsableCookLog(raw)) {
    return 'tombstone';
  }
  return compactCookLog(raw);
}

function readSharedParentOwnerSub(raw: Record<string, unknown>): string | undefined {
  const value = raw[SHARED_PARENT_OWNER_SUB_FIELD];
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  return value;
}

export function applyPullChanges(
  acc: {
    recipes: Map<string, Recipe>;
    collections: Map<string, Collection>;
    chat: Map<string, ChatMessage>;
    cook: Map<string, CookStateRow>;
    cookLogs: Map<string, CookLog>;
    remotePhotoIds: Set<string>;
    chatParentOrigins: Map<string, string>;
    cookParentOrigins: Map<string, string>;
  },
  changes: PullChanges,
): void {
  for (const raw of changes.recipes) {
    const id = raw.id as string;
    const normalized = normalizeRecipeChange(raw);
    if (normalized === 'tombstone') {
      acc.recipes.delete(id);
    } else {
      acc.recipes.set(id, normalized);
    }
  }
  for (const raw of changes.collections ?? []) {
    const id = raw.id as string;
    const normalized = normalizeCollectionChange(raw);
    if (normalized === 'tombstone') {
      acc.collections.delete(id);
    } else {
      acc.collections.set(id, normalized);
    }
  }
  for (const raw of changes.chatMessages) {
    const id = raw.id as string;
    const normalized = normalizeChatChange(raw);
    if (normalized === 'tombstone') {
      acc.chat.delete(id);
      acc.chatParentOrigins.delete(id);
    } else {
      acc.chat.set(id, normalized);
      const owner = readSharedParentOwnerSub(raw);
      if (owner === undefined) {
        acc.chatParentOrigins.delete(id);
      } else {
        acc.chatParentOrigins.set(id, owner);
      }
    }
  }
  for (const raw of changes.cookState) {
    const recipeId = (raw.recipeId ?? raw.id) as string;
    const normalized = normalizeCookChange(raw);
    if (normalized === 'tombstone') {
      acc.cook.delete(recipeId);
      acc.cookParentOrigins.delete(recipeId);
    } else {
      acc.cook.set(recipeId, normalized);
      const owner = readSharedParentOwnerSub(raw);
      if (owner === undefined) {
        acc.cookParentOrigins.delete(recipeId);
      } else {
        acc.cookParentOrigins.set(recipeId, owner);
      }
    }
  }
  for (const raw of changes.cookLogs ?? []) {
    const id = raw.id as string;
    const normalized = normalizeCookLogChange(raw);
    if (normalized === 'tombstone') {
      acc.cookLogs.delete(id);
    } else {
      acc.cookLogs.set(id, normalized);
    }
  }
  for (const raw of changes.photos) {
    const id = raw.id as string;
    if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
      acc.remotePhotoIds.delete(id);
    } else {
      acc.remotePhotoIds.add(id);
    }
  }
}

export function normalizeCollectionChange(raw: Record<string, unknown>): Collection | 'tombstone' {
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) {
    return 'tombstone';
  }
  return compactCollection({
    id: raw.id as string,
    name: typeof raw.name === 'string' ? raw.name : '',
    recipeIds: Array.isArray(raw.recipeIds) ? (raw.recipeIds as string[]) : [],
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  });
}

export type SharedPullChanges = {
  collections: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  photos: Record<string, unknown>[];
};

export type SharedPullPage = {
  changes: SharedPullChanges;
  cursorToken: string;
  hasMore: boolean;
};

/** Keep aligned with server/sharedPull.ts. A 200 must not mean "scope changed". */
const SHARED_SNAPSHOT_CHANGED_ERROR = 'shared-snapshot-changed';
const SHARED_SNAPSHOT_CHANGED_STATUS = 409;

async function isSharedSnapshotChanged(response: Response): Promise<boolean> {
  if (response.status !== SHARED_SNAPSHOT_CHANGED_STATUS) {
    return false;
  }
  try {
    const body = (await response.json()) as { error?: unknown };
    return body.error === SHARED_SNAPSHOT_CHANGED_ERROR;
  } catch {
    return false;
  }
}

export async function pullSharedPage(
  cursorToken: string | null,
): Promise<SharedPullPage | 'signedOut' | 'error' | 'restart'> {
  const params = new URLSearchParams({ limit: '200' });
  if (cursorToken) {
    params.set('cursor', cursorToken);
  }
  let response: Response;
  try {
    response = await fetch(`/api/sync/shared?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return 'error';
  }
  if (!response.ok) {
    if (await isSharedSnapshotChanged(response)) {
      return 'restart';
    }
    return readErrorStatus(response);
  }
  const body = (await response.json()) as {
    changes?: SharedPullChanges;
    cursorToken?: string;
    hasMore?: boolean;
  };
  if (!body.changes) {
    return 'error';
  }
  return {
    changes: body.changes,
    cursorToken: typeof body.cursorToken === 'string' ? body.cursorToken : '',
    hasMore: Boolean(body.hasMore),
  };
}

export type GrantRole = 'viewer' | 'editor';

export type CollectionGrant = {
  sub: string;
  email: string;
  /** Older servers omit it; that means viewer. */
  role?: GrantRole;
  createdAt: number;
};

export type GrantHttpResult =
  | { kind: 'ok'; grants?: CollectionGrant[]; grant?: CollectionGrant }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

type SharingHttpResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

async function grantRequest(
  path: string,
  init?: RequestInit,
): Promise<GrantHttpResult> {
  const result = await sharingRequest(path, init);
  if (result.kind !== 'ok') {
    return result;
  }
  return {
    kind: 'ok',
    grants: (result.body as { grants?: CollectionGrant[] }).grants,
    grant: (result.body as { grant?: CollectionGrant }).grant,
  };
}

/** Owner sharing REST (grants and links): 401/403 sign out, 503 is transient. */
async function sharingRequest(
  path: string,
  init?: RequestInit,
): Promise<SharingHttpResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
  } catch {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      kind: 'error',
      message: t(offline ? 'error.sharingOffline' : 'error.sharingUpdate'),
    };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return { kind: 'signedOut' };
  }
  if (response.status === 503) {
    return { kind: 'error', message: t('error.sharingUnavailable'), status: 503 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      kind: 'error',
      message: serverErrorText(body, 'error.sharingUpdate'),
      status: response.status,
    };
  }
  return { kind: 'ok', body };
}

export async function listCollectionGrants(
  collectionId: string,
): Promise<GrantHttpResult> {
  return grantRequest(`/api/collections/${encodeURIComponent(collectionId)}/grants`);
}

export async function addCollectionGrant(
  collectionId: string,
  email: string,
  role: GrantRole,
): Promise<GrantHttpResult> {
  return grantRequest(`/api/collections/${encodeURIComponent(collectionId)}/grants`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email, role }),
  });
}

export async function setCollectionGrantRole(
  collectionId: string,
  sub: string,
  role: GrantRole,
): Promise<GrantHttpResult> {
  return grantRequest(
    `/api/collections/${encodeURIComponent(collectionId)}/grants/role`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sub, role }),
    },
  );
}

export async function revokeCollectionGrant(
  collectionId: string,
  sub: string,
): Promise<GrantHttpResult> {
  return grantRequest(
    `/api/collections/${encodeURIComponent(collectionId)}/grants/revoke`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sub }),
    },
  );
}

export type LeaveSharedResult =
  | { kind: 'ok' }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

/**
 * A 404 here means the grant is already gone — the owner revoked it, or a
 * prior leave already went through. Either way, the viewer is not on the
 * collection any more, so the caller treats a 404 as success.
 */
export async function leaveSharedCollection(
  ownerSub: string,
  collectionId: string,
): Promise<LeaveSharedResult> {
  let response: Response;
  try {
    response = await fetch('/api/shared/leave', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: jsonHeaders(),
      body: JSON.stringify({ ownerSub, collectionId }),
    });
  } catch {
    return { kind: 'error', message: t('error.leaveCollection') };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    clearLibrary();
    return { kind: 'signedOut' };
  }
  if (response.status === 404) {
    return { kind: 'ok' };
  }
  if (response.status === 503) {
    return { kind: 'error', message: t('error.sharingUnavailable'), status: 503 };
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      kind: 'error',
      message: serverErrorText(body, 'error.leaveCollection'),
      status: response.status,
    };
  }
  return { kind: 'ok' };
}

export type CollectionLink = {
  /** sha256 of the token; identifies the link for revoke, cannot open it. */
  id: string;
  role: GrantRole;
  createdAt: number;
  expiresAt: number;
};

export type CollectionLinksBody = {
  links: CollectionLink[];
  /** Mint response only: the one time the token is shown. */
  url?: string;
  /** Mint response only: the new link's sha256 id (never the token). */
  id?: string;
  /** Revoke response only: the link that was revoked. */
  revokedId?: string;
  /**
   * Mint or revoke response: the write committed but the list read after it
   * failed. `links` is only the minted row (mint) or empty (revoke); reread.
   */
  partial?: true;
};

export type CollectionLinkHttpResult =
  | ({ kind: 'ok' } & CollectionLinksBody)
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

export function parseCollectionLinksBody(body: unknown): CollectionLinksBody | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { links?: unknown }).links)) {
    return null;
  }
  const links: CollectionLink[] = [];
  for (const raw of (body as { links: unknown[] }).links) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.createdAt !== 'number' ||
      typeof row.expiresAt !== 'number'
    ) {
      continue;
    }
    links.push({
      id: row.id,
      role: row.role === 'editor' ? 'editor' : 'viewer',
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  }
  const record = body as {
    url?: unknown;
    id?: unknown;
    revokedId?: unknown;
    partial?: unknown;
  };
  const parsed: CollectionLinksBody = { links };
  if (typeof record.url === 'string') {
    parsed.url = record.url;
  }
  if (typeof record.id === 'string') {
    parsed.id = record.id;
  }
  if (typeof record.revokedId === 'string') {
    parsed.revokedId = record.revokedId;
  }
  if (record.partial === true) {
    parsed.partial = true;
  }
  return parsed;
}

async function linkRequest(path: string, init?: RequestInit): Promise<CollectionLinkHttpResult> {
  const result = await sharingRequest(path, init);
  if (result.kind !== 'ok') {
    return result;
  }
  const parsed = parseCollectionLinksBody(result.body);
  if (parsed === null) {
    return { kind: 'error', message: t('error.sharingUpdate') };
  }
  return { kind: 'ok', ...parsed };
}

export async function listCollectionLinks(
  collectionId: string,
): Promise<CollectionLinkHttpResult> {
  return linkRequest(`/api/collections/${encodeURIComponent(collectionId)}/links`);
}

export async function createCollectionLink(
  collectionId: string,
  role: GrantRole,
): Promise<CollectionLinkHttpResult> {
  return linkRequest(`/api/collections/${encodeURIComponent(collectionId)}/links`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ role }),
  });
}

export async function revokeCollectionLink(
  collectionId: string,
  linkId: string,
): Promise<CollectionLinkHttpResult> {
  return linkRequest(`/api/collections/${encodeURIComponent(collectionId)}/links/revoke`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ id: linkId }),
  });
}

export type PublicLinkHttpResult =
  | { kind: 'ok'; url: string | null }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string; status?: number };

/** Owner public-link REST: `{ url }`, null while the collection is not public. */
async function publicLinkRequest(path: string, init?: RequestInit): Promise<PublicLinkHttpResult> {
  const result = await sharingRequest(path, init);
  if (result.kind !== 'ok') {
    return result;
  }
  const url = (result.body as { url?: unknown } | null)?.url;
  if (url !== null && typeof url !== 'string') {
    return { kind: 'error', message: t('error.sharingUpdate') };
  }
  return { kind: 'ok', url };
}

export async function getCollectionPublicLink(collectionId: string): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/collections/${encodeURIComponent(collectionId)}/public`);
}

export async function enableCollectionPublicLink(
  collectionId: string,
): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/collections/${encodeURIComponent(collectionId)}/public`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: '{}',
  });
}

export async function disableCollectionPublicLink(
  collectionId: string,
): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/collections/${encodeURIComponent(collectionId)}/public/revoke`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: '{}',
  });
}

/** Owner recipe-link REST (`docs/plans/recipe-links.md`): the same `{ url }` shape. */
export async function getRecipePublicLink(recipeId: string): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/recipes/${encodeURIComponent(recipeId)}/public`);
}

export async function enableRecipePublicLink(recipeId: string): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/recipes/${encodeURIComponent(recipeId)}/public`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: '{}',
  });
}

export async function disableRecipePublicLink(recipeId: string): Promise<PublicLinkHttpResult> {
  return publicLinkRequest(`/api/recipes/${encodeURIComponent(recipeId)}/public/revoke`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: '{}',
  });
}
