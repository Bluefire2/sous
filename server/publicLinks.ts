import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { hashInviteToken, isInviteTokenShape } from './invites.ts';
import { isInviteId, randomToken } from './session.ts';
import { recipeListsPhoto } from './shareAuth.ts';
import {
  collectionDocRef,
  compactRecipeFields,
  getStoreFirestore,
  isLiveDoc,
  isUuid,
} from './store.ts';

/**
 * Public collection links (`docs/plans/public-collections.md`):
 * `{origin}/p/<token>` lets anyone, signed in or not, read one collection.
 * Read only, no AI, no account. Unlisted: the token is the only way in.
 *
 * Firestore `publicLinks/{sha256(token)}`, at most one live per collection.
 * Unlike collection links, the token is stored: a public link is meant to be
 * passed around, so the owner can copy it again. It lives until the owner
 * turns it off or deletes the collection; turning it on again mints a new one.
 *
 * Every read rechecks the whole chain: live link → admitted owner → live
 * collection → listed live recipe (→ photo listed on that recipe). Nothing
 * here is cached, so turning a link off takes effect on the next request.
 */

export type PublicLinkStatus = 'live' | 'revoked';

export type PublicLinkRecord = {
  ownerSub: string;
  /** The owner's session email when the link was turned on. Copied onto grants at join; never sent to a visitor. */
  ownerEmail: string;
  collectionId: string;
  token: string;
  status: PublicLinkStatus;
  createdAt: number;
  revokedAt?: number;
};

export type PublicApiPath =
  | { kind: 'collection'; token: string }
  | { kind: 'photo'; token: string; recipeId: string; photoId: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function hashPublicToken(token: string): string {
  return hashInviteToken(token);
}

export function isPublicTokenShape(raw: unknown): raw is string {
  return typeof raw === 'string' && isInviteTokenShape(raw);
}

/**
 * `/api/public/<token>` or `/api/public/<token>/recipes/<recipeId>/photos/<photoId>`.
 * Anything else is null. `/api/public/join` is an exact route, and `join` is
 * too short to be a token.
 */
export function publicApiPath(pathname: string): PublicApiPath | null {
  const prefix = '/api/public/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const parts = pathname.slice(prefix.length).split('/');
  const token = parts[0];
  if (!isPublicTokenShape(token)) {
    return null;
  }
  if (parts.length === 1) {
    return { kind: 'collection', token };
  }
  if (
    parts.length === 5 &&
    parts[1] === 'recipes' &&
    isUuid(parts[2]) &&
    parts[3] === 'photos' &&
    isUuid(parts[4])
  ) {
    return { kind: 'photo', token, recipeId: parts[2], photoId: parts[4] };
  }
  return null;
}

export function publicPageUrl(origin: string, token: string): string {
  return `${origin}/p/${token}`;
}

export function parsePublicLinkDoc(raw: unknown): PublicLinkRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.ownerSub !== 'string' || raw.ownerSub === '') {
    return null;
  }
  if (typeof raw.ownerEmail !== 'string') {
    return null;
  }
  if (!isUuid(raw.collectionId)) {
    return null;
  }
  if (!isPublicTokenShape(raw.token)) {
    return null;
  }
  if (raw.status !== 'live' && raw.status !== 'revoked') {
    return null;
  }
  if (!positiveFinite(raw.createdAt)) {
    return null;
  }
  const record: PublicLinkRecord = {
    ownerSub: raw.ownerSub,
    ownerEmail: raw.ownerEmail,
    collectionId: raw.collectionId,
    token: raw.token,
    status: raw.status,
    createdAt: raw.createdAt,
  };
  if (positiveFinite(raw.revokedAt)) {
    record.revokedAt = raw.revokedAt;
  }
  return record;
}

export function publicLinkIsLive(link: PublicLinkRecord | null): link is PublicLinkRecord {
  return link !== null && link.status === 'live';
}

export function mintPublicLinkRecord(
  input: { ownerSub: string; ownerEmail: string; collectionId: string },
  now: number,
): { id: string; record: PublicLinkRecord } {
  const token = randomToken(32);
  return {
    id: hashPublicToken(token),
    record: {
      ownerSub: input.ownerSub,
      ownerEmail: input.ownerEmail,
      collectionId: input.collectionId,
      token,
      status: 'live',
      createdAt: now,
    },
  };
}

export function revokedPublicLink(link: PublicLinkRecord, now: number): PublicLinkRecord {
  return { ...link, status: 'revoked', revokedAt: now };
}

