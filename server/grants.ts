import { FieldPath, type Transaction } from '@google-cloud/firestore';
import { isAllowed } from './allowlist.ts';
import { allowedEmails } from './env.ts';
import { readMember } from './members.ts';
import { accessAllows } from './membership.ts';
import {
  readLivePublicLinksInTransaction,
  writeRevokedPublicLinks,
} from './publicLinks.ts';
import {
  canViewCollection,
  canViewRecipe,
  parseShareRole,
  recipeListsPhoto,
  type ShareRole,
} from './shareAuth.ts';
import {
  collectionDeletePayload,
  collectionDocRef,
  compareMutation,
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  readStoredMutationState,
  type MutationResult,
  type StoreKind,
} from './store.ts';

export const MAX_LIVE_GRANTS = 20;
export const NO_ACCOUNT_MESSAGE = 'No Sous account with that email';

export type LiveGrant = {
  viewerSub: string;
  email: string;
  collectionId: string;
  /** Missing on grants written before roles; `parseGrantDoc` reads that as viewer. */
  role: ShareRole;
  createdAt: number;
  updatedAt: number;
  active: true;
};

export type GrantTombstone = {
  viewerSub: string;
  updatedAt: number;
  deletedAt: number;
  active: false;
};

export type IncomingShareDoc = {
  ownerSub: string;
  collectionId: string;
  ownerEmail?: string;
  /** Copied from the forward grant so the viewer pull needs no second read. */
  role?: ShareRole;
  updatedAt: number;
  deletedAt?: number;
};

export type LiveIncomingShare = {
  grantId: string;
  ownerSub: string;
  collectionId: string;
  /** The sharer's email when the grant was made; display only, never authorization. */
  ownerEmail?: string;
  /** Missing reads as viewer (`parseShareRole`). */
  role?: ShareRole;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeShareEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const email = raw.trim().toLowerCase();
  if (email === '' || !email.includes('@') || email.length > 320) {
    return undefined;
  }
  return email;
}

export function isSafeFirestoreDocumentId(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw !== '' &&
    raw.trim() === raw &&
    !raw.includes('/') &&
    raw !== '.' &&
    raw !== '..' &&
    !/^__[\s\S]*__$/.test(raw) &&
    new TextEncoder().encode(raw).byteLength <= 1_500
  );
}

export function shareGrantId(ownerSub: string, collectionId: string): string {
  return `${ownerSub}_${collectionId}`;
}

export function parseGrantDoc(
  raw: unknown,
  expectedViewerSub: string,
): LiveGrant | GrantTombstone | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.viewerSub !== 'string' || raw.viewerSub !== expectedViewerSub) {
    return null;
  }
  const updatedAt = finiteNumber(raw.updatedAt);
  if (updatedAt === undefined) {
    return null;
  }
  const deletedAt = finiteNumber(raw.deletedAt);
  if (deletedAt !== undefined) {
    return { viewerSub: raw.viewerSub, updatedAt, deletedAt, active: false };
  }
  if (typeof raw.email !== 'string' || raw.email === '') {
    return null;
  }
  if (typeof raw.collectionId !== 'string' || !isUuid(raw.collectionId)) {
    return null;
  }
  const createdAt = finiteNumber(raw.createdAt);
  if (createdAt === undefined) {
    return null;
  }
  return {
    viewerSub: raw.viewerSub,
    email: raw.email,
    collectionId: raw.collectionId,
    role: parseShareRole(raw.role),
    createdAt,
    updatedAt,
    active: true,
  };
}

export function isLiveGrant(
  grant: LiveGrant | GrantTombstone | null,
): grant is LiveGrant {
  return grant !== null && !('deletedAt' in grant);
}

export function addGrantTransition(input: {
  existing: LiveGrant | GrantTombstone | null;
  viewerSub: string;
  email: string;
  collectionId: string;
  role: ShareRole;
  now: number;
  liveCount: number;
}):
  | { kind: 'write'; doc: LiveGrant }
  | { kind: 'idempotent'; doc: LiveGrant }
  | { kind: 'cap' } {
  if (isLiveGrant(input.existing)) {
    return { kind: 'idempotent', doc: input.existing };
  }
  if (input.liveCount >= MAX_LIVE_GRANTS) {
    return { kind: 'cap' };
  }
  return {
    kind: 'write',
    doc: {
      viewerSub: input.viewerSub,
      email: input.email,
      collectionId: input.collectionId,
      role: input.role,
      createdAt: input.now,
      updatedAt: input.now,
      active: true,
    },
  };
}

export function revokeGrantTransition(input: {
  existing: LiveGrant | GrantTombstone | null;
  viewerSub: string;
  now: number;
}):
  | { kind: 'missing' }
  | { kind: 'write'; doc: GrantTombstone }
  | { kind: 'already'; doc: GrantTombstone } {
  if (input.existing === null) {
    return { kind: 'missing' };
  }
  if (input.existing !== null && 'deletedAt' in input.existing) {
    return { kind: 'already', doc: input.existing };
  }
  return {
    kind: 'write',
    doc: {
      viewerSub: input.viewerSub,
      updatedAt: input.now,
      deletedAt: input.now,
      active: false,
    },
  };
}

