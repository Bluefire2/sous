/**
 * Aggregate view of `Recipe.importCheck` across every library, for measuring
 * the import warnings (`docs/plans/import-reliability.md`, Measurement).
 * Read-only; owner-run:
 *
 *   node --env-file=.env.local scripts/import-check-report.ts
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it reads the real
 * database unless FIRESTORE_EMULATOR_HOST is set. Prints counts only: never a
 * user id, an email, a title, a URL, or any recipe text.
 */
import { compactImportCheck, IMPORT_WARNING_CODES } from '../server/importWarnings.ts';
import { getStoreFirestore } from '../server/store.ts';

const db = getStoreFirestore();
const users = await db.collection('users').get();

let checked = 0;
let dismissed = 0;
let dismissedUnedited = 0;
let edited = 0;
let resolved = 0;
const live = new Map<string, number>(IMPORT_WARNING_CODES.map((code) => [code, 0]));
const dismissedByCode = new Map<string, number>(IMPORT_WARNING_CODES.map((code) => [code, 0]));

for (const user of users.docs) {
  // Single-field filter on a map subfield: indexed automatically per collection.
  const recipes = await user.ref.collection('recipes').where('importCheck.at', '>', 0).get();
  for (const doc of recipes.docs) {
    const data = doc.data();
    if (Number.isFinite(data.deletedAt)) continue;
    const check = compactImportCheck(data.importCheck);
    if (check === undefined) continue;
    checked += 1;
    if (check.editedAt !== undefined) edited += 1;
    if (check.warnings.length === 0) resolved += 1;
    if (check.dismissedAt !== undefined) {
      dismissed += 1;
      if (check.editedAt === undefined) dismissedUnedited += 1;
    }
    const counts = check.dismissedAt !== undefined ? dismissedByCode : live;
    for (const warning of check.warnings) {
      counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
    }
  }
}

console.log(`recipes with an import check: ${checked}`);
console.log(`  edited after import: ${edited}`);
console.log(`  every warning resolved by an edit: ${resolved}`);
console.log(`  dismissed: ${dismissed}`);
console.log(`  dismissed with no edit (false-positive proxy): ${dismissedUnedited}`);
console.log('');
console.log('warnings by code (showing / dismissed):');
for (const code of IMPORT_WARNING_CODES) {
  console.log(`  ${code}: ${live.get(code) ?? 0} / ${dismissedByCode.get(code) ?? 0}`);
}
