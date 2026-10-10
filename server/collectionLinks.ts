import type { Transaction } from '@google-cloud/firestore';
import {
  collectionLiveForGrant,
  firestoreGrantAddTransaction,
  orchestrateGrantAdd,
  type GrantAddOutcome,
  type GrantAddTransaction,
} from './grants.ts';
import { INVITE_TTL_MS, hashInviteToken, isInviteTokenShape } from './invites.ts';
import { randomToken, isInviteId } from './session.ts';
import { parseShareRole, type ShareRole } from './shareAuth.ts';
import { collectionDocRef, getStoreFirestore, isUuid } from './store.ts';

/**
 * Shareable collection links: `{origin}/c/<token>` attaches an already
 * admitted member to one collection with the role chosen at mint. Not an app
 * invite (`invites.ts`); a link never creates a member.
 *
 * Firestore `collectionLinks/{sha256(token)}`. The raw token is returned once
 * at mint and never stored. Multi-use until revoked or `expiresAt`.
 */
export const COLLECTION_LINK_TTL_MS = INVITE_TTL_MS;
export const MAX_LIVE_COLLECTION_LINKS = 20;

export type CollectionLinkStatus = 'live' | 'revoked';

export type CollectionLinkRecord = {
  ownerSub: string;
  /** The owner's session email at mint; display only, copied onto grants as `ownerEmail`. */
  ownerEmail: string;
  collectionId: string;
  role: ShareRole;
  status: CollectionLinkStatus;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};

export type CollectionLinkEntry = {
  id: string;
  role: ShareRole;
  createdAt: number;
  expiresAt: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function hashCollectionLinkToken(token: string): string {
  return hashInviteToken(token);
}

export function isCollectionLinkId(raw: unknown): raw is string {
  return typeof raw === 'string' && isInviteId(raw);
}

/** `/c/<token>` only; `/c/join` and anything else is not a token path. */
export function collectionLinkTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/c/')) {
    return null;
  }
  const rest = pathname.slice('/c/'.length);
  if (rest === '' || rest.includes('/')) {
    return null;
  }
  return isInviteTokenShape(rest) ? rest : null;
}

export function parseCollectionLinkDoc(raw: unknown): CollectionLinkRecord | null {
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
  if (raw.role !== 'viewer' && raw.role !== 'editor') {
    return null;
  }
  if (raw.status !== 'live' && raw.status !== 'revoked') {
    return null;
  }
  if (!positiveFinite(raw.createdAt) || !positiveFinite(raw.expiresAt)) {
    return null;
  }
  const record: CollectionLinkRecord = {
    ownerSub: raw.ownerSub,
    ownerEmail: raw.ownerEmail,
    collectionId: raw.collectionId,
    role: parseShareRole(raw.role),
    status: raw.status,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };
  if (positiveFinite(raw.revokedAt)) {
    record.revokedAt = raw.revokedAt;
  }
  return record;
}

export function collectionLinkIsLive(
  link: CollectionLinkRecord | null,
  now: number,
): link is CollectionLinkRecord {
  return link !== null && link.status === 'live' && link.expiresAt > now;
}

export function mintCollectionLinkRecord(
  input: { ownerSub: string; ownerEmail: string; collectionId: string; role: ShareRole },
  now: number,
): { token: string; id: string; record: CollectionLinkRecord } {
  const token = randomToken(32);
  return {
    token,
    id: hashCollectionLinkToken(token),
    record: {
      ownerSub: input.ownerSub,
      ownerEmail: input.ownerEmail,
      collectionId: input.collectionId,
      role: input.role,
      status: 'live',
      createdAt: now,
      expiresAt: now + COLLECTION_LINK_TTL_MS,
    },
  };
}