export type RevokeGrantTransition = ReturnType<typeof revokeGrantTransition>;
export type RevokeGrantOutcome =
  | { kind: 'badRequest' }
  | RevokeGrantTransition;

export type RevokeGrantTransaction = {
  readForwardGrant: (
    viewerSub: string,
  ) => Promise<LiveGrant | GrantTombstone | null>;
  writePair: (
    viewerSub: string,
    tombstone: GrantTombstone,
  ) => Promise<void>;
};

export type RevokeGrantDependencies = {
  runTransaction: (
    work: (tx: RevokeGrantTransaction) => Promise<RevokeGrantTransition>,
  ) => Promise<RevokeGrantTransition>;
};

export async function orchestrateGrantRevoke(
  viewerSub: unknown,
  now: number,
  dependencies: RevokeGrantDependencies,
): Promise<RevokeGrantOutcome> {
  if (!isSafeFirestoreDocumentId(viewerSub)) {
    return { kind: 'badRequest' };
  }
  return dependencies.runTransaction(async (tx) => {
    const existing = await tx.readForwardGrant(viewerSub);
    const next = revokeGrantTransition({ existing, viewerSub, now });
    if (next.kind === 'write') {
      await tx.writePair(viewerSub, next.doc);
    }
    return next;
  });
}

/**
 * Only a live grant changes role. A missing or revoked grant is `missing`
 * (404); re-adding the person is how a revoked grant comes back. The same
 * role is a no-op so a double tap does not move the pull scope digest.
 */
export function changeGrantRoleTransition(input: {
  existing: LiveGrant | GrantTombstone | null;
  role: ShareRole;
  now: number;
}):
  | { kind: 'missing' }
  | { kind: 'unchanged'; doc: LiveGrant }
  | { kind: 'write'; doc: LiveGrant } {
  if (!isLiveGrant(input.existing)) {
    return { kind: 'missing' };
  }
  if (input.existing.role === input.role) {
    return { kind: 'unchanged', doc: input.existing };
  }
  return {
    kind: 'write',
    doc: {
      ...input.existing,
      role: input.role,
      updatedAt: Math.max(input.now, input.existing.updatedAt),
    },
  };
}

export type GrantRoleTransition = ReturnType<typeof changeGrantRoleTransition>;
export type GrantRoleOutcome = { kind: 'badRequest' } | GrantRoleTransition;

export type GrantRoleTransaction = {
  readForwardGrant: (
    viewerSub: string,
  ) => Promise<LiveGrant | GrantTombstone | null>;
  readReverseShare: (viewerSub: string) => Promise<IncomingShareDoc | undefined>;
  writePair: (grant: LiveGrant, share: IncomingShareDoc) => Promise<void>;
};

export type GrantRoleDependencies = {
  runTransaction: (
    work: (tx: GrantRoleTransaction) => Promise<GrantRoleTransition>,
  ) => Promise<GrantRoleTransition>;
};

/** Forward grant and reverse share change together, like add and revoke. */
export async function orchestrateGrantRoleChange(
  input: { ownerSub: string; collectionId: string; viewerSub: unknown; role: ShareRole },
  now: number,
  dependencies: GrantRoleDependencies,
): Promise<GrantRoleOutcome> {
  const viewerSub = input.viewerSub;
  if (!isSafeFirestoreDocumentId(viewerSub)) {
    return { kind: 'badRequest' };
  }
  return dependencies.runTransaction(async (tx) => {
    const existing = await tx.readForwardGrant(viewerSub);
    const next = changeGrantRoleTransition({ existing, role: input.role, now });
    if (next.kind !== 'write') {
      return next;
    }
    const share = await tx.readReverseShare(viewerSub);
    await tx.writePair(
      next.doc,
      incomingSharePayload(input.ownerSub, input.collectionId, next.doc.updatedAt, {
        ownerEmail: share?.ownerEmail,
        role: next.doc.role,
      }),
    );
    return next;
  });
}

export function collectionLiveForGrant(
  txRead: Record<string, unknown> | undefined,
): boolean {
  return isLiveDoc(txRead);
}

export function canonicalCollectionTombstoneAt(
  collection: Record<string, unknown> | undefined,
): number | undefined {
  if (collection === undefined) {
    return undefined;
  }
  const updatedAt = finiteNumber(collection.updatedAt);
  const deletedAt = finiteNumber(collection.deletedAt);
  return updatedAt !== undefined && updatedAt === deletedAt
    ? updatedAt
    : undefined;
}

export function collectionIsCanonicalTombstoneAt(
  collection: Record<string, unknown> | undefined,
  cascadeAt: number,
): boolean {
  return canonicalCollectionTombstoneAt(collection) === cascadeAt;
}

/** Server order for a delete cascade. Never the client delete clock. */
export function serverGrantCascadeOrder(
  now: number,
  pairUpdatedAts: readonly number[],
): number {
  let latest = Number.isFinite(now) ? now : 0;
  for (const at of pairUpdatedAts) {
    if (Number.isFinite(at) && at > latest) {
      latest = at;
    }
  }
  return latest + 1;
}

