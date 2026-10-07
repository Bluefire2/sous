import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverageMarkdown, type CoverageSummary, type FileSummary } from './coverageSummary.ts';

const ROOT = join('/', 'repo');

function file(covered: number, total: number, branches: [number, number] = [1, 2]): FileSummary {
  const metric = (c: number, t: number) => ({ covered: c, total: t, pct: t === 0 ? 100 : (c / t) * 100 });
  return {
    lines: metric(covered, total),
    statements: metric(covered, total),
    functions: metric(1, 1),
    branches: metric(branches[0], branches[1]),
  };
}

const summary: CoverageSummary = {
  total: file(180, 240, [30, 40]),
  [join(ROOT, 'server', 'sync.ts')]: file(90, 100),
  [join(ROOT, 'server', 'mcp', 'tools.ts')]: file(40, 50),
  [join(ROOT, 'src', 'lib', 'remote.ts')]: file(10, 40),
  [join(ROOT, 'scripts', 'devPorts.ts')]: file(5, 5),
  [join(ROOT, 'api', 'chat.ts')]: file(35, 45),
};

describe('coverageMarkdown', () => {
  const md = coverageMarkdown(summary, ROOT);

  it('states the totals and that it is not a gate', () => {
    expect(md).toContain('Lines **75.0%** (180 of 240), branches 75.0%, functions 100.0%. A report, not a gate.');
  });

  it('puts each file in its most specific area, with forward slashes', () => {
    expect(md).toContain('| `server/mcp/` | 1 | 80.0% | 50.0% |');
    expect(md).toContain('| `server/` | 1 | 90.0% | 50.0% |');
    expect(md).toContain('| `src/lib/` | 1 | 25.0% | 50.0% |');
    expect(md).not.toContain('`server/agent/`');
  });

  it('lists the least-covered files first and leaves out tiny ones', () => {
    const table = md.split('Least covered')[1];
    expect(table.indexOf('src/lib/remote.ts')).toBeLessThan(table.indexOf('api/chat.ts'));
    expect(table).toContain('| `src/lib/remote.ts` | 25.0% | 30 |');
    expect(table).not.toContain('scripts/devPorts.ts');
  });

  it('copes with a summary that has no files', () => {
    expect(coverageMarkdown({ total: file(0, 0, [0, 0]) }, ROOT)).toContain('Lines **–** (0 of 0)');
  });
});
