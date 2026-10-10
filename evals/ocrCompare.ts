/**
 * Compares two ways of reading the handwritten fixtures in
 * `evals/import-handwritten/dev/` and `holdout/`:
 *
 * - A (production): the photos go straight to Gemini (`importFromImages`).
 * - B (Cloud Vision → Gemini): DOCUMENT_TEXT_DETECTION per page, then Gemini
 *   on the joined OCR text (`importFromSource`).
 *
 * For each fixture and run it prints latency, tokens, estimated cost, the
 * judge's verdict against `golden.json`, and `calls` (Gemini invocations,
 * including a retry, not successes). A progress bar shows finished calls,
 * calls left, and an estimate of the time left. In a terminal that bar stays
 * on one line and is redrawn in place; piped output prints a new line so a
 * saved log stays plain text.
 *
 *   node --env-file=.env.local evals/ocrCompare.ts [fixture…] [--runs=N]
 *     [--split=dev|holdout|all] [--thinking=minimal|low|medium|high]
 *   npm run eval:ocr-compare
 *
 * `--split` defaults to `dev`. `--thinking` applies to approach A only. It is
 * for experiments and does not change production. Holdout rows hide judge
 * reasons (see `evals/AGENTS.md`).
 *
 * A needs `GEMINI_API_KEY` (the judge uses it too). B needs Application
 * Default Credentials with `vision.googleapis.com` enabled on the quota
 * project, and is skipped with a message without them. Never runs in CI. The
 * numbers inform principle 2's "When to revisit" in
 * `docs/constitutions/image-import.md`; they do not block shipping.
 *
 * Output is stdout only, with no base64, OCR text, or request bodies, and no
 * result files: transcriptions of personal notes are personal data. Exits 0
 * whatever the judge says; non-zero only for a harness error.
 */
import { ThinkingLevel } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import {
  importFromImages,
  importFromSource,
  recipeImportDepsFromEnv,
  type ImportImage,
  type ImportOutcome,
  type ImportedRecipe,
  type RecipeImportDeps,
} from '../server/recipeImport.ts';
import {
  listHandwrittenFixtures,
  type HandwrittenFixture,
  type HandwrittenSplit,
} from './handwrittenFixtures.ts';
import { ingredientCount, judgeRecipe } from './judge.ts';

// Estimates carried over from the owner-approved plan for gemini-3.7-flash (not
// on the public pricing page); not rechecked for gemini-3.8-flash.
const GEMINI_INPUT_USD_PER_MTOK = 1.5;
/** Applies to candidates plus thoughts. */
const GEMINI_OUTPUT_USD_PER_MTOK = 9;
/** List price after the free 1,000 units a month. */
const VISION_USD_PER_UNIT = 1.5 / 1000;

const VISION_URL = 'https://eu-vision.googleapis.com/v1/images:annotate';

const MAX_RUNS = 5;

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

// Neither the Gemini SDK nor fetch times out by default; one stalled call would
// hang the whole run with nothing printed.
const GEMINI_TIMEOUT_MS = 90_000;
const JUDGE_TIMEOUT_MS = 2 * GEMINI_TIMEOUT_MS;
const VISION_TIMEOUT_MS = 30_000;
const ADC_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Approach = 'A' | 'B';

type RunKind = ImportOutcome['kind'] | 'gemini_error' | 'vision_error';

interface TokenUsage {
  prompt: number;
  output: number;
  thinking: number;
  /** Gemini `finishReason` per call, joined with `+`; anything but STOP means the reply was cut short. */
  finish: string;
}

interface RunResult {
  fixture: string;
  split: HandwrittenSplit;
  run: number;
  approach: Approach;
  calls: number;
  kind: RunKind;
  pages: number;
  visionMs: number;
  geminiMs: number;
  tokens: TokenUsage;
  visionUnits: number;
  geminiUsd: number;
  judge: 'pass' | 'fail' | 'error' | '—';
  judgeFailures: { field: string; reason: string }[];
  ingredientDelta: number | null;
  stepDelta: number | null;
}

interface VisionPageResponse {
  error?: unknown;
  fullTextAnnotation?: { text?: string };
}

