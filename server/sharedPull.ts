import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sessionSecret } from './env.ts';
import {
  canonicalSharedAuthorizationScope,
  type LiveIncomingShare,
  type SharedAuthorizationScopeEntry,
} from './grants.ts';
import { canViewCollection, canViewRecipe, parseShareRole } from './shareAuth.ts';
import {
  compactCollectionFields,
  compactRecipeFields,
  isLiveDoc,
  type StoreKind,
} from './store.ts';

/** Wire signal for a shared authorization scope that moved between pages. Not 401 or 403. */
export const SHARED_SNAPSHOT_CHANGED_ERROR = 'shared-snapshot-changed';
export const SHARED_SNAPSHOT_CHANGED_STATUS = 409;

const SHARED_CURSOR_VERSION = 1;

export type SharedCursorPayload = {
  v: 1;
  viewerSub: string;
  generation: string;
  grantId: string;
  recipeId: string;
};

export type DecodedSharedCursor =
  | { kind: 'start' }
  | { kind: 'continue'; cursor: SharedCursorPayload }
  | { kind: 'reject' };

export type SharedPullCursor =
  | { kind: 'start' }
  | {
      kind: 'continue';
      generation: string;
      grantId: string;
      recipeId: string;
    };

type ReadDocData = (
  uid: string,
  kind: StoreKind,
  id: string,
) => Promise<Record<string, unknown> | undefined>;

type ReadDocsData = (
  uid: string,
  kind: StoreKind,
  ids: readonly string[],
) => Promise<Array<Record<string, unknown> | undefined>>;

export type BuildSharedPullPageInput = {
  viewerSub: string;
  cursor: SharedPullCursor;
  limit: number;
  listLiveIncomingShares: (viewerSub: string) => Promise<LiveIncomingShare[]>;
  readLiveIncomingShare: (
    viewerSub: string,
    grantId: string,
  ) => Promise<LiveIncomingShare | undefined>;
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  readDocData: ReadDocData;
  readDocsData: ReadDocsData;
  readAuthorizationScope: (
    viewerSub: string,
  ) => Promise<SharedAuthorizationScopeEntry[]>;
};

export type SharedPullPageBody = {
  changes: {
    collections: Record<string, unknown>[];
    recipes: Record<string, unknown>[];
    photos: Record<string, unknown>[];
  };
  cursor: { grantId: string; recipeId: string };
  hasMore: boolean;
};

export type SharedPullPageResult =
  | ({ kind: 'page'; generation: string } & SharedPullPageBody)
  | { kind: 'snapshot-changed' };

/**
 * Digest of the viewer's authorization surface. This detects a changed
 * generation; it does not authorize a row. Recipe and photo bodies are not
 * hashed.
 */
export function sharedAuthorizationGeneration(
  entries: readonly SharedAuthorizationScopeEntry[],
): string {
  const canonical = canonicalSharedAuthorizationScope(entries);
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('base64url');
}

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

/** Rejects non-alphabet characters that Node's base64url decoder would ignore. */
function decodeBase64urlStrict(part: string): Buffer | null {
  if (part === '' || /[^A-Za-z0-9_-]/.test(part)) {
    return null;
  }
  const buf = Buffer.from(part, 'base64url');
  if (buf.toString('base64url') !== part) {
    return null;
  }
  return buf;
}

/** Domain prefix so a session cookie cannot verify as a shared cursor. */
export const SHARED_CURSOR_HMAC_DOMAIN = 'sous-shared-cursor';

function sharedCursorMac(payloadPart: string, secret: string): Buffer {
  return createHmac('sha256', secret)
    .update(`${SHARED_CURSOR_HMAC_DOMAIN}.${payloadPart}`)
    .digest();
}

function hmacSign(payloadPart: string, secret: string): string {
  return base64urlEncode(sharedCursorMac(payloadPart, secret));
}

