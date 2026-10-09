/**
 * Live check of the judge (docs/plans/i18n-review-ci.md, step 3). Captures
 * clean states and the same states with one planted defect per rubric item,
 * judges them the way a review run does, and reports recall per rubric item
 * and false positives on the clean pairs. Like `npm run test:import`, it
 * calls Gemini and never runs in `npm test`. Measure any change to the judge
 * prompt or model with it, and record the result in the plan.
 *
 *   node --env-file=<.env.local> testing/i18n-review/calibration.ts [--base-url http://localhost:4173]
 *
 * Exits non-zero when a clean pair has a confirmed blocker or a "left in
 * English" defect is missed; the other items are measured, not required.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { chromium, type Page } from 'playwright';
import { captureState, readCaptureEnv } from './capture.ts';
import { TARGET_LANGS, type Lang } from './catalog.ts';
import {
  CallBudget,
  type Judgment,
  type JudgeTask,
  judgeAll,
  normalizeText,
  readSources,
  type RubricItem,
  type Shot,
} from './judge.ts';
import { type Capturable, isSkipped, STATES } from './states.ts';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** States judged clean in every target language: the false-positive set. */
const CLEAN_STATES = [
  'settings',
  'library-populated',
  'library-move-many',
  'library-invite-confirm',
  'share-collection-sheet-public',
  'import-preview',
  'recipe-view',
  'admin',
  'suggest',
  'cooks-populated',
];

/**
 * Real problems the judge finds on a "clean" state. They are not false
 * positives, so they do not fail calibration; remove an entry when its bug is
 * fixed, and the calibration expects that pair to be clean again.
 */
const KNOWN_REAL: { state: string; lang: Lang; text: string; why: string }[] = [
  {
    state: 'import-preview',
    lang: 'zh-Hans',
    text: '份量',
    why: "common.servings: 份量 is the amount in one serving, not the number of servings (glossary: 份); confirmed by a Chinese speaker, 2026-10-09",
  },
];

type Plant = { text: [from: string, to: string] } | { truncate: string };

interface Defect {
  rubricItem: RubricItem;
  state: string;
  lang: Lang;
  plant: Plant;
  /** The text a finding must name to count as catching it. */
  expect: string;
}

const DEFECTS: Defect[] = [
  { rubricItem: 'Nothing left in English', state: 'import-preview', lang: 'uk', plant: { text: ['Зберегти', 'Save'] }, expect: 'Save' },
  { rubricItem: 'Nothing left in English', state: 'settings', lang: 'zh-Hans', plant: { text: ['语言', 'Language'] }, expect: 'Language' },
  { rubricItem: 'Sense in context', state: 'library-populated', lang: 'ru', plant: { text: ['Выбрать', 'Выбор'] }, expect: 'Выбор' },
  // The Move button as "emigrate" (#117 made Share an icon, so its "分享" is no longer text to plant in).
  { rubricItem: 'Sense in context', state: 'library-select', lang: 'zh-Hans', plant: { text: ['移动', '移民'] }, expect: '移民' },
  {
    rubricItem: 'Grammar across strings',
    state: 'library-move-many',
    lang: 'uk',
    plant: { text: ['Перемістити 3 рецепти', 'Перемістити 3 рецептів'] },
    expect: 'рецептів',
  },
  {
    rubricItem: 'Grammar across strings',
    state: 'library-move-many',
    lang: 'ru',
    plant: { text: ['Переместить 3 рецепта', 'Переместить 3 рецептов'] },
    expect: 'рецептов',
  },
  { rubricItem: 'Consistent terms', state: 'library-populated', lang: 'uk', plant: { text: ['Нова колекція', 'Нова збірка'] }, expect: 'збірка' },
  { rubricItem: 'Consistent terms', state: 'library-populated', lang: 'zh-Hans', plant: { text: ['新建合集', '新建收藏夹'] }, expect: '收藏夹' },
  {
    rubricItem: 'Register',
    state: 'share-collection-sheet-public',
    lang: 'ru',
    plant: { text: ['пока вы её не выключите', 'пока ты её не выключишь'] },
    expect: 'ты её не выключишь',
  },
  {
    rubricItem: 'Register',
    state: 'share-collection-sheet-public',
    lang: 'uk',
    plant: { text: ['доки ви його не вимкнете', 'доки ти його не вимкнеш'] },
    expect: 'ти його не вимкнеш',
  },
  { rubricItem: 'Layout', state: 'share-collection-sheet-public', lang: 'ru', plant: { truncate: 'Копировать' }, expect: 'Копировать' },
  { rubricItem: 'Layout', state: 'share-collection-sheet-public', lang: 'uk', plant: { truncate: 'Копіювати' }, expect: 'Копіювати' },
];

