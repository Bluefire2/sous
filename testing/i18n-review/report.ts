/**
 * The review's outputs (docs/plans/i18n-review-ci.md, step 4): `results.json`,
 * which the workflow's issue builder reads, and the Markdown report in the
 * format docs/i18n-review/README.md describes. Pure: run.ts gathers captures
 * and judgments, this file shapes and renders them.
 */
import { CATALOGS, LANG_NAMES, type Lang, type MessageKey } from './catalog.ts';
import { type Finding, type Judgment, normalizeText } from './judge.ts';
import { inline } from './markdown.ts';
import type { SkipReason } from './states.ts';

export interface CaptureRow {
  state: string;
  lang: Lang;
  status: 'ok' | 'failed' | 'skipped' | 'unstable';
  detail?: string;
  sha256?: string;
  ms?: number;
}

export type CellResult =
  | 'pass'
  | 'fail'
  /** English in a task run: captured as the reference, not judged. */
  | 'reference'
  /** Captured with `--no-judge`. */
  | 'captured'
  | 'capture failed'
  | 'not deterministic'
  | 'judge error'
  | 'not judged: call limit'
  /** English for this state did not capture, so there was nothing to judge against. */
  | 'not judged: no reference'
  | `skipped: ${SkipReason}`;

export interface Cell {
  state: string;
  lang: Lang;
  result: CellResult;
  detail?: string;
}

export interface CandidateKey {
  key: MessageKey;
  /** The catalog it matched in: the finding's language, or English for text left in English. */
  catalog: Lang;
}

export interface ResultFinding extends Finding {
  state: string;
  lang: Lang;
  /** Named by both judgings. Only confirmed findings are filed. */
  confirmed: boolean;
  /** Relative to the output directory. */
  screenshot: string;
  candidateKeys: CandidateKey[];
  /** Keys that matched as well as these but were left out. */
  moreKeys: number;
}

export interface Results {
  version: 1;
  date: string;
  commit: string | null;
  /** The working tree had uncommitted changes, so the build may not match `commit`. */
  dirty: boolean;
  scope: 'task' | 'full';
  langs: Lang[];
  judgedLangs: Lang[];
  judged: boolean;
  model: string;
  judgeCalls: number;
  callLimit: number;
  cells: Cell[];
  findings: ResultFinding[];
}

export interface ResultsInput {
  date: string;
  commit: string | null;
  dirty: boolean;
  scope: 'task' | 'full';
  langs: Lang[];
  judgedLangs: Lang[];
  model: string;
  judgeCalls: number;
  callLimit: number;
  captures: CaptureRow[];
  /** Null with `--no-judge`. */
  judgments: Judgment[] | null;
}

const MAX_KEYS = 5;
const PARAM = /\{(\w+)\}/g;

/** Every string a key can show: the value, or each plural form. */
function templatesOf(lang: Lang): { key: MessageKey; template: string }[] {
  const out: { key: MessageKey; template: string }[] = [];
  for (const [key, value] of Object.entries(CATALOGS[lang]) as [MessageKey, unknown][]) {
    if (typeof value === 'string') {
      out.push({ key, template: value });
    } else if (value !== null && typeof value === 'object') {
      for (const form of Object.values(value)) {
        if (typeof form === 'string') out.push({ key, template: form });
      }
    }
  }
  return out;
}

const TEMPLATES = new Map<Lang, { key: MessageKey; template: string }[]>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Opening and closing quote marks a judge may wrap a quotation in. */
const QUOTE_PAIRS = ['""', "''", '“”', '«»', '‘’', '„“', '「」', '『』'];

/**
 * The text without quote marks that wrap all of it. Only a matched pair is
 * removed: a closing 」 can be part of the quoted text itself.
 */
function unquote(text: string): string {
  const trimmed = text.trim();
  const pair = QUOTE_PAIRS.find(([open, close]) => trimmed.length > 2 && trimmed.startsWith(open) && trimmed.endsWith(close));
  return pair === undefined ? trimmed : trimmed.slice(1, -1).trim();
}

/** The parts of a template between its `{params}`, and the params in order. */
function split(template: string): { segments: string[]; params: string[] } {
  const parts = template.split(PARAM);
  return {
    segments: parts.filter((_, i) => i % 2 === 0),
    params: parts.filter((_, i) => i % 2 === 1),
  };
}

/**
 * How well a catalog string explains the quoted text: 3 when the quote is the
 * whole string, 2 when the string sits inside a longer quote, 1 when the quote
 * is part of the string, 0 otherwise. `{count}` matches a number and any
 * other `{param}` matches any text.
 */
