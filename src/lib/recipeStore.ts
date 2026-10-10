import { useMemo } from 'react';
import { t } from '../i18n';
import {
  addPendingBlob,
  captureSnapshot,
  dropPhoto,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  libraryEpoch,
  listRecipes,
  markPhotoRemote,
  photoOwnerSub,
  removeRecipeLocal,
  restoreSnapshot,
  sortRecipes,
  upsertRecipe,
  getCollection,
  getRecipeOrigin,
  isSharedCollection,
  isSharedRecipe,
  listCollections,
  recipeAccess,
  upsertCollection,
  type LibraryAccess,
} from './libraryMemory';
import {
  selectRecipe,
  selectRecipeAccess,
  selectRecipeCollectionId,
  selectRecipeSharedBy,
} from './librarySelectors';
import { useLibrarySelect, useLibrarySlice } from './useLibrary';
import {
  disableRecipePublicLink,
  enableRecipePublicLink,
  fetchPhotoBlobOutcome,
  getRecipePublicLink,
  postPhoto,
  pushOps,
  type PublicLinkHttpResult,
  type RemoteResult,
} from './remote';
import { photoStore } from './photoStore';
import { withLocalWrite } from './localWrite';
import { localWriteOverlapsPull, type SyncOutcome } from './syncEngine';
import { compactRecipe } from './compactRecipe';
import { reconcileImportCheck, type ImportCheck } from './importCheck';
import { compactCollection } from './compactCollection';
import { wouldExceedRecipeIdCap } from './collectionMembership';
import { recipePhotoIds } from './recipePhotos';
import { variantGroup } from './variantGroup';
import { carryStepLanes } from './stepLanes';
import type { Recipe, RecipeDraft } from './types';
import type { PushOp } from './pushOps';
import { isDiscardedPushReason } from './pushReasons';
import { SessionExpiredError } from './sessionExpired';

export { compactRecipe };

/**
 * A create that did not stick. The message is the error to show. Its staged
 * photo bytes are kept for a retry, but when the server may still hold the
 * failed recipe they move to new ids: `photoIdRemap` maps each old id to its
 * new one, and a retry must use the new ids (`remapPhotoIds`). Empty when
 * the old ids are safe to reuse.
 */
export class CreateRollbackError extends Error {
  readonly photoIdRemap: ReadonlyMap<string, string>;

  constructor(cause: unknown, photoIdRemap: ReadonlyMap<string, string>) {
    super(cause instanceof Error ? cause.message : t('error.recipeSave'), { cause });
    this.photoIdRemap = photoIdRemap;
  }
}

/**
 * Photo ids listed by saves that have not finished. Overlapping saves of the
 * same recipe (an edit still in flight while a lesson is promoted) both count,
 * so the one that fails does not tombstone an id the other still lists.
 */
const photosHeldBySaves = new Map<string, number>();

/**
 * Ids a `recipe.put` accepted. A later failed save must not tombstone them:
 * the live recipe lists them even after this save releases its hold.
 */
const photosCommittedByPut = new Set<string>();

/**
 * Uploaded by a save whose put certainly did not land, while another save
 * still held the id. Claimed after a later holder releases, and only when
 * that hold was the last one and that save's put certainly did not land.
 * An unknown put outcome drops them instead: that save may have committed
 * the id, and an orphan is cheaper than deleting a live photo.
 */
const photosLeftForLastHolder = new Set<string>();

function holdPhotoIds(ids: readonly string[]): void {
  for (const id of ids) {
    photosHeldBySaves.set(id, (photosHeldBySaves.get(id) ?? 0) + 1);
  }
}

function releasePhotoIds(ids: readonly string[]): void {
  for (const id of ids) {
    const next = (photosHeldBySaves.get(id) ?? 0) - 1;
    if (next <= 0) {
      photosHeldBySaves.delete(id);
    } else {
      photosHeldBySaves.set(id, next);
    }
  }
}

/** Ids this save made remote that no other in-flight or committed save still needs. */
function orphanedUploads(uploaded: readonly string[]): string[] {
  const orphans: string[] = [];
  for (const id of uploaded) {
    if (photosCommittedByPut.has(id)) {
      continue;
    }
    // Count includes this save. 1 means nobody else is holding the id.
    if ((photosHeldBySaves.get(id) ?? 0) !== 1) {
      continue;
    }
    orphans.push(id);
  }
  return orphans;
}

