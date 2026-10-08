import type { DocumentReference } from '@google-cloud/firestore';
import { isInviteId, randomToken } from './session.ts';
import { hashPublicToken, isPublicTokenShape, publicRecipeBody } from './publicLinks.ts';
import { savedFromName } from './recipeSavedFrom.ts';
import { recipeListsPhoto } from './shareAuth.ts';
import {
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  liveRecipeLinksQuery,
  recipeDocRef,
  recipeLinksColRef,
} from './store.ts';

/**
 * Recipe links (`docs/plans/recipe-links.md`): `{origin}/p/<token>` shows
 * one recipe to anyone, signed in or not, and an admitted member can save a
 * copy into their own library (`server/recipeLinkSave.ts`). Read only, no
 * AI. There is no grant: the recipe stays in the owner's tree, and a saved
 * copy is the saver's own.
 *
 * Firestore `recipeLinks/{sha256(token)}`, at most one live per recipe. The
 * token shares the public-collection URL space (`/p/<token>`,
 * `/api/public/<token>`), so the no-referrer pages, the log exclusion, and
 * the PWA denylist cover it unchanged; a token is looked up as a collection
 * link first, then as a recipe link. Like a public link, the token is stored
 * so the owner can copy it again.
 *
 * Every read rechecks the chain: live link → admitted owner → live recipe
 * (→ photo listed on it). Nothing is cached.
 */

export type RecipeLinkStatus = 'live' | 'revoked';

export type RecipeLinkRecord = {
  ownerSub: string;
  /** The owner's session email when the link was turned on. Never sent to a visitor. */
  ownerEmail: string;
  /** The owner's Google display name, refreshed each time the link is turned on or read by the owner. Shown to visitors. */
  ownerName?: string;
  recipeId: string;
  token: string;
  status: RecipeLinkStatus;
  createdAt: number;
  revokedAt?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parseRecipeLinkDoc(raw: unknown): RecipeLinkRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.ownerSub !== 'string' || raw.ownerSub === '') {
    return null;
  }
  if (typeof raw.ownerEmail !== 'string') {
    return null;
  }
  if (!isUuid(raw.recipeId)) {
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
  const record: RecipeLinkRecord = {
    ownerSub: raw.ownerSub,
    ownerEmail: raw.ownerEmail,
    recipeId: raw.recipeId,
    token: raw.token,
    status: raw.status,
    createdAt: raw.createdAt,
  };
  const ownerName = savedFromName(raw.ownerName);
  if (ownerName !== undefined) {
    record.ownerName = ownerName;
  }
  if (positiveFinite(raw.revokedAt)) {
    record.revokedAt = raw.revokedAt;
  }
  return record;
}

export function recipeLinkIsLive(link: RecipeLinkRecord | null): link is RecipeLinkRecord {
  return link !== null && link.status === 'live';
}

export function mintRecipeLinkRecord(
  input: { ownerSub: string; ownerEmail: string; ownerName?: string; recipeId: string },
  now: number,
): { id: string; record: RecipeLinkRecord } {
  const token = randomToken(32);
  const record: RecipeLinkRecord = {
    ownerSub: input.ownerSub,
    ownerEmail: input.ownerEmail,
    recipeId: input.recipeId,
    token,
    status: 'live',
    createdAt: now,
  };
  const ownerName = savedFromName(input.ownerName);
  if (ownerName !== undefined) {
    record.ownerName = ownerName;
  }
  return { id: hashPublicToken(token), record };
}

/** The newest live link among `rows`, or null. Two live rows only happen if a write raced; either works. */
export function newestLiveRecipeLink(
  rows: readonly (RecipeLinkRecord | null)[],
): RecipeLinkRecord | null {
  let newest: RecipeLinkRecord | null = null;
  for (const row of rows) {
    if (recipeLinkIsLive(row) && (newest === null || row.createdAt > newest.createdAt)) {
      newest = row;
    }
  }
  return newest;
}

export type RecipeLinkBody = {
  kind: 'recipe';
  recipe: Record<string, unknown>;
  /** The owner's display name. Missing when their profile has none; never their email. */
  sharedBy?: string;
};

export function recipeLinkBody(
  link: RecipeLinkRecord,
  recipe: Record<string, unknown>,
): RecipeLinkBody {
  const body: RecipeLinkBody = { kind: 'recipe', recipe: publicRecipeBody(recipe) };
  if (link.ownerName !== undefined) {
    body.sharedBy = link.ownerName;
  }
  return body;
}

export type RecipeLinkReadDependencies = {
  readRecipeLink: (id: string) => Promise<RecipeLinkRecord | null>;
  /** Throws when membership is unknown, like `sharingOwnerAdmitted`. */
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  readRecipe: (ownerSub: string, recipeId: string) => Promise<Record<string, unknown> | undefined>;
};

