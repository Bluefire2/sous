import { describe, expect, it } from 'vitest';
import { parseState, planUpdate, shouldRun, type AcceptedFinding, type IssueState, type UpdateInput } from './issue.ts';
import type { Cell, ResultFinding, Results } from './report.ts';

const LANGS = ['en', 'uk', 'ru', 'zh-Hans'];
const STATES = ['settings', 'library-populated'];

function finding(over: Partial<ResultFinding> & Pick<ResultFinding, 'fingerprint' | 'state' | 'lang' | 'text'>): ResultFinding {
  return {
    problem: 'Left in English.',
    suggestion: 'Мова',
    severity: 'blocker',
    rubricItem: 'Nothing left in English',
    confirmed: true,
    screenshot: `${over.state}/${over.lang}.png`,
    candidateKeys: [{ key: 'settings.language', catalog: 'en' }],
    moreKeys: 0,
    ...over,
  };
}

/** Every state in every language judged `pass`, except cells overridden by `cells`. */
function results(over: { date?: string; commit?: string; findings?: ResultFinding[]; cells?: Cell[]; states?: string[] } = {}): Results {
  const states = over.states ?? STATES;
  const overridden = new Map((over.cells ?? []).map((c) => [`${c.state}/${c.lang}`, c]));
  const cells: Cell[] = states.flatMap((state) =>
    LANGS.map((lang) => overridden.get(`${state}/${lang}`) ?? { state, lang: lang as Cell['lang'], result: lang === 'en' ? 'reference' : 'pass' }),
  );
  for (const f of over.findings ?? []) {
    const cell = cells.find((c) => c.state === f.state && c.lang === f.lang);
    if (cell && f.confirmed && f.severity === 'blocker') cell.result = 'fail';
  }
  return {
    version: 1,
    date: over.date ?? '2026-10-04',
    commit: over.commit ?? 'aaaaaaaaaaaaaaaa',
    dirty: false,
    scope: 'task',
    langs: LANGS as Results['langs'],
    judgedLangs: ['uk', 'ru', 'zh-Hans'],
    judged: true,
    model: 'gemini-test',
    judgeCalls: 9,
    callLimit: 500,
    cells,
    findings: over.findings ?? [],
  };
}

function input(r: Results, previous: IssueState | null, accepted: AcceptedFinding[] = []): UpdateInput {
  return { results: r, previous, accepted, manifestIds: STATES, allLangs: LANGS, runUrl: 'https://example.invalid/run/1' };
}

const english = finding({ fingerprint: 'f-english', state: 'settings', lang: 'uk', text: 'Language' });
const plural = finding({
  fingerprint: 'f-plural',
  state: 'library-populated',
  lang: 'ru',
  text: 'Требуют внимания: 1',
  rubricItem: 'Grammar across strings',
});

