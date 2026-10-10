/**
 * Keeps one GitHub issue of open findings from the scheduled in-context
 * translation review (docs/plans/i18n-review-ci.md, step 6). The functions
 * here are pure; the command at the bottom reads and writes the issue with
 * `gh`. It imports only Node built-ins at run time, so `should-run` works
 * before `npm ci`.
 *
 *   node testing/i18n-review/issue.ts should-run --event schedule --sha <sha>
 *   node testing/i18n-review/issue.ts update --results review/results.json
 *   node testing/i18n-review/issue.ts update --results r.json --dry-run \
 *        [--previous-body old.md] [--out dir]
 *
 * The issue's state (the last fully reviewed commit and every open finding)
 * lives in a hidden comment in its body, so the workflow needs no other
 * storage. `update` exits 1 after updating the issue when the run itself was
 * unhealthy (a capture failed or was not deterministic, a judge call failed,
 * or the call limit cut it short); findings alone are not a failure, since
 * the issue is where they go.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inline } from './markdown.ts';
import type { Cell, ResultFinding, Results } from './report.ts';

export const ISSUE_TITLE = 'In-context translation review: open findings';
export const ISSUE_LABEL = 'i18n-review';
const STATE_MARKER = 'i18n-review-state:';

/** A finding the issue lists, with when it was first and last seen. */
export interface TrackedFinding {
  fingerprint: string;
  state: string;
  lang: string;
  severity: 'blocker' | 'nit';
  rubricItem: string;
  text: string;
  problem: string;
  suggestion: string;
  candidateKeys: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface IssueState {
  version: 1;
  /** The last commit a complete full run reviewed; a scheduled run on it is skipped. */
  commit: string | null;
  findings: TrackedFinding[];
}

/** One entry of docs/i18n-review/accepted.json. */
export interface AcceptedFinding {
  fingerprint: string;
  reason: string;
  date: string;
  /** For people reading the file; only the fingerprint is matched. */
  state?: string;
  lang?: string;
  text?: string;
}

export interface UpdateInput {
  results: Results;
  previous: IssueState | null;
  accepted: AcceptedFinding[];
  /** Every manifest id, to tell a full run from a partial one. */
  manifestIds: string[];
  allLangs: string[];
  /** The workflow run, where the report and screenshots are. */
  runUrl: string | null;
}

export interface IssueUpdate {
  body: string;
  /** Posted only when findings appeared, were resolved, or were accepted. */
  comment: string | null;
  /** Whether the issue should be open: any finding still open. */
  open: boolean;
  state: IssueState;
  /** The run could not judge everything it should have. */
  unhealthy: Cell[];
}

const JUDGED = new Set(['pass', 'fail']);
const UNHEALTHY = new Set(['capture failed', 'not deterministic', 'judge error', 'not judged: call limit', 'not judged: no reference']);

const cellKey = (state: string, lang: string) => `${state}/${lang}`;

export function parseState(body: string | null | undefined): IssueState | null {
  const match = body === null || body === undefined ? null : new RegExp(`<!-- ${STATE_MARKER}([A-Za-z0-9+/=]+) -->`).exec(body);
  if (match === null) return null;
  try {
    const state = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as IssueState;
    return state.version === 1 && Array.isArray(state.findings) ? state : null;
  } catch {
    return null;
  }
}

/** Base64 so no text in a finding can close the HTML comment early. */
function stateComment(state: IssueState): string {
  return `<!-- ${STATE_MARKER}${Buffer.from(JSON.stringify(state), 'utf8').toString('base64')} -->`;
}

/** A scheduled run on a commit already fully reviewed is skipped; a dispatched run always runs. */
export function shouldRun(event: string, sha: string, previous: IssueState | null): { run: boolean; reason: string } {
  if (event !== 'schedule') return { run: true, reason: `a ${event} run always runs` };
  if (previous?.commit === sha) return { run: false, reason: `main is still ${sha.slice(0, 12)}, already reviewed` };
  return { run: true, reason: previous?.commit ? `main moved from ${previous.commit.slice(0, 12)}` : 'no reviewed commit yet' };
}

function track(finding: ResultFinding, date: string, previous: TrackedFinding | undefined): TrackedFinding {
  return {
    fingerprint: finding.fingerprint,
    state: finding.state,
    lang: finding.lang,
    severity: finding.severity,
    rubricItem: finding.rubricItem,
    text: finding.text,
    problem: finding.problem,
    suggestion: finding.suggestion,
    candidateKeys: finding.candidateKeys.map((k) => (k.catalog === finding.lang ? k.key : `${k.key} (${k.catalog})`)),
    firstSeen: previous?.firstSeen ?? date,
    lastSeen: date,
  };
}

const byPlace = (a: TrackedFinding, b: TrackedFinding) =>
  a.state.localeCompare(b.state) || a.lang.localeCompare(b.lang) || a.text.localeCompare(b.text);

export function planUpdate(input: UpdateInput): IssueUpdate {
  const { results, accepted } = input;
  const date = results.date;
  const acceptedIds = new Set(accepted.map((a) => a.fingerprint));
  const previousFindings = input.previous?.findings ?? [];
  const before = new Map(previousFindings.map((f) => [f.fingerprint, f]));
  const judged = new Set(results.cells.filter((c) => JUDGED.has(c.result)).map((c) => cellKey(c.state, c.lang)));

  // Confirmed findings of this run; unconfirmed ones are never filed.
  const current = new Map<string, TrackedFinding>();
  for (const finding of results.findings) {
    if (!finding.confirmed || acceptedIds.has(finding.fingerprint) || current.has(finding.fingerprint)) continue;
    current.set(finding.fingerprint, track(finding, date, before.get(finding.fingerprint)));
  }
  // A finding on a screen this run did not judge (out of a partial run's
  // scope, or a failed capture) stays open as it was.
  const carried = previousFindings.filter(
    (f) => !current.has(f.fingerprint) && !acceptedIds.has(f.fingerprint) && !judged.has(cellKey(f.state, f.lang)),
  );
  const resolved = previousFindings.filter(
    (f) => !current.has(f.fingerprint) && !acceptedIds.has(f.fingerprint) && judged.has(cellKey(f.state, f.lang)),
  );
  const newlyAccepted = previousFindings.filter((f) => acceptedIds.has(f.fingerprint));
  const added = [...current.values()].filter((f) => !before.has(f.fingerprint));
  const open = [...current.values(), ...carried].sort(byPlace);

  const unhealthy = results.cells.filter((c) => UNHEALTHY.has(c.result));
  const covered = new Set(results.cells.map((c) => cellKey(c.state, c.lang)));
  const full = input.manifestIds.every((id) => input.allLangs.every((lang) => covered.has(cellKey(id, lang))));
  const state: IssueState = {
    version: 1,
    // Only a complete full run lets a later scheduled run skip this commit.
    commit: full && unhealthy.length === 0 && results.judged ? results.commit : (input.previous?.commit ?? null),
    findings: open,
  };

  return {
    body: renderBody(results, open, unhealthy, input.runUrl, full, state, accepted.length),
    comment:
      added.length + resolved.length + newlyAccepted.length === 0
        ? null
        : renderComment(added, resolved, newlyAccepted, results, input.runUrl),
    open: open.length > 0,
    state,
    unhealthy,
  };
}

function findingRow(f: TrackedFinding): string {
  const keys = f.candidateKeys.length === 0 ? 'none found' : f.candidateKeys.map((k) => `\`${k}\``).join(', ');
  return `| ${f.state} | ${f.lang} | “${inline(f.text)}” | ${inline(f.problem)} | ${inline(f.suggestion)} | ${keys} | ${f.firstSeen} |`;
}

function findingTable(findings: TrackedFinding[]): string[] {
  return [
    '| Screen | Language | Text | Problem | Suggestion | Candidate keys | First seen |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...findings.map(findingRow),
  ];
}

function commitText(results: Results): string {
  if (results.commit === null) return 'an unknown commit';
  return `\`${results.commit.slice(0, 12)}\`${results.dirty ? ' with uncommitted changes' : ''}`;
}

export function renderBody(
  results: Results,
  open: TrackedFinding[],
  unhealthy: Cell[],
  runUrl: string | null,
  full: boolean,
  state: IssueState,
  acceptedCount: number,
): string {
  const blockers = open.filter((f) => f.severity === 'blocker');
  const nits = open.filter((f) => f.severity === 'nit');
  const states = new Set(results.cells.map((c) => c.state)).size;
  const lines: string[] = [
    'The scheduled in-context translation review of `main` (`npm run test:i18n`, `docs/i18n-review/README.md`) rewrites this issue after each run.',
    '',
    `**Last run:** ${results.date}, ${commitText(results)}, ${full ? 'full' : 'partial'}: ${states} screens in ${results.langs.join(', ')}; ${results.judgeCalls} judge calls.${runUrl === null ? '' : ` [Report and screenshots](${runUrl}).`}`,
    '',
    'Suggestions are the judge model’s and can be wrong. A fix goes through a normal review, with `npm run test:i18n` on the screens it touches. To keep a finding out of this issue, add its fingerprint to `docs/i18n-review/accepted.json` with a reason.',
    '',
  ];
  if (open.length === 0) {
    lines.push('**No open findings.**', '');
  }
  if (blockers.length > 0) {
    lines.push(`### Blockers (${blockers.length})`, '', ...findingTable(blockers), '');
  }
  if (nits.length > 0) {
    lines.push('<details>', `<summary>Nits (${nits.length})</summary>`, '', ...findingTable(nits), '', '</details>', '');
  }
  if (unhealthy.length > 0) {
    lines.push(
      `### Not judged in this run (${unhealthy.length})`,
      '',
      'Findings on these screens stay as they were until a run judges them again.',
      '',
      ...unhealthy.map((c) => `- ${c.state} · ${c.lang} · ${c.result}${c.detail ? `: ${inline(c.detail)}` : ''}`),
      '',
    );
  }
  const skipped = new Map<string, string[]>();
  for (const c of results.cells) {
    if (!c.result.startsWith('skipped: ')) continue;
    const reason = c.result.slice('skipped: '.length);
    const ids = skipped.get(reason) ?? [];
    if (!ids.includes(c.state)) ids.push(c.state);
    skipped.set(reason, ids);
  }
  if (skipped.size > 0) {
    lines.push('### Skipped screens', '', ...[...skipped].map(([reason, ids]) => `- ${reason}: ${ids.join(', ')}`), '');
  }
  if (acceptedCount > 0) {
    lines.push(`${acceptedCount} accepted finding(s) in \`docs/i18n-review/accepted.json\` are left out.`, '');
  }
  const fingerprints = open.map((f) => `${f.fingerprint} ${f.state}/${f.lang}`).join(', ');
  if (fingerprints !== '') {
    lines.push('<details>', '<summary>Fingerprints</summary>', '', fingerprints, '', '</details>', '');
  }
  lines.push(stateComment(state));
  return lines.join('\n');
}

function listLine(f: TrackedFinding): string {
  return `- ${f.state} · ${f.lang} · ${f.severity}: “${inline(f.text)}”`;
}

export function renderComment(
  added: TrackedFinding[],
  resolved: TrackedFinding[],
  accepted: TrackedFinding[],
  results: Results,
  runUrl: string | null,
): string {
  const lines = [`Review of ${commitText(results)} on ${results.date}${runUrl === null ? '' : ` ([run](${runUrl}))`}:`, ''];
  if (added.length > 0) lines.push(`**New (${added.length})**`, ...added.sort(byPlace).map(listLine), '');
  if (resolved.length > 0) lines.push(`**Resolved (${resolved.length})**`, ...resolved.sort(byPlace).map(listLine), '');
  if (accepted.length > 0) lines.push(`**Accepted (${accepted.length})**`, ...accepted.sort(byPlace).map(listLine), '');
  return lines.join('\n').trimEnd();
}

// ---- The command ----

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface IssueRef {
  number: number;
  state: 'OPEN' | 'CLOSED';
  body: string;
}

function gh(args: string[], input?: string): string {
  const repo = process.env.GITHUB_REPOSITORY;
  return execFileSync('gh', [...args, ...(repo ? ['--repo', repo] : [])], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function findIssue(): IssueRef | null {
  const rows = JSON.parse(
    gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'all', '--limit', '50', '--json', 'number,state,body,title']),
  ) as (IssueRef & { title: string })[];
  const ours = rows.filter((r) => r.title === ISSUE_TITLE).sort((a, b) => a.number - b.number);
  return ours[0] ?? null;
}

function output(name: string, value: string): void {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function runUrlFromEnv(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      event: { type: 'string', default: 'workflow_dispatch' },
      sha: { type: 'string' },
      results: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'previous-body': { type: 'string' },
      out: { type: 'string' },
    },
  });

  if (command === 'should-run') {
    if (!values.sha) throw new Error('should-run needs --sha');
    const issue = findIssue();
    const decision = shouldRun(values.event, values.sha, parseState(issue?.body));
    console.log(decision.reason);
    output('run', String(decision.run));
    return;
  }

  if (command !== 'update') throw new Error('usage: issue.ts should-run|update …');
  if (!values.results || !existsSync(values.results)) throw new Error(`no results at ${values.results ?? '(none given)'}`);
  const dryRun = values['dry-run'];
  const issue = dryRun ? null : findIssue();
  const previousBody =
    values['previous-body'] !== undefined ? readFileSync(values['previous-body'], 'utf8') : (issue?.body ?? null);
  const manifest = readJson<{ id: string }[]>(join(repoRoot, 'docs/i18n-review/screens.json'));
  const update = planUpdate({
    results: readJson<Results>(values.results),
    previous: parseState(previousBody),
    accepted: readJson<AcceptedFinding[]>(join(repoRoot, 'docs/i18n-review/accepted.json')),
    manifestIds: manifest.map((m) => m.id),
    allLangs: ['en', 'uk', 'ru', 'zh-Hans'],
    runUrl: runUrlFromEnv(),
  });

  if (dryRun) {
    if (values.out) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, 'body.md'), update.body);
      if (update.comment !== null) writeFileSync(join(values.out, 'comment.md'), update.comment);
    }
    console.log(`--- issue would be ${update.open ? 'open' : 'closed'} ---\n${update.body}\n`);
    console.log(update.comment === null ? '--- no comment ---' : `--- comment ---\n${update.comment}`);
  } else {
    gh(['label', 'create', ISSUE_LABEL, '--color', '1D76DB', '--description', 'Scheduled in-context translation review', '--force']);
    let number = issue?.number;
    let isOpen = issue?.state === 'OPEN';
    if (number === undefined) {
      const url = gh(['issue', 'create', '--title', ISSUE_TITLE, '--label', ISSUE_LABEL, '--body-file', '-'], update.body).trim();
      number = Number(url.split('/').pop());
      isOpen = true;
      console.log(`Created ${url}`);
    } else {
      gh(['issue', 'edit', String(number), '--body-file', '-'], update.body);
    }
    if (update.comment !== null) gh(['issue', 'comment', String(number), '--body-file', '-'], update.comment);
    if (update.open && !isOpen) gh(['issue', 'reopen', String(number)]);
    if (!update.open && isOpen) gh(['issue', 'close', String(number), '--reason', 'completed']);
    console.log(`Issue #${number}: ${update.state.findings.length} open finding(s), ${update.open ? 'open' : 'closed'}.`);
  }
  if (update.unhealthy.length > 0) {
    console.log(`The run did not judge ${update.unhealthy.length} capture(s); see "Not judged in this run".`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