/**
 * This save uploaded these ids, then failed, while another save still lists
 * them. Remember them so the last holder can tombstone them if it fails too.
 */
function rememberUploadsHeldElsewhere(uploaded: readonly string[]): void {
  for (const id of uploaded) {
    if (photosCommittedByPut.has(id)) {
      continue;
    }
    if ((photosHeldBySaves.get(id) ?? 0) > 1) {
      photosLeftForLastHolder.add(id);
    }
  }
}

/**
 * Ids a failed sibling uploaded that this save held and has now released.
 * Call after `releasePhotoIds`: a count of 0 means this save was the last
 * holder. Taking one removes it; a committed id is removed too, since the
 * live recipe lists it. An id another save still holds stays for that save.
 */
function takePhotosLeftForLastHolder(held: readonly string[]): string[] {
  const take: string[] = [];
  for (const id of held) {
    if (!photosLeftForLastHolder.has(id)) {
      continue;
    }
    if (photosCommittedByPut.has(id)) {
      photosLeftForLastHolder.delete(id);
      continue;
    }
    if ((photosHeldBySaves.get(id) ?? 0) !== 0) {
      continue;
    }
    photosLeftForLastHolder.delete(id);
    take.push(id);
  }
  return take;
}

/** The put's outcome is unknown, so these ids might be on the live recipe. */
function forgetPhotosLeftForLastHolder(held: readonly string[]): void {
  for (const id of held) {
    photosLeftForLastHolder.delete(id);
  }
}

/** Clears the in-flight accounting. Tests reuse photo ids across cases. */
export function resetRecipePhotoSaveTracking(): void {
  photosHeldBySaves.clear();
  photosCommittedByPut.clear();
  photosLeftForLastHolder.clear();
}

/**
 * Uploads a staged blob that is not already on the server. A remote id's
 * pending bytes are the view cache (`cachePhotoBlob`); a replacement photo
 * is a new id, so this does not POST those bytes again.
 *
 * A fresh id is recorded in `uploaded` before the POST. A response that is
 * lost after the server stored the bytes still throws, and the failed save
 * can tombstone that id.
 */
async function uploadPhotoIfNeeded(
  photoId: string | undefined,
  recipeId: string,
  updatedAt: number,
  uploaded: string[],
): Promise<void> {
  if (photoId === undefined) {
    return;
  }
  const blob = getPendingBlob(photoId);
  if (!blob) {
    return;
  }
  if (getSnapshot().remotePhotoIds.has(photoId)) {
    return;
  }
  uploaded.push(photoId);
  const result = await postPhoto(photoId, recipeId, updatedAt, blob);
  if (result !== 'ok') {
    throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.photoSave'));
  }
  markPhotoRemote(photoId);
}

type ParentPhotoSlot = { kind: 'cover' | 'gallery'; id: string };

function parentPhotoSlots(parent: Recipe): ParentPhotoSlot[] {
  const slots: ParentPhotoSlot[] = [];
  if (parent.photoId !== undefined) {
    slots.push({ kind: 'cover', id: parent.photoId });
  }
  for (const id of parent.galleryPhotoIds ?? []) {
    slots.push({ kind: 'gallery', id });
  }
  return slots;
}

async function loadParentPhoto(id: string): Promise<Blob | 'missing' | 'unavailable' | 'signedOut'> {
  const pending = getPendingBlob(id);
  if (pending) {
    return pending;
  }
  return fetchPhotoBlobOutcome(id, photoOwnerSub(id));
}

/**
 * Cover and gallery copied onto new ids owned by the saver. A 404 is skipped.
 * A temporary fetch failure or a signed-out session aborts before any copy is
 * minted, so the save can be retried with the original photos still in place.
 */
