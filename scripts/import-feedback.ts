/**
 * Read-only view of import reports sent from the app
 * (`docs/plans/import-feedback.md`). Writes nothing:
 *
 *   node --env-file=.env.local scripts/import-feedback.ts [--days N] [--email addr]
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it reads the real
 * database unless FIRESTORE_EMULATOR_HOST is set. Prints the full link, the
 * error, warning codes, the recipe title, the note, and the first 200
 * characters of pasted text. `--days` defaults to 7.
 */
import { getStoreFirestore } from '../server/store.ts';

const USAGE = 'usage: node --env-file=.env.local scripts/import-feedback.ts [--days N] [--email addr]';

function usageExit(): never {
  console.error(USAGE);
  process.exit(2);
}

let days = 7;
let email: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--days') {
    const value = Number(args[++i]);
    if (!Number.isFinite(value) || value <= 0) usageExit();
    days = value;
  } else if (arg === '--email') {
    const value = (args[++i] ?? '').trim().toLowerCase();
    if (value === '') usageExit();
    email = value;
  } else {
    usageExit();
  }
}

function iso(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : '-';
}

const db = getStoreFirestore();

let subs: Set<string> | undefined;
if (email !== undefined) {
  let users = await db.collection('users').where('emailLower', '==', email).get();
  if (users.empty) {
    users = await db.collection('users').where('email', '==', email).get();
  }
  if (users.empty) {
    console.log('No profile with that email.');
    process.exit(1);
  }
  subs = new Set(users.docs.map((doc) => doc.id));
}

const snapshot = await db
  .collection('importFeedback')
  .where('createdAt', '>=', Date.now() - days * 86_400_000)
  .orderBy('createdAt')
  .get();

for (const doc of snapshot.docs) {
  const r = doc.data();
  if (subs !== undefined && !subs.has(String(r.sub))) continue;
  console.log(`${iso(r.createdAt)} ${r.trigger} ${r.via} sub=${r.sub}`);
  if (typeof r.url === 'string') console.log(`  url: ${r.url}`);
  if (r.error !== undefined && r.error !== null) {
    const e = r.error;
    console.log(`  error: ${e.code ?? '-'} ${e.status ?? '-'} site=${e.siteStatus ?? '-'} ${e.message ?? ''}`);
  }
  const warnings = r.result?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    console.log(`  warnings: ${warnings.map((w: { code?: unknown }) => String(w.code)).join(', ')}`);
  }
  if (typeof r.result?.recipeJson === 'string') {
    try {
      console.log(`  title: ${JSON.parse(r.result.recipeJson).title}`);
    } catch {
      console.log('  (recipe JSON truncated or invalid)');
    }
  }
  if (typeof r.comment === 'string') console.log(`  comment: ${r.comment}`);
  if (typeof r.pastedText === 'string') console.log(`  pasted: ${r.pastedText.slice(0, 200)}`);
}

const stale = await db
  .collection('importFeedback')
  .where('expireAt', '<', new Date(Date.now() - 3 * 86_400_000))
  .limit(1)
  .get();
if (!stale.empty) {
  console.log(
    'WARNING: reports are more than 3 days past expireAt — the TTL policy on importFeedback.expireAt is probably not applied.',
  );
}
