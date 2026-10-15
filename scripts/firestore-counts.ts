/**
 * Read-only document counts for comparing two Firestore databases, such as
 * the old `(default)` and `sous-us` in `docs/plans/us-region-move.md`:
 *
 *   node --env-file=.env.local scripts/firestore-counts.ts [--as-of=<ISO time>]
 *
 * One line per collection group in `FIRESTORE_COLLECTIONS` (other top-level
 * collections are named, not counted), then a total. A group with a TTL
 * policy is counted twice: all documents, and those whose `expireAt` is
 * after the as-of time. Firestore's TTL sweep can delete expired documents
 * at any time, so only the unexpired count is expected to match between
 * databases, and only when both runs use the same `--as-of` (MCP access
 * tokens expire within the hour, so "now" moves the count during a
 * cutover). It defaults to now and is printed, so a later run can reuse it.
 * Names and counts only; never a document id or content.
 *
 * Uses GOOGLE_CLOUD_PROJECT, FIRESTORE_DATABASE_ID and ADC like dev:api, and
 * prints the database first.
 */
import { Timestamp } from '@google-cloud/firestore';
import { FIRESTORE_COLLECTIONS } from '../server/accountDeletion.ts';
import { firestoreTarget } from '../server/env.ts';
import { getStoreFirestore } from '../server/store.ts';

type CollectionName = keyof typeof FIRESTORE_COLLECTIONS;

/**
 * Collection groups with a TTL policy on `expireAt`. Kept by hand: a new TTL
 * collection (AGENTS.md lists the policies) must be added here, or it is
 * compared on its full count.
 */
const TTL_GROUPS: ReadonlySet<CollectionName> = new Set<CollectionName>([
  'importFeedback',
  'featureRequests',
  'mcpAuthCodes',
  'mcpTokens',
  'llmUsage',
]);

const asOfArg = process.argv.slice(2).find((arg) => arg.startsWith('--as-of='));
const now = asOfArg === undefined ? Date.now() : Date.parse(asOfArg.slice('--as-of='.length));
if (!Number.isFinite(now)) {
  console.error('usage: node --env-file=.env.local scripts/firestore-counts.ts [--as-of=<ISO time>]');
  process.exit(2);
}

console.error(`Firestore: ${firestoreTarget()}`);
console.log(`as-of ${new Date(now).toISOString()}`);
const db = getStoreFirestore();
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