async function copyParentPhotos(parent: Recipe): Promise<{
  photoId: string | undefined;
  galleryPhotoIds: string[] | undefined;
}> {
  const slots = parentPhotoSlots(parent);
  const loaded = await Promise.all(slots.map((slot) => loadParentPhoto(slot.id)));
  if (loaded.some((item) => item === 'signedOut')) {
    throw new SessionExpiredError();
  }
  if (loaded.some((item) => item === 'unavailable')) {
    throw new Error(t('error.photosCopy'));
  }

  let photoId: string | undefined;
  const galleryPhotoIds: string[] = [];
  for (let index = 0; index < slots.length; index += 1) {
    const blob = loaded[index];
    if (!(blob instanceof Blob)) {
      continue;
    }
    const nextId = await photoStore.add(blob);
    if (slots[index]?.kind === 'cover') {
      photoId = nextId;
    } else {
      galleryPhotoIds.push(nextId);
    }
  }
  return {
    photoId,
    galleryPhotoIds: galleryPhotoIds.length > 0 ? galleryPhotoIds : undefined,
  };
}

/** `uploaded` collects fresh ids, including when a later upload throws. */
async function uploadRecipePhotos(recipe: Recipe, uploaded: string[] = []): Promise<void> {
  for (const photoId of recipePhotoIds(recipe)) {
    await uploadPhotoIfNeeded(photoId, recipe.id, recipe.updatedAt, uploaded);
  }
}

/** Tombstone one photo. Local bytes drop only when the server accepts it. */
async function deletePhoto(photoId: string): Promise<Awaited<ReturnType<typeof pushOps>>> {
  const at = Date.now();
  const result = await pushOps([
    { kind: 'photo.delete', payload: { id: photoId, updatedAt: at } },
  ]);
  if (result === 'ok') {
    dropPhoto(photoId);
  }
  return result;
}

async function deleteRemovedPhotos(
  previous: Recipe | undefined,
  next: Recipe,
): Promise<void> {
  const keep = new Set(recipePhotoIds(next));
  for (const photoId of previous ? recipePhotoIds(previous) : []) {
    if (keep.has(photoId)) {
      continue;
    }
    try {
      await deletePhoto(photoId);
    } catch {
      // The put already landed. One failure must not skip the photos after it.
    }
  }
}

/**
 * Photos this save uploaded and then failed to attach. One push for the whole
 * list, so a failed edit does not wait on a round trip per photo. Best effort:
 * a failed delete must not replace the save error.
 */
async function discardOrphanUploads(photoIds: readonly string[]): Promise<void> {
  if (photoIds.length === 0) {
    return;
  }
  const at = Date.now();
  try {
    const result = await pushOps(
      photoIds.map((id) => ({ kind: 'photo.delete' as const, payload: { id, updatedAt: at } })),
    );
    if (result === 'ok') {
      for (const id of photoIds) {
        dropPhoto(id);
      }
    }
  } catch {
    // Best effort; the caller surfaces the original error.
  }
}

function samePhotoIds(a: Recipe, b: Recipe): boolean {
  const left = recipePhotoIds(a);
  const right = recipePhotoIds(b);
  return (
    a.photoId === b.photoId &&
    left.length === right.length &&
    left.every((id, i) => id === right[i])
  );
}

/**
 * An editor's save of someone else's recipe. Text only: the server refuses a
 * photo change from anyone but the owner, so it is refused here before any
 * upload, and nothing is uploaded or deleted. The row keeps its shared
 * origin; the next pull brings back whatever the owner's tree holds.
 */
async function saveShared(recipe: Recipe): Promise<void> {
  const previous = getRecipe(recipe.id);
  const origin = getRecipeOrigin(recipe.id);
  if (!previous || origin?.kind !== 'shared') {
    throw new Error(t('common.recipeNotFound'));
  }
  const next = compactRecipe({
    ...recipe,
    createdAt: previous.createdAt,
    updatedAt: Date.now(),
  });
  if (!samePhotoIds(previous, next)) {
    throw new Error(t('error.sharedPhotos'));
  }
  await withLocalWrite(async () => {
    upsertRecipe(next, origin);
    try {
      const result = await pushOps([{ kind: 'recipe.put', payload: next, shared: true }]);
      if (result !== 'ok') {
        throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.recipeSave'));
      }
      return { value: undefined, reconcile: true };
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        throw err;
      }
      // A newer in-flight save has replaced this row. Restoring `previous`
      // would wipe it. Same guard as an owned save.
      if (getRecipe(next.id) === next) {
        upsertRecipe(previous, origin);
      }
      return { value: undefined, reconcile: false, error: err };
    }
  });
}

