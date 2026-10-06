import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_ORDER, type DeletionStep } from '../server/accountDeletion.ts';
import { runDeleteAccountData, type DeleteAccountDataDeps } from './delete-account-data.ts';

const SUB = '1234567890';
const OWNER = 'owner@example.com';

type Subject = { memberStatus: string | undefined; emails: string[] };

/** Fake steps over an in-memory count per step; apply zeroes it unless told to leave some. */
function harness(options: { subject?: Subject; counts?: Record<string, number>; leaveBehind?: string } = {}) {
  const order = ['incomingShares', 'invites', 'users'];
  const counts: Record<string, number> = { incomingShares: 2, invites: 1, users: 3, ...options.counts };
  const calls: string[] = [];
  const steps: Record<string, DeletionStep> = {};
  for (const name of order) {
    steps[name] = {
      inventory: vi.fn(async (sub: string) => {
        calls.push(`inventory ${name} ${sub}`);
        return [{ label: name, count: counts[name] }];
      }),
      apply: vi.fn(async (sub: string, now: number) => {
        calls.push(`apply ${name} ${sub} ${now}`);
        if (name !== options.leaveBehind) counts[name] = 0;
      }),
    };
  }
  const out: string[] = [];
  const err: string[] = [];
  const readSubject = vi.fn(async () => options.subject ?? { memberStatus: 'revoked', emails: ['cook@example.com'] });
  const deps: DeleteAccountDataDeps = {
    readSubject,
    steps,
    order,
    allowedRaw: () => OWNER,
    now: () => 42,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { deps, calls, out, err, readSubject };
}

describe('runDeleteAccountData arguments', () => {
  it('prints the usage and exits 2 without a sub, before any read', async () => {
    for (const argv of [[], ['--apply'], ['  ']]) {
      const h = harness();
      expect(await runDeleteAccountData(argv, h.deps)).toBe(2);
      expect(h.err[0]).toMatch(/^Usage: /);
      expect(h.readSubject).not.toHaveBeenCalled();
    }
  });

  it('refuses a path-like sub before any read', async () => {
    for (const sub of ['a/b', '..', '.']) {
      const h = harness();
      expect(await runDeleteAccountData([sub, '--apply'], h.deps), sub).toBe(2);
      expect(h.err).toEqual(['That is not a Firestore document id.']);
      expect(h.readSubject).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
    }
  });
});

describe('runDeleteAccountData dry run', () => {
  it('inventories every step in order, applies nothing, and prints the total', async () => {
    const h = harness();
    expect(await runDeleteAccountData([SUB], h.deps)).toBe(0);
    expect(h.calls).toEqual([`inventory incomingShares ${SUB}`, `inventory invites ${SUB}`, `inventory users ${SUB}`]);
    expect(h.out).toEqual(['incomingShares: 2', 'invites: 1', 'users: 3', '6 to change. Dry run; pass --apply to delete.']);
  });

  it('notes the refusal --apply would hit, and still writes nothing', async () => {
    const h = harness({ subject: { memberStatus: 'active', emails: ['cook@example.com'] } });
    expect(await runDeleteAccountData([SUB], h.deps)).toBe(0);
    expect(h.out).toContain('Note: --apply would refuse. members/{sub} is still active. Revoke access first (README steps 1–2).');
    expect(h.calls.some((call) => call.startsWith('apply'))).toBe(false);
  });
});

describe('runDeleteAccountData --apply', () => {
  const refusals: [string, Subject, string, RegExp][] = [
    ['an active member', { memberStatus: 'active', emails: ['cook@example.com'] }, OWNER, /still active/],
    ['an owner', { memberStatus: undefined, emails: [OWNER] }, OWNER, /in ALLOWED_EMAILS/],
    ['no allowlist', { memberStatus: 'revoked', emails: ['cook@example.com'] }, '  ', /ALLOWED_EMAILS is not set/],
    ['no email on record', { memberStatus: undefined, emails: [] }, OWNER, /No email is stored/],
  ];
  for (const [label, subject, allowed, message] of refusals) {
    it(`refuses ${label} with exit 1 and applies nothing`, async () => {
      const h = harness({ subject });
      h.deps.allowedRaw = () => allowed;
      expect(await runDeleteAccountData([SUB, '--apply'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toMatch(message);
      expect(h.calls.some((call) => call.startsWith('apply'))).toBe(false);
    });
  }

  it('lets --not-owner lift only the no-email refusal', async () => {
    const noEmail = harness({ subject: { memberStatus: undefined, emails: [] } });
    expect(await runDeleteAccountData([SUB, '--apply', '--not-owner'], noEmail.deps)).toBe(0);

    const owner = harness({ subject: { memberStatus: undefined, emails: [OWNER] } });
    expect(await runDeleteAccountData([SUB, '--apply', '--not-owner'], owner.deps)).toBe(1);
    const active = harness({ subject: { memberStatus: 'active', emails: [] } });
    expect(await runDeleteAccountData([SUB, '--apply', '--not-owner'], active.deps)).toBe(1);
  });

  it('applies every step in order at one time, then confirms none remains', async () => {
    const h = harness();
    expect(await runDeleteAccountData(['--apply', SUB], h.deps)).toBe(0);
    expect(h.calls.filter((call) => call.startsWith('apply'))).toEqual([
      `apply incomingShares ${SUB} 42`,
      `apply invites ${SUB} 42`,
      `apply users ${SUB} 42`,
    ]);
    // Inventory before and after the apply.
    expect(h.calls.filter((call) => call.startsWith('inventory'))).toHaveLength(6);
    expect(h.out.at(-1)).toBe('Firestore data deleted; none remains. Now delete the photos (README step 5).');
    expect(h.err).toEqual([]);
  });

  it('exits 1 when anything is still found after the apply', async () => {
    const h = harness({ leaveBehind: 'invites' });
    expect(await runDeleteAccountData([SUB, '--apply'], h.deps)).toBe(1);
    expect(h.err).toEqual(['1 still found after apply. Run the dry run to see where.']);
  });

  it('stops at a step that throws, before the later ones', async () => {
    const h = harness();
    vi.mocked(h.deps.steps.invites.apply).mockRejectedValueOnce(new Error('2 documents remain'));
    await expect(runDeleteAccountData([SUB, '--apply'], h.deps)).rejects.toThrow('2 documents remain');
    expect(h.calls).not.toContain(`apply users ${SUB} 42`);
  });

  it('the real order deletes the profile last', () => {
    // users goes after everything that points at it. scripts/invariants.test.ts
    // checks that the order covers every personal collection once.
    expect(ACCOUNT_DELETION_ORDER.at(-1)).toBe('users');
  });
});

describe('the CLI', () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const usage = /^Usage: node --env-file=\.env\.local scripts\/delete-account-data\.ts <sub>/;
  const run = (script: string) =>
    spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, FIRESTORE_EMULATOR_HOST: '' } });

  it('still prints the usage and exits 2 with no argument', () => {
    const result = run(join(scriptsDir, 'delete-account-data.ts'));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(usage);
  });

  it('runs when reached through a symlinked directory, instead of silently exiting 0', () => {
    // A junction on Windows (no admin needed), a directory symlink elsewhere.
    const tmp = mkdtempSync(join(tmpdir(), 'sous-cli-'));
    const link = join(tmp, 'scripts-link');
    try {
      symlinkSync(scriptsDir, link, 'junction');
      const result = run(join(link, 'delete-account-data.ts'));
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(usage);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
