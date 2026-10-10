import { sortCookLogs } from './cookLogShape';
import { recipePhotoIds } from './recipePhotos';
import type { BackupGraphIds } from './backupImportRemap';
import type { ChatMessage, Collection, CookLog, CookStateRow, Recipe } from './types';

/**
 * What this session may do to a row. `owner` is the session's own tree.
 * A shared row is `viewer` unless its grant (or, for a recipe, any shared
 * collection listing it) says `editor`. Memory only, set when a pull
 * publishes; never a `Recipe` or `Collection` field.
 */
export type LibraryAccess = 'owner' | 'editor' | 'viewer';

export type ItemOrigin =
  | { kind: 'own' }
  | {
      kind: 'shared';
      ownerSub: string;
      ownerEmail?: string;
      /** Missing means viewer. */
      access?: 'editor' | 'viewer';
    };

export function originAccess(origin: ItemOrigin | undefined): LibraryAccess | undefined {
  if (origin === undefined) {
    return undefined;
  }
  if (origin.kind === 'own') {
    return 'owner';
  }
  return origin.access === 'editor' ? 'editor' : 'viewer';
}

/**
 * A shared recipe is editable when any shared collection that lists it was
 * granted as editor: the stronger role wins, as it does on the server.
 */
export function withSharedRecipeAccess(
  recipeOrigins: ReadonlyMap<string, ItemOrigin>,
  collections: ReadonlyMap<string, Collection>,
  collectionOrigins: ReadonlyMap<string, ItemOrigin>,
): Map<string, ItemOrigin> {
  const editable = new Set<string>();
  // The shared pull carries the owner's email on collections only. Keyed by
  // owner, so a collection from someone else that happens to list the same
  // recipe id cannot label this recipe with their address.
  const ownerEmails = new Map<string, Map<string, string>>();
  for (const [id, collection] of collections) {
    const collectionOrigin = collectionOrigins.get(id);
    if (collectionOrigin?.kind === 'shared' && collectionOrigin.ownerEmail) {
      let byRecipe = ownerEmails.get(collectionOrigin.ownerSub);
      if (byRecipe === undefined) {
        byRecipe = new Map();
        ownerEmails.set(collectionOrigin.ownerSub, byRecipe);
      }
      for (const recipeId of collection.recipeIds) {
        byRecipe.set(recipeId, collectionOrigin.ownerEmail);
      }
    }
    if (originAccess(collectionOrigin) !== 'editor') {
      continue;
    }
    for (const recipeId of collection.recipeIds) {
      editable.add(recipeId);
    }
  }
  const next = new Map<string, ItemOrigin>();
  for (const [id, origin] of recipeOrigins) {
    if (origin.kind !== 'shared') {
      next.set(id, origin);
      continue;
    }
    const ownerEmail = origin.ownerEmail ?? ownerEmails.get(origin.ownerSub)?.get(id);
    next.set(id, {
      ...origin,
      ...(ownerEmail ? { ownerEmail } : {}),
      access: editable.has(id) ? 'editor' : 'viewer',
    });
  }
  return next;
}

export type LibrarySnapshot = {
  recipes: ReadonlyMap<string, Recipe>;
  collections: ReadonlyMap<string, Collection>;
  chat: ReadonlyMap<string, ChatMessage>;
  cook: ReadonlyMap<string, CookStateRow>;
  cookLogs: ReadonlyMap<string, CookLog>;
  remotePhotoIds: ReadonlySet<string>;
  pendingBlobs: ReadonlyMap<string, Blob>;
  recipeOrigins: ReadonlyMap<string, ItemOrigin>;
  collectionOrigins: ReadonlyMap<string, ItemOrigin>;
  /**
   * Server-derived shared parent owner for a viewer chat row, keyed by
   * message id. Absent means there is no persisted evidence the parent was
   * shared. Not part of ChatMessage or a version-3 backup.
   */
  chatParentOrigins: ReadonlyMap<string, string>;
  /** Same marker for cook rows, keyed by recipe id. */
  cookParentOrigins: ReadonlyMap<string, string>;
  loaded: boolean;
  /**
   * True only when these rows came from a pull whose shared phase succeeded.
   * An owned-only publish (shared phase failed) clears it. A later idle
   * status must not treat that snapshot as a confirmed library.
   */
  fullPull: boolean;
};