type VisionOcr =
  | { kind: 'ok'; text: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'vision_error' };

function recordingDeps(
  base: RecipeImportDeps,
  thinkingLevel?: ThinkingLevel,
): { deps: RecipeImportDeps; usage: TokenUsage[]; counter: { calls: number } } {
  const usage: TokenUsage[] = [];
  const counter = { calls: 0 };
  const deps: RecipeImportDeps = {
    model: base.model,
    translator: base.translator,
    ai: {
      models: {
        generateContent: async (params) => {
          counter.calls += 1;
          const request =
            thinkingLevel !== undefined
              ? {
                  ...params,
                  config: {
                    ...params.config,
                    thinkingConfig: {
                      ...params.config?.thinkingConfig,
                      thinkingLevel,
                    },
                  },
                }
              : params;
          const response = await withTimeout(
            base.ai.models.generateContent(request),
            GEMINI_TIMEOUT_MS,
            'Gemini',
          );
          usage.push({
            prompt: response.usageMetadata?.promptTokenCount ?? 0,
            output: response.usageMetadata?.candidatesTokenCount ?? 0,
            thinking: response.usageMetadata?.thoughtsTokenCount ?? 0,
            finish: response.candidates?.[0]?.finishReason ?? 'none',
          });
          return response;
        },
      },
    },
  };
  return { deps, usage, counter };
}

function sumUsage(usage: readonly TokenUsage[]): TokenUsage {
  return usage.reduce(
    (total, row) => ({
      prompt: total.prompt + row.prompt,
      output: total.output + row.output,
      thinking: total.thinking + row.thinking,
      finish: total.finish === '' ? row.finish : `${total.finish}+${row.finish}`,
    }),
    { prompt: 0, output: 0, thinking: 0, finish: '' },
  );
}

function geminiUsd(tokens: TokenUsage): number {
  return (
    (tokens.prompt * GEMINI_INPUT_USD_PER_MTOK +
      (tokens.output + tokens.thinking) * GEMINI_OUTPUT_USD_PER_MTOK) /
    1_000_000
  );
}

function parseArgs(argv: readonly string[]): {
  names: string[];
  runs: number;
  split: HandwrittenSplit | 'all';
  thinking: ThinkingLevel | undefined;
} {
  const names: string[] = [];
  let runs = 1;
  let split: HandwrittenSplit | 'all' = 'dev';
  let thinking: ThinkingLevel | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--runs=')) {
      const n = Number.parseInt(arg.slice('--runs='.length), 10);
      runs = Number.isFinite(n) ? Math.min(MAX_RUNS, Math.max(1, n)) : 1;
    } else if (arg.startsWith('--split=')) {
      const value = arg.slice('--split='.length);
      if (value !== 'dev' && value !== 'holdout' && value !== 'all') {
        console.error('--split must be dev, holdout, or all.');
        process.exit(1);
      }
      split = value;
    } else if (arg.startsWith('--thinking=')) {
      const key = arg.slice('--thinking='.length).toLowerCase();
      if (!Object.hasOwn(THINKING_LEVELS, key)) {
        console.error('--thinking must be minimal, low, medium, or high.');
        process.exit(1);
      }
      thinking = THINKING_LEVELS[key];
    } else {
      names.push(arg);
    }
  }
  return { names, runs, split, thinking };
}

