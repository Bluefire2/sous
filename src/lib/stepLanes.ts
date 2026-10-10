import { MAX_DONE_STEPS } from './recipeSteps';
import type { RecipeStep } from './types';

/**
 * Parallel steps (`docs/plans/parallel-steps.md`). Pure: no store, no device,
 * no React. Progress is a set of done step indexes, written compactly as a
 * done prefix (`currentStep`) plus the steps done ahead of it (`doneSteps`).
 * Keep it a set: two people's progress then merges by union, which a future
 * shared cooking session relies on.
 */

export interface StepProgress {
  /** Every step before this index is done. */
  currentStep: number;
  /** Done steps after `currentStep`, sorted. */
  doneSteps: readonly number[];
}

export interface LaneRun {
  lane: string;
  /** Global step indexes, in order. */
  steps: number[];
}

export type StepBlock =
  | { kind: 'sync'; index: number }
  | { kind: 'parallel'; start: number; end: number; lanes: LaneRun[] };

/**
 * A maximal run of consecutive steps with a lane is one parallel block (end
 * exclusive); its lanes are the distinct names in order of first appearance.
 * A step without a lane is a sync point everyone does in order.
 */
export function stepBlocks(steps: readonly RecipeStep[]): StepBlock[] {
  const blocks: StepBlock[] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].lane === undefined) {
      blocks.push({ kind: 'sync', index: i });
      i += 1;
      continue;
    }
    const start = i;
    const lanes: LaneRun[] = [];
    const byName = new Map<string, LaneRun>();
    while (i < steps.length) {
      const lane = steps[i].lane;
      if (lane === undefined) break;
      let run = byName.get(lane);
      if (!run) {
        run = { lane, steps: [] };
        byName.set(lane, run);
        lanes.push(run);
      }
      run.steps.push(i);
      i += 1;
    }
    blocks.push({ kind: 'parallel', start, end: i, lanes });
  }
  return blocks;
}

