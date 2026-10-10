function collectionPath(collectionId: string): string {
  return `/collections/${encodeURIComponent(collectionId)}`;
}

export type MissingCollectionAction = {
  /** Replace the URL with `/` once a full pull has shown the id is gone. */
  redirectHome: boolean;
  /** Close rename, delete, leave, and share. The URL itself did not change. */
  resetCollectionSheets: boolean;
};

/**
 * What Library should do when `/collections/:id` is not in the loaded list.
 * `snapshotConfirmed` is true only for the snapshot a full pull published
 * (shared phase included). An owned-only publish, a slow pull, a sign-out,
 * and a not-yet-loaded library are not confirmation. `hold` is an owned
 * delete or a leave of this same id, which must keep its sheet.
 */
export function missingCollectionAction(input: {
  collectionId: string | undefined;
  /** Undefined until the library has loaded. An empty list has loaded. */
  collectionIds: readonly string[] | undefined;
  snapshotConfirmed: boolean;
  hold: boolean;
}): MissingCollectionAction {
  const none: MissingCollectionAction = {
    redirectHome: false,
    resetCollectionSheets: false,
  };
  if (input.collectionId === undefined || input.collectionId === '') return none;
  if (input.collectionIds === undefined) return none;
  if (input.collectionIds.includes(input.collectionId)) return none;
  if (input.hold) return none;
  return {
    redirectHome: input.snapshotConfirmed,
    resetCollectionSheets: true,
  };
}

/**
 * Where the collections index sends Back. Only a library path is kept:
 * `/` or `/collections/<id>`. Anything else, including the index itself,
 * goes home.
 */
export function libraryReturnPath(from: unknown): string {
  if (from === '/') return '/';
  if (typeof from !== 'string' || !from.startsWith('/collections/')) return '/';
  const id = from.slice('/collections/'.length);
  if (id === '' || id.includes('/')) return '/';
  return from;
}

/**
 * The library path a screen was opened from, carried in navigation state as
 * `{ from }`. `undefined` when there is none or it is not a library path.
 */
export function libraryPathFromState(state: unknown): string | undefined {
  if (state === null || typeof state !== 'object' || !('from' in state)) return undefined;
  const { from } = state;
  return typeof from === 'string' && libraryReturnPath(from) === from ? from : undefined;
}

export function libraryHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/';
  }
  return collectionPath(collectionId);
}

/** `mode: 'create'` opens the Import screen on Create, where the model writes a recipe from an idea. */
export function importHref(collectionId: string | undefined, mode?: 'create'): string {
  const path =
    collectionId === undefined || collectionId === ''
      ? '/import'
      : `${collectionPath(collectionId)}/import`;
  return mode === 'create' ? `${path}?mode=create` : path;
}

export function newRecipeHref(collectionId: string | undefined): string {
  if (collectionId === undefined || collectionId === '') {
    return '/recipe/new';
  }
  return `${collectionPath(collectionId)}/recipe/new`;
}
