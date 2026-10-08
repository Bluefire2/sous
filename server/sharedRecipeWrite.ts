import type { DocumentReference } from '@google-cloud/firestore';
import { incomingSharesCol } from './grants.ts';
import {
  canViewRecipe,
  parseShareRole,
  strongerShareRole,
  type ShareRole,
} from './shareAuth.ts';
import {
  collectionDocRef,
  compactRecipeFields,
  compareMutation,
  getStoreFirestore,
  isLiveDoc,
  isUuid,
  readStoredMutationState,
  recipeDocRef,
  type MutationResult,
} from './store.ts';

/** How the session reaches another member's recipe, found on the server. */
export type SharedRecipeAccess = {
  ownerSub: string;
  role: ShareRole;
  /** The owner's live recipe document as read while resolving access. */
  recipe: Record<string, unknown>;
};

export type SharedRecipeAccessIo = {
  /** Every incoming-share document for the session, live or not. */
  listShares: () => Promise<Array<{ grantId: string; data: Record<string, unknown> }>>;
  readCollection: (
    ownerSub: string,
    collectionId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  readRecipe: (
    ownerSub: string,
    recipeId: string,
  ) => Promise<Record<string, unknown> | undefined>;
};

/**
 * Same chain as a shared chat parent: live incoming share → live collection →
 * `recipeIds` lists the id → live recipe. Every share is checked so the
 * stronger role wins when two collections list the same recipe. Owner and role
 * come from the session's share documents, never from a request body.
 */
export async function findSharedRecipeAccess(
  recipeId: string,
  io: SharedRecipeAccessIo,
): Promise<SharedRecipeAccess | null> {
  let best: SharedRecipeAccess | null = null;
  for (const { grantId, data } of await io.listShares()) {
    if (!isLiveDoc(data)) {
      continue;
    }
    const ownerSub = data.ownerSub;
    const collectionId = data.collectionId;
    if (
      typeof ownerSub !== 'string' ||
      ownerSub === '' ||
      typeof collectionId !== 'string' ||
      !isUuid(collectionId)
    ) {
      continue;
    }
    const collection = await io.readCollection(ownerSub, collectionId);
    const ids = Array.isArray(collection?.recipeIds) ? collection.recipeIds : [];
    if (!ids.includes(recipeId)) {
      continue;
    }
    const recipe = await io.readRecipe(ownerSub, recipeId);
    if (!canViewRecipe(recipeId, { grantId, ownerSub, collectionId }, collection, recipe)) {
      continue;
    }
    const role = parseShareRole(data.role);
    if (best === null || strongerShareRole(best.role, role) !== best.role) {
      best = { ownerSub, role, recipe };
    }
    if (best.role === 'editor') {
      return best;
    }
  }
  return best;
}

function sameIds(a: unknown, b: unknown): boolean {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * True when a put leaves the cover and gallery exactly as stored. Compared
 * after the same compaction the write applies, so an empty gallery and an
 * omitted one are the same thing. Reordering counts as a change.
 */
export function recipePhotoIdsUnchanged(
  stored: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  const before = compactRecipeFields(stored);
  const after = compactRecipeFields(payload);
  return (
    before.photoId === after.photoId &&
    sameIds(before.galleryPhotoIds, after.galleryPhotoIds)
  );
}

export type SharedRecipePutPlan =
  | { kind: 'reject'; result: MutationResult }
  | { kind: 'write'; ownerSub: string; body: Record<string, unknown> };

/**
 * Decision for a recipe put a non-owner makes. Only an editor may write, and
 * only text: photo ids must match the stored recipe, because a new id would
 * point the owner's recipe at bytes in the editor's own bucket path. The row
 * keeps the owner's id, `createdAt`, and `variantOf` (an editor could
 * otherwise point it at a recipe in their own tree). `updatedAt` is the editor's clock
 * clamped to server time, then compared and stored under the same
 * last-write-wins rule as the owner's own devices: a far-future stamp from a
 * non-owner cannot lock the owner out of their own recipe.
 */
export function planSharedRecipePut(input: {
  recipeId: string;
  access: SharedRecipeAccess | null;
  ownerAdmitted: boolean;
  payload: Record<string, unknown>;
  clientUpdatedAt: number;
  serverUpdatedAt: number;
}): SharedRecipePutPlan {
  const { access } = input;
  if (access === null || access.role !== 'editor' || !input.ownerAdmitted) {
    return { kind: 'reject', result: { applied: false, reason: 'invalid' } };
  }
  if (!recipePhotoIdsUnchanged(access.recipe, input.payload)) {
    return { kind: 'reject', result: { applied: false, reason: 'invalid' } };
  }
  const updatedAt = Math.min(input.clientUpdatedAt, input.serverUpdatedAt);
  const cmp = compareMutation(
    readStoredMutationState(access.recipe),
    updatedAt,
    'put',
  );
  if (!cmp.allow) {
    return {
      kind: 'reject',
      result: {
        applied: false,
        reason: cmp.reason === 'already-deleted' ? 'already-deleted' : undefined,
        current: access.recipe,
      },
    };
  }
  return {
    kind: 'write',
    ownerSub: access.ownerSub,
    body: {
      ...compactRecipeFields({
        ...input.payload,
        createdAt: access.recipe.createdAt,
        photoId: access.recipe.photoId,
        galleryPhotoIds: access.recipe.galleryPhotoIds,
        variantOf: access.recipe.variantOf,
        savedFrom: access.recipe.savedFrom,
      }),
      id: input.recipeId,
      updatedAt,
      serverUpdatedAt: input.serverUpdatedAt,
    },
  };
}

/** A non-owner may never delete; a live shared recipe id in someone else's tree is refused. */
export function sharedRecipeDeleteAllowed(
  ownDocExists: boolean,
  access: SharedRecipeAccess | null,
): boolean {
  return ownDocExists || access === null;
}

export type SharedRecipePutTransaction = SharedRecipeAccessIo & {
  writeRecipe: (ownerSub: string, recipeId: string, body: Record<string, unknown>) => void;
};

export type SharedRecipePutDependencies = {
  now: () => number;
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  runTransaction: (
    work: (tx: SharedRecipePutTransaction) => Promise<MutationResult>,
  ) => Promise<MutationResult>;
};

/**
 * Access is resolved inside the transaction that writes, so a revoke, a
 * removal from the collection, or an owner delete that commits first makes
 * this put fail instead of landing on a recipe the editor lost.
 */
export async function orchestrateSharedRecipePut(
  input: {
    recipeId: string;
    payload: Record<string, unknown>;
    clientUpdatedAt: number;
  },
  deps: SharedRecipePutDependencies,
): Promise<MutationResult> {
  return deps.runTransaction(async (tx) => {
    const access = await findSharedRecipeAccess(input.recipeId, tx);
    const ownerAdmitted =
      access !== null && access.role === 'editor'
        ? await deps.ownerAdmitted(access.ownerSub)
        : false;
    const serverUpdatedAt = deps.now();
    const plan = planSharedRecipePut({
      recipeId: input.recipeId,
      access,
      ownerAdmitted,
      payload: input.payload,
      clientUpdatedAt: input.clientUpdatedAt,
      serverUpdatedAt,
    });
    if (plan.kind === 'reject') {
      return plan.result;
    }
    tx.writeRecipe(plan.ownerSub, input.recipeId, plan.body);
    return { applied: true, serverUpdatedAt };
  });
}

function sharedRecipeAccessIo(
  read: (ref: DocumentReference) => Promise<Record<string, unknown> | undefined>,
  list: () => Promise<Array<{ grantId: string; data: Record<string, unknown> }>>,
): SharedRecipeAccessIo {
  return {
    listShares: list,
    readCollection: (ownerSub, collectionId) =>
      read(collectionDocRef(ownerSub, collectionId)),
    readRecipe: (ownerSub, recipeId) => read(recipeDocRef(ownerSub, recipeId)),
  };
}

/** Non-transactional lookup, for the delete refusal where nothing is written. */
export async function readSharedRecipeAccess(
  viewerSub: string,
  recipeId: string,
): Promise<SharedRecipeAccess | null> {
  return findSharedRecipeAccess(
    recipeId,
    sharedRecipeAccessIo(
      async (ref) => {
        const snap = await ref.get();
        return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
      },
      async () => {
        const snap = await incomingSharesCol(viewerSub).get();
        return snap.docs.map((doc) => ({
          grantId: doc.id,
          data: doc.data() as Record<string, unknown>,
        }));
      },
    ),
  );
}

/** An editor's `recipe.put`, written to the owner's tree. */
export async function putSharedRecipe(
  viewerSub: string,
  recipeId: string,
  payload: Record<string, unknown>,
  clientUpdatedAt: number,
  ownerAdmitted: (ownerSub: string) => Promise<boolean>,
): Promise<MutationResult> {
  const db = getStoreFirestore();
  return orchestrateSharedRecipePut(
    { recipeId, payload, clientUpdatedAt },
    {
      now: () => Date.now(),
      ownerAdmitted,
      runTransaction: (work) =>
        db.runTransaction(async (tx) => {
          const read = async (ref: DocumentReference) => {
            const snap = await tx.get(ref);
            return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
          };
          const io = sharedRecipeAccessIo(read, async () => {
            const snap = await tx.get(incomingSharesCol(viewerSub));
            return snap.docs.map((doc) => ({
              grantId: doc.id,
              data: doc.data() as Record<string, unknown>,
            }));
          });
          return work({
            ...io,
            writeRecipe: (ownerSub, id, body) => {
              tx.set(recipeDocRef(ownerSub, id), body, { merge: false });
            },
          });
        }),
    },
  );
}
