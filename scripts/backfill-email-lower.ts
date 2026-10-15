/**
 * One-time backfill of `users/{sub}.emailLower` for profiles written before
 * sign-in started storing it, so add-by-email finds mixed-case addresses.
 * Idempotent. Dry run unless `--apply`:
 *
 *   node --env-file=.env.local scripts/backfill-email-lower.ts [--apply]
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it targets the real
 * database unless FIRESTORE_EMULATOR_HOST is set.
 */
import { FieldPath } from '@google-cloud/firestore';
import { emailLowerBackfill, getStoreFirestore } from '../server/store.ts';
import { firestoreTarget } from '../server/env.ts';

const apply = process.argv.includes('--apply');
console.error(`Firestore: ${firestoreTarget()}`);
const db = getStoreFirestore();
let scanned = 0;
let pending = 0;
let lastId: string | undefined;

for (;;) {
  let query = db.collection('users').orderBy(FieldPath.documentId()).limit(300);
  if (lastId !== undefined) {
    query = query.startAfter(lastId);
  }
  const snap = await query.get();
  if (snap.empty) {
    break;
  }
  const batch = db.batch();
  let writes = 0;
  for (const doc of snap.docs) {
    scanned += 1;
    const next = emailLowerBackfill(doc.data());
    if (next === null) {
      continue;
    }
    pending += 1;
    console.log(`users/${doc.id}: emailLower missing or stale`);
    if (apply) {
      batch.update(doc.ref, { emailLower: next });
      writes += 1;
    }
  }
  if (writes > 0) {
    await batch.commit();
  }
  lastId = snap.docs[snap.docs.length - 1].id;
}

console.log(
  apply
    ? `${scanned} profiles scanned, ${pending} updated.`
    : `${scanned} profiles scanned, ${pending} need emailLower. Dry run; pass --apply to write.`,
);
