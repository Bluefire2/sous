import type { ChatMessage, Collection, CookLog, CookStateRow, Recipe } from './types';
import { recipePhotoIds } from './recipePhotos';

export type CloneIdNamespace = 'recipe' | 'collection' | 'photo' | 'chatMessage' | 'cookLog';

export type CloneIdFor = (namespace: CloneIdNamespace, originalId: string) => string;

export type BackupImportMode = 'preserve' | 'clone';

/** IDs are compared only within their entity/reference namespace. */
export interface BackupGraphIds {
  recipeIds: ReadonlySet<string>;
  collectionIds: ReadonlySet<string>;
  chatMessageIds: ReadonlySet<string>;
  cookLogIds: ReadonlySet<string>;
  photoIds: ReadonlySet<string>;
}

function overlaps(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const id of left) {
    if (right.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * Chooses one mode for the complete import graph. Legacy backups are
 * idempotent only when one of their namespaced IDs already exists in the
 * current account's owned graph.
 */
export function decideBackupImportMode(
  exportedBySub: string | undefined,
  currentSub: string,
  backupIds: BackupGraphIds,
  existingOwnedIds: BackupGraphIds,
): BackupImportMode {
  if (exportedBySub !== undefined) {
    return exportedBySub === currentSub ? 'preserve' : 'clone';
  }
  return overlaps(backupIds.recipeIds, existingOwnedIds.recipeIds)
    || overlaps(backupIds.collectionIds, existingOwnedIds.collectionIds)
    || overlaps(backupIds.chatMessageIds, existingOwnedIds.chatMessageIds)
    || overlaps(backupIds.cookLogIds, existingOwnedIds.cookLogIds)
    || overlaps(backupIds.photoIds, existingOwnedIds.photoIds)
    ? 'preserve'
    : 'clone';
}

function remapId(map: Map<string, string>, id: string): string {
  return map.get(id) ?? id;
}

function remapRecipe(recipe: Recipe, recipeIdMap: Map<string, string>, photoIdMap: Map<string, string>): Recipe {
  return {
    ...recipe,
    id: remapId(recipeIdMap, recipe.id),
    photoId:
      recipe.photoId === undefined
        ? undefined
        : remapId(photoIdMap, recipe.photoId),
    galleryPhotoIds: recipe.galleryPhotoIds?.map((id) => remapId(photoIdMap, id)),
    // Not part of the graph: an original that is a shared recipe is never
    // exported. Every variant of one original maps alike, so groups survive.
    variantOf:
      recipe.variantOf === undefined
        ? undefined
        : remapId(recipeIdMap, recipe.variantOf),
  };
}

function remapCollection(
  collection: Collection,
  collectionIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>,
): Collection {
  return {
    ...collection,
    id: remapId(collectionIdMap, collection.id),
    recipeIds: collection.recipeIds.map((id) => remapId(recipeIdMap, id)),
  };
}

function remapChatMessage(
  message: ChatMessage,
  chatIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>,
  photoIdMap: Map<string, string>,
): ChatMessage {
  return {
    ...message,
    id: remapId(chatIdMap, message.id),
    recipeId: remapId(recipeIdMap, message.recipeId),
    photoIds: message.photoIds?.map((id) => remapId(photoIdMap, id)),
  };
}

function remapCookLog(
  log: CookLog,
  cookLogIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>,
  photoIdMap: Map<string, string>,
): CookLog {
  return {
    ...log,
    id: remapId(cookLogIdMap, log.id),
    recipeId: remapId(recipeIdMap, log.recipeId),
    photoIds: log.photoIds?.map((id) => remapId(photoIdMap, id)),
  };
}

function remapCookRow(row: CookStateRow, recipeIdMap: Map<string, string>): CookStateRow {
  return {
    ...row,
    recipeId: remapId(recipeIdMap, row.recipeId),
  };
}

export interface BackupImportEntities {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  cookLogs: CookLog[];
  /** Photo ids present in the backup file (before remap). */
  backupPhotoIds: string[];
}

export interface RemappedBackupImport {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  cookLogs: CookLog[];
  /** Old photo id → new photo id (identity when preserving). */
  photoIdMap: Map<string, string>;
}

export function backupGraphIds(input: BackupImportEntities): BackupGraphIds {
  const recipeIds = new Set<string>();
  const collectionIds = new Set<string>();
  const chatMessageIds = new Set<string>();
  const cookLogIds = new Set<string>();
  const photoIds = new Set(input.backupPhotoIds);

  for (const recipe of input.recipes) {
    recipeIds.add(recipe.id);
    for (const id of recipePhotoIds(recipe)) {
      photoIds.add(id);
    }
  }
  for (const collection of input.collections) {
    collectionIds.add(collection.id);
    for (const id of collection.recipeIds) {
      recipeIds.add(id);
    }
  }
  for (const message of input.chatMessages) {
    chatMessageIds.add(message.id);
    recipeIds.add(message.recipeId);
    for (const id of message.photoIds ?? []) {
      photoIds.add(id);
    }
  }
  for (const row of input.cookState) {
    recipeIds.add(row.recipeId);
  }
  for (const log of input.cookLogs) {
    cookLogIds.add(log.id);
    recipeIds.add(log.recipeId);
    for (const id of log.photoIds ?? []) {
      photoIds.add(id);
    }
  }

  return { recipeIds, collectionIds, chatMessageIds, cookLogIds, photoIds };
}

/**
 * Clone ids are a pure function of the importing account, namespace, and
 * original id, so importing the same backup again overwrites the earlier
 * clone instead of duplicating it.
 */
export async function cloneUuid(
  currentSub: string,
  namespace: CloneIdNamespace,
  originalId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `sous-backup-clone\u0000${currentSub}\u0000${namespace}\u0000${originalId}`,
    ),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  // RFC 9562 version 8 plus the RFC variant bits. isUuid requires both.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deterministicCloneIds(
  graphIds: BackupGraphIds,
  currentSub: string,
): Promise<CloneIdFor> {
  const namespaces: Array<[CloneIdNamespace, ReadonlySet<string>]> = [
    ['recipe', graphIds.recipeIds],
    ['collection', graphIds.collectionIds],
    ['photo', graphIds.photoIds],
    ['chatMessage', graphIds.chatMessageIds],
    ['cookLog', graphIds.cookLogIds],
  ];
  const ids = new Map<string, string>();
  await Promise.all(
    namespaces.flatMap(([namespace, originals]) =>
      [...originals].map(async (id) => {
        ids.set(`${namespace}\u0000${id}`, await cloneUuid(currentSub, namespace, id));
      }),
    ),
  );
  return (namespace, originalId) => {
    const id = ids.get(`${namespace}\u0000${originalId}`);
    if (id === undefined) {
      throw new Error(`No clone id for ${namespace} ${originalId}`);
    }
    return id;
  };
}

export function remapBackupImport(
  input: BackupImportEntities,
  mode: BackupImportMode,
  cloneId: CloneIdFor,
): RemappedBackupImport {
  const graphIds = backupGraphIds(input);
  if (mode === 'preserve') {
    return {
      recipes: input.recipes,
      collections: input.collections,
      chatMessages: input.chatMessages,
      cookState: input.cookState,
      cookLogs: input.cookLogs,
      photoIdMap: new Map([...graphIds.photoIds].map((id) => [id, id])),
    };
  }

  const recipeIdMap = new Map<string, string>();
  for (const id of graphIds.recipeIds) {
    recipeIdMap.set(id, cloneId('recipe', id));
  }

  const collectionIdMap = new Map<string, string>();
  for (const id of graphIds.collectionIds) {
    collectionIdMap.set(id, cloneId('collection', id));
  }

  const photoIdMap = new Map<string, string>();
  for (const id of graphIds.photoIds) {
    photoIdMap.set(id, cloneId('photo', id));
  }

  const chatIdMap = new Map<string, string>();
  for (const id of graphIds.chatMessageIds) {
    chatIdMap.set(id, cloneId('chatMessage', id));
  }

  const cookLogIdMap = new Map<string, string>();
  for (const id of graphIds.cookLogIds) {
    cookLogIdMap.set(id, cloneId('cookLog', id));
  }

  return {
    recipes: input.recipes.map((r) => remapRecipe(r, recipeIdMap, photoIdMap)),
    collections: input.collections.map((c) =>
      remapCollection(c, collectionIdMap, recipeIdMap),
    ),
    chatMessages: input.chatMessages.map((m) =>
      remapChatMessage(m, chatIdMap, recipeIdMap, photoIdMap),
    ),
    cookState: input.cookState.map((row) => remapCookRow(row, recipeIdMap)),
    cookLogs: input.cookLogs.map((log) =>
      remapCookLog(log, cookLogIdMap, recipeIdMap, photoIdMap),
    ),
    photoIdMap,
  };
}
