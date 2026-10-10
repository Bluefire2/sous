import { t } from '../i18n';
import { isUsableRecipe } from './recipeShape';
import type { ChatMessage, Collection, CookLog, CookStateRow, Recipe } from './types';
import { compactCookLog, isUsableCookLog } from './cookLogShape';
import {
  addPendingBlob,
  cachePhotoBlob,
  captureSnapshot,
  chatParentIsShared,
  cookParentIsShared,
  dropPendingBlob,
  dropPhoto,
  getCollection,
  getCook,
  getCookLog,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  isSharedCollection,
  isSharedRecipe,
  listAllChat,
  listAllCook,
  listCollections,
  listCookLogs,
  listRecipes,
  markPhotoRemote,
  ownedBackupGraphIds,
  removeChatLocal,
  removeCollectionLocal,
  removeCookLocal,
  removeCookLogLocal,
  removeRecipeRowLocal,
  upsertChat,
  upsertCollection,
  upsertCook,
  upsertCookLog,
  upsertRecipe,
  type LibrarySnapshot,
} from './libraryMemory';
import { compactRecipe } from './compactRecipe';
import { compactCollection, compactCollectionName } from './compactCollection';
import { recipePhotoIds } from './recipePhotos';
import { withLocalWrite } from './localWrite';
import { fetchPhotoBlob, postPhoto, pushOps, type RemoteResult } from './remote';
import type { PushOp } from './pushOps';
import { SHARED_PARENT_OWNER_SUB_FIELD } from './pushReasons';
import {
  backupGraphIds,
  decideBackupImportMode,
  deterministicCloneIds,
  remapBackupImport,
} from './backupImportRemap';

interface BackupPhoto {
  id: string;
  type: string;
  base64: string;
  createdAt: number;
}

