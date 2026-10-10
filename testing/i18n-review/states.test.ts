import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOCKS } from './mocks.ts';
import { isSkipped, SKIP_REASONS, STATES } from './states.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/i18n-review/screens.json'), 'utf8')) as {
  id: string;
}[];

describe('review states (docs/plans/i18n-review-ci.md, States)', () => {
  it('has an entry for every manifest id, and none for ids the manifest lacks', () => {
    const manifestIds = manifest.map((entry) => entry.id).sort();
    expect(Object.keys(STATES).sort()).toEqual(manifestIds);
  });

  it('skips only for a known reason', () => {
    for (const [id, entry] of Object.entries(STATES)) {
      if (isSkipped(entry)) {
        expect(SKIP_REASONS, id).toContain(entry.skip);
      }
    }
  });

  it('uses only mocks that exist', () => {
    for (const [id, entry] of Object.entries(STATES)) {
      if (!isSkipped(entry)) {
        for (const mock of entry.mocks ?? []) {
          expect(Object.keys(MOCKS), id).toContain(mock);
        }
      }
    }
  });
});
