import {
  deleteCollectionWithGrants,
  listLiveIncomingShares,
  readLiveIncomingShare,
  readSharedAuthorizationScope,
  sharingOwnerAdmitted,
} from './grants.ts';
import { drainGcsDeletes } from './photos.ts';
import {
  putSharedRecipe,
  readSharedRecipeAccess,
  sharedRecipeDeleteAllowed,
} from './sharedRecipeWrite.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
} from './membership.ts';
import {
  buildSharedPullPage,
  decodeSharedCursor,
  encodeSharedCursor,
  SHARED_SNAPSHOT_CHANGED_ERROR,
  SHARED_SNAPSHOT_CHANGED_STATUS,
} from './sharedPull.ts';
import {
  addedCollectionRecipeIds,
  cascadeRecipeDelete,
  clearChatForRecipe,
  compactCollectionFields,
  compactCookLogFields,
  compactRecipeFields,
  countLiveNamedCollections,
  decodePullCursor,
  isKnownPushKind,
  isLiveDoc,
  listChangedSince,
  MAX_NAMED_COLLECTIONS,
  putDoc,
  readDocData,
  readDocsData,
  readTombstonedRecipeIds,
  recipeIdsWithoutTombstones,
  chatCookPullFields,
  tombstoneDoc,
  tombstonePhotoWithGcs,
  type PullCursor,
  type PushRejectReason,
  type StoreKind,
  validatePushOp,
} from './store.ts';

export const STORE_KINDS: StoreKind[] = [
  'recipes',
  'chatMessages',
  'cookState',
  'photos',
  'collections',
  'cookLogs',
];

const MAX_PUSH_OPS = 50;
/** The push limit, in UTF-16 code units of the decoded body (`raw.length`). */
const MAX_PUSH_CHARS = 1_000_000;
/**
 * Where reading stops. UTF-8 spends at most 3 bytes per UTF-16 code unit, so
 * no body within `MAX_PUSH_CHARS` is longer than this: the stream is bounded
 * without refusing a push of Cyrillic or CJK text that was accepted before.
 */
const MAX_PUSH_BYTES = 3 * MAX_PUSH_CHARS;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function docToChange(kind: StoreKind, doc: Record<string, unknown>): Record<string, unknown> {
  const deletedAt = doc.deletedAt;
  if (deletedAt !== undefined && deletedAt !== null) {
    return { id: doc.id, deletedAt };
  }
  if (kind === 'chatMessages' || kind === 'cookState') {
    return chatCookPullFields(doc);
  }
  const copy = { ...doc };
  delete copy.serverUpdatedAt;
  delete copy.deletedAt;
  if (kind === 'recipes') {
    return compactRecipeFields(copy);
  }
  if (kind === 'collections') {
    return compactCollectionFields(copy);
  }
  if (kind === 'cookLogs') {
    return compactCookLogFields(copy);
  }
  if (kind === 'photos') {
    return {
      id: copy.id,
      recipeId: copy.recipeId,
      contentType: copy.contentType,
      size: copy.size,
      createdAt: copy.createdAt,
    };
  }
  return copy;
}

function mergeCursors(prev: PullCursor, kind: StoreKind, cursor: [number, string] | null): PullCursor {
  const next = { ...prev };
  if (cursor) {
    next[kind] = cursor;
  }
  return next;
}

export async function syncPull(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  let limit = 200;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (Number.isFinite(parsed)) {
      limit = Math.min(500, Math.max(1, Math.floor(parsed)));
    }
  }

  const cursor = decodePullCursor(url.searchParams.get('cursor'));

  const changes: Record<StoreKind, Record<string, unknown>[]> = {
    recipes: [],
    chatMessages: [],
    cookState: [],
    photos: [],
    collections: [],
    cookLogs: [],
  };

  let nextCursor: PullCursor = { ...cursor };
  let hasMore = false;

  for (const kind of STORE_KINDS) {
    const page = await listChangedSince(access.sub, kind, cursor[kind], limit);
    changes[kind] = page.docs.map((doc) => docToChange(kind, doc));
    nextCursor = mergeCursors(nextCursor, kind, page.cursor);
    if (page.hasMore) {
      hasMore = true;
    }
  }

  return jsonResponse({
    user: { sub: access.sub, email: access.email },
    changes,
    cursor: nextCursor,
    hasMore,
  });
  } catch (err) {
    console.error('syncPull store error:', err);
    return storeUnavailable();
  }
}

