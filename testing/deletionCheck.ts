/**
 * Account deletion against the emulator (docs/plans/test-coverage.md, step 9).
 * Runs the real `scripts/delete-account-data.ts` on the `viewer` persona, as
 * the README procedure does, and checks that only the viewer's data went:
 *
 *   node testing/deletionCheck.ts http://localhost:4173
 *
 * The `test-mode` CI job runs it after `testing/smoke.ts`. It changes the
 * seed for good (the viewer is gone), so it runs last. The script's own
 * exit codes are assertions: it exits 1 when a step leaves anything behind.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_PROJECT_ID, emulatorHost } from './env.ts';
import { FIXTURE_IDS } from './fixtures.ts';
import { OWNER_EMAIL, persona } from './personas.ts';

const baseUrl = (process.argv[2] ?? 'http://localhost:3001').replace(/\/+$/, '');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVOCATION_BOUND_MS = 65_000;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail === '' ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

async function signIn(name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/__test/sign-in?as=${encodeURIComponent(name)}`, { redirect: 'manual' });
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((pair) => pair.startsWith('sous_session='));
  if (cookie === undefined) throw new Error(`could not sign ${name} in (status ${res.status})`);
  return cookie;
}

async function request(method: string, path: string, cookie: string, json?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Cookie: cookie, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: json === undefined ? undefined : JSON.stringify(json),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, body: text !== '' && (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text };
}

/** Everything a pull returns, as one comparable string. */
async function pullSnapshot(cookie: string): Promise<string> {
  const res = await request('GET', '/api/sync/pull?limit=500', cookie);
  if (res.status !== 200) throw new Error(`pull answered ${res.status}`);
  return JSON.stringify((res.body as { changes: unknown }).changes);
}

async function grantSubs(cookie: string, collectionId: string): Promise<string[]> {
  const res = await request('GET', `/api/collections/${collectionId}/grants`, cookie);
  if (res.status !== 200) throw new Error(`grants answered ${res.status}`);
  return ((res.body as { grants?: { sub: string }[] }).grants ?? []).map((g) => g.sub).sort();
}