interface BackupFile {
  app: 'cook';
  version: 1 | 2 | 3 | 4;
  exportedAt: number;
  /** Google `sub` of the account that exported this file (optional on legacy backups). */
  exportedBySub?: string;
  recipes: unknown[];
  chatMessages: ChatMessage[];
  photos: BackupPhoto[];
  cookState?: CookStateRow[];
  collections?: unknown[];
  cookLogs?: unknown[];
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function attributePhotos(
  recipes: Recipe[],
  chatMessages: ChatMessage[],
  cookLogs: CookLog[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const recipe of recipes) {
    for (const photoId of recipePhotoIds(recipe)) {
      if (!map.has(photoId)) {
        map.set(photoId, recipe.id);
      }
    }
  }
  for (const message of chatMessages) {
    for (const photoId of message.photoIds ?? []) {
      if (!map.has(photoId)) {
        map.set(photoId, message.recipeId);
      }
    }
  }
  for (const log of cookLogs) {
    for (const photoId of log.photoIds ?? []) {
      if (!map.has(photoId)) {
        map.set(photoId, log.recipeId);
      }
    }
  }
  return map;
}

function withoutImportedProvenance<T extends object>(row: T): T {
  if (!Object.prototype.hasOwnProperty.call(row, SHARED_PARENT_OWNER_SUB_FIELD)) {
    return row;
  }
  const copy = { ...row } as T & Record<string, unknown>;
  delete copy[SHARED_PARENT_OWNER_SUB_FIELD];
  return copy;
}

export async function exportLibrary(currentSub: string): Promise<Blob> {
  const recipes = listRecipes().filter((recipe) => !isSharedRecipe(recipe.id));
  const chatMessages = listAllChat()
    .filter((message) => !chatParentIsShared(message.id, message.recipeId))
    .map(withoutImportedProvenance);
  const cookState = listAllCook()
    .filter((row) => !cookParentIsShared(row.recipeId))
    .map(withoutImportedProvenance);
  const collections = listCollections().filter(
    (collection) => !isSharedCollection(collection.id),
  );
  const cookLogs = listCookLogs().filter((log) => !isSharedRecipe(log.recipeId));
  // Photo attribution runs after the shared-parent filter, so an attachment
  // that belongs only to an omitted chat row is not exported.
  const photoIds = [...attributePhotos(recipes, chatMessages, cookLogs).keys()];

  const photos: BackupPhoto[] = [];
  for (const id of photoIds) {
    let blob = getPendingBlob(id);
    if (!blob) {
      const fetched = await fetchPhotoBlob(id, undefined);
      if (fetched === null || fetched === 'signedOut') {
        continue;
      }
      blob = fetched;
    }
    photos.push({
      id,
      type: blob.type || 'image/jpeg',
      base64: await blobToBase64(blob),
      createdAt: Date.now(),
    });
  }

  const backup: BackupFile = {
    app: 'cook',
    version: 4,
    exportedAt: Date.now(),
    exportedBySub: currentSub,
    recipes,
    chatMessages,
    cookState,
    collections,
    cookLogs,
    photos,
  };

  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

function isUsableCollection(raw: unknown): raw is Collection {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id === '') {
    return false;
  }
  if (compactCollectionName(row.name) === undefined) {
    return false;
  }
  if (!Array.isArray(row.recipeIds)) {
    return false;
  }
  if (typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number') {
    return false;
  }
  return true;
}

/**
 * Drops chat, cook, and cook log rows whose recipe is not a usable recipe
 * entity in this backup, and photos attributable only to those rows. Recipe
 * entities stay.
 * Legacy orphan dependents are not restorable under the server parent
 * invariant; this does not synthesize parent recipes.
 */
function sanitizeDanglingDependents(
  recipes: Recipe[],
  collections: Collection[],
  chatMessages: ChatMessage[],
  cookState: CookStateRow[],
  cookLogs: CookLog[],
): {
  recipes: Recipe[];
  collections: Collection[];
  chatMessages: ChatMessage[];
  cookState: CookStateRow[];
  cookLogs: CookLog[];
  omitPhotoIds: Set<string>;
} {
  const usableIds = new Set(recipes.map((recipe) => recipe.id));
  const keptChat = chatMessages.filter((message) => usableIds.has(message.recipeId));
  const keptCook = cookState.filter((row) => usableIds.has(row.recipeId));
  const keptCookLogs = cookLogs.filter((log) => usableIds.has(log.recipeId));
  const keptPhotoIds = new Set(attributePhotos(recipes, keptChat, keptCookLogs).keys());
  const omitPhotoIds = new Set<string>();
  const dropped = [
    ...chatMessages.filter((message) => !usableIds.has(message.recipeId)),
    ...cookLogs.filter((log) => !usableIds.has(log.recipeId)),
  ];
  for (const row of dropped) {
    for (const photoId of row.photoIds ?? []) {
      if (!keptPhotoIds.has(photoId)) {
        omitPhotoIds.add(photoId);
      }
    }
  }
  return {
    recipes,
    collections,
    chatMessages: keptChat,
    cookState: keptCook,
    cookLogs: keptCookLogs,
    omitPhotoIds,
  };
}

function importPushError(result: Exclude<RemoteResult, 'ok'>): Error {
  return new Error(
    result === 'signedOut'
      ? t('error.sessionExpired')
      : t('error.backupImport'),
  );
}

/**
 * Drops only the rows this import upserted. An id whose current object is a
 * newer write is left alone. A new recipe drops its row only, so a chat, cook,
 * or log a newer write replaced is not cascaded away. Its id is then removed
 * from any collection that still lists it.
 */
function undoImportedLibrary(
  previous: LibrarySnapshot,
  imported: {
    recipes: Recipe[];
    collections: Collection[];
    chat: ChatMessage[];
    cook: CookStateRow[];
    cookLogs: CookLog[];
    photos: { id: string; blob: Blob }[];
    markedRemote: ReadonlySet<string>;
  },
): void {
  for (const message of imported.chat) {
    if (getSnapshot().chat.get(message.id) !== message) {
      continue;
    }
    const prior = previous.chat.get(message.id);
    if (prior) {
      upsertChat(prior);
    } else {
      removeChatLocal(message.id);
    }
  }
  for (const row of imported.cook) {
    if (getCook(row.recipeId) !== row) {
      continue;
    }
    const prior = previous.cook.get(row.recipeId);
    if (prior) {
      upsertCook(prior);
    } else {
      removeCookLocal(row.recipeId);
    }
  }
  for (const log of imported.cookLogs) {
    if (getCookLog(log.id) !== log) {
      continue;
    }
    const prior = previous.cookLogs.get(log.id);
    if (prior) {
      upsertCookLog(prior);
    } else {
      removeCookLogLocal(log.id);
    }
  }
  for (const collection of imported.collections) {
    if (getCollection(collection.id) !== collection) {
      continue;
    }
    const prior = previous.collections.get(collection.id);
    if (prior) {
      upsertCollection(prior);
    } else {
      removeCollectionLocal(collection.id);
    }
  }
  for (const recipe of imported.recipes) {
    if (getRecipe(recipe.id) !== recipe) {
      continue;
    }
    const prior = previous.recipes.get(recipe.id);
    if (prior) {
      upsertRecipe(prior, previous.recipeOrigins.get(recipe.id) ?? { kind: 'own' });
    } else {
      removeRecipeRowLocal(recipe.id);
      forgetRecipeId(recipe.id);
    }
  }
  for (const photo of imported.photos) {
    undoImportedPhoto(previous, photo, imported.markedRemote);
  }
}

function forgetRecipeId(recipeId: string): void {
  for (const collection of listCollections()) {
    if (!collection.recipeIds.includes(recipeId)) {
      continue;
    }
    upsertCollection({
      ...collection,
      recipeIds: collection.recipeIds.filter((id) => id !== recipeId),
    });
  }
}

function undoImportedPhoto(
  previous: LibrarySnapshot,
  photo: { id: string; blob: Blob },
  markedRemote: ReadonlySet<string>,
): void {
  if (getPendingBlob(photo.id) === photo.blob) {
    const prior = previous.pendingBlobs.get(photo.id);
    if (prior && prior !== photo.blob) {
      addPendingBlob(photo.id, prior);
    } else if (!prior) {
      dropPendingBlob(photo.id);
    }
  }
  if (!markedRemote.has(photo.id) || getPendingBlob(photo.id) !== undefined) {
    return;
  }
  const priorPending = previous.pendingBlobs.get(photo.id);
  if (!previous.remotePhotoIds.has(photo.id)) {
    dropPhoto(photo.id);
    if (priorPending) {
      addPendingBlob(photo.id, priorPending);
    }
    return;
  }
  if (priorPending) {
    cachePhotoBlob(photo.id, priorPending);
  }
}

/** Merges a backup, preserving the whole graph only when provenance or owned overlap says it is local. */
export async function importLibrary(
  file: Blob,
  currentSub: string,
): Promise<{ imported: number; skipped: number }> {
  const backup = JSON.parse(await file.text()) as BackupFile;
  if (backup.app !== 'cook' || !Array.isArray(backup.recipes)) {
    throw new Error(t('error.backupNotSous'));
  }

  const recipes = backup.recipes.filter(isUsableRecipe).map(compactRecipe);
  const skipped = backup.recipes.length - recipes.length;
  const collections = (backup.collections ?? [])
    .filter(isUsableCollection)
    .map(compactCollection);
  const chatMessages = (backup.chatMessages ?? []).map(withoutImportedProvenance);
  const cookState = (backup.cookState ?? []).map(withoutImportedProvenance);
  const cookLogs = (Array.isArray(backup.cookLogs) ? backup.cookLogs : [])
    .filter(isUsableCookLog)
    .map(compactCookLog);
  const importEntities = {
    recipes,
    collections,
    chatMessages,
    cookState,
    cookLogs,
    backupPhotoIds: (backup.photos ?? []).map((p) => p.id),
  };
  const graphIds = backupGraphIds(importEntities);
  const mode = decideBackupImportMode(
    backup.exportedBySub,
    currentSub,
    graphIds,
    ownedBackupGraphIds(),
  );
  const remapped = remapBackupImport(
    importEntities,
    mode,
    mode === 'clone'
      ? await deterministicCloneIds(graphIds, currentSub)
      : () => {
          throw new Error('preserve mode does not assign clone ids');
        },
  );
  // Mode uses the full graph, including dangling chat/cook. Those rows are
  // removed only from the write set, after preserve-versus-clone.
  const kept = sanitizeDanglingDependents(
    remapped.recipes,
    remapped.collections,
    remapped.chatMessages,
    remapped.cookState,
    remapped.cookLogs,
  );
  const importRecipes = kept.recipes;
  const importCollections = kept.collections;
  const importChat = kept.chatMessages;
  const importCook = kept.cookState;
  const importCookLogs = kept.cookLogs;
  const photoAttribution = attributePhotos(importRecipes, importChat, importCookLogs);

  const keptPhotos = (backup.photos ?? []).flatMap((photo) => {
    const id = remapped.photoIdMap.get(photo.id) ?? photo.id;
    if (kept.omitPhotoIds.has(id)) {
      return [];
    }
    return [{ ...photo, id }];
  });
  const photos = await Promise.all(
    keptPhotos.map(async (photo) => ({
      id: photo.id,
      blob: await (await fetch(`data:${photo.type};base64,${photo.base64}`)).blob(),
      createdAt: photo.createdAt,
    })),
  );

  const previous = captureSnapshot();
  // The import rejects before the follow-up read publishes. A recipe phase
  // that already returned ok still asks for that read, so an overlapping pull
  // is not the last word. Rows this import wrote are undone first, except ones
  // a newer write has replaced. A signed-out session is left cleared.
  return withLocalWrite(async () => {
    let recipesLanded = false;
    let signedOut = false;
    const markedRemote = new Set<string>();
    try {
      for (const photo of photos) {
        addPendingBlob(photo.id, photo.blob);
      }
      for (const recipe of importRecipes) {
        upsertRecipe(recipe);
      }
      for (const collection of importCollections) {
        upsertCollection(collection);
      }
      for (const message of importChat) {
        upsertChat(message);
      }
      for (const row of importCook) {
        upsertCook(row);
      }
      for (const log of importCookLogs) {
        upsertCookLog(log);
      }

      // Remote import is best-effort across requests. Recipe puts are
      // acknowledged before photo bytes and dependent puts. A failure after
      // the recipe phase can leave accepted server rows. Undoing the rows
      // this import wrote hides chat and cook the server never stored, when
      // nothing is in flight to reread, without wiping a concurrent edit.
      const recipeOps: PushOp[] = importRecipes.map((recipe) => ({
        kind: 'recipe.put',
        payload: recipe,
      }));
      const recipeResult = await pushOps(recipeOps);
      if (recipeResult !== 'ok') {
        signedOut = recipeResult === 'signedOut';
        throw importPushError(recipeResult);
      }
      recipesLanded = true;

      for (const [photoId, recipeId] of photoAttribution) {
        const photo = photos.find((p) => p.id === photoId);
        if (!photo) {
          continue;
        }
        const uploaded = await postPhoto(
          photoId,
          recipeId,
          photo.createdAt,
          photo.blob,
        );
        if (uploaded !== 'ok') {
          signedOut = uploaded === 'signedOut';
          throw new Error(
            uploaded === 'signedOut' ? t('error.sessionExpired') : t('error.backupPhotoUpload'),
          );
        }
        markPhotoRemote(photoId);
        markedRemote.add(photoId);
      }

      const dependentOps: PushOp[] = [];
      for (const collection of importCollections) {
        dependentOps.push({ kind: 'collection.put', payload: collection });
      }
      for (const message of importChat) {
        dependentOps.push({ kind: 'chat.put', payload: message });
      }
      for (const row of importCook) {
        dependentOps.push({
          kind: 'cookState.put',
          payload: { ...row, updatedAt: Date.now() },
        });
      }
      for (const log of importCookLogs) {
        dependentOps.push({ kind: 'cookLog.put', payload: log });
      }
      const dependentResult = await pushOps(dependentOps);
      if (dependentResult !== 'ok') {
        signedOut = dependentResult === 'signedOut';
        throw importPushError(dependentResult);
      }

      return { value: { imported: importRecipes.length, skipped }, reconcile: true };
    } catch (err) {
      // A 401 already cleared the library. Putting the previous rows back
      // would hand a signed-out client the pre-import library.
      if (!signedOut) {
        undoImportedLibrary(previous, {
          recipes: importRecipes,
          collections: importCollections,
          chat: importChat,
          cook: importCook,
          cookLogs: importCookLogs,
          photos,
          markedRemote,
        });
      }
      return {
        value: { imported: 0, skipped },
        reconcile: recipesLanded && !signedOut,
        reread: signedOut ? 'no' : undefined,
        error: err,
      };
    }
  });
}
