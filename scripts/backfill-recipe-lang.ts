/**
 * One-time backfill of `lang` on `users/{uid}/recipes/{id}` for recipes
 * saved before language labels. Idempotent. Dry run unless `--write`:
 *
 *   node --env-file=.env.local scripts/backfill-recipe-lang.ts [--write]
 *
 * Uses GOOGLE_CLOUD_PROJECT and ADC like dev:api, so it targets the real
 * database unless FIRESTORE_EMULATOR_HOST is set. A write is a field
 * update of only `lang` and `serverUpdatedAt`. It never set()s, never
 * changes recipe text, and never changes `updatedAt`.
 */
import { FieldPath, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLang } from '../server/lang.ts';
import { getStoreFirestore, isLiveDoc } from '../server/store.ts';
import { firestoreTarget } from '../server/env.ts';
import {
  DEFAULT_TRANSLATE_PROVIDER,
  detectLanguage,
  geminiTranslateDepsFromEnv,
  resolveTranslateConfig,
  type GeminiTranslateDeps,
} from '../server/translate.ts';

const PAGE = 300;

/** Opening of the recipe sent to detectLanguage. Later text is not required. */
const MAX_DETECTION_CHARS = 4_000;

/**
 * Live, still unlabelled, and `updatedAt` still the finite number from the
 * read that decided to detect. The walk passes the doc's own `updatedAt`.
 * The write transaction passes that earlier value, so a tombstone, a new
 * `lang`, or a newer `updatedAt` is skipped.
 */
export function shouldLabel(
  doc: Record<string, unknown> | undefined,
  readUpdatedAt: unknown,
): boolean {
  if (doc === undefined || !isLiveDoc(doc)) {
    return false;
  }
  if (hasLang(doc.lang)) {
    return false;
  }
  return sameFiniteUpdatedAt(doc.updatedAt, readUpdatedAt);
}

/** The only fields a backfill write may contain. */
export function backfillPatch(
  lang: string,
  serverUpdatedAt: number,
): { lang: string; serverUpdatedAt: number } {
  return { lang, serverUpdatedAt };
}

function hasLang(lang: unknown): boolean {
  if (typeof lang === 'string') {
    return lang.trim() !== '';
  }
  return lang !== undefined && lang !== null;
}

function sameFiniteUpdatedAt(current: unknown, read: unknown): boolean {
  return (
    typeof current === 'number' &&
    typeof read === 'number' &&
    Number.isFinite(current) &&
    Number.isFinite(read) &&
    current === read
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushText(parts: string[], value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  if (trimmed !== '') {
    parts.push(trimmed);
  }
}

/** Title, description, and steps from the start, capped for one detection call. */
function detectionText(doc: Record<string, unknown>): string {
  const parts: string[] = [];
  pushText(parts, doc.title);
  pushText(parts, doc.description);
  if (Array.isArray(doc.steps)) {
    for (const step of doc.steps) {
      if (parts.join('\n\n').length >= MAX_DETECTION_CHARS) {
        break;
      }
      if (!isPlainObject(step)) {
        continue;
      }
      pushText(parts, step.text);
    }
  }
  return parts.join('\n\n').slice(0, MAX_DETECTION_CHARS);
}

interface Counts {
  scanned: number;
  unlabelled: number;
  undetectable: number;
  written: number;
  detected: Map<string, number>;
}

function noteDetected(counts: Counts, lang: string): void {
  counts.detected.set(lang, (counts.detected.get(lang) ?? 0) + 1);
}

function detectedSummary(detected: ReadonlyMap<string, number>): string {
  const tags = [...detected.keys()].sort((a, b) => a.localeCompare(b));
  if (tags.length === 0) {
    return 'none';
  }
  return tags.map((tag) => `${tag} ${detected.get(tag)}`).join(', ');
}

function logSummary(counts: Counts, write: boolean): void {
  const parts = [
    `${counts.scanned} recipes scanned`,
    `${counts.unlabelled} unlabelled`,
    `detected: ${detectedSummary(counts.detected)}`,
    `${counts.undetectable} undetectable`,
  ];
  if (write) {
    parts.push(`${counts.written} written`);
  }
  console.log(`${parts.join(', ')}.`);
  if (!write) {
    console.log('Dry run; pass --write to write.');
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(entry) === fileURLToPath(import.meta.url);
}

async function labelOne(
  db: Firestore,
  ref: DocumentReference,
  readUpdatedAt: unknown,
  lang: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const fresh = snap.data();
    if (!shouldLabel(fresh, readUpdatedAt)) {
      return false;
    }
    tx.update(ref, backfillPatch(lang, Date.now()));
    return true;
  });
}

async function scanUserRecipes(
  db: Firestore,
  userId: string,
  deps: GeminiTranslateDeps,
  write: boolean,
  counts: Counts,
): Promise<void> {
  const recipes = db.collection('users').doc(userId).collection('recipes');
  let lastRecipeId: string | undefined;
  for (;;) {
    let query = recipes.orderBy(FieldPath.documentId()).limit(PAGE);
    if (lastRecipeId !== undefined) {
      query = query.startAfter(lastRecipeId);
    }
    const snap = await query.get();
    if (snap.empty) {
      break;
    }
    for (const recipe of snap.docs) {
      counts.scanned += 1;
      const data = recipe.data();
      const readUpdatedAt = data.updatedAt;
      if (!shouldLabel(data, readUpdatedAt)) {
        continue;
      }
      counts.unlabelled += 1;
      const lang = normalizeLang(await detectLanguage(detectionText(data), deps));
      if (lang === undefined) {
        counts.undetectable += 1;
        console.log(`${recipe.ref.path}: undetectable`);
        continue;
      }
      noteDetected(counts, lang);
      console.log(`${recipe.ref.path}: ${lang}`);
      if (!write) {
        continue;
      }
      const applied = await labelOne(db, recipe.ref, readUpdatedAt, lang);
      if (applied) {
        counts.written += 1;
      } else {
        console.log(`${recipe.ref.path}: skipped on re-read`);
      }
    }
    lastRecipeId = snap.docs[snap.docs.length - 1].id;
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  if (resolveTranslateConfig(process.env).provider !== DEFAULT_TRANSLATE_PROVIDER) {
    console.error(
      `TRANSLATE_PROVIDER must be ${DEFAULT_TRANSLATE_PROVIDER} to detect language.`,
    );
    process.exitCode = 1;
    return;
  }
  const ready = geminiTranslateDepsFromEnv();
  if (!ready.ok) {
    console.error('GEMINI_API_KEY is not set. Detection needs it in .env.local.');
    process.exitCode = 1;
    return;
  }
  console.error(`Firestore: ${firestoreTarget()}`);
  const db = getStoreFirestore();
  const counts: Counts = {
    scanned: 0,
    unlabelled: 0,
    undetectable: 0,
    written: 0,
    detected: new Map(),
  };
  let lastUserId: string | undefined;
  for (;;) {
    let query = db.collection('users').orderBy(FieldPath.documentId()).limit(PAGE);
    if (lastUserId !== undefined) {
      query = query.startAfter(lastUserId);
    }
    const snap = await query.get();
    if (snap.empty) {
      break;
    }
    for (const user of snap.docs) {
      await scanUserRecipes(db, user.id, ready.deps, write, counts);
    }
    lastUserId = snap.docs[snap.docs.length - 1].id;
  }
  logSummary(counts, write);
}

if (isDirectRun()) {
  await main();
}