function hmacVerify(payloadPart: string, sigPart: string, secret: string): boolean {
  const expected = sharedCursorMac(payloadPart, secret);
  const actual = decodeBase64urlStrict(sigPart);
  if (!actual || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function splitToken(token: string): { payload: string; signature: string } | null {
  const dot = token.indexOf('.');
  if (dot === -1) {
    return null;
  }
  if (token.indexOf('.', dot + 1) !== -1) {
    return null;
  }
  return { payload: token.slice(0, dot), signature: token.slice(dot + 1) };
}

/** Signed continuation. A position cannot be spliced onto another generation or viewer. */
export function encodeSharedCursor(cursor: SharedCursorPayload): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  const payloadPart = base64urlEncode(
    JSON.stringify({
      v: cursor.v,
      viewerSub: cursor.viewerSub,
      generation: cursor.generation,
      grantId: cursor.grantId,
      recipeId: cursor.recipeId,
    }),
  );
  return `${payloadPart}.${hmacSign(payloadPart, secret)}`;
}

/**
 * Missing cursor starts at page 1. Anything unsigned, malformed, or bound to
 * another viewer is rejected so its position cannot resume.
 */
export function decodeSharedCursor(
  raw: string | null,
  viewerSub: string,
): DecodedSharedCursor {
  if (raw === null || raw === '') {
    return { kind: 'start' };
  }
  const secret = sessionSecret();
  if (!secret) {
    return { kind: 'reject' };
  }
  const parts = splitToken(raw);
  if (!parts || !hmacVerify(parts.payload, parts.signature, secret)) {
    return { kind: 'reject' };
  }
  const payloadBuf = decodeBase64urlStrict(parts.payload);
  if (!payloadBuf) {
    return { kind: 'reject' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8')) as unknown;
  } catch {
    return { kind: 'reject' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'reject' };
  }
  const record = parsed as {
    v?: unknown;
    viewerSub?: unknown;
    generation?: unknown;
    grantId?: unknown;
    recipeId?: unknown;
  };
  if (record.v !== SHARED_CURSOR_VERSION) {
    return { kind: 'reject' };
  }
  if (typeof record.viewerSub !== 'string' || record.viewerSub !== viewerSub) {
    return { kind: 'reject' };
  }
  if (typeof record.generation !== 'string' || record.generation === '') {
    return { kind: 'reject' };
  }
  if (typeof record.grantId !== 'string' || typeof record.recipeId !== 'string') {
    return { kind: 'reject' };
  }
  return {
    kind: 'continue',
    cursor: {
      v: 1,
      viewerSub: record.viewerSub,
      generation: record.generation,
      grantId: record.grantId,
      recipeId: record.recipeId,
    },
  };
}

function afterRecipeCursor(recipeId: string, cursorRecipeId: string): boolean {
  if (cursorRecipeId === '') {
    return true;
  }
  return recipeId > cursorRecipeId;
}

async function readSharedPageBody(
  input: BuildSharedPullPageInput,
  position: { grantId: string; recipeId: string },
): Promise<SharedPullPageBody> {
  const shares = await input.listLiveIncomingShares(input.viewerSub);
  const admittedByOwner = new Map<string, boolean>();
  const start = shares.findIndex((share) => {
    if (position.grantId === '') {
      return true;
    }
    return share.grantId > position.grantId || share.grantId === position.grantId;
  });
  const empty: SharedPullPageBody = {
    changes: { collections: [], recipes: [], photos: [] },
    cursor: position,
    hasMore: false,
  };
  if (start === -1) {
    return empty;
  }

  for (let i = start; i < shares.length; i += 1) {
    const candidate = shares[i];
    const share = await input.readLiveIncomingShare(
      input.viewerSub,
      candidate.grantId,
    );
    if (
      share === undefined ||
      share.grantId !== candidate.grantId ||
      share.ownerSub !== candidate.ownerSub ||
      share.collectionId !== candidate.collectionId
    ) {
      continue;
    }
    let admitted = admittedByOwner.get(share.ownerSub);
    if (admitted === undefined) {
      admitted = await input.ownerAdmitted(share.ownerSub);
      admittedByOwner.set(share.ownerSub, admitted);
    }
    if (!admitted) {
      continue;
    }
    const collection = await input.readDocData(
      share.ownerSub,
      'collections',
      share.collectionId,
    );
    if (
      !canViewCollection(
        {
          ownerSub: share.ownerSub,
          collectionId: share.collectionId,
          grantId: share.grantId,
        },
        collection,
      ) ||
      collection === undefined
    ) {
      continue;
    }
    const listed = Array.isArray(collection.recipeIds)
      ? collection.recipeIds.filter((id): id is string => typeof id === 'string')
      : [];
    listed.sort();
    const resume = share.grantId === position.grantId ? position.recipeId : '';
    const pending = listed.filter((id) => afterRecipeCursor(id, resume));
    if (share.grantId === position.grantId && pending.length === 0) {
      continue;
    }
    const pageIds = pending.slice(0, input.limit);
    const recipeDocs =
      pageIds.length > 0
        ? await input.readDocsData(share.ownerSub, 'recipes', pageIds)
        : [];
    const recipes: Record<string, unknown>[] = [];
    const recipePhotoRefs: Array<{ recipeId: string; photoIds: string[] }> = [];
    pageIds.forEach((recipeId, index) => {
      const recipe = recipeDocs[index];
      if (!canViewRecipe(recipeId, share, collection, recipe)) {
        return;
      }
      const compact = compactRecipeFields({ ...recipe, id: recipeId });
      // Who shared the recipe with the owner is the owner's to know; an
      // editor's put keeps the owner's value (`planSharedRecipePut`).
      delete compact.savedFrom;
      recipes.push({ ...compact, ownerSub: share.ownerSub });
      const photoIds: string[] = [];
      if (typeof compact.photoId === 'string') {
        photoIds.push(compact.photoId);
      }
      if (Array.isArray(compact.galleryPhotoIds)) {
        for (const id of compact.galleryPhotoIds) {
          if (typeof id === 'string' && !photoIds.includes(id)) {
            photoIds.push(id);
          }
        }
      }
      recipePhotoRefs.push({ recipeId, photoIds });
    });
    const uniquePhotoIds = [
      ...new Set(recipePhotoRefs.flatMap((ref) => ref.photoIds)),
    ];
    const photoDocs =
      uniquePhotoIds.length > 0
        ? await input.readDocsData(share.ownerSub, 'photos', uniquePhotoIds)
        : [];
    const photoById = new Map(
      uniquePhotoIds.map((id, index) => [id, photoDocs[index]]),
    );
    const photos: Record<string, unknown>[] = [];
    for (const { recipeId, photoIds } of recipePhotoRefs) {
      for (const photoId of photoIds) {
        const photo = photoById.get(photoId);
        if (
          photo === undefined ||
          !isLiveDoc(photo) ||
          photo.status !== 'live' ||
          photo.recipeId !== recipeId
        ) {
          continue;
        }
        photos.push({
          id: photoId,
          recipeId,
          contentType: photo.contentType,
          size: photo.size,
          createdAt: photo.createdAt,
        });
      }
    }
    const moreInGrant = pending.length > pageIds.length;
    const moreGrants = i < shares.length - 1;
    const lastRecipeId = moreInGrant
      ? pageIds[pageIds.length - 1] ?? resume
      : '\uFFFF';
    return {
      changes: {
        collections: [
          {
            ...compactCollectionFields({ ...collection, id: share.collectionId }),
            ownerSub: share.ownerSub,
            ...(share.ownerEmail ? { ownerEmail: share.ownerEmail } : {}),
            role: parseShareRole(share.role),
          },
        ],
        recipes,
        photos,
      },
      cursor: { grantId: share.grantId, recipeId: lastRecipeId },
      hasMore: moreInGrant || moreGrants,
    };
  }

  return empty;
}

export async function buildSharedPullPage(
  input: BuildSharedPullPageInput,
): Promise<SharedPullPageResult> {
  const position =
    input.cursor.kind === 'continue'
      ? { grantId: input.cursor.grantId, recipeId: input.cursor.recipeId }
      : { grantId: '', recipeId: '' };
  const generation = sharedAuthorizationGeneration(
    await input.readAuthorizationScope(input.viewerSub),
  );
  if (
    input.cursor.kind === 'continue' &&
    input.cursor.generation !== generation
  ) {
    return { kind: 'snapshot-changed' };
  }
  const page = await readSharedPageBody(input, position);
  const after = sharedAuthorizationGeneration(
    await input.readAuthorizationScope(input.viewerSub),
  );
  if (after !== generation) {
    return { kind: 'snapshot-changed' };
  }
  return { kind: 'page', ...page, generation };
}