function runScript(args: string[]): { status: number | null; out: string } {
  const host = emulatorHost(process.env);
  if (host === null) throw new Error('FIRESTORE_EMULATOR_HOST is not a loopback address');
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/delete-account-data.ts'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: host,
      GOOGLE_CLOUD_PROJECT: TEST_PROJECT_ID,
      ALLOWED_EMAILS: OWNER_EMAIL,
      FIRESTORE_DATABASE_ID: '',
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function toChange(out: string): number | undefined {
  const match = /^(\d+) to change\./m.exec(out);
  return match === null ? undefined : Number(match[1]);
}

async function main(): Promise<void> {
  const viewer = persona('viewer');
  const owner = await signIn('owner');
  const member = await signIn('member');
  const viewerCookie = await signIn('viewer');
  // Not admitted alongside: `empty` has its own rows and joined shares by now (writeSmoke.ts).
  const emptyCookie = await signIn('empty');

  const before = {
    member: await pullSnapshot(member),
    owner: await pullSnapshot(owner),
    weeknights: await grantSubs(member, FIXTURE_IDS.member.weeknights),
    picks: await grantSubs(owner, FIXTURE_IDS.owner.picks),
    baking: await grantSubs(member, FIXTURE_IDS.member.baking),
    empty: await pullSnapshot(emptyCookie),
    memberKitchen: JSON.stringify((await request('GET', '/api/settings/kitchen', member)).body),
    memberPreferences: JSON.stringify((await request('GET', '/api/settings/preferences', member)).body),
  };
  check('the member starts with metric', before.memberPreferences.includes('"metric"'), before.memberPreferences);
  check('the member starts with a kitchen profile', before.memberKitchen.includes('"eggs"'), before.memberKitchen);
  check('the viewer starts with grants on Weeknights and on Owner’s picks', before.weeknights.includes(viewer.sub) && before.picks.includes(viewer.sub));

  // README step 1: deny access first, or a signed-in client could push its library back.
  const dryWhileMember = runScript([viewer.sub]);
  const stillActive = 'members/{sub} is still active';
  check(
    'a dry run while still a member exits 0 and notes that --apply would refuse',
    dryWhileMember.status === 0 && dryWhileMember.out.includes(`--apply would refuse. ${stillActive}`),
    dryWhileMember.out,
  );
  const applyWhileMember = runScript([viewer.sub, '--apply']);
  check(
    '--apply refuses while the viewer is still a member',
    applyWhileMember.status === 1 && applyWhileMember.out.includes(`Refusing to apply. ${stillActive}`),
    applyWhileMember.out,
  );

  const revoke = await request('POST', '/api/admin/decision', owner, { sub: viewer.sub, action: 'revoke' });
  check('the owner revokes the viewer', revoke.status === 200, `status ${revoke.status}`);
  const deadline = Date.now() + REVOCATION_BOUND_MS;
  let status = 0;
  while (Date.now() < deadline) {
    status = (await request('GET', '/api/sync/pull', viewerCookie)).status;
    if (status === 401) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  // The decision clears this server's cache, so this is the next request; the poll only bounds it.
  check('the viewer is refused on their next request', status === 401, `status ${status}`);

  const dry = runScript([viewer.sub]);
  const pending = toChange(dry.out);
  check('the dry run finds the viewer’s data', dry.status === 0 && pending !== undefined && pending > 0, dry.out);
  check('the dry run lists the viewer’s kitchen profile', dry.out.includes('users/{sub}/settings'), dry.out);
  const dryAgain = runScript([viewer.sub]);
  check('a second dry run finds the same amount', toChange(dryAgain.out) === pending, dryAgain.out);
  check(
    "the dry run left the viewer's grants in place",
    (await grantSubs(member, FIXTURE_IDS.member.weeknights)).includes(viewer.sub) &&
      (await grantSubs(owner, FIXTURE_IDS.owner.picks)).includes(viewer.sub),
  );

  const apply = runScript([viewer.sub, '--apply']);
  check('--apply deletes and finds none left', apply.status === 0 && apply.out.includes('none remains'), apply.out);
  const again = runScript([viewer.sub]);
  check('a second dry run finds nothing', again.status === 0 && toChange(again.out) === 0, again.out);

  check("the member's library is untouched", (await pullSnapshot(member)) === before.member);
  check("the owner's library is untouched", (await pullSnapshot(owner)) === before.owner);
  check(
    "the member's kitchen profile is untouched",
    JSON.stringify((await request('GET', '/api/settings/kitchen', member)).body) === before.memberKitchen,
  );
  check(
    "the member's preferences are untouched",
    JSON.stringify((await request('GET', '/api/settings/preferences', member)).body) === before.memberPreferences,
  );
  check("the empty persona's library is untouched", (await pullSnapshot(emptyCookie)) === before.empty);
  check('Baking’s grants are untouched', JSON.stringify(await grantSubs(member, FIXTURE_IDS.member.baking)) === JSON.stringify(before.baking));
  const weeknights = await grantSubs(member, FIXTURE_IDS.member.weeknights);
  const picks = await grantSubs(owner, FIXTURE_IDS.owner.picks);
  check('Weeknights lost only the viewer’s grant', JSON.stringify(weeknights) === JSON.stringify(before.weeknights.filter((s) => s !== viewer.sub)), JSON.stringify(weeknights));
  check('Owner’s picks lost only the viewer’s grant', JSON.stringify(picks) === JSON.stringify(before.picks.filter((s) => s !== viewer.sub)), JSON.stringify(picks));
  check('the viewer’s cookie is refused', (await request('GET', '/api/sync/pull', viewerCookie)).status === 401);

  console.log(failures === 0 ? 'All deletion checks passed' : `${failures} deletion check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (err) {
  console.log(`FAIL  deletion checks ran: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
