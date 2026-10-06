/**
 * Turns `coverage/coverage-summary.json` (from `npm run test:coverage`) into a
 * short Markdown report for the CI job summary (docs/plans/test-coverage.md,
 * step 12):
 *
 *   node scripts/coverageSummary.ts coverage/coverage-summary.json >> "$GITHUB_STEP_SUMMARY"
 *
 * A report, not a gate: it always exits 0 once it can read the file. It shows
 * the totals, each area, and the least-covered files that are big enough to
 * matter, so a new untested module is visible in the PR.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Metric = { total: number; covered: number; pct: number };
export type FileSummary = { lines: Metric; statements: Metric; functions: Metric; branches: Metric };
export type CoverageSummary = Record<string, FileSummary>;

/** Areas in the order the report lists them. A file belongs to the first that prefixes it. */
export const AREAS = ['server/mcp/', 'server/agent/', 'server/', 'src/lib/', 'scripts/', 'api/'] as const;
/** Files with fewer measured lines than this are left out of the least-covered list. */
export const MIN_LINES_TO_LIST = 20;
export const LEAST_COVERED_COUNT = 10;

function pct(covered: number, total: number): string {
  return total === 0 ? '–' : `${((covered / total) * 100).toFixed(1)}%`;
}

export function coverageMarkdown(summary: CoverageSummary, root: string): string {
  const files = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([path, data]) => ({ path: relative(root, path).replace(/\\/g, '/'), data }));

  const total = summary.total;
  const lines: string[] = ['## Unit test coverage', ''];
  if (total !== undefined) {
    lines.push(
      `Lines **${pct(total.lines.covered, total.lines.total)}** (${total.lines.covered} of ${total.lines.total}), ` +
        `branches ${pct(total.branches.covered, total.branches.total)}, ` +
        `functions ${pct(total.functions.covered, total.functions.total)}. A report, not a gate.`,
      '',
    );
  }

  lines.push('| Area | Files | Lines | Branches |', '| --- | ---: | ---: | ---: |');
  for (const area of AREAS) {
    const inArea = files.filter((f) => AREAS.find((a) => f.path.startsWith(a)) === area);
    if (inArea.length === 0) continue;
    const sum = (pick: (d: FileSummary) => Metric) =>
      inArea.reduce((acc, f) => ({ covered: acc.covered + pick(f.data).covered, total: acc.total + pick(f.data).total }), {
        covered: 0,
        total: 0,
      });
    const l = sum((d) => d.lines);
    const b = sum((d) => d.branches);
    lines.push(`| \`${area}\` | ${inArea.length} | ${pct(l.covered, l.total)} | ${pct(b.covered, b.total)} |`);
  }

  const least = files
    .filter((f) => f.data.lines.total >= MIN_LINES_TO_LIST)
    .sort((a, b) => a.data.lines.pct - b.data.lines.pct || b.data.lines.total - a.data.lines.total)
    .slice(0, LEAST_COVERED_COUNT);
  if (least.length > 0) {
    lines.push('', `Least covered (at least ${MIN_LINES_TO_LIST} lines):`, '', '| File | Lines | Uncovered lines |', '| --- | ---: | ---: |');
    for (const f of least) {
      const { covered, total: count } = f.data.lines;
      lines.push(`| \`${f.path}\` | ${pct(covered, count)} | ${count - covered} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const path = process.argv[2] ?? 'coverage/coverage-summary.json';
  const summary = JSON.parse(readFileSync(path, 'utf8')) as CoverageSummary;
  process.stdout.write(coverageMarkdown(summary, resolve('.')));
}
