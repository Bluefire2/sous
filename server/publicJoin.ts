import {
  orchestrateCollectionLinkRedeem,
  type CollectionLinkRecord,
  type CollectionLinkRedeemOutcome,
} from './collectionLinks.ts';
import { firestoreGrantAddTransaction } from './grants.ts';
import {
  hashPublicToken,
  isPublicTokenShape,
  parsePublicLinkDoc,
  publicLinksCol,
  type PublicLinkRecord,
} from './publicLinks.ts';
import { getStoreFirestore } from './store.ts';

/**
 * A public link joins exactly like a viewer collection link that never
 * expires, so join reuses `orchestrateCollectionLinkRedeem`: same grant
 * pair, same cap, an existing grant keeps its role, the owner writes nothing.
 * Kept out of `publicLinks.ts` so `grants.ts` can import that module for the
 * collection-delete cascade without a cycle.
 */
export function asViewerCollectionLink(link: PublicLinkRecord | null): CollectionLinkRecord | null {
  if (link === null) {
    return null;
  }
  return {
    ownerSub: link.ownerSub,
    ownerEmail: link.ownerEmail,
    collectionId: link.collectionId,
    role: 'viewer',
    status: link.status,
    createdAt: link.createdAt,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

export type PublicJoinOutcome =
  | (Exclude<CollectionLinkRedeemOutcome, { kind: 'dead' }> & { collectionId: string })
  | { kind: 'dead' };

/**
 * A signed-in member adds a public collection to their library as a viewer.
 * The caller has already decided the redeemer is admitted and the owner is.
 */
export async function joinPublicLink(
  token: string,
  redeemer: { sub: string; email: string },
): Promise<PublicJoinOutcome> {
  if (!isPublicTokenShape(token)) {
    return { kind: 'dead' };
  }
  const db = getStoreFirestore();
  const linkRef = publicLinksCol().doc(hashPublicToken(token));
  let collectionId: string | null = null;
  const outcome = await orchestrateCollectionLinkRedeem(redeemer, {
    now: () => Date.now(),
    runTransaction: (work) =>
      db.runTransaction(async (tx) =>
        work({
          readLink: async () => {
            const snap = await tx.get(linkRef);
            const link = snap.exists ? parsePublicLinkDoc(snap.data()) : null;
            const usable = link !== null && link.token === token ? link : null;
            collectionId = usable?.collectionId ?? null;
            return asViewerCollectionLink(usable);
          },
          grantsFor: (ownerSub, id) => firestoreGrantAddTransaction(tx, ownerSub, id),
        }),
      ),
  });
  if (outcome.kind === 'dead' || collectionId === null) {
    return { kind: 'dead' };
  }
  return { ...outcome, collectionId };
}