export type PushResult = {
  index: number;
  applied: boolean;
  reason?: PushRejectReason;
  current?: Record<string, unknown>;
};

/**
 * `shared` is the client saying "this is someone else's recipe; never create
 * it in my tree". It only narrows the write: owner and role are still found
 * from the session's incoming shares, and without it a put is an ordinary
 * write to the session's own tree.
 */
export async function applyPushOp(
  uid: string,
  op: { kind: string; payload: unknown; shared?: boolean },
): Promise<{ applied: boolean; reason?: PushRejectReason; current?: Record<string, unknown> }> {
  if (!isKnownPushKind(op.kind)) {
    return { applied: false, reason: 'unknown' };
  }
  const validated = validatePushOp(op);
  if (!validated.ok) {
    return { applied: false, reason: 'invalid' };
  }
  const { kind, payload } = validated.op;

  switch (kind) {
    case 'recipe.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const updatedAt = body.updatedAt as number;
      const compact = compactRecipeFields(body);
      if (op.shared === true) {
        return putSharedRecipe(uid, id, compact, updatedAt, sharingOwnerAdmitted);
      }
      return putDoc(uid, 'recipes', id, compact, updatedAt);
    }
    case 'recipe.delete': {
      const body = payload as { id: string; updatedAt: number };
      // Only the owner deletes. With no row of its own, a session that
      // reaches this id through a share gets a refusal, not a stray
      // tombstone in its own tree.
      const ownDocExists = (await readDocData(uid, 'recipes', body.id)) !== undefined;
      const access = ownDocExists ? null : await readSharedRecipeAccess(uid, body.id);
      if (!sharedRecipeDeleteAllowed(ownDocExists, access)) {
        return { applied: false, reason: 'invalid' };
      }
      await cascadeRecipeDelete(uid, body.id, body.updatedAt);
      return { applied: true };
    }
    case 'chat.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const createdAt = body.createdAt;
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
        return { applied: false, reason: 'invalid' };
      }
      const messageBody = { ...body, updatedAt: createdAt };
      return putDoc(uid, 'chatMessages', id, messageBody, createdAt);
    }
    case 'chat.clearForRecipe': {
      const body = payload as { recipeId: string; at: number };
      await clearChatForRecipe(uid, body.recipeId, body.at);
      return { applied: true };
    }
    case 'cookState.put': {
      const body = payload as Record<string, unknown>;
      const recipeId = body.recipeId as string;
      const updatedAt = body.updatedAt as number;
      return putDoc(uid, 'cookState', recipeId, body, updatedAt);
    }
    case 'photo.delete': {
      const body = payload as { id: string; updatedAt: number };
      return tombstonePhotoWithGcs(uid, body.id, body.updatedAt);
    }
    case 'collection.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const updatedAt = body.updatedAt as number;
      const existing = await readDocData(uid, 'collections', id);
      if (!isLiveDoc(existing)) {
        const live = await countLiveNamedCollections(uid);
        if (live >= MAX_NAMED_COLLECTIONS) {
          return { applied: false, reason: 'cap' };
        }
      }
      const compact = compactCollectionFields(body);
      const recipeIds = Array.isArray(compact.recipeIds)
        ? compact.recipeIds.filter((recipeId): recipeId is string => typeof recipeId === 'string')
        : [];
      const addedRecipeIds = addedCollectionRecipeIds(existing, recipeIds);
      // This preflight is intentionally outside putDoc's transaction. A concurrent
      // recipe delete may briefly win this race, but its membership cascade converges.
      const tombstonedRecipeIds = await readTombstonedRecipeIds(uid, addedRecipeIds);
      return putDoc(
        uid,
        'collections',
        id,
        {
          ...compact,
          recipeIds: recipeIdsWithoutTombstones(recipeIds, tombstonedRecipeIds),
        },
        updatedAt,
      );
    }
    case 'collection.delete': {
      const body = payload as { id: string; updatedAt: number };
      return deleteCollectionWithGrants(uid, body.id, body.updatedAt);
    }
    case 'cookLog.put': {
      const body = payload as Record<string, unknown>;
      const id = body.id as string;
      const updatedAt = body.updatedAt as number;
      const compact = compactCookLogFields(body);
      return putDoc(uid, 'cookLogs', id, compact, updatedAt);
    }
    case 'cookLog.delete': {
      const body = payload as { id: string; updatedAt: number };
      return tombstoneDoc(uid, 'cookLogs', body.id, body.updatedAt);
    }
    default:
      return { applied: false, reason: 'unknown' };
  }
}