async function plant(page: Page, what: Plant): Promise<void> {
  if ('text' in what) {
    const [from, to] = what.text;
    const count = (await page.evaluate(`(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let count = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue.includes(${JSON.stringify(from)})) {
          node.nodeValue = node.nodeValue.split(${JSON.stringify(from)}).join(${JSON.stringify(to)});
          count += 1;
        }
      }
      return count;
    })()`)) as number;
    if (count === 0) throw new Error(`no text "${from}" to replace`);
    return;
  }
  // A clipped button: pinned narrow (min and max too, or a flex row's
  // min-width: auto keeps it wide), no wrapping, overflow hidden.
  // A self-invoking string, like the text plant: a string passed to
  // locator.evaluate is evaluated as an expression, never called.
  const clipped = (await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(what.truncate)});
    if (!el) return false;
    Object.assign(el.style, { width: '64px', minWidth: '64px', maxWidth: '64px', flex: 'none', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'clip' });
    return el.scrollWidth > el.clientWidth;
  })()`)) as boolean;
  if (!clipped) throw new Error(`"${what.truncate}" did not clip`);
}

function capturable(state: string, extra?: Plant): Capturable {
  const entry = STATES[state];
  if (entry === undefined || isSkipped(entry)) throw new Error(`${state} is not capturable`);
  if (extra === undefined) return entry;
  return {
    ...entry,
    reach: async (page, ctx) => {
      await entry.reach?.(page, ctx);
      await plant(page, extra);
    },
  };
}

function matches(findingText: string, expected: string): boolean {
  const f = normalizeText(findingText);
  const e = normalizeText(expected);
  return f.includes(e) || (f.length >= 3 && e.includes(f));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string', default: 'http://localhost:4173' } } });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const env = await readCaptureEnv(values['base-url']);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/i18n-review/screens.json'), 'utf8')) as {
    id: string;
    setup: string;
  }[];
  const setupOf = (id: string) => manifest.find((entry) => entry.id === id)?.setup ?? '';

  const browser = await chromium.launch();
  const shot = async (state: string, lang: Lang, extra?: Plant): Promise<Shot> => {
    const result = await captureState(browser, capturable(state, extra), lang, env);
    if (result.status === 'failed') throw new Error(`${state} ${lang}: ${result.error}`);
    return { png: result.png, pageText: result.pageText };
  };

  const tasks: { task: JudgeTask; defect?: Defect }[] = [];
  const outDir = join(repoRoot, '.i18n-review', `calibration-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(outDir, { recursive: true });
  try {
    const states = [...new Set([...CLEAN_STATES, ...DEFECTS.map((d) => d.state)])];
    const english = new Map<string, Shot>();
    for (const state of states) english.set(state, await shot(state, 'en'));
    for (const state of CLEAN_STATES) {
      for (const lang of TARGET_LANGS) {
        tasks.push({
          task: { state, lang, setup: setupOf(state), reference: english.get(state)!, target: await shot(state, lang) },
        });
      }
    }
    for (const defect of DEFECTS) {
      tasks.push({
        defect,
        task: {
          state: defect.state,
          lang: defect.lang,
          setup: setupOf(defect.state),
          reference: english.get(defect.state)!,
          target: await shot(defect.state, defect.lang, defect.plant),
        },
      });
      const last = tasks[tasks.length - 1].task;
      writeFileSync(join(outDir, `defect-${defect.rubricItem.replace(/\W+/g, '-')}-${defect.state}-${defect.lang}.png`), last.target.png);
    }
  } finally {
    await browser.close();
  }
  console.log(`Captured ${tasks.length} pairs; judging.`);

  const budget = new CallBudget();
  const judgments = await judgeAll(
    tasks.map((t) => t.task),
    { ai: new GoogleGenAI({ apiKey }), sources: readSources(repoRoot) },
    budget,
  );

  const rows: { label: string; judgment: Judgment; caught?: 'blocker' | 'seen' | 'missed' }[] = [];
  let failures = 0;
  tasks.forEach(({ task, defect }, i) => {
    const judgment = judgments[i];
    if (defect === undefined) {
      const known = (text: string) =>
        KNOWN_REAL.some((k) => k.state === task.state && k.lang === task.lang && matches(text, k.text));
      for (const f of judgment.confirmed.filter((x) => known(x.text))) {
        console.log(`KNOWN real ${f.severity} on ${task.state} ${task.lang}: "${f.text}"`);
      }
      judgment.confirmed = judgment.confirmed.filter((x) => !known(x.text));
      const blockers = judgment.confirmed.filter((f) => f.severity === 'blocker');
      if (blockers.length > 0 || judgment.status === 'error') failures += 1;
      rows.push({ label: `clean ${task.state} ${task.lang}`, judgment });
      if (judgment.status === 'error') console.log(`ERROR clean ${task.state} ${task.lang}: ${judgment.error}`);
      for (const f of judgment.confirmed) {
        console.log(`FALSE ${f.severity} on clean ${task.state} ${task.lang}: "${f.text}" (${f.rubricItem}) ${f.problem}`);
      }
      return;
    }
    const all = [...judgment.confirmed, ...judgment.unconfirmed];
    const caught = judgment.confirmed.some((f) => f.severity === 'blocker' && matches(f.text, defect.expect))
      ? 'blocker'
      : all.some((f) => matches(f.text, defect.expect))
        ? 'seen'
        : 'missed';
    if (defect.rubricItem === 'Nothing left in English' && caught !== 'blocker') failures += 1;
    rows.push({ label: `defect ${defect.rubricItem} ${defect.state} ${defect.lang}`, judgment, caught });
    console.log(`${caught.toUpperCase().padEnd(7)} ${defect.rubricItem} (${defect.lang}, ${defect.state}): planted "${defect.expect}"`);
  });

  const clean = rows.filter((r) => r.caught === undefined);
  const falseBlockers = clean.reduce(
    (n, r) => n + r.judgment.confirmed.filter((f) => f.severity === 'blocker').length,
    0,
  );
  console.log(`\nClean pairs: ${clean.length}, confirmed false blockers: ${falseBlockers}, ` +
    `unconfirmed reports: ${clean.reduce((n, r) => n + r.judgment.unconfirmed.length, 0)}`);
  for (const item of [...new Set(DEFECTS.map((d) => d.rubricItem))]) {
    const forItem = rows.filter((r) => r.caught !== undefined && r.label.startsWith(`defect ${item}`));
    const count = (c: string) => forItem.filter((r) => r.caught === c).length;
    console.log(`${item}: ${count('blocker')} confirmed blocker, ${count('seen')} seen only, ${count('missed')} missed of ${forItem.length}`);
  }
  console.log(`Judge calls: ${budget.used}`);

  writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows.map((r) => ({ ...r })), null, 2));
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