/** Distinct lane names in the recipe, in order of first appearance. */
export function recipeLanes(steps: readonly RecipeStep[]): string[] {
  const lanes: string[] = [];
  for (const step of steps) {
    if (step.lane !== undefined && !lanes.includes(step.lane)) lanes.push(step.lane);
  }
  return lanes;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Drops entries that are not non-negative integers (or not below `stepCount`
 * when given), duplicates, and entries before `currentStep`; folds entries
 * that continue the prefix into `currentStep`; caps the rest at
 * `MAX_DONE_STEPS`. Never clamps `currentStep` itself.
 */
export function normalizeStepProgress(
  progress: { currentStep: number; doneSteps?: readonly unknown[] },
  stepCount?: number,
): { currentStep: number; doneSteps: number[] } {
  let currentStep = progress.currentStep;
  const done = new Set<number>();
  for (const value of progress.doneSteps ?? []) {
    if (!isIndex(value)) continue;
    if (stepCount !== undefined && value >= stepCount) continue;
    done.add(value);
  }
  while (done.has(currentStep)) {
    done.delete(currentStep);
    currentStep += 1;
  }
  const doneSteps = [...done]
    .filter((index) => index > currentStep)
    .sort((a, b) => a - b)
    .slice(0, MAX_DONE_STEPS);
  return { currentStep, doneSteps };
}

export function isStepDone(progress: StepProgress, index: number): boolean {
  return index < progress.currentStep || progress.doneSteps.includes(index);
}

function doneSet(progress: StepProgress, stepCount: number): Set<number> {
  const done = new Set<number>();
  for (let i = 0; i < Math.min(progress.currentStep, stepCount); i += 1) done.add(i);
  for (const index of progress.doneSteps) {
    if (index < stepCount) done.add(index);
  }
  return done;
}

function fromDoneSet(done: ReadonlySet<number>, stepCount: number): {
  currentStep: number;
  doneSteps: number[];
} {
  return normalizeStepProgress({ currentStep: 0, doneSteps: [...done] }, stepCount);
}

function firstUndone(done: ReadonlySet<number>, stepCount: number): number {
  let index = 0;
  while (index < stepCount && done.has(index)) index += 1;
  return index;
}

function blockAt(blocks: readonly StepBlock[], index: number): StepBlock | undefined {
  return blocks.find((block) =>
    block.kind === 'sync' ? block.index === index : index >= block.start && index < block.end,
  );
}

/**
 * The steps step `index` waits for, read from the lanes as a graph: a lane
 * step waits for the step before it in its lane, or for the sync step before
 * its block if it is first in its lane; a sync step waits for the step before
 * it, or for the last step of every lane when a block comes before it.
 */
function waitsFor(blocks: readonly StepBlock[], index: number): number[] {
  const block = blockAt(blocks, index);
  if (!block) return [];
  if (block.kind === 'parallel') {
    const run = block.lanes.find((candidate) => candidate.steps.includes(index));
    const position = run ? run.steps.indexOf(index) : 0;
    if (run && position > 0) return [run.steps[position - 1]];
    return block.start > 0 ? [block.start - 1] : [];
  }
  if (index === 0) return [];
  const before = blockAt(blocks, index - 1);
  if (before?.kind === 'parallel') return before.lanes.map((run) => run.steps[run.steps.length - 1]);
  return [index - 1];
}

/**
 * The steps that read as "now": every undone step whose steps it waits for
 * (`waitsFor`) are done. Without lanes that is the first undone step; in a
 * block it is each lane's next step. Empty when every step is done.
 */
export function activeSteps(
  steps: readonly RecipeStep[],
  progress: StepProgress,
): ReadonlySet<number> {
  const done = doneSet(progress, steps.length);
  const blocks = stepBlocks(steps);
  const active = new Set<number>();
  for (let index = 0; index < steps.length; index += 1) {
    if (!done.has(index) && waitsFor(blocks, index).every((j) => done.has(j))) {
      active.add(index);
    }
  }
  return active;
}

/**
 * True for an undone sync step that follows a block in which some lane is
 * not finished yet: it comes after every lane, so the screen says so.
 */
export function waitsForLanes(
  steps: readonly RecipeStep[],
  progress: StepProgress,
  index: number,
): boolean {
  if (steps[index] === undefined || steps[index].lane !== undefined) return false;
  if (index === 0 || steps[index - 1].lane === undefined) return false;
  const done = doneSet(progress, steps.length);
  if (done.has(index)) return false;
  return waitsFor(stepBlocks(steps), index).some((j) => !done.has(j));
}

/**
 * Progress after tapping step `index`. Without lanes this is the recipe
 * screen's old rule: tapping the current step ticks it, tapping any other
 * step jumps there. A lane step changes only its own lane and the shared
 * steps, never another lane's progress, so two cooks' taps never clash:
 * - an undone lane step ticks itself and every earlier step that is shared
 *   or in the same lane (in any block);
 * - a done lane step un-ticks itself and every later step that is shared or
 *   in the same lane.
 * A sync step that is current (or the first undone step) is ticked; any
 * other sync step is jumped to, as without lanes.
 */
export function tapStep(
  steps: readonly RecipeStep[],
  progress: StepProgress,
  index: number,
): { currentStep: number; doneSteps: number[] } {
  const stepCount = steps.length;
  const done = doneSet(progress, stepCount);
  const blocks = stepBlocks(steps);
  const block = blockAt(blocks, index);
  if (!block) return normalizeStepProgress(progress, stepCount);

  if (block.kind === 'sync') {
    const current =
      !done.has(index) && waitsFor(blocks, index).every((j) => done.has(j));
    if (current || index === firstUndone(done, stepCount)) {
      done.add(index);
      return fromDoneSet(done, stepCount);
    }
    return { currentStep: index, doneSteps: [] };
  }

  const lane = steps[index].lane;
  const ownOrShared = (j: number) => steps[j].lane === undefined || steps[j].lane === lane;
  if (done.has(index)) {
    for (let j = index; j < stepCount; j += 1) {
      if (ownOrShared(j)) done.delete(j);
    }
  } else {
    for (let j = 0; j <= index; j += 1) {
      if (ownOrShared(j)) done.add(j);
    }
  }
  return fromDoneSet(done, stepCount);
}

/**
 * Keeps lanes through an edit that left them out, deciding each step on its
 * own. Ask is told to state every step's lane; this is the safety net for a
 * step where it did not:
 * - a lane on the step is that lane, so Ask can move a step between lanes;
 * - an empty lane means "no lane", so Ask can remove one lane or all of them;
 * - no lane field gets the lane of a stored step with exactly the same
 *   text: the one at the same position if it matches, otherwise the first
 *   such step not already matched. So inserting or moving a step keeps the
 *   others' lanes; a reworded step without a lane field loses its lane.
 * To tell repeated text apart ("Stir" in two lanes), proposed steps are
 * matched to stored ones first by text and stated lane (that is the same
 * step, wherever Ask moved it), then by text at the same position, then by
 * the first unmatched step with that text. A stored step matched once is not
 * matched again.
 */
export function carryStepLanes(
  stored: readonly RecipeStep[],
  proposed: readonly RecipeStep[],
): RecipeStep[] {
  const matched = new Map<number, number>();
  const used = new Set<number>();
  const claim = (i: number, j: number) => {
    matched.set(i, j);
    used.add(j);
  };
  const free = (j: number, text: string) => !used.has(j) && stored[j]?.text === text;
  proposed.forEach((step, i) => {
    if (!step.lane) return;
    const sameStep = (j: number) => free(j, step.text) && stored[j].lane === step.lane;
    const j = sameStep(i) ? i : stored.findIndex((_, k) => sameStep(k));
    if (j >= 0) claim(i, j);
  });
  proposed.forEach((step, i) => {
    if (!matched.has(i) && free(i, step.text)) claim(i, i);
  });
  proposed.forEach((step, i) => {
    if (step.lane !== undefined || matched.has(i)) return;
    const j = stored.findIndex((_, k) => free(k, step.text));
    if (j >= 0) claim(i, j);
  });
  return proposed.map((step, i) => {
    if (step.lane === '') return { text: step.text };
    if (step.lane !== undefined) return step;
    const j = matched.get(i);
    const lane = j === undefined ? undefined : stored[j].lane;
    return lane === undefined ? step : { ...step, lane };
  });
}