/** Bytes a new recipe's photos are waiting to upload, captured before any upload. */
function stagedBlobs(recipe: Recipe): Map<string, Blob> {
  const staged = new Map<string, Blob>();
  for (const photoId of recipePhotoIds(recipe)) {
    const blob = getPendingBlob(photoId);
    if (blob) {
      staged.set(photoId, blob);
    }
  }
  return staged;
}

/**
 * Puts a failed create's staged bytes back as pending, including any this
 * attempt uploaded, so a retry uploads them again. Same ids only when the
 * server is known not to hold the failed recipe; otherwise that recipe may
 * still list the ids, and deleting it later force-tombstones every photo it
 * lists, including ones a retry shared with it. `remove` of a saved recipe
 * still drops its bytes.
 */
function restageBlobs(
  staged: ReadonlyMap<string, Blob>,
  sameIds: boolean,
): ReadonlyMap<string, string> {
  const remap = new Map<string, string>();
  for (const [photoId, blob] of staged) {
    const nextId = sameIds ? photoId : crypto.randomUUID();
    addPendingBlob(nextId, blob);
    if (nextId !== photoId) {
      remap.set(photoId, nextId);
    }
  }
  return remap;
}

/**
 * Undoes a create that may have reached the server: its recipe put, or a
 * photo upload after it, failed. Whether the put landed is unknowable (a
 * dropped response, or a rejected collection op in the same batch), so this
 * always pushes `recipe.delete` plus the collection scrub; for an id that
 * never landed it writes an unused tombstone. The server's delete cascade
 * tombstones any photo already stored under the recipe. Best effort, never
 * retried. Returns the photo id remap for `CreateRollbackError`, or
 * `'signedOut'` when the delete met a 401 (the library is already cleared).
 */
async function discardCreatedRecipe(
  id: string,
  staged: ReadonlyMap<string, Blob>,
): Promise<ReadonlyMap<string, string> | 'signedOut'> {
  const at = Date.now();
  // Same membership scrub as `remove`: a dead id still counts against the cap.
  const scrubbed = listCollections()
    .filter((c) => c.recipeIds.includes(id))
    .map((c) =>
      compactCollection({
        ...c,
        recipeIds: c.recipeIds.filter((recipeId) => recipeId !== id),
        updatedAt: at,
      }),
    );
  // A pull that read the live row before the delete landed must not paint it
  // back; hold the library as `remove` does. Create throws out of its own
  // write, so that read is not scheduled before this one. A failed discard
  // still rereads when a pull overlapped: the first launch stays on "Loading
  // recipes" until something publishes, and a recipe the server kept is the
  // same truth `remove` already trusts a reread for. With no pull in flight,
  // a failed discard does not reread. Sign-out has already cleared the library.
  const ops: PushOp[] = [{ kind: 'recipe.delete', payload: { id, updatedAt: at } }];
  for (const collection of scrubbed) {
    ops.push({ kind: 'collection.put', payload: collection });
  }
  const result = await withLocalWrite(
    async ({ epoch }) => {
      removeRecipeLocal(id);
      for (const collection of scrubbed) {
        upsertCollection(collection);
      }
      let pushed: RemoteResult = 'error';
      try {
        pushed = await pushOps(ops);
      } catch {
        // Best effort; the caller surfaces the original error.
      }
      const overlapped = pushed !== 'signedOut' && localWriteOverlapsPull(epoch);
      return {
        value: pushed,
        reconcile: pushed === 'ok',
        reread: overlapped ? 'always' : 'no',
      };
    },
    { awaitReread: true },
  );
  if (result === 'signedOut') {
    // The 401 cleared the library; keep nothing.
    return 'signedOut';
  }
  // Anything but 'ok' leaves the failed recipe possibly live on the server.
  return restageBlobs(staged, result === 'ok');
}

/**
 * An owned or shared save of a recipe whose import check is already decided.
 * `save` reconciles it first; `replaceFromImport` replaces it.
 */