/** The newest live link among `rows`, or null. Two live rows only happen if a write raced; either works. */
export function newestLivePublicLink(
  rows: readonly (PublicLinkRecord | null)[],
): PublicLinkRecord | null {
  let newest: PublicLinkRecord | null = null;
  for (const row of rows) {
    if (publicLinkIsLive(row) && (newest === null || row.createdAt > newest.createdAt)) {
      newest = row;
    }
  }
  return newest;
}

/**
 * What a visitor gets for one recipe: the stored recipe fields, without the
 * import check (the owner's import diagnostics, not recipe content) or
 * `variantOf`: a visitor has no library to group variants in, so the id
 * would only name a recipe they cannot see. Shared pull keeps it, because a
 * member's variants group with the owner's. `savedFrom` names whoever shared
 * the recipe with the owner; that is the owner's to know, not the visitor's.
 */
export function publicRecipeBody(recipe: Record<string, unknown>): Record<string, unknown> {
  const body = compactRecipeFields(recipe);
  delete body.importCheck;
  delete body.variantOf;
  delete body.savedFrom;
  return body;
}

export type PublicCollectionBody = {
  collection: { id: string; name: string };
  recipes: Record<string, unknown>[];
};

/**
 * The visitor's snapshot, in the collection's order. Recipes that are
 * missing or deleted are left out; the collection id is the owner's, which
 * the join flow needs to open the collection afterwards.
 */
export function publicCollectionBody(
  collection: Record<string, unknown>,
  recipes: readonly (Record<string, unknown> | undefined)[],
): PublicCollectionBody {
  const out: Record<string, unknown>[] = [];
  for (const recipe of recipes) {
    if (recipe !== undefined && isLiveDoc(recipe)) {
      out.push(publicRecipeBody(recipe));
    }
  }
  return {
    collection: {
      id: String(collection.id),
      name: typeof collection.name === 'string' ? collection.name.trim() : '',
    },
    recipes: out,
  };
}

