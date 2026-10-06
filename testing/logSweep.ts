/**
 * Checks a test-mode server log for what AGENTS.md says no server log line
 * may hold (docs/plans/test-coverage.md, step 10):
 *
 *   node testing/logSweep.ts test-server.log
 *
 * The `test-mode` CI job runs it on the server's output after the smoke and
 * deletion checks, so every route they touched has written its lines. The
 * patterns need no runtime values: persona emails end in `@sous.invalid`, MCP
 * tokens have fixed prefixes, and link tokens follow fixed paths. A hit
 * prints the pattern's name and the line number, never the line itself.
 *
 * It sees only what the app writes (its console.log and console.error
 * lines). No server here logs request lines, so the link-token pattern
 * guards app text, not Cloud Run's request log (`scripts/logExclusions.ts`
 * covers that). The smoke run makes no website import, so the logged-URL
 * pattern guards against a regression rather than today's output.
 *
 * `findLeaks` is pure, so `testing/logSweep.test.ts` checks the patterns.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LEAK_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  // Plain or percent-encoded (an address inside a logged URL).
  { name: 'a persona email', pattern: /(?:@|%40)sous\.invalid\b/i },
  { name: 'an MCP access or refresh token', pattern: /\bsous_(?:at|rt)_[A-Za-z0-9_-]{8,}/ },
  { name: 'a session cookie', pattern: /\bsous_session=[A-Za-z0-9_-]/ },
  { name: 'an invite, collection, or public link token', pattern: /\/(?:invite|c|p|api\/public)\/[A-Za-z0-9_-]{20,}/ },
  // Any quoted http(s) URL with a query, whatever the JSON key.
  { name: 'a query string in a logged url', pattern: /"[^"]*https?:\/\/[^"\s]*\?[^"]*"/ },
];

export function findLeaks(log: string): { line: number; name: string }[] {
  const leaks: { line: number; name: string }[] = [];
  log.split(/\r?\n/).forEach((text, index) => {
    for (const { name, pattern } of LEAK_PATTERNS) {
      if (pattern.test(text)) leaks.push({ line: index + 1, name });
    }
  });
  return leaks;
}

/** Real paths on both sides, as in scripts/delete-account-data.ts: a symlinked run must not silently pass. */
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
  const path = process.argv[2];
  if (path === undefined) {
    console.error('Usage: node testing/logSweep.ts <server log>');
    process.exit(2);
  }
  const log = readFileSync(path, 'utf8');
  const leaks = findLeaks(log);
  for (const leak of leaks) console.log(`FAIL  line ${leak.line}: ${leak.name}`);
  const lines = log.split(/\r?\n/).filter((line) => line !== '').length;
  console.log(leaks.length === 0 ? `ok    ${lines} log lines hold no email, token, or query string` : `${leaks.length} leak(s) found`);
  process.exitCode = leaks.length === 0 ? 0 : 1;
}
