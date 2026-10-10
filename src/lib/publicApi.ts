import { t } from '../i18n';
import { serverErrorText } from './errorText';
import { isUsableRecipe } from './recipeShape';
import { invalidateSession } from './session';
import type { Recipe } from './types';

/**
 * What anyone with a link reads at `/p/<token>`: a public collection
 * (`docs/plans/public-collections.md`) or one recipe from a recipe link
 * (`docs/plans/recipe-links.md`). Fetched fresh on every screen; never put
 * in `libraryMemory`, synced, or cached, so turning the link off wins at once.
 */
export type PublicCollectionData = {
  collection: { id: string; name: string };
  recipes: Recipe[];
};

export type PublicRecipeLinkData = {
  recipe: Recipe;
  /** The sharer's display name, when they have one. */
  sharedBy?: string;
};

export type PublicLinkData =
  | ({ kind: 'collection' } & PublicCollectionData)
  | ({ kind: 'recipe' } & PublicRecipeLinkData);

export type PublicLinkResult =
  | { kind: 'ok'; data: PublicLinkData }
  | { kind: 'missing' }
  | { kind: 'error' };

/** Drops anything malformed rather than failing the page. Null when the envelope is wrong. */
export function parsePublicCollection(body: unknown): PublicCollectionData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as { collection?: unknown; recipes?: unknown };
  const collection = record.collection as { id?: unknown; name?: unknown } | undefined;
  if (
    !collection ||
    typeof collection !== 'object' ||
    typeof collection.id !== 'string' ||
    typeof collection.name !== 'string' ||
    !Array.isArray(record.recipes)
  ) {
    return null;
  }
  return {
    collection: { id: collection.id, name: collection.name },
    recipes: record.recipes.filter(isUsableRecipe),
  };
}

/** A recipe link's body. Null when the recipe is not usable. */
export function parsePublicRecipeLink(body: unknown): PublicRecipeLinkData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as { recipe?: unknown; sharedBy?: unknown };
  if (!isUsableRecipe(record.recipe)) {
    return null;
  }
  const data: PublicRecipeLinkData = { recipe: record.recipe };
  if (typeof record.sharedBy === 'string' && record.sharedBy.trim() !== '') {
    data.sharedBy = record.sharedBy.trim();
  }
  return data;
}

/** Either kind of link body; a body without `kind` is a collection. */
export function parsePublicLink(body: unknown): PublicLinkData | null {
  if (body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'recipe') {
    const recipe = parsePublicRecipeLink(body);
    return recipe === null ? null : { kind: 'recipe', ...recipe };
  }
  const collection = parsePublicCollection(body);
  return collection === null ? null : { kind: 'collection', ...collection };
}

export async function fetchPublicLink(token: string): Promise<PublicLinkResult> {
  let response: Response;
  try {
    response = await fetch(`/api/public/${encodeURIComponent(token)}`, {
      // A visitor read: the cookie, if any, is not needed and not sent.
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'error' };
  }
  if (response.status === 404) {
    return { kind: 'missing' };
  }
  if (!response.ok) {
    return { kind: 'error' };
  }
  try {
    const data = parsePublicLink(await response.json());
    return data === null ? { kind: 'error' } : { kind: 'ok', data };
  } catch {
    return { kind: 'error' };
  }
}

export function publicPhotoUrl(token: string, recipeId: string, photoId: string): string {
  return `/api/public/${encodeURIComponent(token)}/recipes/${encodeURIComponent(
    recipeId,
  )}/photos/${encodeURIComponent(photoId)}`;
}

export type PublicJoinResult =
  | { kind: 'ok'; collectionId: string; result: 'joined' | 'already' | 'own' }
  | { kind: 'signedOut' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** A signed-in member adds the collection to their library as a viewer. */
export async function joinPublicCollection(token: string): Promise<PublicJoinResult> {
  let response: Response;
  try {
    response = await fetch('/api/public/join', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: 'error', message: t('public.joinFailed') };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    return { kind: 'signedOut' };
  }
  if (response.status === 404) {
    return { kind: 'missing' };
  }
  if (response.status === 409) {
    // The grant cap. The server's `share-full` words are for the owner.
    return { kind: 'error', message: t('public.joinFull') };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { kind: 'error', message: serverErrorText(body, 'public.joinFailed') };
  }
  const record = (body ?? {}) as { collectionId?: unknown; result?: unknown };
  if (
    typeof record.collectionId !== 'string' ||
    (record.result !== 'joined' && record.result !== 'already' && record.result !== 'own')
  ) {
    return { kind: 'error', message: t('public.joinFailed') };
  }
  return { kind: 'ok', collectionId: record.collectionId, result: record.result };
}

export type PublicSaveResult =
  | { kind: 'ok'; recipeId: string; result: 'saved' | 'already' | 'own' }
  | { kind: 'signedOut' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** A signed-in member saves their own copy of a recipe link's recipe. */
export async function savePublicRecipe(token: string): Promise<PublicSaveResult> {
  let response: Response;
  try {
    response = await fetch('/api/public/save', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: 'error', message: t('public.saveFailed') };
  }
  if (response.status === 401 || response.status === 403) {
    invalidateSession();
    return { kind: 'signedOut' };
  }
  if (response.status === 404) {
    return { kind: 'missing' };
  }
  if (response.status === 429) {
    return { kind: 'error', message: t('public.saveRateLimited') };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { kind: 'error', message: serverErrorText(body, 'public.saveFailed') };
  }
  const record = (body ?? {}) as { recipeId?: unknown; result?: unknown };
  if (
    typeof record.recipeId !== 'string' ||
    (record.result !== 'saved' && record.result !== 'already' && record.result !== 'own')
  ) {
    return { kind: 'error', message: t('public.saveFailed') };
  }
  return { kind: 'ok', recipeId: record.recipeId, result: record.result };
}

/**
 * Sign-in from a public page comes back to `/p`, never `/p/<token>`: the
 * return path rides the OAuth start URL and cookie, and the token must stay
 * out of both. The token waits in this tab's sessionStorage instead.
 */
const RETURN_KEY = 'sous.publicReturn';

export const PUBLIC_RETURN_PATH = '/p';

export function rememberPublicReturn(token: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, token);
  } catch {
    // Storage can be blocked; sign-in then lands on the library instead.
  }
}

/** The token sign-in should come back to, if any. Read only: StrictMode may call this twice. */
export function readPublicReturn(): string | null {
  try {
    const token = sessionStorage.getItem(RETURN_KEY);
    return token !== null && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function clearPublicReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Nothing to clear.
  }
}
