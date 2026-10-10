/**
 * Read-only view of feature suggestions sent from `/suggest`
 * (`docs/plans/feature-requests.md`). Writes nothing:
 *
 *   node --env-file=.env.local scripts/feature-requests.ts [--days N] [--email addr]
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it reads the real
 * database unless FIRESTORE_EMULATOR_HOST is set. Prints each suggestion's
 * text and context. A suggestion never stores an email; when the sender
 * allowed contact, this looks theirs up from `users/{sub}` and prints it here
 * only. `--days` defaults to 30.
 */
import { getStoreFirestore } from '../server/store.ts';

const USAGE = 'usage: node --env-file=.env.local scripts/feature-requests.ts [--days N] [--email addr]';

function usageExit(): never {
  console.error(USAGE);
  process.exit(2);
}

let days = 30;
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
  .collection('featureRequests')
  .where('createdAt', '>=', Date.now() - days * 86_400_000)
  .orderBy('createdAt')
  .get();

for (const doc of snapshot.docs) {
  const r = doc.data();
  const sub = String(r.sub);
  if (subs !== undefined && !subs.has(sub)) continue;
  const context = [
    `from=${r.from ?? '-'}`,
    `locale=${r.locale ?? '-'}`,
    `installed=${r.standalone ?? '-'}`,
    `contactOk=${r.contactOk === true}`,
  ].join(' ');
  console.log(`${iso(r.createdAt)} sub=${sub} ${context}`);
  if (r.contactOk === true) {
    const profile = await db.collection('users').doc(sub).get();
    const address = profile.get('email');
    console.log(`  reply to: ${typeof address === 'string' ? address : '(no profile email)'}`);
  }
  const text = typeof r.text === 'string' ? r.text : '';
  for (const line of text.split('\n')) console.log(`  | ${line}`);
}

const stale = await db
  .collection('featureRequests')
  .where('expireAt', '<', new Date(Date.now() - 3 * 86_400_000))
  .limit(1)
  .get();
if (!stale.empty) {
  console.log(
    'WARNING: suggestions are more than 3 days past expireAt — the TTL policy on featureRequests.expireAt is probably not applied.',
  );
}