describe('planUpdate', () => {
  it('first run with findings: lists them, opens the issue, and comments on them as new', () => {
    const update = planUpdate(input(results({ findings: [english] }), null));
    expect(update.open).toBe(true);
    expect(update.body).toContain('### Blockers (1)');
    expect(update.body).toContain('| settings | uk | “Language” |');
    expect(update.body).toContain('`settings.language (en)`');
    expect(update.comment).toContain('**New (1)**');
    expect(update.state.findings.map((f) => [f.fingerprint, f.firstSeen])).toEqual([['f-english', '2026-10-04']]);
    expect(update.state.commit).toBe('aaaaaaaaaaaaaaaa');
  });

  it('first run with nothing found: a closed issue that records the commit, and no comment', () => {
    const update = planUpdate(input(results(), null));
    expect(update.open).toBe(false);
    expect(update.body).toContain('**No open findings.**');
    expect(update.comment).toBeNull();
    expect(update.state.commit).toBe('aaaaaaaaaaaaaaaa');
  });

  it('a finding still there keeps its first-seen date and posts no comment', () => {
    const first = planUpdate(input(results({ findings: [english] }), null));
    const second = planUpdate(input(results({ date: '2026-10-05', commit: 'bbbb', findings: [english] }), first.state));
    expect(second.comment).toBeNull();
    expect(second.state.findings[0]).toMatchObject({ firstSeen: '2026-10-04', lastSeen: '2026-10-05' });
    expect(second.body).toContain('| 2026-10-04 |');
  });

  it('a new finding next to an old one is the only one called new', () => {
    const first = planUpdate(input(results({ findings: [english] }), null));
    const second = planUpdate(input(results({ commit: 'bbbb', findings: [english, plural] }), first.state));
    expect(second.comment).toContain('**New (1)**');
    expect(second.comment).toContain('Требуют внимания: 1');
    expect(second.comment).not.toContain('“Language”');
  });

  it('a finding gone from a judged screen is resolved, and the last one closes the issue', () => {
    const first = planUpdate(input(results({ findings: [english] }), null));
    const second = planUpdate(input(results({ commit: 'bbbb' }), first.state));
    expect(second.open).toBe(false);
    expect(second.comment).toContain('**Resolved (1)**');
    expect(second.state.findings).toEqual([]);
  });

  it('an accepted finding is dropped from the issue and reported once as accepted', () => {
    const first = planUpdate(input(results({ findings: [english, plural] }), null));
    const accepted: AcceptedFinding[] = [{ fingerprint: 'f-plural', reason: 'A label: count line takes the plural.', date: '2026-10-05' }];
    const second = planUpdate(input(results({ commit: 'bbbb', findings: [english, plural] }), first.state, accepted));
    expect(second.state.findings.map((f) => f.fingerprint)).toEqual(['f-english']);
    expect(second.comment).toContain('**Accepted (1)**');
    expect(second.body).toContain('1 accepted finding(s)');
    const third = planUpdate(input(results({ commit: 'cccc', findings: [english, plural] }), second.state, accepted));
    expect(third.comment).toBeNull();
  });

  it('a new finding after a clean run reopens the issue', () => {
    const clean = planUpdate(input(results(), null));
    expect(clean.open).toBe(false);
    const next = planUpdate(input(results({ commit: 'bbbb', findings: [plural] }), clean.state));
    expect(next.open).toBe(true);
    expect(next.comment).toContain('**New (1)**');
  });

  it('never files an unconfirmed finding', () => {
    const update = planUpdate(input(results({ findings: [{ ...english, confirmed: false }] }), null));
    expect(update.open).toBe(false);
    expect(update.comment).toBeNull();
  });

  it('keeps a finding open when its screen was not judged, and marks the run unhealthy', () => {
    const first = planUpdate(input(results({ findings: [english] }), null));
    const broken = results({ commit: 'bbbb', cells: [{ state: 'settings', lang: 'uk', result: 'capture failed', detail: 'Timeout' }] });
    const second = planUpdate(input(broken, first.state));
    expect(second.state.findings.map((f) => f.fingerprint)).toEqual(['f-english']);
    expect(second.comment).toBeNull();
    expect(second.unhealthy).toHaveLength(1);
    expect(second.body).toContain('### Not judged in this run (1)');
    // An incomplete run does not let tomorrow's scheduled run skip this commit.
    expect(second.state.commit).toBe('aaaaaaaaaaaaaaaa');
  });

  it('a partial run leaves findings outside its scope alone and does not record its commit', () => {
    const first = planUpdate(input(results({ findings: [english, plural] }), null));
    const partial = results({ commit: 'bbbb', states: ['settings'], findings: [english] });
    const second = planUpdate(input(partial, first.state));
    expect(second.state.findings.map((f) => f.fingerprint).sort()).toEqual(['f-english', 'f-plural']);
    expect(second.comment).toBeNull();
    expect(second.body).toContain('partial');
    expect(second.state.commit).toBe('aaaaaaaaaaaaaaaa');
  });

  it('lists nits in a collapsed section', () => {
    const nit = finding({ fingerprint: 'f-nit', state: 'settings', lang: 'ru', text: 'Язык', severity: 'nit', rubricItem: 'Sense in context' });
    const update = planUpdate(input(results({ findings: [nit] }), null));
    expect(update.body).toContain('<summary>Nits (1)</summary>');
    expect(update.body).not.toContain('### Blockers');
  });
});

describe('issue state', () => {
  it('round-trips through the body, even with text that would close an HTML comment', () => {
    const tricky = { ...english, text: 'a --> b <!-- c', problem: '@someone | *bold*' };
    const update = planUpdate(input(results({ findings: [tricky] }), null));
    expect(parseState(update.body)).toEqual(update.state);
    expect(update.body).toContain('&#64;someone \\| \\*bold\\*');
  });

  it('reads nothing from a body without state', () => {
    expect(parseState('Some issue someone wrote by hand')).toBeNull();
    expect(parseState(null)).toBeNull();
  });
});

describe('shouldRun', () => {
  const reviewed: IssueState = { version: 1, commit: 'aaaa', findings: [] };

  it('skips a scheduled run on a commit already reviewed', () => {
    expect(shouldRun('schedule', 'aaaa', reviewed).run).toBe(false);
  });

  it('runs a scheduled run when main moved, or when nothing was reviewed yet', () => {
    expect(shouldRun('schedule', 'bbbb', reviewed).run).toBe(true);
    expect(shouldRun('schedule', 'aaaa', null).run).toBe(true);
  });

  it('always runs a dispatched run', () => {
    expect(shouldRun('workflow_dispatch', 'aaaa', reviewed).run).toBe(true);
  });
});