export function incomingShareCascadeDoc(
  _existing: IncomingShareDoc | undefined,
  ownerSub: string,
  collectionId: string,
  cascadeAt: number,
): IncomingShareDoc {
  return incomingSharePayload(ownerSub, collectionId, cascadeAt, { deletedAt: cascadeAt });
}

export function grantCascadeRevoke(
  _existing: LiveGrant | GrantTombstone | null,
  viewerSub: string,
  cascadeAt: number,
): GrantTombstone {
  return {
    viewerSub,
    updatedAt: cascadeAt,
    deletedAt: cascadeAt,
    active: false,
  };
}

export function parseIncomingShareDoc(raw: unknown): IncomingShareDoc | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  if (typeof raw.ownerSub !== 'string' || raw.ownerSub === '') {
    return undefined;
  }
  if (typeof raw.collectionId !== 'string' || !isUuid(raw.collectionId)) {
    return undefined;
  }
  const updatedAt = finiteNumber(raw.updatedAt);
  if (updatedAt === undefined) {
    return undefined;
  }
  const share: IncomingShareDoc = {
    ownerSub: raw.ownerSub,
    collectionId: raw.collectionId,
    updatedAt,
  };
  if (typeof raw.ownerEmail === 'string' && raw.ownerEmail !== '') {
    share.ownerEmail = raw.ownerEmail;
  }
  if (raw.role === 'viewer' || raw.role === 'editor') {
    share.role = raw.role;
  }
  const deletedAt = finiteNumber(raw.deletedAt);
  if (deletedAt !== undefined) {
    share.deletedAt = deletedAt;
  }
  return share;
}

/** Both sides tombstone together. A newer pair timestamp does not skip the pair. */
export function cascadeGrantPairTransition(input: {
  existingGrant: LiveGrant | GrantTombstone | null;
  existingShare: IncomingShareDoc | undefined;
  viewerSub: string;
  ownerSub: string;
  collectionId: string;
  cascadeAt: number;
}): { grant: GrantTombstone; share: IncomingShareDoc } {
  return {
    grant: grantCascadeRevoke(
      input.existingGrant,
      input.viewerSub,
      input.cascadeAt,
    ),
    share: incomingShareCascadeDoc(
      input.existingShare,
      input.ownerSub,
      input.collectionId,
      input.cascadeAt,
    ),
  };
}

export function incomingSharePayload(
  ownerSub: string,
  collectionId: string,
  updatedAt: number,
  extra?: { ownerEmail?: string; role?: ShareRole; deletedAt?: number },
): IncomingShareDoc {
  const share: IncomingShareDoc = { ownerSub, collectionId, updatedAt };
  if (extra?.ownerEmail) {
    share.ownerEmail = extra.ownerEmail;
  }
  if (extra?.role !== undefined && extra.deletedAt === undefined) {
    share.role = extra.role;
  }
  if (extra?.deletedAt !== undefined) {
    share.deletedAt = extra.deletedAt;
  }
  return share;
}

export type ShareTarget =
  | { kind: 'ok'; sub: string; email: string }
  | { kind: 'self' }
  | { kind: 'notFound' }
  | { kind: 'unknown' };

export type UserEmailRow = { sub: string; email: string; lastSeenAt: number };
export type UserEmailField = 'emailLower' | 'email';

export async function queryShareProfileRows(
  email: string,
  queryUsersByField: (
    field: UserEmailField,
    email: string,
  ) => Promise<UserEmailRow[]>,
): Promise<UserEmailRow[]> {
  const rows = await queryUsersByField('emailLower', email);
  if (rows.length > 0) {
    return rows;
  }
  return queryUsersByField('email', email);
}