function listedRecipeIds(collection: Record<string, unknown>): string[] {
  if (!Array.isArray(collection.recipeIds)) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of collection.recipeIds) {
    if (isUuid(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export type PublicReadDependencies = {
  readLink: (id: string) => Promise<PublicLinkRecord | null>;
  /** Throws when membership is unknown, like `sharingOwnerAdmitted`. */
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  readCollection: (
    ownerSub: string,
    collectionId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  readRecipes: (
    ownerSub: string,
    ids: readonly string[],
  ) => Promise<Array<Record<string, unknown> | undefined>>;
};

type LiveChain = { link: PublicLinkRecord; collection: Record<string, unknown> };

/** Live link, admitted owner, live collection; null for every way that fails. */
async function resolveLiveChain(
  token: string,
  deps: Pick<PublicReadDependencies, 'readLink' | 'ownerAdmitted' | 'readCollection'>,
): Promise<LiveChain | null> {
  if (!isPublicTokenShape(token)) {
    return null;
  }
  const link = await deps.readLink(hashPublicToken(token));
  if (!publicLinkIsLive(link) || link.token !== token) {
    return null;
  }
  // Grants from an owner who is no longer admitted are inert; so is this.
  if (!(await deps.ownerAdmitted(link.ownerSub))) {
    return null;
  }
  const collection = await deps.readCollection(link.ownerSub, link.collectionId);
  if (collection === undefined || !isLiveDoc(collection) || collection.id !== link.collectionId) {
    return null;
  }
  return { link, collection };
}

/** The snapshot for `GET /api/public/<token>`, or null (one generic 404). Throws on store errors. */
export async function readPublicCollection(
  token: string,
  deps: PublicReadDependencies,
): Promise<{ link: PublicLinkRecord; body: PublicCollectionBody } | null> {
  const chain = await resolveLiveChain(token, deps);
  if (chain === null) {
    return null;
  }
  const ids = listedRecipeIds(chain.collection);
  const recipes = ids.length === 0 ? [] : await deps.readRecipes(chain.link.ownerSub, ids);
  return { link: chain.link, body: publicCollectionBody(chain.collection, recipes) };
}

/**
 * Whose photo a public photo request may stream, or null. The recipe must be
 * listed in the live collection, live itself, and list the photo. Throws on
 * store errors.
 */
export async function resolvePublicPhoto(
  path: { token: string; recipeId: string; photoId: string },
  deps: PublicReadDependencies,
): Promise<{ ownerSub: string } | null> {
  const chain = await resolveLiveChain(path.token, deps);
  if (chain === null) {
    return null;
  }
  if (!listedRecipeIds(chain.collection).includes(path.recipeId)) {
    return null;
  }
  const [recipe] = await deps.readRecipes(chain.link.ownerSub, [path.recipeId]);
  if (recipe === undefined || !isLiveDoc(recipe) || !recipeListsPhoto(recipe, path.photoId)) {
    return null;
  }
  return { ownerSub: chain.link.ownerSub };
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

export function publicLinksCol() {
  return getStoreFirestore().collection('publicLinks');
}

function livePublicLinksQuery(ownerSub: string, collectionId: string) {
  // Equality filters only, so Firestore serves this from single-field indexes.
  return publicLinksCol()
    .where('ownerSub', '==', ownerSub)
    .where('collectionId', '==', collectionId)
    .where('status', '==', 'live');
}

export async function readPublicLink(id: string): Promise<PublicLinkRecord | null> {
  if (!isInviteId(id)) {
    return null;
  }
  const snap = await publicLinksCol().doc(id).get();
  return snap.exists ? parsePublicLinkDoc(snap.data()) : null;
}

export async function readOwnerPublicLink(
  ownerSub: string,
  collectionId: string,
): Promise<PublicLinkRecord | null> {
  const snap = await livePublicLinksQuery(ownerSub, collectionId).get();
  return newestLivePublicLink(snap.docs.map((doc) => parsePublicLinkDoc(doc.data())));
}

export type EnsurePublicLinkOutcome =
  | { kind: 'ok'; link: PublicLinkRecord }
  | { kind: 'collectionMissing' };

/** Turns the link on. Already on returns the live link unchanged. */
export async function ensurePublicLink(
  input: { ownerSub: string; ownerEmail: string; collectionId: string },
  now: number,
): Promise<EnsurePublicLinkOutcome> {
  const db = getStoreFirestore();
  const collectionRef = collectionDocRef(input.ownerSub, input.collectionId);
  return db.runTransaction(async (tx) => {
    const collectionSnap = await tx.get(collectionRef);
    if (
      !isLiveDoc(
        collectionSnap.exists ? (collectionSnap.data() as Record<string, unknown>) : undefined,
      )
    ) {
      return { kind: 'collectionMissing' } as const;
    }
    const liveSnap = await tx.get(livePublicLinksQuery(input.ownerSub, input.collectionId));
    const existing = newestLivePublicLink(
      liveSnap.docs.map((doc) => parsePublicLinkDoc(doc.data())),
    );
    if (existing !== null) {
      return { kind: 'ok', link: existing } as const;
    }
    const minted = mintPublicLinkRecord(input, now);
    tx.create(publicLinksCol().doc(minted.id), minted.record);
    return { kind: 'ok', link: minted.record } as const;
  });
}

type LivePublicLinkRow = { ref: DocumentReference; record: PublicLinkRecord };

/**
 * Whether the collection has a live public link, read inside `tx`. Fails
 * closed: any row the query matches counts, even one `parsePublicLinkDoc`
 * cannot read.
 */
export async function hasLivePublicLinkInTransaction(
  tx: Transaction,
  ownerSub: string,
  collectionId: string,
): Promise<boolean> {
  return !(await tx.get(livePublicLinksQuery(ownerSub, collectionId))).empty;
}

/** Ids of the owner's collections with a live public link. Fails closed like the check above. */
export async function listLivePublicCollectionIds(ownerSub: string): Promise<Set<string>> {
  const snap = await publicLinksCol()
    .where('ownerSub', '==', ownerSub)
    .where('status', '==', 'live')
    .get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const collectionId = doc.get('collectionId');
    if (typeof collectionId === 'string') ids.add(collectionId);
  }
  return ids;
}

/** Transaction read half of turning a collection's links off. */
export async function readLivePublicLinksInTransaction(
  tx: Transaction,
  ownerSub: string,
  collectionId: string,
): Promise<LivePublicLinkRow[]> {
  const snap = await tx.get(livePublicLinksQuery(ownerSub, collectionId));
  const rows: LivePublicLinkRow[] = [];
  for (const doc of snap.docs) {
    const record = parsePublicLinkDoc(doc.data());
    if (publicLinkIsLive(record)) {
      rows.push({ ref: doc.ref, record });
    }
  }
  return rows;
}

/** Transaction write half: every row read above becomes revoked. */
export function writeRevokedPublicLinks(
  tx: Transaction,
  rows: readonly LivePublicLinkRow[],
  now: number,
): void {
  for (const row of rows) {
    tx.set(row.ref, revokedPublicLink(row.record, now), { merge: false });
  }
}

/** Turns the link off. Already off is fine: there is nothing left to stop. */
export async function revokePublicLinks(
  ownerSub: string,
  collectionId: string,
  now: number,
): Promise<void> {
  await getStoreFirestore().runTransaction(async (tx) => {
    const rows = await readLivePublicLinksInTransaction(tx, ownerSub, collectionId);
    writeRevokedPublicLinks(tx, rows, now);
  });
}