async function visionOcr(pages: readonly ImportImage[], auth: Headers): Promise<VisionOcr> {
  const headers = new Headers(auth);
  headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(VISION_URL, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      body: JSON.stringify({
        requests: pages.map((p) => ({
          image: { content: p.base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        })),
      }),
    });
  } catch {
    return { kind: 'vision_error' };
  }
  if (res.status === 401 || res.status === 403) {
    let errorStatus = 'UNKNOWN';
    try {
      const body = (await res.json()) as { error?: { status?: unknown } };
      if (typeof body.error?.status === 'string') errorStatus = body.error.status;
    } catch {
      // Keep UNKNOWN.
    }
    return {
      kind: 'denied',
      reason:
        `Cloud Vision returned ${res.status} ${errorStatus}. ` +
        'Enable vision.googleapis.com on cooking-assistant-508423 and check the ADC quota project.',
    };
  }
  if (!res.ok) return { kind: 'vision_error' };
  let responses: VisionPageResponse[];
  try {
    const body = (await res.json()) as { responses?: VisionPageResponse[] };
    if (!Array.isArray(body.responses) || body.responses.length !== pages.length) {
      return { kind: 'vision_error' };
    }
    responses = body.responses;
  } catch {
    return { kind: 'vision_error' };
  }
  if (responses.some((r) => r.error !== undefined)) return { kind: 'vision_error' };
  return {
    kind: 'ok',
    text: responses
      .map((r, i) => `Page ${i + 1}:\n${r.fullTextAnnotation?.text ?? ''}`)
      .join('\n\n'),
  };
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T | null; ms: number }> {
  const start = performance.now();
  try {
    const value = await run();
    return { value, ms: performance.now() - start };
  } catch {
    // Not logged: SDK errors can echo the request.
    return { value: null, ms: performance.now() - start };
  }
}

async function judged(
  result: Omit<RunResult, 'judge' | 'judgeFailures' | 'ingredientDelta' | 'stepDelta'>,
  outcome: ImportOutcome | null,
  golden: ImportedRecipe,
): Promise<RunResult> {
  if (outcome === null || outcome.kind !== 'ok') {
    return { ...result, judge: '—', judgeFailures: [], ingredientDelta: null, stepDelta: null };
  }
  const recipe = outcome.recipe;
  const deltas = {
    ingredientDelta: ingredientCount(recipe) - ingredientCount(golden),
    stepDelta: recipe.steps.length - golden.steps.length,
  };
  try {
    const verdict = await withTimeout(judgeRecipe(recipe, golden), JUDGE_TIMEOUT_MS, 'Judge');
    return {
      ...result,
      ...deltas,
      judge: verdict.pass ? 'pass' : 'fail',
      judgeFailures: verdict.failures,
    };
  } catch {
    return { ...result, ...deltas, judge: 'error', judgeFailures: [] };
  }
}

async function runA(
  fixture: HandwrittenFixture,
  run: number,
  base: RecipeImportDeps,
  thinkingLevel?: ThinkingLevel,
): Promise<RunResult> {
  const { deps, usage, counter } = recordingDeps(base, thinkingLevel);
  const { value: outcome, ms } = await timed(() => importFromImages(fixture.pages, '', deps));
  const tokens = sumUsage(usage);
  return judged(
    {
      fixture: fixture.name,
      split: fixture.split,
      calls: counter.calls,
      run,
      approach: 'A',
      kind: outcome?.kind ?? 'gemini_error',
      pages: fixture.pages.length,
      visionMs: 0,
      geminiMs: ms,
      tokens,
      visionUnits: 0,
      geminiUsd: geminiUsd(tokens),
    },
    outcome,
    fixture.golden,
  );
}