const listeners = new Set<() => void>();

function empty(loaded: boolean): LibrarySnapshot {
  return {
    recipes: new Map(),
    collections: new Map(),
    chat: new Map(),
    cook: new Map(),
    cookLogs: new Map(),
    remotePhotoIds: new Set(),
    pendingBlobs: new Map(),
    recipeOrigins: new Map(),
    collectionOrigins: new Map(),
    chatParentOrigins: new Map(),
    cookParentOrigins: new Map(),
    loaded,
    fullPull: false,
  };
}

let snapshot: LibrarySnapshot = empty(false);

/**
 * Bumped when a local write starts. A pull that began at an older epoch, or
 * while a write was still open, must not replace the library: its snapshot
 * can still contain a recipe the write already deleted, or omit a row the
 * write just saved.
 */
let epoch = 0;
let openWrites = 0;

export function libraryEpoch(): number {
  return epoch;
}

export function localWritesOpen(): number {
  return openWrites;
}

export function beginLocalWrite(): number {
  openWrites += 1;
  epoch += 1;
  return epoch;
}

export function endLocalWrite(): void {
  if (openWrites > 0) {
    openWrites -= 1;
  }
}

function emit(next: LibrarySnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Copies every map, for rollback only. Ordinary writes copy just the maps
 * they change, so an unchanged map keeps its identity and hooks that read it
 * do not re-derive. No write mutates a published map.
 */
function cloneMaps(from: LibrarySnapshot): {
  recipes: Map<string, Recipe>;
  collections: Map<string, Collection>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  cookLogs: Map<string, CookLog>;
  remotePhotoIds: Set<string>;
  pendingBlobs: Map<string, Blob>;
  recipeOrigins: Map<string, ItemOrigin>;
  collectionOrigins: Map<string, ItemOrigin>;
  chatParentOrigins: Map<string, string>;
  cookParentOrigins: Map<string, string>;
} {
  return {
    recipes: new Map(from.recipes),
    collections: new Map(from.collections),
    chat: new Map(from.chat),
    cook: new Map(from.cook),
    cookLogs: new Map(from.cookLogs),
    remotePhotoIds: new Set(from.remotePhotoIds),
    pendingBlobs: new Map(from.pendingBlobs),
    recipeOrigins: new Map(from.recipeOrigins),
    collectionOrigins: new Map(from.collectionOrigins),
    chatParentOrigins: new Map(from.chatParentOrigins),
    cookParentOrigins: new Map(from.cookParentOrigins),
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): LibrarySnapshot {
  return snapshot;
}

export function captureSnapshot(): LibrarySnapshot {
  return { ...cloneMaps(snapshot), loaded: snapshot.loaded, fullPull: snapshot.fullPull };
}

export function restoreSnapshot(previous: LibrarySnapshot): void {
  emit({
    ...cloneMaps(previous),
    loaded: previous.loaded,
    fullPull: previous.fullPull,
  });
}

export function markLoaded(): void {
  if (snapshot.loaded) {
    return;
  }
  emit({ ...snapshot, loaded: true });
}

/** Test isolation. The app boots unloaded; `clearLibrary` leaves it loaded. */
export function markUnloadedForTests(): void {
  if (!snapshot.loaded) {
    return;
  }
  emit({ ...snapshot, loaded: false });
}

export function clearLibrary(): void {
  // Signed-out syncs call this repeatedly; an already empty library stays as is.
  const alreadyEmpty =
    snapshot.loaded &&
    !snapshot.fullPull &&
    Object.values(snapshot).every(
      (value) => !(value instanceof Map || value instanceof Set) || value.size === 0,
    );
  if (alreadyEmpty) {
    return;
  }
  emit(empty(true));
}

type OwnedPullSnapshot = {
  recipes: Map<string, Recipe>;
  collections: Map<string, Collection>;
  chat: Map<string, ChatMessage>;
  cook: Map<string, CookStateRow>;
  cookLogs: Map<string, CookLog>;
  remotePhotoIds: Set<string>;
  chatParentOrigins?: ReadonlyMap<string, string>;
  cookParentOrigins?: ReadonlyMap<string, string>;
};

function copyOwnerMap(
  source: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(source ?? []);
}

export type SharedPullSnapshot = {
  recipes: Map<string, Recipe>;
  collections: Map<string, Collection>;
  remotePhotoIds: Set<string>;
  recipeOrigins: Map<string, ItemOrigin>;
  collectionOrigins: Map<string, ItemOrigin>;
};

export function replaceFromPull(next: OwnedPullSnapshot): void {
  const recipeOrigins = new Map<string, ItemOrigin>();
  for (const id of next.recipes.keys()) {
    recipeOrigins.set(id, { kind: 'own' });
  }
  const collectionOrigins = new Map<string, ItemOrigin>();
  for (const id of next.collections.keys()) {
    collectionOrigins.set(id, { kind: 'own' });
  }
  emit({
    recipes: next.recipes,
    collections: next.collections,
    chat: next.chat,
    cook: next.cook,
    cookLogs: next.cookLogs,
    remotePhotoIds: next.remotePhotoIds,
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    chatParentOrigins: copyOwnerMap(next.chatParentOrigins),
    cookParentOrigins: copyOwnerMap(next.cookParentOrigins),
    loaded: true,
    fullPull: false,
  });
}

export function replaceFromPullWithShared(
  owned: OwnedPullSnapshot,
  shared: SharedPullSnapshot,
): void {
  const recipes = new Map(owned.recipes);
  const recipeOrigins = new Map<string, ItemOrigin>();
  for (const id of recipes.keys()) {
    recipeOrigins.set(id, { kind: 'own' });
  }
  for (const [id, recipe] of shared.recipes) {
    if (recipes.has(id)) {
      continue;
    }
    recipes.set(id, recipe);
    const origin = shared.recipeOrigins.get(id);
    if (origin) {
      recipeOrigins.set(id, origin);
    }
  }

  const collections = new Map(owned.collections);
  const collectionOrigins = new Map<string, ItemOrigin>();
  for (const id of collections.keys()) {
    collectionOrigins.set(id, { kind: 'own' });
  }
  for (const [id, collection] of shared.collections) {
    if (collections.has(id)) {
      continue;
    }
    collections.set(id, collection);
    const origin = shared.collectionOrigins.get(id);
    if (origin) {
      collectionOrigins.set(id, origin);
    }
  }

  emit({
    recipes,
    collections,
    chat: owned.chat,
    cook: owned.cook,
    cookLogs: owned.cookLogs,
    remotePhotoIds: new Set([...owned.remotePhotoIds, ...shared.remotePhotoIds]),
    pendingBlobs: snapshot.pendingBlobs,
    recipeOrigins,
    collectionOrigins,
    chatParentOrigins: copyOwnerMap(owned.chatParentOrigins),
    cookParentOrigins: copyOwnerMap(owned.cookParentOrigins),
    loaded: true,
    fullPull: true,
  });
}

/** `source` with `key` set to `value`; the same map when it already holds that value. */
function withEntry<K, V>(
  source: ReadonlyMap<K, V>,
  key: K,
  value: V,
  same: (a: V, b: V) => boolean = Object.is,
): ReadonlyMap<K, V> {
  const current = source.get(key);
  if (source.has(key) && same(current as V, value)) {
    return source;
  }
  const next = new Map(source);
  next.set(key, value);
  return next;
}

/** `source` without `keys`; the same map when none of them is present. */
function without<K, V>(source: ReadonlyMap<K, V>, keys: Iterable<K>): ReadonlyMap<K, V> {
  let next: Map<K, V> | undefined;
  for (const key of keys) {
    if ((next ?? source).has(key)) {
      next ??= new Map(source);
      next.delete(key);
    }
  }
  return next ?? source;
}

/** `source` with `member` added; the same set when it is already there. */
function withMember<T>(source: ReadonlySet<T>, member: T): ReadonlySet<T> {
  if (source.has(member)) {
    return source;
  }
  const next = new Set(source);
  next.add(member);
  return next;
}

/** `source` without `members`; the same set when none of them is present. */
function withoutMembers<T>(source: ReadonlySet<T>, members: Iterable<T>): ReadonlySet<T> {
  let next: Set<T> | undefined;
  for (const member of members) {
    if ((next ?? source).has(member)) {
      next ??= new Set(source);
      next.delete(member);
    }
  }
  return next ?? source;
}

/**
 * Publishes the changed fields together. When every field is the one already
 * published, nothing changed, so there is nothing to publish.
 */
function publishChanges(changes: Partial<LibrarySnapshot>): void {
  const keys = Object.keys(changes) as (keyof LibrarySnapshot)[];
  if (keys.every((key) => Object.is(changes[key], snapshot[key]))) {
    return;
  }
  emit({ ...snapshot, ...changes });
}

function sameOrigin(a: ItemOrigin, b: ItemOrigin): boolean {
  if (a.kind === 'own' || b.kind === 'own') {
    return a.kind === b.kind;
  }
  return a.ownerSub === b.ownerSub && a.ownerEmail === b.ownerEmail && a.access === b.access;
}

/** `origin` defaults to own; an editor's optimistic save passes the shared origin through. */
export function upsertRecipe(recipe: Recipe, origin: ItemOrigin = { kind: 'own' }): void {
  publishChanges({
    recipes: withEntry(snapshot.recipes, recipe.id, recipe),
    recipeOrigins: withEntry(snapshot.recipeOrigins, recipe.id, origin, sameOrigin),
  });
}

export function removeRecipeLocal(id: string): void {
  const recipe = snapshot.recipes.get(id);
  const messages = [...snapshot.chat.values()].filter((message) => message.recipeId === id);
  const logs = [...snapshot.cookLogs.values()].filter((log) => log.recipeId === id);
  const messageIds = messages.map((message) => message.id);
  const photoIds = [
    ...messages.flatMap((message) => message.photoIds ?? []),
    ...logs.flatMap((log) => log.photoIds ?? []),
    ...(recipe ? recipePhotoIds(recipe) : []),
  ];
  publishChanges({
    recipes: without(snapshot.recipes, [id]),
    recipeOrigins: without(snapshot.recipeOrigins, [id]),
    cook: without(snapshot.cook, [id]),
    cookParentOrigins: without(snapshot.cookParentOrigins, [id]),
    chat: without(snapshot.chat, messageIds),
    chatParentOrigins: without(snapshot.chatParentOrigins, messageIds),
    cookLogs: without(snapshot.cookLogs, logs.map((log) => log.id)),
    pendingBlobs: without(snapshot.pendingBlobs, photoIds),
    remotePhotoIds: withoutMembers(snapshot.remotePhotoIds, photoIds),
  });
}

/** Drops the recipe row only. Chat, cook, logs, and photos stay for the caller. */
export function removeRecipeRowLocal(id: string): void {
  publishChanges({
    recipes: without(snapshot.recipes, [id]),
    recipeOrigins: without(snapshot.recipeOrigins, [id]),
  });
}

/**
 * Optimistic writes copy a live shared recipe origin into the sidecar so
 * export is safe before the next pull. A live owned origin clears it. A
 * missing origin leaves a persisted sidecar in place: revocation drops the
 * recipe before pull returns the stored marker, and that absence must not
 * wipe the marker. Returns the same map when nothing changes.
 */
function withInferredParentOrigin(
  sidecar: ReadonlyMap<string, string>,
  key: string,
  recipeId: string,
): ReadonlyMap<string, string> {
  const origin = snapshot.recipeOrigins.get(recipeId);
  if (origin?.kind === 'shared' && origin.ownerSub !== '') {
    return withEntry(sidecar, key, origin.ownerSub);
  }
  if (origin?.kind === 'own') {
    return without(sidecar, [key]);
  }
  return sidecar;
}

export function upsertChat(message: ChatMessage): void {
  publishChanges({
    chat: withEntry(snapshot.chat, message.id, message),
    chatParentOrigins: withInferredParentOrigin(
      snapshot.chatParentOrigins,
      message.id,
      message.recipeId,
    ),
  });
}

/** Drops one message. Photos stay; the caller decides whether they are still referenced. */
export function removeChatLocal(id: string): void {
  publishChanges({
    chat: without(snapshot.chat, [id]),
    chatParentOrigins: without(snapshot.chatParentOrigins, [id]),
  });
}

export function clearChatLocal(recipeId: string): void {
  const messages = [...snapshot.chat.values()].filter(
    (message) => message.recipeId === recipeId,
  );
  const messageIds = messages.map((message) => message.id);
  const photoIds = messages.flatMap((message) => message.photoIds ?? []);
  publishChanges({
    chat: without(snapshot.chat, messageIds),
    chatParentOrigins: without(snapshot.chatParentOrigins, messageIds),
    pendingBlobs: without(snapshot.pendingBlobs, photoIds),
    remotePhotoIds: withoutMembers(snapshot.remotePhotoIds, photoIds),
  });
}

export function upsertCook(row: CookStateRow): void {
  publishChanges({
    cook: withEntry(snapshot.cook, row.recipeId, row),
    cookParentOrigins: withInferredParentOrigin(
      snapshot.cookParentOrigins,
      row.recipeId,
      row.recipeId,
    ),
  });
}

/** Drops cook progress for one recipe. Does not touch the recipe or its photos. */
export function removeCookLocal(recipeId: string): void {
  publishChanges({
    cook: without(snapshot.cook, [recipeId]),
    cookParentOrigins: without(snapshot.cookParentOrigins, [recipeId]),
  });
}

export function upsertCookLog(log: CookLog): void {
  publishChanges({ cookLogs: withEntry(snapshot.cookLogs, log.id, log) });
}

export function removeCookLogLocal(id: string): void {
  publishChanges({ cookLogs: without(snapshot.cookLogs, [id]) });
}

export function addPendingBlob(id: string, blob: Blob): void {
  publishChanges({ pendingBlobs: withEntry(snapshot.pendingBlobs, id, blob) });
}

export function dropPendingBlob(id: string): void {
  publishChanges({ pendingBlobs: without(snapshot.pendingBlobs, [id]) });
}

export function markPhotoRemote(id: string): void {
  publishChanges({
    pendingBlobs: without(snapshot.pendingBlobs, [id]),
    remotePhotoIds: withMember(snapshot.remotePhotoIds, id),
  });
}

export function cachePhotoBlob(id: string, blob: Blob): void {
  publishChanges({
    pendingBlobs: withEntry(snapshot.pendingBlobs, id, blob),
    remotePhotoIds: withMember(snapshot.remotePhotoIds, id),
  });
}

export function dropPhoto(id: string): void {
  publishChanges({
    pendingBlobs: without(snapshot.pendingBlobs, [id]),
    remotePhotoIds: withoutMembers(snapshot.remotePhotoIds, [id]),
  });
}

export function sortRecipes(recipes: ReadonlyMap<string, Recipe>): Recipe[] {
  return [...recipes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sortCollections(collections: ReadonlyMap<string, Collection>): Collection[] {
  return [...collections.values()].sort((a, b) => {
    const name = a.name.localeCompare(b.name);
    return name !== 0 ? name : a.id.localeCompare(b.id);
  });
}

/** Oldest first. */
export function chatFor(
  chat: ReadonlyMap<string, ChatMessage>,
  recipeId: string,
): ChatMessage[] {
  return [...chat.values()]
    .filter((message) => message.recipeId === recipeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Newest cook first; every entry when `recipeId` is omitted. */
export function cookLogsFor(
  cookLogs: ReadonlyMap<string, CookLog>,
  recipeId?: string,
): CookLog[] {
  const logs = [...cookLogs.values()];
  return sortCookLogs(
    recipeId === undefined ? logs : logs.filter((log) => log.recipeId === recipeId),
  );
}

export function listRecipes(): Recipe[] {
  return sortRecipes(snapshot.recipes);
}

export function getRecipe(id: string): Recipe | undefined {
  return snapshot.recipes.get(id);
}

export function listCollections(): Collection[] {
  return sortCollections(snapshot.collections);
}

export function countOwnedNamedCollections(): number {
  let count = 0;
  for (const id of snapshot.collections.keys()) {
    if (snapshot.collectionOrigins.get(id)?.kind !== 'shared') {
      count += 1;
    }
  }
  return count;
}

export function getCollection(id: string): Collection | undefined {
  return snapshot.collections.get(id);
}

export function upsertCollection(collection: Collection): void {
  writeCollections({ upserts: [collection] });
}

/**
 * Upserts owned collections and drops `removeIds` in one publish.
 * A new id is stored as an own origin. An id that already has an origin
 * keeps it.
 */
export function writeCollections(input: {
  upserts: readonly Collection[];
  removeIds?: readonly string[];
}): void {
  let collections = snapshot.collections;
  let origins = snapshot.collectionOrigins;
  for (const collection of input.upserts) {
    collections = withEntry(collections, collection.id, collection);
    if (!origins.has(collection.id)) {
      origins = withEntry(origins, collection.id, { kind: 'own' });
    }
  }
  if (input.removeIds !== undefined && input.removeIds.length > 0) {
    collections = without(collections, input.removeIds);
    origins = without(origins, input.removeIds);
  }
  publishChanges({ collections, collectionOrigins: origins });
}

export function removeCollectionLocal(id: string): void {
  publishChanges({
    collections: without(snapshot.collections, [id]),
    collectionOrigins: without(snapshot.collectionOrigins, [id]),
  });
}

export function getRecipeOrigin(id: string): ItemOrigin | undefined {
  return snapshot.recipeOrigins.get(id);
}

export function getCollectionOrigin(id: string): ItemOrigin | undefined {
  return snapshot.collectionOrigins.get(id);
}

export function recipeAccess(id: string): LibraryAccess | undefined {
  return originAccess(snapshot.recipeOrigins.get(id));
}

export function collectionAccess(id: string): LibraryAccess | undefined {
  return originAccess(snapshot.collectionOrigins.get(id));
}

export function isSharedRecipe(id: string): boolean {
  return snapshot.recipeOrigins.get(id)?.kind === 'shared';
}

export function isSharedCollection(id: string): boolean {
  return snapshot.collectionOrigins.get(id)?.kind === 'shared';
}

export function photoOwnerSub(photoId: string): string | undefined {
  for (const recipe of snapshot.recipes.values()) {
    if (!recipePhotoIds(recipe).includes(photoId)) {
      continue;
    }
    const origin = snapshot.recipeOrigins.get(recipe.id);
    if (origin?.kind === 'shared') {
      return origin.ownerSub;
    }
    return undefined;
  }
  return undefined;
}

export function listChat(recipeId: string): ChatMessage[] {
  return chatFor(snapshot.chat, recipeId);
}

export function getCook(recipeId: string): CookStateRow | undefined {
  return snapshot.cook.get(recipeId);
}

export function getCookLog(id: string): CookLog | undefined {
  return snapshot.cookLogs.get(id);
}

/** Newest cook first; every entry when `recipeId` is omitted. */
export function listCookLogs(recipeId?: string): CookLog[] {
  return cookLogsFor(snapshot.cookLogs, recipeId);
}

export function getPendingBlob(id: string): Blob | undefined {
  return snapshot.pendingBlobs.get(id);
}

export function listAllChat(): ChatMessage[] {
  return [...snapshot.chat.values()];
}

export function listAllCook(): CookStateRow[] {
  return [...snapshot.cook.values()];
}

export function listPhotoIds(): string[] {
  const ids = new Set<string>(snapshot.remotePhotoIds);
  for (const id of snapshot.pendingBlobs.keys()) {
    ids.add(id);
  }
  return [...ids];
}

/**
 * True when the visible recipe origin or a persisted parent sidecar says
 * shared. Export and owned-overlap detection both use this so they cannot
 * drift. A missing sidecar is not shared: legacy orphans stay exportable.
 */
function parentSourcesSayShared(
  recipeId: string,
  sidecarOwner: string | undefined,
): boolean {
  if (snapshot.recipeOrigins.get(recipeId)?.kind === 'shared') {
    return true;
  }
  return sidecarOwner !== undefined && sidecarOwner !== '';
}

export function chatParentIsShared(messageId: string, recipeId: string): boolean {
  return parentSourcesSayShared(recipeId, snapshot.chatParentOrigins.get(messageId));
}

export function cookParentIsShared(recipeId: string): boolean {
  return parentSourcesSayShared(recipeId, snapshot.cookParentOrigins.get(recipeId));
}

/**
 * Returns namespaced IDs with evidence of belonging to this account.
 * Incoming shared rows are excluded. Chat and cook rows whose parent is
 * shared — by the visible recipe origin or the persisted sidecar — are
 * excluded together with their parent recipe reference and attachment photos.
 */
export function ownedBackupGraphIds(): BackupGraphIds {
  const recipeIds = new Set<string>();
  const collectionIds = new Set<string>();
  const chatMessageIds = new Set<string>();
  const photoIds = new Set<string>();
  const isOwnedRecipeId = (id: string) =>
    snapshot.recipeOrigins.get(id)?.kind !== 'shared';

  for (const recipe of snapshot.recipes.values()) {
    if (!isOwnedRecipeId(recipe.id)) {
      continue;
    }
    recipeIds.add(recipe.id);
    for (const id of recipePhotoIds(recipe)) {
      photoIds.add(id);
    }
  }
  for (const collection of snapshot.collections.values()) {
    if (snapshot.collectionOrigins.get(collection.id)?.kind === 'shared') {
      continue;
    }
    collectionIds.add(collection.id);
    for (const id of collection.recipeIds) {
      if (isOwnedRecipeId(id)) {
        recipeIds.add(id);
      }
    }
  }
  for (const message of snapshot.chat.values()) {
    if (chatParentIsShared(message.id, message.recipeId)) {
      continue;
    }
    chatMessageIds.add(message.id);
    recipeIds.add(message.recipeId);
    for (const id of message.photoIds ?? []) {
      photoIds.add(id);
    }
  }
  for (const row of snapshot.cook.values()) {
    if (cookParentIsShared(row.recipeId)) {
      continue;
    }
    recipeIds.add(row.recipeId);
  }
  const cookLogIds = new Set<string>();
  for (const log of snapshot.cookLogs.values()) {
    if (!isOwnedRecipeId(log.recipeId)) {
      continue;
    }
    cookLogIds.add(log.id);
    recipeIds.add(log.recipeId);
    for (const id of log.photoIds ?? []) {
      photoIds.add(id);
    }
  }

  return { recipeIds, collectionIds, chatMessageIds, cookLogIds, photoIds };
}

export function discardLegacyCookDb(): void {
  try {
    indexedDB.deleteDatabase('cook');
  } catch {
    // private mode / missing API
  }
  try {
    localStorage.removeItem('cook.ownerUid');
    localStorage.removeItem('cook.hasSeeded');
  } catch {
    // ignore
  }
}
