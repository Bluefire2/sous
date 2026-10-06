/**
 * Account deletion request, Firestore part: removes everything Sous stores
 * for one member, collection by collection (`ACCOUNT_DELETION_STEPS` in
 * `server/accountDeletion.ts`), in order, reading each back. Step 4 of the
 * manual deletion procedure in README.md; photos in GCS are step 5.
 *
 *   node --env-file=.env.local scripts/delete-account-data.ts <sub> [--apply] [--not-owner]
 *
 * Dry run unless `--apply`: prints what each step would change. `--apply`
 * refuses while the member still has access (active in `members/{sub}`, or an
 * address stored for them in `ALLOWED_EMAILS`), because a signed-in client
 * could push its library back; deny access first (README steps 1–2).
 * `ALLOWED_EMAILS` comes from the env file, so it must match the deployed one.
 * When no email is stored for the sub at all, `--apply` refuses unless
 * `--not-owner` says the operator checked the deployed allowlist by hand.
 * Prints counts only, never document ids, emails, or contents.
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it targets the real
 * database unless FIRESTORE_EMULATOR_HOST is set.
 *
 * `runDeleteAccountData` is the whole program with its I/O passed in, so
 * `scripts/delete-account-data.test.ts` can run it against fake steps.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_DELETION_ORDER,
  ACCOUNT_DELETION_STEPS,
  deletionRefusal,
  readDeletionSubject,
  type DeletionStep,
} from '../server/accountDeletion.ts';
import { allowedEmails } from '../server/env.ts';
import { isSafeFirestoreDocumentId } from '../server/grants.ts';

const REFUSAL_TEXT = {
  'bad-sub': 'That is not a Firestore document id.',
  'no-allowlist': 'ALLOWED_EMAILS is not set, so an owner cannot be ruled out. Run with --env-file=.env.local.',
  'still-member': 'members/{sub} is still active. Revoke access first (README steps 1–2).',
  owner: 'An email stored for this sub is in ALLOWED_EMAILS. Remove it from the deployed allowlist first.',
  'no-email':
    'No email is stored for this sub (no profile, membership, or access request), so an owner cannot be ruled out. ' +
    'Check the deployed ALLOWED_EMAILS by hand, then pass --not-owner.',
} as const;

const USAGE = 'Usage: node --env-file=.env.local scripts/delete-account-data.ts <sub> [--apply] [--not-owner]';

export interface DeleteAccountDataDeps {
  readSubject: typeof readDeletionSubject;
  steps: Readonly<Record<string, DeletionStep>>;
  order: readonly string[];
  allowedRaw: () => string;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The program. `argv` is the arguments after the script path. Returns the exit code. */
export async function runDeleteAccountData(
  argv: readonly string[],
  deps: DeleteAccountDataDeps,
): Promise<number> {
  const apply = argv.includes('--apply');
  const sub = argv.find((arg) => !arg.startsWith('--'));
  if (sub === undefined || sub.trim() === '') {
    deps.error(USAGE);
    return 2;
  }
  // Before any read: a path-like value would address some other document.
  if (!isSafeFirestoreDocumentId(sub)) {
    deps.error(REFUSAL_TEXT['bad-sub']);
    return 2;
  }

  const subject = await deps.readSubject(sub);
  const refusal = deletionRefusal({
    sub,
    ...subject,
    allowedRaw: deps.allowedRaw(),
    notOwnerConfirmed: argv.includes('--not-owner'),
  });

  const inventoryTotal = async (print: boolean): Promise<number> => {
    let total = 0;
    for (const name of deps.order) {
      for (const line of await deps.steps[name].inventory(sub)) {
        if (print) deps.log(`${line.label}: ${line.count}`);
        total += line.count;
      }
    }
    return total;
  };

  const total = await inventoryTotal(true);

  if (!apply) {
    if (refusal !== null) deps.log(`Note: --apply would refuse. ${REFUSAL_TEXT[refusal]}`);
    deps.log(`${total} to change. Dry run; pass --apply to delete.`);
    return 0;
  }

  if (refusal !== null) {
    deps.error(`Refusing to apply. ${REFUSAL_TEXT[refusal]}`);
    return 1;
  }

  const now = deps.now();
  for (const name of deps.order) {
    // Each step reads its own data back and throws if any remains.
    await deps.steps[name].apply(sub, now);
    deps.log(`${name}: done`);
  }

  const left = await inventoryTotal(false);
  if (left > 0) {
    deps.error(`${left} still found after apply. Run the dry run to see where.`);
    return 1;
  }
  deps.log('Firestore data deleted; none remains. Now delete the photos (README step 5).');
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const code = await runDeleteAccountData(process.argv.slice(2), {
    readSubject: readDeletionSubject,
    steps: ACCOUNT_DELETION_STEPS,
    order: ACCOUNT_DELETION_ORDER,
    allowedRaw: allowedEmails,
    now: () => Date.now(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  process.exit(code);
}