export async function syncPush(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_PUSH_BYTES);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  if (raw === null || raw.length > MAX_PUSH_CHARS) {
    return jsonResponse({ error: 'Payload too large; batch your ops' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  if (!body || typeof body !== 'object' || !Array.isArray((body as { ops?: unknown }).ops)) {
    return jsonResponse({ error: 'Bad request' }, 400);
  }

  const ops = (body as { ops: unknown[] }).ops;
  if (ops.length > MAX_PUSH_OPS) {
    return jsonResponse({ error: 'Too many ops; batch your requests' }, 413);
  }

  const uid = access.sub;

  try {
  const results: PushResult[] = [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!op || typeof op !== 'object') {
      results.push({ index, applied: false, reason: 'invalid' });
      continue;
    }
    const record = op as Record<string, unknown>;
    if (record.uid !== undefined || record.sub !== undefined) {
      // ignored — uid comes only from session
    }
    const kind = record.kind;
    const payload = record.payload;
    const outcome = await applyPushOp(uid, {
      kind: kind as string,
      payload,
      shared: record.shared === true,
    });
    results.push({
      index,
      applied: outcome.applied,
      reason: outcome.reason,
      current: outcome.current,
    });
  }

  await drainGcsDeletes(uid);

  return jsonResponse({ results });
  } catch (err) {
    console.error('syncPush store error:', err);
    return storeUnavailable();
  }
}

export async function syncSharedPull(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    let limit = 200;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (Number.isFinite(parsed)) {
        limit = Math.min(500, Math.max(1, Math.floor(parsed)));
      }
    }
    const decoded = decodeSharedCursor(
      url.searchParams.get('cursor'),
      access.sub,
    );
    if (decoded.kind === 'reject') {
      return jsonResponse(
        { error: SHARED_SNAPSHOT_CHANGED_ERROR },
        SHARED_SNAPSHOT_CHANGED_STATUS,
      );
    }
    const page = await buildSharedPullPage({
      viewerSub: access.sub,
      cursor:
        decoded.kind === 'start'
          ? { kind: 'start' }
          : {
              kind: 'continue',
              generation: decoded.cursor.generation,
              grantId: decoded.cursor.grantId,
              recipeId: decoded.cursor.recipeId,
            },
      limit,
      listLiveIncomingShares,
      readLiveIncomingShare,
      ownerAdmitted: sharingOwnerAdmitted,
      readDocData,
      readDocsData,
      readAuthorizationScope: readSharedAuthorizationScope,
    });
    if (page.kind === 'snapshot-changed') {
      return jsonResponse(
        { error: SHARED_SNAPSHOT_CHANGED_ERROR },
        SHARED_SNAPSHOT_CHANGED_STATUS,
      );
    }
    return jsonResponse({
      changes: page.changes,
      cursorToken: encodeSharedCursor({
        v: 1,
        viewerSub: access.sub,
        generation: page.generation,
        grantId: page.cursor.grantId,
        recipeId: page.cursor.recipeId,
      }),
      hasMore: page.hasMore,
    });
  } catch (err) {
    console.error('syncSharedPull store error:', err);
    return storeUnavailable();
  }
}

export { encodePullCursor, decodePullCursor } from './store.ts';