export function matchScore(quote: string, template: string): number {
  const q = normalizeText(unquote(quote));
  const t = normalizeText(template);
  if (q === '' || t === '') return 0;
  const { segments, params } = split(t);
  const pattern = segments
    .map((segment, i) => escapeRegExp(segment) + (i < params.length ? (params[i] === 'count' ? String.raw`\d[\d\s.,]*` : '.+?') : ''))
    .join('');
  if (new RegExp(`^${pattern}$`).test(q)) return 3;
  const literal = segments.join('').trim();
  if ([...literal].length >= 3 && new RegExp(pattern).test(q)) return 2;
  if ([...q].length >= 2 && segments.some((segment) => segment.includes(q))) return 1;
  return 0;
}

/**
 * The catalog keys that may hold the quoted text: those that match best in
 * the finding's language, or in English when none do (text left in English).
 * A hint for whoever fixes the finding, not a certainty.
 */
export function candidateKeys(text: string, lang: Lang): { keys: CandidateKey[]; more: number } {
  const search = (catalog: Lang) => {
    let templates = TEMPLATES.get(catalog);
    if (templates === undefined) {
      templates = templatesOf(catalog);
      TEMPLATES.set(catalog, templates);
    }
    // Per key, its best score, and how much literal text matched it then.
    const best = new Map<MessageKey, { score: number; literal: number }>();
    for (const { key, template } of templates) {
      const score = matchScore(text, template);
      const literal = split(template).segments.join('').length;
      const seen = best.get(key);
      if (score > 0 && (seen === undefined || score > seen.score || (score === seen.score && literal > seen.literal))) {
        best.set(key, { score, literal });
      }
    }
    const top = Math.max(0, ...[...best.values()].map((b) => b.score));
    // The most specific strings first.
    return [...best]
      .filter(([, b]) => b.score === top && top > 0)
      .sort(([, a], [, b]) => b.literal - a.literal)
      .map(([key]) => key);
  };
  let catalog = lang;
  let keys = search(lang);
  if (keys.length === 0 && lang !== 'en') {
    catalog = 'en';
    keys = search('en');
  }
  return {
    keys: keys.slice(0, MAX_KEYS).map((key) => ({ key, catalog })),
    more: Math.max(0, keys.length - MAX_KEYS),
  };
}

function cellOf(capture: CaptureRow, judgment: Judgment | undefined, input: ResultsInput): Cell {
  const base = { state: capture.state, lang: capture.lang };
  switch (capture.status) {
    case 'skipped':
      return { ...base, result: `skipped: ${capture.detail as SkipReason}` };
    case 'failed':
      return { ...base, result: 'capture failed', detail: capture.detail };
    case 'unstable':
      return { ...base, result: 'not deterministic', detail: capture.detail };
  }
  if (input.judgments === null) return { ...base, result: 'captured' };
  if (!input.judgedLangs.includes(capture.lang)) return { ...base, result: 'reference' };
  // Judged languages are judged only against an English capture.
  if (judgment === undefined) return { ...base, result: 'not judged: no reference' };
  switch (judgment.status) {
    case 'pass':
      return { ...base, result: 'pass' };
    case 'fail':
      return { ...base, result: 'fail' };
    case 'error':
      return { ...base, result: 'judge error', detail: judgment.error };
    case 'budget':
      return { ...base, result: 'not judged: call limit' };
  }
}

export function buildResults(input: ResultsInput): Results {
  const judged = input.judgments !== null;
  const judgmentOf = new Map((input.judgments ?? []).map((j) => [`${j.state}/${j.lang}`, j]));
  const cells = input.captures.map((capture) => cellOf(capture, judgmentOf.get(`${capture.state}/${capture.lang}`), input));
  const findings: ResultFinding[] = [];
  for (const judgment of input.judgments ?? []) {
    const add = (finding: Finding, confirmed: boolean) => {
      const { keys, more } = candidateKeys(finding.text, judgment.lang);
      findings.push({
        ...finding,
        state: judgment.state,
        lang: judgment.lang,
        confirmed,
        screenshot: `${judgment.state}/${judgment.lang}.png`,
        candidateKeys: keys,
        moreKeys: more,
      });
    };
    for (const finding of judgment.confirmed) add(finding, true);
    for (const finding of judgment.unconfirmed) add(finding, false);
  }
  return {
    version: 1,
    date: input.date,
    commit: input.commit,
    dirty: input.dirty,
    scope: input.scope,
    langs: input.langs,
    judgedLangs: judged ? input.judgedLangs : [],
    judged,
    model: input.model,
    judgeCalls: input.judgeCalls,
    callLimit: input.callLimit,
    cells,
    findings,
  };
}

function keysText(finding: ResultFinding): string {
  if (finding.candidateKeys.length === 0) return 'none found';
  const keys = finding.candidateKeys
    .map((k) => `\`${k.key}\`${k.catalog === finding.lang ? '' : ` (${k.catalog})`}`)
    .join(', ');
  return finding.moreKeys > 0 ? `${keys}, and ${finding.moreKeys} more` : keys;
}

