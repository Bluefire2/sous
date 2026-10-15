/**
 * Read-only view of one account's imports, for diagnosing import reports
 * (`docs/plans/import-reliability.md`, phase 1). Writes nothing:
 *
 *   node --env-file=.env.local scripts/import-audit.ts <email>
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it reads the real
 * database unless FIRESTORE_EMULATOR_HOST is set. Prints URLs without their
 * query string or fragment, counts, and titles; never recipe text.
 */
import { getStoreFirestore } from '../server/store.ts';
import { firestoreTarget } from '../server/env.ts';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (email === '') {
  console.error('usage: node --env-file=.env.local scripts/import-audit.ts <email>');
  process.exit(2);
}

function iso(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : '-';
}

function strippedUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return '(unparseable)';
  }
}

function ingredientCount(sections: unknown): number {
  if (!Array.isArray(sections)) return 0;
  return sections.reduce(
    (n: number, s: { items?: unknown }) => n + (Array.isArray(s?.items) ? s.items.length : 0),
    0,
  );
}

console.error(`Firestore: ${firestoreTarget()}`);
const db = getStoreFirestore();
let users = await db.collection('users').where('emailLower', '==', email).get();
if (users.empty) {
  users = await db.collection('users').where('email', '==', email).get();
}
if (users.empty) {
  console.log('No profile with that email.');
  process.exit(1);
}

for (const user of users.docs) {
  const member = await db.collection('members').doc(user.id).get();
  console.log(`sub=${user.id} member=${member.exists ? String(member.data()?.status) : '(none)'}`);

  const rows: { at: number; line: string }[] = [];
  const recipes = await user.ref.collection('recipes').get();
  for (const doc of recipes.docs) {
    const r = doc.data();
    if (Number.isFinite(r.deletedAt)) {
      rows.push({ at: r.deletedAt, line: `${iso(r.deletedAt)} deleted (tombstone, no content)` });
      continue;
    }
    const counts = `ing=${ingredientCount(r.ingredientSections)} steps=${Array.isArray(r.steps) ? r.steps.length : 0}`;
    const edited = r.updatedAt !== r.createdAt ? ' edited' : '';
    const photo = r.photoId ? ' photo' : '';
    const title = String(r.title ?? '').slice(0, 50);
    const source =
      typeof r.sourceUrl === 'string' && r.sourceUrl !== '' ? strippedUrl(r.sourceUrl) : '(no sourceUrl)';
    rows.push({ at: r.createdAt, line: `${iso(r.createdAt)} ${counts}${edited}${photo} ${title} | ${source}` });
  }
  rows.sort((a, b) => a.at - b.at);
  for (const row of rows) console.log(row.line);
}
