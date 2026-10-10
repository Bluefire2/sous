import { describe, expect, it } from 'vitest';
import type { Judgment } from './judge.ts';
import { inline } from './markdown.ts';
import { buildResults, candidateKeys, type CaptureRow, matchScore, renderReport, type ResultsInput } from './report.ts';

function input(over: Partial<ResultsInput> = {}): ResultsInput {
  return {
    date: '2026-10-03',
    commit: '0123456789abcdef0123',
    dirty: false,
    scope: 'task',
    langs: ['en', 'uk'],
    judgedLangs: ['uk'],
    model: 'gemini-test',
    judgeCalls: 3,
    callLimit: 500,
    captures: [],
    judgments: [],
    ...over,
  };
}

const ok = (state: string, lang: CaptureRow['lang']): CaptureRow => ({ state, lang, status: 'ok', sha256: 'x', ms: 1 });

const failing: Judgment = {
  state: 'library-move-many',
  lang: 'uk',
  status: 'fail',
  calls: 2,
  confirmed: [
    {
      text: 'Перемістити 3 рецептів',
      problem: 'Wrong plural after 3.',
      suggestion: 'Перемістити 3 рецепти',
      severity: 'blocker',
      rubricItem: 'Grammar across strings',
      fingerprint: 'f1',
    },
  ],
  unconfirmed: [
    {
      text: 'Скасувати',
      problem: 'Maybe *too* formal | ping @someone',
      suggestion: 'Відмінити',
      severity: 'nit',
      rubricItem: 'Sense in context',
      fingerprint: 'f2',
    },
  ],
};

describe('matchScore', () => {
  it('matches a whole string, quoted or not, with params filled', () => {
    expect(matchScore('Перемістити 3 рецептів', 'Перемістити {count} рецептів')).toBe(3);
    expect(matchScore('  «Зберегти» ', 'Зберегти')).toBe(3);
  });

  it('keeps closing brackets that belong to the text', () => {
    expect(matchScore('将 2 道食谱移到「Weeknights」', '将 {count} 道食谱移到「{name}」')).toBe(3);
    expect(matchScore('「将 2 道食谱移到「Weeknights」」', '将 {count} 道食谱移到「{name}」')).toBe(3);
  });

  it('finds a string inside a longer quote', () => {
    expect(matchScore('Зберегти Скасувати', 'Скасувати')).toBe(2);
  });

  it('finds a quote inside a string', () => {
    expect(matchScore('рецептів', 'Перемістити {count} рецептів')).toBe(1);
  });

  it('ignores very short strings inside a quote', () => {
    expect(matchScore('Go to settings', 'Go')).toBe(0);
  });

  it('is 0 when nothing matches', () => {
    expect(matchScore('Зберегти', 'Скасувати')).toBe(0);
  });
});

describe('candidateKeys', () => {
  it('names the plural key a wrong form came from', () => {
    expect(candidateKeys('Перемістити 3 рецептів', 'uk').keys).toEqual([
      { key: 'library.moveManyTitle', catalog: 'uk' },
    ]);
  });

  it('falls back to English for text left in English', () => {
    expect(candidateKeys('Save', 'uk').keys).toContainEqual({ key: 'common.save', catalog: 'en' });
  });

  it('matches {count} to a number only', () => {
    expect(candidateKeys('3 recipes', 'en').keys).toContainEqual({ key: 'library.recipeCount', catalog: 'en' });
    expect(candidateKeys('these recipes', 'en').keys).not.toContainEqual({ key: 'library.recipeCount', catalog: 'en' });
  });

  it('is empty when nothing matches', () => {
    expect(candidateKeys('qqqqqq zzzzzz', 'uk')).toEqual({ keys: [], more: 0 });
  });
});

describe('buildResults', () => {
  it('marks each cell from its capture and judgment', () => {
    const results = buildResults(
      input({
        captures: [
          ok('library-move-many', 'en'),
          ok('library-move-many', 'uk'),
          { state: 'recipe-gallery', lang: 'en', status: 'skipped', detail: 'needs stored photos' },
          { state: 'recipe-gallery', lang: 'uk', status: 'skipped', detail: 'needs stored photos' },
          { state: 'settings', lang: 'en', status: 'failed', detail: 'timeout' },
          ok('settings', 'uk'),
          ok('admin', 'en'),
          ok('admin', 'uk'),
        ],
        judgments: [failing, { state: 'admin', lang: 'uk', status: 'budget', calls: 0, confirmed: [], unconfirmed: [] }],
      }),
    );
    expect(results.cells.map((c) => `${c.state}/${c.lang}: ${c.result}`)).toEqual([
      'library-move-many/en: reference',
      'library-move-many/uk: fail',
      'recipe-gallery/en: skipped: needs stored photos',
      'recipe-gallery/uk: skipped: needs stored photos',
      'settings/en: capture failed',
      'settings/uk: not judged: no reference',
      'admin/en: reference',
      'admin/uk: not judged: call limit',
    ]);
  });

  it('lists confirmed and unconfirmed findings with keys and screenshots', () => {
    const results = buildResults(input({ captures: [ok('library-move-many', 'en'), ok('library-move-many', 'uk')], judgments: [failing] }));
    expect(results.findings.map((f) => [f.text, f.confirmed, f.screenshot, f.candidateKeys[0]?.key])).toEqual([
      ['Перемістити 3 рецептів', true, 'library-move-many/uk.png', 'library.moveManyTitle'],
      ['Скасувати', false, 'library-move-many/uk.png', 'common.cancel'],
    ]);
  });

  it('marks captures as captured with --no-judge', () => {
    const results = buildResults(input({ captures: [ok('settings', 'en'), ok('settings', 'uk')], judgments: null }));
    expect(results.cells.map((c) => c.result)).toEqual(['captured', 'captured']);
    expect(results.judgedLangs).toEqual([]);
  });
});

describe('renderReport', () => {
  const results = buildResults(
    input({
      captures: [
        ok('library-move-many', 'en'),
        ok('library-move-many', 'uk'),
        { state: 'recipe-gallery', lang: 'en', status: 'skipped', detail: 'needs stored photos' },
        { state: 'recipe-gallery', lang: 'uk', status: 'skipped', detail: 'needs stored photos' },
      ],
      judgments: [failing],
    }),
  );
  const report = renderReport(results);

  it('has the README sections', () => {
    for (const heading of ['## Results', '## Issues', '## Fixed in the catalogs', '## Skipped or redacted', '## Translation cache docs written']) {
      expect(report).toContain(heading);
    }
  });

  it('has one row per state and a column per language', () => {
    expect(report).toContain('| State | en | uk |');
    expect(report).toContain('| library-move-many | reference | fail |');
    expect(report).toContain('| recipe-gallery | skipped: needs stored photos | skipped: needs stored photos |');
  });

  it('lists a blocker with its candidate key and screenshot', () => {
    expect(report).toContain('### Blockers (1)');
    expect(report).toContain('“Перемістити 3 рецептів”');
    expect(report).toContain('Candidate keys: `library.moveManyTitle`');
    expect(report).toContain('[library-move-many/uk.png](library-move-many/uk.png)');
  });

  it('groups skips by reason, once per state', () => {
    expect(report).toContain('- needs stored photos (1): recipe-gallery');
  });

  it('escapes model text', () => {
    expect(report).toContain('Maybe \\*too\\* formal \\| ping &#64;someone');
    expect(inline('a\n b')).toBe('a b');
  });
});