export function collectionLinkEntries(
  rows: { id: string; record: CollectionLinkRecord }[],
  now: number,
): CollectionLinkEntry[] {
  return rows
    .filter((row) => collectionLinkIsLive(row.record, now))
    .map((row) => ({
      id: row.id,
      role: row.record.role,
      createdAt: row.record.createdAt,
      expiresAt: row.record.expiresAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** A link from another owner or collection reads as missing, never as forbidden. */
export function revokeCollectionLinkTransition(input: {
  existing: CollectionLinkRecord | null;
  ownerSub: string;
  collectionId: string;
  now: number;
}): { kind: 'missing' } | { kind: 'write'; record: CollectionLinkRecord } {
  const link = input.existing;
  if (
    link === null ||
    link.ownerSub !== input.ownerSub ||
    link.collectionId !== input.collectionId ||
    link.status !== 'live'
  ) {
    return { kind: 'missing' };
  }
  return { kind: 'write', record: { ...link, status: 'revoked', revokedAt: input.now } };
}

export type CollectionLinkRedeemOutcome =
  /** Unknown, revoked, expired, or the collection is gone. Callers must not tell these apart. */
  | { kind: 'dead' }
  /** The collection owner opened their own link: nothing is written. */
  | { kind: 'self' }
  | { kind: 'cap' }
  | { kind: 'idempotent' }
  | { kind: 'write' };

export type CollectionLinkRedeemTransaction = {
  readLink: () => Promise<CollectionLinkRecord | null>;
  /** Grant reads and writes for the link's collection, inside the same transaction. */
  grantsFor: (ownerSub: string, collectionId: string) => GrantAddTransaction;
};

export type CollectionLinkRedeemDependencies = {
  now: () => number;
  runTransaction: (
    work: (tx: CollectionLinkRedeemTransaction) => Promise<CollectionLinkRedeemOutcome>,
  ) => Promise<CollectionLinkRedeemOutcome>;
};

/**
 * Writes the same forward grant + `incomingShares` pair as add-by-email, via
 * `orchestrateGrantAdd`, with the link's role. The caller has already decided
 * the redeemer is an admitted member or owner; this never checks membership.
 * An already-live grant keeps its role (the owner changes roles explicitly).
 * The link is not consumed.
 */
export async function orchestrateCollectionLinkRedeem(
  redeemer: { sub: string; email: string },
  deps: CollectionLinkRedeemDependencies,
): Promise<CollectionLinkRedeemOutcome> {
  return deps.runTransaction(async (tx) => {
    const link = await tx.readLink();
    const now = deps.now();
    if (!collectionLinkIsLive(link, now)) {
      return { kind: 'dead' };
    }
    if (link.ownerSub === redeemer.sub) {
      return { kind: 'self' };
    }
    const grantTx = tx.grantsFor(link.ownerSub, link.collectionId);
    const outcome: GrantAddOutcome = await orchestrateGrantAdd(
      {
        ownerSub: link.ownerSub,
        ownerEmail: link.ownerEmail,
        collectionId: link.collectionId,
        viewerSub: redeemer.sub,
        email: redeemer.email.trim().toLowerCase(),
        role: link.role,
        // A link never changes an existing grant: an editor link does not
        // upgrade a viewer, a viewer link does not downgrade an editor. Unlike
        // add-by-email, which applies the owner's chosen role.
        onExisting: 'keepRole',
      },
      { now: () => now, runTransaction: (work) => work(grantTx) },
    );
    switch (outcome.kind) {
      case 'collectionMissing':
        return { kind: 'dead' };
      case 'cap':
        return { kind: 'cap' };
      case 'idempotent':
        return { kind: 'idempotent' };
      case 'write':
        return { kind: 'write' };
      default: {
        const unreachable: never = outcome;
        throw new Error(`unexpected grant outcome ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

function linksCol() {
  return getStoreFirestore().collection('collectionLinks');
}

export async function readCollectionLink(id: string): Promise<CollectionLinkRecord | null> {
  if (!isCollectionLinkId(id)) {
    return null;
  }
  const snap = await linksCol().doc(id).get();
  return snap.exists ? parseCollectionLinkDoc(snap.data()) : null;
}

function liveLinksQuery(ownerSub: string, collectionId: string) {
  // Equality filters only, so Firestore serves this from single-field indexes.
  return linksCol()
    .where('ownerSub', '==', ownerSub)
    .where('collectionId', '==', collectionId)
    .where('status', '==', 'live');
}

/**
 * Whether the collection has an open join link, read inside `tx`. A live row
 * that cannot be parsed counts as open: this tells a model someone may still
 * join, so it errs toward saying so.
 */
export async function hasOpenCollectionLinkInTransaction(
  tx: Transaction,
  ownerSub: string,
  collectionId: string,
  now: number,
): Promise<boolean> {
  const snap = await tx.get(liveLinksQuery(ownerSub, collectionId));
  return snap.docs.some((doc) => {
    const record = parseCollectionLinkDoc(doc.data());
    return record === null || collectionLinkIsLive(record, now);
  });
}

/** Ids of the owner's collections with an open join link, counted like the check above. */
export async function listOpenCollectionLinkIds(ownerSub: string, now: number): Promise<Set<string>> {
  // Equality filters only, so Firestore serves this from single-field indexes.
  const snap = await linksCol().where('ownerSub', '==', ownerSub).where('status', '==', 'live').get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const record = parseCollectionLinkDoc(doc.data());
    const collectionId = doc.get('collectionId');
    if (typeof collectionId === 'string' && (record === null || collectionLinkIsLive(record, now))) {
      ids.add(collectionId);
    }
  }
  return ids;
}

export async function listCollectionLinks(
  ownerSub: string,
  collectionId: string,
  now: number,
): Promise<CollectionLinkEntry[]> {
  const snap = await liveLinksQuery(ownerSub, collectionId).get();
  const rows: { id: string; record: CollectionLinkRecord }[] = [];
  for (const doc of snap.docs) {
    const record = parseCollectionLinkDoc(doc.data());
    if (record !== null && isCollectionLinkId(doc.id)) {
      rows.push({ id: doc.id, record });
    }
  }
  return collectionLinkEntries(rows, now);
}

export type MintCollectionLinkOutcome =
  | { kind: 'ok'; token: string; id: string }
  | { kind: 'cap' }
  | { kind: 'collectionMissing' };

export async function mintCollectionLink(
  input: { ownerSub: string; ownerEmail: string; collectionId: string; role: ShareRole },
  now: number,
): Promise<MintCollectionLinkOutcome> {
  const db = getStoreFirestore();
  const collectionRef = collectionDocRef(input.ownerSub, input.collectionId);
  return db.runTransaction(async (tx) => {
    const collectionSnap = await tx.get(collectionRef);
    if (
      !collectionLiveForGrant(
        collectionSnap.exists ? (collectionSnap.data() as Record<string, unknown>) : undefined,
      )
    ) {
      return { kind: 'collectionMissing' } as const;
    }
    const liveSnap = await tx.get(liveLinksQuery(input.ownerSub, input.collectionId));
    let live = 0;
    for (const doc of liveSnap.docs) {
      if (collectionLinkIsLive(parseCollectionLinkDoc(doc.data()), now)) {
        live += 1;
      }
    }
    if (live >= MAX_LIVE_COLLECTION_LINKS) {
      return { kind: 'cap' } as const;
    }
    const minted = mintCollectionLinkRecord(input, now);
    tx.create(linksCol().doc(minted.id), minted.record);
    return { kind: 'ok', token: minted.token, id: minted.id } as const;
  });
}

export async function revokeCollectionLink(
  ownerSub: string,
  collectionId: string,
  id: string,
  now: number,
): Promise<'ok' | 'missing'> {
  if (!isCollectionLinkId(id)) {
    return 'missing';
  }
  const ref = linksCol().doc(id);
  return getStoreFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = revokeCollectionLinkTransition({
      existing: snap.exists ? parseCollectionLinkDoc(snap.data()) : null,
      ownerSub,
      collectionId,
      now,
    });
    if (next.kind === 'missing') {
      return 'missing';
    }
    tx.set(ref, next.record, { merge: false });
    return 'ok';
  });
}

export async function redeemCollectionLink(
  id: string,
  redeemer: { sub: string; email: string },
): Promise<CollectionLinkRedeemOutcome> {
  if (!isCollectionLinkId(id)) {
    return { kind: 'dead' };
  }
  const db = getStoreFirestore();
  const linkRef = linksCol().doc(id);
  return orchestrateCollectionLinkRedeem(redeemer, {
    now: () => Date.now(),
    runTransaction: (work) =>
      db.runTransaction(async (tx) =>
        work({
          readLink: async () => {
            const snap = await tx.get(linkRef);
            return snap.exists ? parseCollectionLinkDoc(snap.data()) : null;
          },
          grantsFor: (ownerSub, collectionId) =>
            firestoreGrantAddTransaction(tx, ownerSub, collectionId),
        }),
      ),
  });
}