export async function resolveShareTarget(input: {
  email: string;
  actorSub: string;
  actorEmail: string;
  queryUsers: (email: string) => Promise<UserEmailRow[]>;
  isOwnerEmail: (email: string) => boolean;
  readMemberStatus: (sub: string) => Promise<'active' | 'revoked' | null>;
}): Promise<ShareTarget> {
  if (input.email === input.actorEmail.trim().toLowerCase()) {
    return { kind: 'self' };
  }
  let rows: UserEmailRow[];
  try {
    rows = await input.queryUsers(input.email);
  } catch {
    return { kind: 'unknown' };
  }
  if (rows.length === 0) {
    return { kind: 'notFound' };
  }
  rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const picked = rows[0];
  if (picked.sub === input.actorSub) {
    return { kind: 'self' };
  }
  if (input.isOwnerEmail(picked.email)) {
    return { kind: 'ok', sub: picked.sub, email: picked.email };
  }
  try {
    const status = await input.readMemberStatus(picked.sub);
    if (status === 'active') {
      return { kind: 'ok', sub: picked.sub, email: picked.email };
    }
    return { kind: 'notFound' };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function queryUsersByField(
  field: UserEmailField,
  email: string,
): Promise<UserEmailRow[]> {
  const snap = await getStoreFirestore()
    .collection('users')
    .where(field, '==', email)
    .get();
  const rows: UserEmailRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const storedEmail = typeof data.email === 'string' ? data.email : email;
    const lastSeenAt =
      typeof data.lastSeenAt === 'number' && Number.isFinite(data.lastSeenAt)
        ? data.lastSeenAt
        : 0;
    rows.push({ sub: doc.id, email: storedEmail, lastSeenAt });
  }
  return rows;
}

export async function queryUsersByEmail(email: string): Promise<UserEmailRow[]> {
  return queryShareProfileRows(email, queryUsersByField);
}

export async function lookupAdmittedSubByEmail(
  email: string,
  actor: { sub: string; email: string },
): Promise<ShareTarget> {
  return resolveShareTarget({
    email,
    actorSub: actor.sub,
    actorEmail: actor.email,
    queryUsers: queryUsersByEmail,
    isOwnerEmail: (candidate) => isAllowed(candidate, true, allowedEmails()),
    readMemberStatus: async (sub) => {
      const member = await readMember(sub);
      return member?.status ?? null;
    },
  });
}

export function grantColRef(ownerSub: string, collectionId: string) {
  return collectionDocRef(ownerSub, collectionId).collection('grants');
}

export function incomingShareRef(viewerSub: string, grantId: string) {
  return getStoreFirestore()
    .collection('incomingShares')
    .doc(viewerSub)
    .collection('items')
    .doc(grantId);
}

export function incomingSharesCol(viewerSub: string) {
  return getStoreFirestore()
    .collection('incomingShares')
    .doc(viewerSub)
    .collection('items');
}

export async function listLiveIncomingShares(
  viewerSub: string,
): Promise<LiveIncomingShare[]> {
  const snap = await incomingSharesCol(viewerSub)
    .orderBy(FieldPath.documentId())
    .get();
  const out: LiveIncomingShare[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (!isLiveDoc(data)) {
      continue;
    }
    if (typeof data.ownerSub !== 'string' || data.ownerSub === '') {
      continue;
    }
    if (typeof data.collectionId !== 'string' || !isUuid(data.collectionId)) {
      continue;
    }
    out.push({
      grantId: doc.id,
      ownerSub: data.ownerSub,
      collectionId: data.collectionId,
      role: parseShareRole(data.role),
    });
  }
  return out;
}

export async function readLiveIncomingShare(
  viewerSub: string,
  grantId: string,
): Promise<LiveIncomingShare | undefined> {
  const snap = await incomingShareRef(viewerSub, grantId).get();
  if (!snap.exists) {
    return undefined;
  }
  const share = parseIncomingShareDoc(snap.data());
  if (share === undefined || share.deletedAt !== undefined) {
    return undefined;
  }
  return {
    grantId,
    ownerSub: share.ownerSub,
    collectionId: share.collectionId,
    ...(share.ownerEmail ? { ownerEmail: share.ownerEmail } : {}),
    role: parseShareRole(share.role),
  };
}

/** Firestore snapshot metadata, not a client timestamp. */
export type SharedScopeShareSnapshot = {
  id: string;
  data: Record<string, unknown> | undefined;
  updateTime: string;
};

export type SharedScopeCollectionSnapshot = {
  exists: boolean;
  data?: Record<string, unknown>;
  updateTime?: string;
};

/**
 * Authorization-scope row. `shareUpdateTime` and `collectionUpdateTime` are
 * Firestore snapshot update times, so a revoke/re-grant keeps a new identity
 * even when the stored fields match.
 */
export type SharedAuthorizationScopeEntry = {
  grantId: string;
  ownerSub: string;
  collectionId: string;
  shareUpdateTime: string;
  collectionLive: boolean;
  recipeIds?: string[];
  collectionUpdateTime?: string;
};

export type SharedAuthorizationScopeIo = {
  listShareSnapshots: (
    viewerSub: string,
  ) => Promise<SharedScopeShareSnapshot[]>;
  readCollectionSnapshot: (
    ownerSub: string,
    collectionId: string,
  ) => Promise<SharedScopeCollectionSnapshot>;
  ownerAdmitted?: (ownerSub: string) => Promise<boolean>;
};

export function canonicalSnapshotUpdateTime(
  updateTime: { seconds: number; nanoseconds: number } | undefined,
): string {
  if (updateTime === undefined) {
    return '';
  }
  const { seconds, nanoseconds } = updateTime;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) {
    return '';
  }
  return `${Math.trunc(seconds)}.${String(Math.trunc(nanoseconds)).padStart(9, '0')}`;
}

function liveShareIdentity(share: SharedScopeShareSnapshot): {
  grantId: string;
  ownerSub: string;
  collectionId: string;
  shareUpdateTime: string;
} | null {
  const parsed = parseIncomingShareDoc(share.data);
  if (parsed === undefined || parsed.deletedAt !== undefined) {
    return null;
  }
  return {
    grantId: share.id,
    ownerSub: parsed.ownerSub,
    collectionId: parsed.collectionId,
    shareUpdateTime: share.updateTime,
  };
}

