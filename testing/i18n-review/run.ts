/**
 * `npm run test:i18n`: the in-context translation review
 * (docs/i18n-review/README.md, docs/plans/i18n-review-ci.md) against a running
 * test-mode server. It captures each state, then has the judge review each
 * target language against English, and writes `report.md` (the README's
 * report) and `results.json` (what the daily workflow files) to the output
 * directory, with each capture as `<state>/<lang>.png` and `.txt`.
 *
 *   npm run test:i18n -- [--base-url http://localhost:4173] [--states a,b]
 *                        [--langs uk,ru] [--scope task|full] [--no-judge]
 *                        [--out dir] [--repeat 2]
 *
 * `--scope task` (the default) judges the target languages; `full` also judges
 * the English column for sense in context and layout. English is always
 * captured as the reference. Judging needs GEMINI_API_KEY (`.env.local`).
 * `--repeat 2` captures every state twice and fails on any capture that is not
 * byte-identical, the determinism check from the plan.
 *
 * Exits non-zero when a capture fails, a judge call fails, or a confirmed
 * blocker is found.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { GoogleGenAI } from '@google/genai';
import { captureState, readCaptureEnv } from './capture.ts';
import { isLang, LANGS, type Lang } from './catalog.ts';
import { CallBudget, JUDGE_MODEL, type Judgment, judgeAll, type JudgeTask, readSources, type Shot } from './judge.ts';
import { buildResults, type CaptureRow, renderReport } from './report.ts';
import { isSkipped, STATES } from './states.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:4173' },
    states: { type: 'string' },
    langs: { type: 'string' },
    out: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    scope: { type: 'string', default: 'task' },
    judge: { type: 'boolean', default: true },
  },
  allowNegative: true,
});

const baseUrl = values['base-url'].replace(/\/+$/, '');
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
  throw new Error(`--repeat must be 1, 2, or 3, not ${values.repeat}`);
}
if (values.scope !== 'task' && values.scope !== 'full') {
  throw new Error(`--scope must be task or full, not ${values.scope}`);
}
const scope: 'task' | 'full' = values.scope;
const requested = (values.langs?.split(',') ?? [...LANGS]).map((value) => value.trim());
const badLang = requested.find((value) => !isLang(value));
if (badLang !== undefined) {
  throw new Error(`Unknown language ${badLang}; use ${LANGS.join(', ')}`);
}
const judging = values.judge;
const apiKey = process.env.GEMINI_API_KEY;
if (judging && !apiKey) {
  throw new Error('Judging needs GEMINI_API_KEY (in .env.local); pass --no-judge to capture only.');
}
// English is the reference for every target language, so it is always captured.
const langs = [...new Set(['en', ...requested])] as Lang[];
// A full run judges the English column too (sense in context and layout),
// whatever --langs lists, since English is always captured.
const judgedLangs = scope === 'full' ? langs : langs.filter((lang) => lang !== 'en');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/i18n-review/screens.json'), 'utf8')) as {
  id: string;
  setup: string;
}[];
const wanted = values.states?.split(',').map((value) => value.trim()) ?? manifest.map((entry) => entry.id);
const unknown = wanted.filter((id) => !Object.hasOwn(STATES, id));
if (unknown.length > 0) {
  throw new Error(`Unknown state ids: ${unknown.join(', ')}`);
}
const date = new Date().toISOString().slice(0, 10);
const outDir = resolve(values.out ?? join(repoRoot, '.i18n-review', date));

/** The commit under review, and whether the working tree had changes on top. */
function gitState(): { commit: string | null; dirty: boolean } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  try {
    // Changes to tracked files only: a run writes its output and logs into
    // the checkout (the workflow's review/), which is not a change to review.
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' };
  } catch {
    return { commit: process.env.GITHUB_SHA ?? null, dirty: false };
  }
}