export type LiveRecipeLink = { link: RecipeLinkRecord; recipe: Record<string, unknown> };

/**
 * Live link, admitted owner, live recipe; null for every way that fails.
 * Throws on store errors.
 */
export async function resolveRecipeLink(
  token: string,
  deps: RecipeLinkReadDependencies,
): Promise<LiveRecipeLink | null> {
  if (!isPublicTokenShape(token)) {
    return null;
  }
  const link = await deps.readRecipeLink(hashPublicToken(token));
  if (!recipeLinkIsLive(link) || link.token !== token) {
    return null;
  }
  // Grants from an owner who is no longer admitted are inert; so is this.
  if (!(await deps.ownerAdmitted(link.ownerSub))) {
    return null;
  }
  const recipe = await deps.readRecipe(link.ownerSub, link.recipeId);
  if (recipe === undefined || !isLiveDoc(recipe) || recipe.id !== link.recipeId) {
    return null;
  }
  return { link, recipe };
}

/**
 * Whose photo a recipe link's photo request may stream, or null. The request
 * must name the link's own recipe, and the live recipe must list the photo.
 */
export async function resolveRecipeLinkPhoto(
  path: { token: string; recipeId: string; photoId: string },
  deps: RecipeLinkReadDependencies,
): Promise<{ ownerSub: string } | null> {
  const live = await resolveRecipeLink(path.token, deps);
  if (live === null || live.link.recipeId !== path.recipeId) {
    return null;
  }
  if (!recipeListsPhoto(live.recipe, path.photoId)) {
    return null;
  }
  return { ownerSub: live.link.ownerSub };
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

export async function readRecipeLink(id: string): Promise<RecipeLinkRecord | null> {
  if (!isInviteId(id)) {
    return null;
  }
  const snap = await recipeLinksColRef().doc(id).get();
  return snap.exists ? parseRecipeLinkDoc(snap.data()) : null;
}

export async function readOwnerRecipeLink(
  ownerSub: string,
  recipeId: string,
): Promise<RecipeLinkRecord | null> {
  const snap = await liveRecipeLinksQuery(ownerSub, recipeId).get();
  return newestLiveRecipeLink(snap.docs.map((doc) => parseRecipeLinkDoc(doc.data())));
}

export type EnsureRecipeLinkOutcome =
  | { kind: 'ok'; link: RecipeLinkRecord }
  | { kind: 'recipeMissing' };

/**
 * Turns the link on. Already on returns the live link, with the owner's
 * display name brought up to date (it is what visitors see).
 */
export async function ensureRecipeLink(
  input: { ownerSub: string; ownerEmail: string; ownerName?: string; recipeId: string },
  now: number,
): Promise<EnsureRecipeLinkOutcome> {
  const db = getStoreFirestore();
  const recipeRef = recipeDocRef(input.ownerSub, input.recipeId);
  const ownerName = savedFromName(input.ownerName);
  return db.runTransaction(async (tx) => {
    const recipeSnap = await tx.get(recipeRef);
    if (
      !isLiveDoc(recipeSnap.exists ? (recipeSnap.data() as Record<string, unknown>) : undefined)
    ) {
      return { kind: 'recipeMissing' } as const;
    }
    const liveSnap = await tx.get(liveRecipeLinksQuery(input.ownerSub, input.recipeId));
    let existing: { ref: DocumentReference; record: RecipeLinkRecord } | null = null;
    for (const doc of liveSnap.docs) {
      const record = parseRecipeLinkDoc(doc.data());
      if (
        recipeLinkIsLive(record) &&
        (existing === null || record.createdAt > existing.record.createdAt)
      ) {
        existing = { ref: doc.ref, record };
      }
    }
    if (existing !== null) {
      if (existing.record.ownerName === ownerName) {
        return { kind: 'ok', link: existing.record } as const;
      }
      const record: RecipeLinkRecord = { ...existing.record };
      delete record.ownerName;
      if (ownerName !== undefined) {
        record.ownerName = ownerName;
      }
      tx.set(existing.ref, record, { merge: false });
      return { kind: 'ok', link: record } as const;
    }
    const minted = mintRecipeLinkRecord({ ...input, ownerName }, now);
    tx.create(recipeLinksColRef().doc(minted.id), minted.record);
    return { kind: 'ok', link: minted.record } as const;
  });
}

/** Turns the link off. Already off is fine: there is nothing left to stop. */
export async function revokeRecipeLinks(
  ownerSub: string,
  recipeId: string,
  now: number,
): Promise<void> {
  await getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(liveRecipeLinksQuery(ownerSub, recipeId));
    for (const doc of snap.docs) {
      tx.set(doc.ref, { status: 'revoked', revokedAt: now }, { merge: true });
    }
  });
}