export function sharedScopeEntryFromSnapshots(
  share: SharedScopeShareSnapshot,
  collection: SharedScopeCollectionSnapshot,
): SharedAuthorizationScopeEntry | null {
  const identity = liveShareIdentity(share);
  if (identity === null) {
    return null;
  }
  const data = collection.exists ? collection.data : undefined;
  const collectionLive = canViewCollection(
    {
      ownerSub: identity.ownerSub,
      collectionId: identity.collectionId,
      grantId: identity.grantId,
    },
    data,
  );
  const entry: SharedAuthorizationScopeEntry = {
    grantId: identity.grantId,
    ownerSub: identity.ownerSub,
    collectionId: identity.collectionId,
    shareUpdateTime: identity.shareUpdateTime,
    collectionLive,
  };
  if (!collectionLive || data === undefined) {
    return entry;
  }
  entry.recipeIds = Array.isArray(data.recipeIds)
    ? data.recipeIds.filter((id): id is string => typeof id === 'string')
    : [];
  entry.collectionUpdateTime = collection.updateTime ?? '';
  return entry;
}

/**
 * Canonical scope description. Sorting and dropping non-live membership
 * happens here so the digest does not depend on query order or tombstone
 * recipe lists. Recipe and photo bodies are not part of this value.
 */
export function canonicalSharedAuthorizationScope(
  entries: readonly SharedAuthorizationScopeEntry[],
): SharedAuthorizationScopeEntry[] {
  const canonical: SharedAuthorizationScopeEntry[] = [];
  for (const entry of entries) {
    const next: SharedAuthorizationScopeEntry = {
      grantId: entry.grantId,
      ownerSub: entry.ownerSub,
      collectionId: entry.collectionId,
      shareUpdateTime: entry.shareUpdateTime,
      collectionLive: entry.collectionLive,
    };
    if (entry.collectionLive) {
      const recipeIds = Array.isArray(entry.recipeIds)
        ? entry.recipeIds.filter((id): id is string => typeof id === 'string')
        : [];
      recipeIds.sort();
      next.recipeIds = recipeIds;
      next.collectionUpdateTime = entry.collectionUpdateTime ?? '';
    }
    canonical.push(next);
  }
  canonical.sort((a, b) =>
    a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0,
  );
  return canonical;
}