async function saveRecipe(edit: Recipe): Promise<void> {
  // A variant's group is fixed when it is created, and so is where a saved
  // copy came from. No edit sets or clears either, and editors that rebuild
  // the record never have to carry them.
  const stored = getRecipe(edit.id);
  const recipe: Recipe = {
    ...edit,
    variantOf: stored?.variantOf,
    savedFrom: stored?.savedFrom,
  };
  if (isSharedRecipe(recipe.id)) {
    if (recipeAccess(recipe.id) !== 'editor') {
      throw new Error(t('error.sharedViewOnly'));
    }
    return saveShared(recipe);
  }
  const previous = getRecipe(recipe.id);
  const next = compactRecipe({ ...recipe, updatedAt: Date.now() });
  await withLocalWrite(async () => {
    const held = recipePhotoIds(next);
    holdPhotoIds(held);
    const uploaded: string[] = [];
    // Unset until the put is sent.
    let putResult: Awaited<ReturnType<typeof pushOps>> | undefined;
    let failure: unknown;
    try {
      upsertRecipe(next);
      await uploadRecipePhotos(next, uploaded);
      putResult = await pushOps([{ kind: 'recipe.put', payload: next }]);
      if (putResult !== 'ok') {
        throw putResult === 'signedOut' ? new SessionExpiredError() : new Error(t('error.recipeSave'));
      }
      for (const id of held) {
        photosCommittedByPut.add(id);
      }
      forgetPhotosLeftForLastHolder(held);
      // The put landed. Each replaced photo is deleted on its own, so one
      // failure neither fails this save nor skips the photos after it.
      // Memory already lists the new ids, so a later save will not retry.
      try {
        await deleteRemovedPhotos(previous, next);
      } catch {
        // Backstop. deleteRemovedPhotos already continues past one failure.
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        // The session also cannot authorize a tombstone.
        throw err;
      }
      // A put that returned ok is on the server. A newer in-flight save has
      // replaced this row in memory; restoring `previous` would wipe it.
      if (putResult !== 'ok' && getRecipe(next.id) === next) {
        if (previous) {
          upsertRecipe(previous);
        } else {
          removeRecipeLocal(next.id);
        }
      }
      // Tombstone only when the put certainly did not land: it was never sent,
      // or the server answered that it discarded it. A plain 'error' can be a
      // dropped response after the live recipe started listing these ids, and
      // deleting them would break it; an orphan is the cheaper mistake.
      // Own uploads only. Ids another save still holds are claimed after this
      // hold is released, so a sibling that fails during the delete below can
      // leave them for whoever drops the count to zero.
      if (putResult === undefined || isDiscardedPushReason(putResult)) {
        rememberUploadsHeldElsewhere(uploaded);
        await discardOrphanUploads(orphanedUploads(uploaded));
      } else if (putResult !== 'ok') {
        forgetPhotosLeftForLastHolder(held);
      }
      failure = err;
    } finally {
      releasePhotoIds(held);
    }
    if (
      failure !== undefined &&
      (putResult === undefined || isDiscardedPushReason(putResult))
    ) {
      await discardOrphanUploads(takePhotosLeftForLastHolder(held));
    }
    if (failure !== undefined) {
      return { value: undefined, reconcile: false, error: failure };
    }
    return { value: undefined, reconcile: true };
  });
}

/** The recipe with its import check carried from the stored one and reconciled with this edit. */
function withReconciledImportCheck(recipe: Recipe): Recipe {
  const previous = getRecipe(recipe.id);
  const check = reconcileImportCheck(
    recipe.importCheck ?? previous?.importCheck,
    previous ?? recipe,
    recipe,
    Date.now(),
  );
  if (check === recipe.importCheck) return recipe;
  return { ...recipe, importCheck: check };
}

/** A recipe link is the owner's to turn on or off; a shared recipe has none of its own. */
function rejectSharedLink(id: string): void {
  if (isSharedRecipe(id)) {
    throw new Error(t('error.sharedViewOnly'));
  }
}

function recipeLinkResult(result: PublicLinkHttpResult): string | null {
  if (result.kind === 'signedOut') {
    throw new Error(t('error.sessionExpired'));
  }
  if (result.kind === 'error') {
    throw new Error(result.message);
  }
  return result.url;
}

