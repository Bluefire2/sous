/**
 * Read-only document counts for comparing two Firestore databases, such as
 * the old `(default)` and `sous-us` in `docs/plans/us-region-move.md`:
 *
 *   node --env-file=.env.local scripts/firestore-counts.ts
 *
 * One line per collection group in `FIRESTORE_COLLECTIONS` (plus any other
 * top-level collection that exists), then a total. A group with a TTL
 * policy is counted twice: all documents, and those whose `expireAt` is
 * still in the future. Firestore's TTL sweep can delete expired documents at
 * any time, so only the unexpired count is expected to match between
 * databases. Names and counts only; never a document id or content.
 *
 * Uses GOOGLE_CLOUD_PROJECT, FIRESTORE_DATABASE_ID and ADC like dev:api, and
 * prints the database first.
 */
import { Timestamp } from '@google-cloud/firestore';
import { FIRESTORE_COLLECTIONS } from '../server/accountDeletion.ts';
import { firestoreTarget } from '../server/env.ts';
import { getStoreFirestore } from '../server/store.ts';

type CollectionName = keyof typeof FIRESTORE_COLLECTIONS;

/** Collection groups with a TTL policy on `expireAt` (AGENTS.md). */
const TTL_GROUPS: ReadonlySet<CollectionName> = new Set<CollectionName>([
  'importFeedback',
  'featureRequests',
  'mcpAuthCodes',
  'mcpTokens',
  'llmUsage',
]);

console.error(`Firestore: ${firestoreTarget()}`);
const db = getStoreFirestore();
const now = Date.now();
// A top-level collection outside the registry is a finding in itself (the
// deletion script never visits it); name it, but count only registered ones.
const unclassified = (await db.listCollections())
  .map((c) => c.id)
  .filter((id) => !Object.hasOwn(FIRESTORE_COLLECTIONS, id));
if (unclassified.length > 0) {
  console.log(`not in FIRESTORE_COLLECTIONS, not counted: ${unclassified.sort().join(', ')}`);
}
const collections = (Object.keys(FIRESTORE_COLLECTIONS) as CollectionName[]).sort();

let total = 0;
let comparable = 0;
for (const collection of collections) {
  const group = db.collectionGroup(collection);
  const all = (await group.count().get()).data().count;
  total += all;
  if (TTL_GROUPS.has(collection)) {
    // A range filter on a collection group needs an index nobody created, so
    // read only expireAt and compare here; these groups are small.
    const snapshot = await group.select('expireAt').get();
    const live = snapshot.docs.filter((doc) => {
      const at: unknown = doc.get('expireAt');
      return at instanceof Timestamp && at.toMillis() > now;
    }).length;
    comparable += live;
    console.log(`${collection}\t${all}\tunexpired ${live}`);
  } else {
    comparable += all;
    console.log(`${collection}\t${all}`);
  }
}
console.log(`TOTAL\t${total}\tcomparable ${comparable}`);