/** One read-only pass: reverse shares, then each live share's collection. */
export async function loadSharedAuthorizationScope(
  viewerSub: string,
  io: SharedAuthorizationScopeIo,
): Promise<SharedAuthorizationScopeEntry[]> {
  const shares = await io.listShareSnapshots(viewerSub);
  const entries: SharedAuthorizationScopeEntry[] = [];
  const admittedByOwner = new Map<string, boolean>();
  for (const share of shares) {
    const identity = liveShareIdentity(share);
    if (identity === null) {
      continue;
    }
    if (io.ownerAdmitted) {
      let admitted = admittedByOwner.get(identity.ownerSub);
      if (admitted === undefined) {
        admitted = await io.ownerAdmitted(identity.ownerSub);
        admittedByOwner.set(identity.ownerSub, admitted);
      }
      if (!admitted) {
        continue;
      }
    }
    const collection = await io.readCollectionSnapshot(
      identity.ownerSub,
      identity.collectionId,
    );
    const entry = sharedScopeEntryFromSnapshots(share, collection);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Reads the viewer's authorization scope in one Firestore read-only
 * transaction. No writes. Callers compare the digest before and after a
 * page; this function does not authorize individual rows.
 */
export async function readSharedAuthorizationScope(
  viewerSub: string,
): Promise<SharedAuthorizationScopeEntry[]> {
  const db = getStoreFirestore();
  return db.runTransaction(
    (tx) =>
      loadSharedAuthorizationScope(viewerSub, {
      ownerAdmitted: sharingOwnerAdmitted,
      listShareSnapshots: async (sub) => {
        const snap = await tx.get(
          incomingSharesCol(sub).orderBy(FieldPath.documentId()),
        );
        return snap.docs.map((doc) => ({
          id: doc.id,
          data: doc.data() as Record<string, unknown>,
          updateTime: canonicalSnapshotUpdateTime(doc.updateTime),
        }));
      },
      readCollectionSnapshot: async (ownerSub, collectionId) => {
        const snap = await tx.get(collectionDocRef(ownerSub, collectionId));
        if (!snap.exists) {
          return { exists: false };
        }
        return {
          exists: true,
          data: snap.data() as Record<string, unknown>,
          updateTime: canonicalSnapshotUpdateTime(snap.updateTime),
        };
      },
    }),
    { readOnly: true },
  );
}

type ReadDocData = (
  uid: string,
  kind: StoreKind,
  id: string,
) => Promise<Record<string, unknown> | undefined>;

/**
 * Whether a sharing owner is still admitted. Denied owners' grants are inert.
 * Throws when membership is unknown so callers answer 503, never 401 or 404.
 */
export async function sharingOwnerAdmitted(ownerSub: string): Promise<boolean> {
  const profile = await getStoreFirestore().collection('users').doc(ownerSub).get();
  const rawEmail = profile.exists ? profile.data()?.email : undefined;
  const decision = await accessAllows({
    sub: ownerSub,
    email: typeof rawEmail === 'string' ? rawEmail : '',
    emailVerified: true,
  });
  if (decision === 'unknown') {
    throw new Error('Sharing owner membership unavailable');
  }
  return decision !== 'denied';
}

export type SessionCanViewOwnerPhotoInput = {
  viewerSub: string;
  ownerSub: string;
  photoId: string;
  listLiveIncomingShares: (viewerSub: string) => Promise<LiveIncomingShare[]>;
  readLiveIncomingShare: (
    viewerSub: string,
    grantId: string,
  ) => Promise<LiveIncomingShare | undefined>;
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  readDocData: ReadDocData;
};

export async function sessionCanViewOwnerPhoto(
  input: SessionCanViewOwnerPhotoInput,
): Promise<boolean> {
  const shares = await input.listLiveIncomingShares(input.viewerSub);
  let ownerAdmitted: boolean | undefined;
  for (const share of shares) {
    if (share.ownerSub !== input.ownerSub) {
      continue;
    }
    const current = await input.readLiveIncomingShare(
      input.viewerSub,
      share.grantId,
    );
    if (
      current === undefined ||
      current.grantId !== share.grantId ||
      current.ownerSub !== share.ownerSub ||
      current.collectionId !== share.collectionId
    ) {
      continue;
    }
    ownerAdmitted ??= await input.ownerAdmitted(input.ownerSub);
    if (!ownerAdmitted) {
      return false;
    }
    const collection = await input.readDocData(
      input.ownerSub,
      'collections',
      share.collectionId,
    );
    const authorizedShare = {
      ownerSub: share.ownerSub,
      collectionId: share.collectionId,
      grantId: share.grantId,
    };
    if (!canViewCollection(authorizedShare, collection)) {
      continue;
    }
    const photo = await input.readDocData(
      input.ownerSub,
      'photos',
      input.photoId,
    );
    const recipeId = photo?.recipeId;
    if (
      photo === undefined ||
      !isLiveDoc(photo) ||
      photo.status !== 'live' ||
      !isUuid(recipeId)
    ) {
      continue;
    }
    const recipe = await input.readDocData(
      input.ownerSub,
      'recipes',
      recipeId,
    );
    if (
      canViewRecipe(
        recipeId,
        authorizedShare,
        collection,
        recipe,
      ) &&
      recipe !== undefined &&
      recipeListsPhoto(recipe, input.photoId)
    ) {
      return true;
    }
  }
  return false;
}

export const LIVE_GRANT_QUERY_LIMIT = MAX_LIVE_GRANTS + 1;

export type CollectionGrantDeletePlan =
  | { kind: 'reject' }
  | { kind: 'tombstone-only' }
  | { kind: 'apply' }
  | { kind: 'heal'; grantCascadeAt: number; writeCollection: boolean };

/**
 * Client LWW decides whether the collection tombstone is written.
 * ACL revocation uses a stored `grantCascadeAt` or a fresh server order,
 * never `clientUpdatedAt`.
 */
export function planCollectionGrantDelete(
  collection: Record<string, unknown> | undefined,
  clientUpdatedAt: number,
): CollectionGrantDeletePlan {
  const stored = readStoredMutationState(collection);
  const cmp = compareMutation(stored, clientUpdatedAt, 'tombstone');
  const canonicalAt = canonicalCollectionTombstoneAt(collection);
  if (canonicalAt !== undefined && collection !== undefined) {
    const grantCascadeAt = finiteNumber(collection.grantCascadeAt);
    if (grantCascadeAt !== undefined) {
      return { kind: 'heal', grantCascadeAt, writeCollection: cmp.allow };
    }
    return cmp.allow ? { kind: 'tombstone-only' } : { kind: 'reject' };
  }
  if (!cmp.allow) {
    return { kind: 'reject' };
  }
  if (collection !== undefined && stored !== null && isLiveDoc(collection)) {
    return { kind: 'apply' };
  }
  return { kind: 'tombstone-only' };
}

export type LiveForwardGrantSnap = {
  viewerSub: string;
  data: Record<string, unknown> | undefined;
};

export type CollectionGrantDeleteTransaction = {
  readCollection: () => Promise<Record<string, unknown> | undefined>;
  queryLiveForwardGrants: () => Promise<LiveForwardGrantSnap[]>;
  readReverseShare: (viewerSub: string) => Promise<Record<string, unknown> | undefined>;
  writeCollection: (doc: Record<string, unknown>) => void;
  writePair: (viewerSub: string, grant: GrantTombstone, share: IncomingShareDoc) => void;
};

export type CollectionGrantDeleteDependencies = {
  now: () => number;
  runTransaction: (
    work: (tx: CollectionGrantDeleteTransaction) => Promise<MutationResult>,
  ) => Promise<MutationResult>;
};

function rawUpdatedAt(raw: unknown): number | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  return finiteNumber(raw.updatedAt);
}

export async function orchestrateCollectionGrantDelete(
  input: {
    ownerSub: string;
    collectionId: string;
    clientUpdatedAt: number;
  },
  deps: CollectionGrantDeleteDependencies,
): Promise<MutationResult> {
  return deps.runTransaction(async (tx) => {
    const now = deps.now();
    const current = await tx.readCollection();
    const plan = planCollectionGrantDelete(current, input.clientUpdatedAt);
    if (plan.kind === 'reject') {
      return { applied: false, current };
    }
    if (plan.kind === 'tombstone-only') {
      tx.writeCollection(
        collectionDeletePayload(input.collectionId, input.clientUpdatedAt, now),
      );
      return { applied: true, serverUpdatedAt: now };
    }

    const liveDocs = (await tx.queryLiveForwardGrants()).slice(0, LIVE_GRANT_QUERY_LIMIT);
    const pairs: Array<{
      viewerSub: string;
      grant: LiveGrant | GrantTombstone | null;
      share: IncomingShareDoc | undefined;
      updatedAts: number[];
    }> = [];
    for (const doc of liveDocs) {
      if (!isSafeFirestoreDocumentId(doc.viewerSub)) {
        continue;
      }
      const shareRaw = await tx.readReverseShare(doc.viewerSub);
      const grant = parseGrantDoc(doc.data, doc.viewerSub);
      const share = parseIncomingShareDoc(shareRaw);
      const updatedAts: number[] = [];
      const grantAt = grant?.updatedAt ?? rawUpdatedAt(doc.data);
      const shareAt = share?.updatedAt ?? rawUpdatedAt(shareRaw);
      if (grantAt !== undefined) {
        updatedAts.push(grantAt);
      }
      if (shareAt !== undefined) {
        updatedAts.push(shareAt);
      }
      pairs.push({ viewerSub: doc.viewerSub, grant, share, updatedAts });
    }

    const grantCascadeAt =
      plan.kind === 'heal'
        ? plan.grantCascadeAt
        : serverGrantCascadeOrder(
            now,
            pairs.flatMap((pair) => pair.updatedAts),
          );

    const writeCollection = plan.kind === 'apply' || plan.writeCollection;
    if (writeCollection) {
      tx.writeCollection(
        collectionDeletePayload(
          input.collectionId,
          input.clientUpdatedAt,
          now,
          grantCascadeAt,
        ),
      );
    }

    for (const pair of pairs) {
      const next = cascadeGrantPairTransition({
        existingGrant: pair.grant,
        existingShare: pair.share,
        viewerSub: pair.viewerSub,
        ownerSub: input.ownerSub,
        collectionId: input.collectionId,
        cascadeAt: grantCascadeAt,
      });
      tx.writePair(pair.viewerSub, next.grant, next.share);
    }

    if (!writeCollection) {
      return { applied: false, current };
    }
    return { applied: true, serverUpdatedAt: now };
  });
}

export type PublicLinkRevokeIo<Row> = {
  /** Live public links of the collection; read before anything is written. */
  readLive: () => Promise<Row[]>;
  writeRevoked: (rows: Row[]) => void;
};

/**
 * A collection delete and its public-link revoke in one transaction. The
 * live links are read first (Firestore: all reads before writes), then the
 * delete runs, and the links are revoked only when it applied. A delete
 * that did not apply is either stale (the collection is live and newer) or
 * a heal of a tombstone whose first delete already revoked them; public
 * links can only be created on a live collection.
 */
export async function deleteRevokingPublicLinks<Row>(
  io: PublicLinkRevokeIo<Row>,
  work: () => Promise<MutationResult>,
): Promise<MutationResult> {
  const rows = await io.readLive();
  const result = await work();
  if (result.applied) {
    io.writeRevoked(rows);
  }
  return result;
}

export async function deleteCollectionWithGrants(
  ownerSub: string,
  collectionId: string,
  clientUpdatedAt: number,
): Promise<MutationResult> {
  const db = getStoreFirestore();
  const collectionRef = collectionDocRef(ownerSub, collectionId);
  const grants = grantColRef(ownerSub, collectionId);
  return orchestrateCollectionGrantDelete(
    { ownerSub, collectionId, clientUpdatedAt },
    {
      now: () => Date.now(),
      runTransaction: (work) =>
        db.runTransaction(async (tx) =>
          deleteRevokingPublicLinks(
            {
              readLive: () => readLivePublicLinksInTransaction(tx, ownerSub, collectionId),
              writeRevoked: (rows) => writeRevokedPublicLinks(tx, rows, Date.now()),
            },
            () =>
              work({
                readCollection: async () => {
                  const snap = await tx.get(collectionRef);
                  return snap.exists
                    ? (snap.data() as Record<string, unknown>)
                    : undefined;
                },
                queryLiveForwardGrants: async () => {
                  const snap = await tx.get(
                    grants.where('active', '==', true).limit(LIVE_GRANT_QUERY_LIMIT),
                  );
                  return snap.docs.map((doc) => ({
                    viewerSub: doc.id,
                    data: doc.data() as Record<string, unknown>,
                  }));
                },
                readReverseShare: async (viewerSub) => {
                  const snap = await tx.get(
                    incomingShareRef(viewerSub, shareGrantId(ownerSub, collectionId)),
                  );
                  return snap.exists
                    ? (snap.data() as Record<string, unknown>)
                    : undefined;
                },
                writeCollection: (doc) => {
                  tx.set(collectionRef, doc, { merge: false });
                },
                writePair: (viewerSub, grant, share) => {
                  tx.set(grants.doc(viewerSub), grant, { merge: false });
                  tx.set(
                    incomingShareRef(viewerSub, shareGrantId(ownerSub, collectionId)),
                    share,
                    { merge: false },
                  );
                },
              }),
          ),
        ),
    },
  );
}

export type ForwardGrantSnap = {
  id: string;
  data: Record<string, unknown> | undefined;
};

export type GrantAddTransaction = {
  readCollection: () => Promise<Record<string, unknown> | undefined>;
  readForwardGrants: () => Promise<ForwardGrantSnap[]>;
  writePair: (grant: LiveGrant, share: IncomingShareDoc) => void;
};

export type GrantAddOutcome =
  | { kind: 'collectionMissing' }
  | { kind: 'cap' }
  | { kind: 'idempotent'; doc: LiveGrant }
  | { kind: 'write'; doc: LiveGrant };

export type GrantAddDependencies = {
  now: () => number;
  runTransaction: (
    work: (tx: GrantAddTransaction) => Promise<GrantAddOutcome>,
  ) => Promise<GrantAddOutcome>;
};

/**
 * What a grant add does to a person who already has a live grant.
 * `applyRole`: the owner picked a role for that person (add by email), so it
 * is written, in this transaction, the same pair write as a role change.
 * `keepRole`: the existing role stands and nothing is written, so a
 * grant path the owner did not aim at this person never upgrades or
 * downgrades them.
 */
export type GrantAddOnExisting = 'applyRole' | 'keepRole';

export async function orchestrateGrantAdd(
  input: {
    ownerSub: string;
    ownerEmail: string;
    collectionId: string;
    viewerSub: string;
    email: string;
    role: ShareRole;
    onExisting: GrantAddOnExisting;
  },
  deps: GrantAddDependencies,
): Promise<GrantAddOutcome> {
  return deps.runTransaction(async (tx) => {
    const now = deps.now();
    const collection = await tx.readCollection();
    if (!collectionLiveForGrant(collection)) {
      return { kind: 'collectionMissing' };
    }
    const grants = await tx.readForwardGrants();
    const grantSnap = grants.find((doc) => doc.id === input.viewerSub);
    const existing = parseGrantDoc(grantSnap?.data, input.viewerSub);
    let liveCount = 0;
    for (const doc of grants) {
      if (isLiveGrant(parseGrantDoc(doc.data, doc.id))) {
        liveCount += 1;
      }
    }
    const next = addGrantTransition({
      existing,
      viewerSub: input.viewerSub,
      email: input.email,
      collectionId: input.collectionId,
      role: input.role,
      now,
      liveCount,
    });
    if (next.kind === 'cap') {
      return { kind: 'cap' };
    }
    if (next.kind === 'idempotent') {
      if (input.onExisting === 'keepRole') {
        return { kind: 'idempotent', doc: next.doc };
      }
      const changed = changeGrantRoleTransition({
        existing: next.doc,
        role: input.role,
        now,
      });
      if (changed.kind !== 'write') {
        return { kind: 'idempotent', doc: next.doc };
      }
      tx.writePair(
        changed.doc,
        incomingSharePayload(input.ownerSub, input.collectionId, changed.doc.updatedAt, {
          ownerEmail: input.ownerEmail,
          role: changed.doc.role,
        }),
      );
      return { kind: 'write', doc: changed.doc };
    }
    tx.writePair(
      next.doc,
      incomingSharePayload(input.ownerSub, input.collectionId, next.doc.updatedAt, {
        ownerEmail: input.ownerEmail,
        role: next.doc.role,
      }),
    );
    return { kind: 'write', doc: next.doc };
  });
}

/** Firestore reads and writes for one owner's collection grants, inside `tx`. */
export function firestoreGrantAddTransaction(
  tx: Transaction,
  ownerSub: string,
  collectionId: string,
): GrantAddTransaction {
  const grantCollection = grantColRef(ownerSub, collectionId);
  const collectionRef = collectionDocRef(ownerSub, collectionId);
  return {
    readCollection: async () => {
      const snap = await tx.get(collectionRef);
      return snap.exists
        ? (snap.data() as Record<string, unknown>)
        : undefined;
    },
    readForwardGrants: async () => {
      const snap = await tx.get(grantCollection);
      return snap.docs.map((doc) => ({
        id: doc.id,
        data: doc.data() as Record<string, unknown>,
      }));
    },
    writePair: (grant, share) => {
      tx.set(grantCollection.doc(grant.viewerSub), grant, { merge: false });
      tx.set(
        incomingShareRef(
          grant.viewerSub,
          shareGrantId(ownerSub, collectionId),
        ),
        share,
        { merge: false },
      );
    },
  };
}

export async function commitCollectionGrant(input: {
  ownerSub: string;
  ownerEmail: string;
  collectionId: string;
  viewerSub: string;
  email: string;
  role: ShareRole;
  onExisting: GrantAddOnExisting;
}): Promise<GrantAddOutcome> {
  const db = getStoreFirestore();
  return orchestrateGrantAdd(input, {
    now: () => Date.now(),
    runTransaction: (work) =>
      db.runTransaction(async (tx) =>
        work(firestoreGrantAddTransaction(tx, input.ownerSub, input.collectionId)),
      ),
  });
}