async function runB(
  fixture: HandwrittenFixture,
  run: number,
  base: RecipeImportDeps,
  auth: Headers,
): Promise<RunResult | { kind: 'denied'; reason: string }> {
  const visionStart = performance.now();
  const ocr = await visionOcr(fixture.pages, auth);
  const visionMs = performance.now() - visionStart;
  if (ocr.kind === 'denied') return ocr;
  const shared = {
    fixture: fixture.name,
    split: fixture.split,
    run,
    approach: 'B' as const,
    pages: fixture.pages.length,
    visionMs,
    visionUnits: fixture.pages.length,
  };
  if (ocr.kind === 'vision_error') {
    return judged(
      {
        ...shared,
        calls: 0,
        kind: 'vision_error',
        geminiMs: 0,
        tokens: { prompt: 0, output: 0, thinking: 0, finish: '—' },
        geminiUsd: 0,
      },
      null,
      fixture.golden,
    );
  }
  const { deps, usage, counter } = recordingDeps(base);
  const { value: outcome, ms } = await timed(() => importFromSource(ocr.text, deps));
  const tokens = sumUsage(usage);
  return judged(
    {
      ...shared,
      calls: counter.calls,
      kind: outcome?.kind ?? 'gemini_error',
      geminiMs: ms,
      tokens,
      geminiUsd: geminiUsd(tokens),
    },
    outcome,
    fixture.golden,
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((n, v) => n + v, 0) / values.length;
}

function usd(value: number): number {
  return Number(value.toFixed(5));
}

const BAR_WIDTH = 24;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return minutes === 0 ? `${rest}s` : `${minutes}m${String(rest).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Finished calls against the planned total, plus a time estimate once one call has finished. */
function progressPrefix(done: number, total: number, startedAt: number): string {
  const filled = total === 0 ? 0 : Math.round((BAR_WIDTH * done) / total);
  const clamped = Math.min(BAR_WIDTH, Math.max(0, filled));
  const bar = `${'#'.repeat(clamped)}${'-'.repeat(BAR_WIDTH - clamped)}`;
  const left = Math.max(0, total - done);
  let eta = '';
  if (done > 0 && left > 0) {
    const elapsed = performance.now() - startedAt;
    eta = `, eta ${formatDuration((elapsed / done) * left)}`;
  }
  return `[${bar}] ${done}/${total}, ${left} left${eta}`;
}

function tableRow(r: RunResult): Record<string, string | number> {
  return {
    fixture: r.fixture,
    split: r.split,
    run: r.run,
    approach: r.approach,
    outcome: r.kind,
    calls: r.calls,
    'vision ms': Math.round(r.visionMs),
    'gemini ms': Math.round(r.geminiMs),
    'total ms': Math.round(r.visionMs + r.geminiMs),
    'prompt tok': r.tokens.prompt,
    'output tok': r.tokens.output,
    'thinking tok': r.tokens.thinking,
    finish: r.tokens.finish,
    'vision units': r.visionUnits,
    'est USD': usd(r.geminiUsd + r.visionUnits * VISION_USD_PER_UNIT),
    judge: r.judge,
    'Δ ingredients': r.ingredientDelta ?? '—',
    'Δ steps': r.stepDelta ?? '—',
  };
}

function summaryRow(
  split: HandwrittenSplit,
  approach: Approach,
  rows: readonly RunResult[],
): Record<string, string | number> {
  const passes = rows.filter((r) => r.judge === 'pass').length;
  const row: Record<string, string | number> = {
    split,
    approach,
    passes: `${passes}/${rows.length}`,
    'median total ms': Math.round(median(rows.map((r) => r.visionMs + r.geminiMs))),
    'mean USD': usd(mean(rows.map((r) => r.geminiUsd + r.visionUnits * VISION_USD_PER_UNIT))),
  };
  if (approach === 'B') row['mean USD (free tier)'] = usd(mean(rows.map((r) => r.geminiUsd)));
  row['mean prompt tok/page'] = Math.round(mean(rows.map((r) => r.tokens.prompt / r.pages)));
  return row;
}

async function main(): Promise<number> {
  const { names, runs, split, thinking } = parseArgs(process.argv.slice(2));

  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('GEMINI_API_KEY is required. Put it in .env.local (same as dev:api).');
    return 1;
  }

  let fixtures: HandwrittenFixture[];
  try {
    fixtures =
      split === 'all'
        ? [...listHandwrittenFixtures('dev'), ...listHandwrittenFixtures('holdout')]
        : listHandwrittenFixtures(split);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (names.length > 0) {
    for (const name of names) {
      if (!fixtures.some((f) => f.name === name)) {
        console.log(`No fixture named ${name} in split ${split}; ignoring it.`);
      }
    }
    fixtures = fixtures.filter((f) => names.includes(f.name));
  }
  if (fixtures.length === 0) {
    const where = split === 'all' ? '{dev,holdout}' : split;
    console.log(
      `No handwritten fixtures in evals/import-handwritten/${where}/. See evals/README.md to add some.`,
    );
    return 0;
  }

  const b: { auth: Headers | null; skipped: string | null } = { auth: null, skipped: null };
  // Set while the bar occupies the current terminal line, so the next log
  // line clears it instead of appending after a partial redraw.
  let progressOpen = false;
  const clearSticky = (): void => {
    if (!progressOpen) return;
    process.stdout.write('\r\x1b[K');
    progressOpen = false;
  };
  const skipB = (reason: string): void => {
    if (b.skipped !== null) return;
    b.skipped = reason;
    b.auth = null;
    clearSticky();
    console.log(`Skipping B (Cloud Vision → Gemini): ${reason}`);
  };

  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    b.auth = await withTimeout(auth.getRequestHeaders(VISION_URL), ADC_TIMEOUT_MS, 'ADC lookup');
  } catch {
    skipB(
      'no Application Default Credentials (or the lookup timed out). Run gcloud auth application-default login, then gcloud auth application-default set-quota-project cooking-assistant-508423.',
    );
  }

  const base = recipeImportDepsFromEnv();
  const results: RunResult[] = [];
  let total = fixtures.length * runs * (b.auth !== null ? 2 : 1);
  let done = 0;
  const startedAt = performance.now();
  const sticky = process.stdout.isTTY;
  const paint = (label: string): void => {
    const line = `${progressPrefix(done, total, startedAt)}  ${label}`;
    if (sticky) {
      process.stdout.write(`\r\x1b[K${line}`);
      progressOpen = true;
      return;
    }
    console.log(line);
  };
  const record = (r: RunResult): void => {
    results.push(r);
    done += 1;
    const detail = `${r.split}/${r.fixture} run ${r.run} ${r.approach}: ${r.kind}, ${Math.round(r.visionMs + r.geminiMs)} ms, calls ${r.calls}, finish ${r.tokens.finish}, judge ${r.judge}`;
    if (sticky) {
      clearSticky();
      console.log(detail);
      return;
    }
    console.log(`${progressPrefix(done, total, startedAt)}  ${detail}`);
  };
  console.log(
    `Running ${fixtures.length} fixture(s) x ${runs} run(s), split ${split}, thinking ${thinking ?? 'model default'} (A only): A${b.auth !== null ? ' and B' : ''}. ${total} call(s).`,
  );
  for (const fixture of fixtures) {
    for (let run = 1; run <= runs; run++) {
      const where = `${fixture.split}/${fixture.name} run ${run}`;
      paint(`${where} A …`);
      record(await runA(fixture, run, base, thinking));
      if (b.auth !== null) {
        paint(`${where} B …`);
        const result = await runB(fixture, run, base, b.auth);
        if (result.kind === 'denied') {
          skipB(result.reason);
          const fixtureIndex = fixtures.indexOf(fixture);
          const remainingB = runs - run + (fixtures.length - fixtureIndex - 1) * runs;
          total -= remainingB;
          done += 1;
          paint('B skipped');
        } else {
          record(result);
        }
      }
    }
  }
  if (sticky) {
    paint('done');
    process.stdout.write('\n');
    progressOpen = false;
  }

  console.table(results.map(tableRow));

  const failures = results.filter((r) => r.judgeFailures.length > 0);
  if (failures.length > 0) {
    console.log('Judge failures:');
    for (const r of failures) {
      if (r.split === 'holdout') {
        console.log(
          `  holdout/${r.fixture} run ${r.run} ${r.approach} — judge failed with ${r.judgeFailures.length} reason(s) (hidden: holdout)`,
        );
        continue;
      }
      for (const f of r.judgeFailures) {
        console.log(`  dev/${r.fixture} run ${r.run} ${r.approach} — ${f.field}: ${f.reason}`);
      }
    }
  }

  const summary = (['dev', 'holdout'] as const).flatMap((rowSplit) =>
    (['A', 'B'] as const)
      .map((approach) => ({
        approach,
        rows: results.filter((r) => r.split === rowSplit && r.approach === approach),
      }))
      .filter(({ rows }) => rows.length > 0)
      .map(({ approach, rows }) => summaryRow(rowSplit, approach, rows)),
  );
  console.log('Summary:');
  console.table(summary);
  if (b.skipped !== null) console.log(`B was skipped: ${b.skipped}`);
  return 0;
}

// exit() rather than exitCode: a timed-out request can keep a socket open.
process.exit(await main());