function findingLines(finding: ResultFinding): string[] {
  return [
    `- **${finding.state}** · ${finding.lang} · ${finding.severity} · ${finding.rubricItem}`,
    `  - Text: “${inline(finding.text)}”`,
    `  - Problem: ${inline(finding.problem)}`,
    `  - Suggestion: ${inline(finding.suggestion)}`,
    `  - Candidate keys: ${keysText(finding)}`,
    `  - Screenshot: [${finding.screenshot}](${finding.screenshot})`,
  ];
}

export function renderReport(results: Results): string {
  const lines: string[] = [];
  const states = [...new Set(results.cells.map((c) => c.state))];
  const cellOf = new Map(results.cells.map((c) => [`${c.state}/${c.lang}`, c]));
  const count = (result: CellResult) => results.cells.filter((c) => c.result === result).length;
  const commit = results.commit === null ? 'unknown' : `\`${results.commit.slice(0, 12)}\``;

  lines.push(`# In-context translation review, ${results.date}`, '');
  lines.push(`- Scope: ${results.scope}`);
  lines.push(`- Commit: ${commit}${results.dirty ? ' with uncommitted changes' : ''}`);
  lines.push(
    `- Languages judged: ${
      results.judged ? results.judgedLangs.map((l) => `${l} (${LANG_NAMES[l]})`).join(', ') || 'none' : 'none (--no-judge)'
    }; English is the reference`,
  );
  lines.push('- Translated states: in test mode, from mocked responses; no opt-in needed');
  if (results.judged) {
    lines.push(`- Judge: \`${results.model}\`, ${results.judgeCalls} calls (limit ${results.callLimit})`);
  }
  lines.push(
    `- Result: ${count('pass')} pass, ${count('fail')} fail, ${count('capture failed')} capture failed, ` +
      `${count('not deterministic')} not deterministic, ${count('judge error')} judge errors, ` +
      `${count('not judged: call limit') + count('not judged: no reference')} not judged`,
  );
  lines.push('');

  lines.push('## Results', '');
  lines.push(`| State | ${results.langs.join(' | ')} |`);
  lines.push(`| --- | ${results.langs.map(() => '---').join(' | ')} |`);
  for (const state of states) {
    const row = results.langs.map((lang) => cellOf.get(`${state}/${lang}`)?.result ?? '');
    lines.push(`| ${state} | ${row.join(' | ')} |`);
  }
  lines.push('');

  const problems = results.cells.filter((c) => c.detail !== undefined);
  if (problems.length > 0) {
    lines.push('## Capture and judge errors', '');
    for (const cell of problems) {
      lines.push(`- **${cell.state}** · ${cell.lang} · ${cell.result}: ${inline(cell.detail ?? '')}`);
    }
    lines.push('');
  }

  lines.push('## Issues', '');
  const confirmed = results.findings.filter((f) => f.confirmed);
  const blockers = confirmed.filter((f) => f.severity === 'blocker');
  const nits = confirmed.filter((f) => f.severity === 'nit');
  const unconfirmed = results.findings.filter((f) => !f.confirmed);
  if (!results.judged) {
    lines.push('Not judged (--no-judge).', '');
  } else if (results.findings.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      'Suggestions are the judge model’s and can be wrong; a fix goes through a normal review. ' +
        'Candidate keys are catalog strings that contain the quoted text.',
      '',
    );
    lines.push(`### Blockers (${blockers.length})`, '');
    lines.push(...(blockers.length === 0 ? ['None.'] : blockers.flatMap(findingLines)), '');
    lines.push(`### Nits (${nits.length})`, '');
    lines.push(...(nits.length === 0 ? ['None.'] : nits.flatMap(findingLines)), '');
    lines.push(`### Unconfirmed (${unconfirmed.length})`, '');
    lines.push('Named by one of the two judgings only. Listed for reading, never filed.', '');
    lines.push(...(unconfirmed.length === 0 ? ['None.'] : unconfirmed.flatMap(findingLines)), '');
  }

  lines.push('## Fixed in the catalogs', '');
  lines.push('None in this run. A fix is its own change, and that change re-runs the states it affects.', '');

  lines.push('## Skipped or redacted', '');
  const skipped = new Map<string, string[]>();
  for (const state of states) {
    const reasons = new Set(
      results.cells.filter((c) => c.state === state && c.result.startsWith('skipped: ')).map((c) => c.result.slice(9)),
    );
    for (const reason of reasons) skipped.set(reason, [...(skipped.get(reason) ?? []), state]);
  }
  if (skipped.size === 0) {
    lines.push('Nothing skipped.');
  } else {
    for (const [reason, ids] of skipped) {
      lines.push(`- ${reason} (${ids.length}): ${ids.join(', ')}`);
    }
  }
  lines.push('', 'Nothing redacted: test mode shows only fixture data.', '');

  lines.push('## Translation cache docs written', '');
  lines.push('None: the run used test mode, and nothing reached production.', '');
  return lines.join('\n');
}