export const recipeStore = {
  /**
   * The recipe's link (`docs/plans/recipe-links.md`), or null while it has
   * none. Anyone with it can read the recipe and members can save a copy.
   */
  async recipeLink(id: string): Promise<string | null> {
    rejectSharedLink(id);
    return recipeLinkResult(await getRecipePublicLink(id));
  },

  /** Turns the recipe link on; already on returns the same link. */
  async enableRecipeLink(id: string): Promise<string | null> {
    rejectSharedLink(id);
    return recipeLinkResult(await enableRecipePublicLink(id));
  },

  /** Turns the recipe link off. Turning it on again makes a new one. */
  async disableRecipeLink(id: string): Promise<void> {
    rejectSharedLink(id);
    recipeLinkResult(await disableRecipePublicLink(id));
  },

  list(): Recipe[] {
    return listRecipes();
  },

  get(id: string): Recipe | undefined {
    return getRecipe(id);
  },

  /** True for a recipe that arrived through an incoming share. */
  isShared(id: string): boolean {
    return isSharedRecipe(id);
  },

  /** Email of whoever shared this recipe with you, when known. */
  sharedBy(id: string): string | undefined {
    const origin = getRecipeOrigin(id);
    return origin?.kind === 'shared' ? origin.ownerEmail : undefined;
  },

  /** `editor` when a shared recipe may be edited here (text only, not photos). */
  access(id: string): LibraryAccess | undefined {
    return recipeAccess(id);
  },

  /**
   * Saves an edit. The import check is carried from the stored recipe when
   * the caller leaves it out (the edit form has no field for it), then
   * reconciled with the edit (`reconcileImportCheck`).
   */
  async save(recipe: Recipe): Promise<void> {
    return saveRecipe(withReconciledImportCheck(recipe));
  },

  /** Hides this recipe's import warnings, here and on every device. Not an edit. */
  async dismissImportWarnings(id: string): Promise<void> {
    const recipe = getRecipe(id);
    if (!recipe) throw new Error(t('common.recipeNotFound'));
    if (recipe.importCheck === undefined || recipe.importCheck.dismissedAt !== undefined) return;
    await recipeStore.save({
      ...recipe,
      importCheck: { ...recipe.importCheck, dismissedAt: Date.now() },
    });
  },

  /**
   * Replaces a recipe's imported text with a fresh import of its source:
   * title, description, servings, times, sections, steps, notes, `lang`, and
   * the import check, which is the new import's or none. Identity, tags,
   * photos, `sourceUrl`, collections and cook logs stay. On a shared recipe
   * the editor's usual rules apply.
   */
  async replaceFromImport(id: string, draft: RecipeDraft, importCheck: ImportCheck | undefined): Promise<void> {
    const existing = getRecipe(id);
    if (!existing) throw new Error(t('common.recipeNotFound'));
    await saveRecipe({
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      title: draft.title,
      description: draft.description,
      servings: draft.servings,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredientSections: draft.ingredientSections,
      // Import never produces lanes; keep the ones added since, by text.
      steps: carryStepLanes(existing.steps, draft.steps),
      notes: draft.notes,
      lang: draft.lang,
      importCheck,
      tags: existing.tags,
      sourceUrl: existing.sourceUrl,
      photoId: existing.photoId,
      galleryPhotoIds: existing.galleryPhotoIds,
    });
  },
  /**
   * Merges a draft into the recipe with this id. Every field is named rather
   * than spread because drafts come from the `update_recipe` tool, whose schema
   * cannot express `sourceUrl`, `photoId`, `galleryPhotoIds`, or `lang` — a
   * spread would blank them. `lang` is carried from the existing recipe,
   * like `sourceUrl`, and so is the import check, which `save` reconciles. On a shared recipe the draft never supplies photos.
   * The draft is an edit of the stored recipe, including while a translation
   * is on screen. Lanes go through `carryStepLanes`, step by step: a stated
   * lane is kept, an empty one removes it, and a step with no lane field
   * keeps the lane of a stored step with the same text.
   */
  async applyDraft(id: string, draft: RecipeDraft): Promise<void> {
    const existing = getRecipe(id);
    if (!existing) throw new Error(`No recipe with id ${id}.`);
    const shared = isSharedRecipe(id);
    const photoId = shared ? existing.photoId : (draft.photoId ?? existing.photoId);
    const galleryPhotoIds = shared
      ? existing.galleryPhotoIds
      : (draft.galleryPhotoIds ?? existing.galleryPhotoIds);
    await recipeStore.save({
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      title: draft.title,
      description: draft.description,
      servings: draft.servings,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredientSections: draft.ingredientSections,
      steps: carryStepLanes(existing.steps, draft.steps),
      tags: draft.tags,
      notes: draft.notes,
      sourceUrl: draft.sourceUrl ?? existing.sourceUrl,
      lang: draft.lang ?? existing.lang,
      importCheck: existing.importCheck,
      photoId,
      galleryPhotoIds,
    });
  },

  /**
   * A new recipe from an Ask proposal. Photos come from `parent`, copied onto
   * new ids. Fields on the draft never supply a photo. `lang` comes from
   * `parent` too: the proposal never carries it, including when `parent` is
   * a shared recipe. The new recipe joins `parent`'s variant group, keyed on
   * the group's original, so a variant of a variant does not nest. Step lanes
   * carry from `parent` as in `applyDraft`.
   */
  async createFromAsk(parent: Recipe, draft: RecipeDraft): Promise<Recipe> {
    const copied = await copyParentPhotos(parent);
    try {
      return await recipeStore.create({
        ...draft,
        steps: carryStepLanes(parent.steps, draft.steps),
        lang: parent.lang,
        // A recipe from an Ask proposal was not imported.
        importCheck: undefined,
        photoId: copied.photoId,
        galleryPhotoIds: copied.galleryPhotoIds,
        variantOf: parent.variantOf ?? parent.id,
        // A variant is the member's own; it was not saved from a link.
        savedFrom: undefined,
      });
    } catch (err) {
      // A retry copies onto fresh ids, so these copies would never upload.
      for (const photoId of [copied.photoId, ...(copied.galleryPhotoIds ?? [])]) {
        if (photoId !== undefined) {
          dropPhoto(photoId);
        }
      }
      if (err instanceof CreateRollbackError) {
        for (const photoId of err.photoIdRemap.values()) {
          dropPhoto(photoId);
        }
      }
      throw err;
    }
  },

  async create(
    data: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>,
    opts?: { collectionId?: string },
  ): Promise<Recipe> {
    const now = Date.now();
    const recipe = compactRecipe({
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    const collectionId = opts?.collectionId;
    const previousCollection =
      collectionId !== undefined ? getCollection(collectionId) : undefined;
    let nextCollection = previousCollection;
    if (collectionId !== undefined) {
      if (!previousCollection || isSharedCollection(collectionId)) {
        throw new Error(t('error.collectionNotFound'));
      }
      if (wouldExceedRecipeIdCap([...previousCollection.recipeIds, recipe.id])) {
        throw new Error(t('error.collectionFull'));
      }
      nextCollection = compactCollection({
        ...previousCollection,
        recipeIds: [...previousCollection.recipeIds, recipe.id],
        updatedAt: now,
      });
    }
    const staged = stagedBlobs(recipe);
    if (staged.size !== recipePhotoIds(recipe).length) {
      // This call uploads a new recipe's photos. An id with no bytes here
      // would save a recipe pointing at a photo that never exists.
      throw new Error(t('error.photoSave'));
    }
    // The server stores a photo only under a live recipe, so the recipe row
    // goes first and the photos follow. The discard below opens its own
    // write epoch, so this one closes before that runs.
    try {
      return await withLocalWrite(async () => {
        upsertRecipe(recipe);
        if (nextCollection) {
          upsertCollection(nextCollection);
        }
        const ops: PushOp[] = [{ kind: 'recipe.put', payload: recipe }];
        if (nextCollection) {
          ops.push({ kind: 'collection.put', payload: nextCollection });
        }
        const result = await pushOps(ops);
        if (result !== 'ok') {
          throw result === 'signedOut' ? new SessionExpiredError() : new Error(t('error.recipeSave'));
        }
        await uploadRecipePhotos(recipe);
        return { value: recipe, reconcile: true };
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The 401 cleared the library already; write nothing back into it.
        throw err;
      }
      // Any other failure may have left the recipe on the server: at the
      // batch, where the client cannot tell which op failed, or at a photo.
      const remap = await discardCreatedRecipe(recipe.id, staged);
      throw remap === 'signedOut' ? new SessionExpiredError() : new CreateRollbackError(err, remap);
    }
  },

  async remove(id: string): Promise<void> {
    if (isSharedRecipe(id)) {
      throw new Error(t('error.sharedViewOnly'));
    }
    const previous = captureSnapshot();
    const at = Date.now();
    // Nothing else drops the id from collections, and a dead id still counts
    // against the per-collection cap, so scrub membership alongside the recipe.
    const staleIn = listCollections().filter((c) => c.recipeIds.includes(id));
    const scrubbed = staleIn.map((c) =>
      compactCollection({
        ...c,
        recipeIds: c.recipeIds.filter((recipeId) => recipeId !== id),
        updatedAt: at,
      }),
    );
    const ops: PushOp[] = [{ kind: 'recipe.delete', payload: { id, updatedAt: at } }];
    for (const collection of scrubbed) {
      ops.push({ kind: 'collection.put', payload: collection });
    }
    // The server tombstones the recipe before the rest of the delete finishes.
    // A failed response can still mean the recipe is gone. A pull that started
    // before this write can also paint the old card back. Hold the library
    // until the push settles, then read the server instead of restoring blindly.
    // A successful delete that overlapped nothing does not pull.
    let writeEpoch = 0;
    let pullOutcome: SyncOutcome | undefined;
    const result = await withLocalWrite(
      async ({ epoch }) => {
        writeEpoch = epoch;
        removeRecipeLocal(id);
        for (const collection of scrubbed) {
          upsertCollection(collection);
        }
        const pushed = await pushOps(ops);
        const overlaps = localWriteOverlapsPull(epoch);
        if (pushed === 'ok' && !overlaps) {
          return { value: pushed, reconcile: true, reread: 'no' };
        }
        return { value: pushed, reconcile: pushed === 'ok', reread: 'always' };
      },
      {
        awaitReread: true,
        onReread(outcome) {
          pullOutcome = outcome;
        },
      },
    );
    if (result === 'ok') {
      return;
    }
    if (pullOutcome === 'signedOut') {
      throw new Error(t('error.sessionExpired'));
    }
    if (pullOutcome === 'ok') {
      if (getRecipe(id) === undefined) {
        return;
      }
      throw new Error(t('error.recipeDelete'));
    }
    if (libraryEpoch() === writeEpoch) {
      restoreSnapshot(previous);
    }
    throw new Error(
      result === 'signedOut' ? t('error.sessionExpired') : t('error.recipeDelete'),
    );
  },
};

/** Reactive list of all recipes, newest first. `undefined` while loading. */
export function useRecipes(): Recipe[] | undefined {
  const loaded = useLibrarySlice('loaded');
  const recipes = useLibrarySlice('recipes');
  // Callers read shared/owned state beside the list, so an origin-only change
  // must hand them a new list too.
  const origins = useLibrarySlice('recipeOrigins');
  return useMemo(
    () => (loaded ? sortRecipes(recipes) : undefined),
    [loaded, recipes, origins],
  );
}

/** Reactive single recipe. `undefined` while loading, `null` if not found. */
export function useRecipe(id: string | undefined): Recipe | null | undefined {
  return useLibrarySelect(selectRecipe(id));
}

/** Reactive email of whoever shared this recipe with you, when known. */
export function useRecipeSharedBy(id: string | undefined): string | undefined {
  return useLibrarySelect(selectRecipeSharedBy(id));
}

/**
 * Reactive collection this recipe is filed in. `undefined` while the library
 * is loading and when the recipe is unfiled.
 */
export function useRecipeCollectionId(id: string | undefined): string | undefined {
  return useLibrarySelect(selectRecipeCollectionId(id));
}

/**
 * Reactive variant group of one recipe, the original first; empty when the
 * recipe has no other variants. Origins decide which shared recipes may
 * join (`variantGroup`). It re-renders on any recipe or origin change, so
 * only the component that shows the group should call it.
 */
export function useRecipeVariants(id: string | undefined): readonly Recipe[] {
  const recipes = useLibrarySlice('recipes');
  const origins = useLibrarySlice('recipeOrigins');
  return useMemo(() => variantGroup(recipes, origins, id), [recipes, origins, id]);
}

/** Reactive access to one recipe; `undefined` when it is not in the library. */
export function useRecipeAccess(id: string | undefined): LibraryAccess | undefined {
  return useLibrarySelect(selectRecipeAccess(id));
}