async function main(): Promise<void> {
  const env = await readCaptureEnv(baseUrl);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const rows: CaptureRow[] = [];
  const shots = new Map<string, Shot>();
  try {
    for (const state of wanted) {
      const entry = STATES[state];
      for (const lang of langs) {
        if (isSkipped(entry)) {
          rows.push({ state, lang, status: 'skipped', detail: entry.skip });
          continue;
        }
        const results = [];
        for (let run = 0; run < repeat; run++) {
          results.push(await captureState(browser, entry, lang, env));
        }
        const first = results[0];
        const dir = join(outDir, state);
        mkdirSync(dir, { recursive: true });
        if (first.status === 'failed') {
          if (first.png) writeFileSync(join(dir, `${lang}.failed.png`), first.png);
          rows.push({ state, lang, status: 'failed', detail: first.error, ms: first.ms });
          console.log(`FAIL  ${state} ${lang}: ${first.error}`);
          continue;
        }
        writeFileSync(join(dir, `${lang}.png`), first.png);
        writeFileSync(join(dir, `${lang}.txt`), first.pageText);
        shots.set(`${state}/${lang}`, { png: first.png, pageText: first.pageText });
        const hashes = results.map((r) => (r.status === 'ok' ? r.sha256 : `failed: ${r.error}`));
        const stable = hashes.every((hash) => hash === first.sha256);
        if (!stable) {
          results.forEach((r, n) => {
            if (n > 0 && r.status === 'ok') writeFileSync(join(dir, `${lang}.run${n + 1}.png`), r.png);
          });
        }
        rows.push({
          state,
          lang,
          status: stable ? 'ok' : 'unstable',
          detail: stable ? undefined : `captures differ: ${hashes.map((h) => h.slice(0, 12)).join(' ')}`,
          sha256: first.sha256,
          ms: first.ms,
        });
        console.log(`${stable ? 'ok   ' : 'DIFF '} ${state} ${lang} (${first.ms} ms)`);
      }
    }
  } finally {
    await browser.close();
  }

  const count = (status: CaptureRow['status']) => rows.filter((row) => row.status === status).length;
  console.log(
    `\n${count('ok')} captured, ${count('failed')} failed, ${count('unstable')} not deterministic, ` +
      `${count('skipped')} skipped. Output: ${outDir}`,
  );
  let failed = count('failed') + count('unstable') > 0;

  let judgments: Judgment[] | null = null;
  const budget = new CallBudget();
  if (judging && apiKey) {
    const setupOf = (id: string) => manifest.find((entry) => entry.id === id)?.setup ?? '';
    const tasks: JudgeTask[] = [];
    for (const state of wanted) {
      const reference = shots.get(`${state}/en`);
      for (const lang of judgedLangs) {
        const target = shots.get(`${state}/${lang}`);
        if (reference && target) tasks.push({ state, lang, setup: setupOf(state), reference, target });
      }
    }
    console.log(`Judging ${tasks.length} captures.`);
    judgments = await judgeAll(
      tasks,
      { ai: new GoogleGenAI({ apiKey }), sources: readSources(repoRoot) },
      budget,
      (j) => {
        if (j.status === 'error') console.log(`ERROR judging ${j.state} ${j.lang}: ${j.error}`);
        for (const f of j.confirmed) {
          console.log(`${f.severity.toUpperCase().padEnd(7)} ${j.state} ${j.lang}: "${f.text}" (${f.rubricItem}) ${f.problem}`);
        }
      },
    );
    const blockers = judgments.flatMap((j) => j.confirmed.filter((f) => f.severity === 'blocker'));
    const nits = judgments.flatMap((j) => j.confirmed.filter((f) => f.severity === 'nit'));
    const errors = judgments.filter((j) => j.status === 'error').length;
    const overBudget = judgments.filter((j) => j.status === 'budget').length;
    console.log(
      `${judgments.length} judged with ${budget.used} calls: ${blockers.length} confirmed blockers, ${nits.length} nits, ` +
        `${judgments.reduce((n, j) => n + j.unconfirmed.length, 0)} unconfirmed, ${errors} errors.`,
    );
    if (overBudget > 0) {
      console.log(`Stopped judging at MAX_JUDGE_CALLS (${budget.limit}): ${overBudget} captures not judged.`);
    }
    failed ||= blockers.length > 0 || errors > 0 || overBudget > 0;
  }

  const results = buildResults({
    date,
    ...gitState(),
    scope,
    langs,
    judgedLangs,
    model: JUDGE_MODEL,
    judgeCalls: budget.used,
    callLimit: budget.limit,
    captures: rows,
    judgments,
  });
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderReport(results));
  console.log(`Report: ${join(outDir, 'report.md')}`);
  process.exitCode = failed ? 1 : 0;
}

await main();
