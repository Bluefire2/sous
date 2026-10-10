import { MAX_DONE_STEPS, MAX_LANES } from './recipeSteps';
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
 * The done steps whose whole chain is done: the step and, through
 * `waitsFor`, everything it waits for. A lane step done ahead (its cook
 * skipped on) is done but not finished, so what follows it still waits.
 */
function finishedSteps(blocks: readonly StepBlock[], done: ReadonlySet<number>, stepCount: number): Set<number> {
  const finished = new Set<number>();
  for (let index = 0; index < stepCount; index += 1) {
    if (done.has(index) && waitsFor(blocks, index).every((j) => finished.has(j))) {
      finished.add(index);
    }
  }
  return finished;
}

/**
 * The steps that read as "now": every undone step whose steps it waits for
 * are finished (`finishedSteps`). Without lanes that is the first undone
 * step; in a block it is each lane's next step. Empty when every step is
 * done.
 */
export function activeSteps(
  steps: readonly RecipeStep[],
  progress: StepProgress,
): ReadonlySet<number> {
  const done = doneSet(progress, steps.length);
  const blocks = stepBlocks(steps);
  const finished = finishedSteps(blocks, done, steps.length);
  const active = new Set<number>();
  for (let index = 0; index < steps.length; index += 1) {
    if (!done.has(index) && waitsFor(blocks, index).every((j) => finished.has(j))) {
      active.add(index);
    }
  }
  return active;
}

/**
 * The undone sync steps that follow a block of two or more lanes in which
 * some lane is not finished yet: each comes after every lane, so the screen
 * says so. (After a one-lane block the order already says it.)
 */
export function stepsWaitingForLanes(
  steps: readonly RecipeStep[],
  progress: StepProgress,
): ReadonlySet<number> {
  const done = doneSet(progress, steps.length);
  const blocks = stepBlocks(steps);
  const finished = finishedSteps(blocks, done, steps.length);
  const waiting = new Set<number>();
  for (const block of blocks) {
    if (block.kind !== 'parallel' || block.lanes.length < 2) continue;
    const join = block.end;
    if (join >= steps.length || done.has(join)) continue;
    if (waitsFor(blocks, join).some((j) => !finished.has(j))) waiting.add(join);
  }
  return waiting;
}

/**
 * Progress after tapping step `index`. Without lanes this is the recipe
 * screen's old rule: tapping the current step ticks it, tapping any other
 * step jumps there. A lane tap never changes another lane's steps, and a
 * shared step is only ever ticked by a lane tap once everything it waits for
 * is finished (`finishedSteps`), so no lane races past a step where the
 * lanes meet:
 * - an undone lane step ticks itself and the earlier steps in its lane, plus
 *   each earlier shared step whose wait is then finished, in order;
 * - a done lane step un-ticks itself and every later step that is shared or
 *   in the same lane.
 * A sync step:
 * - current (everything it waits for is finished): ticked;
 * - done: un-ticked with every step after it, as without lanes ("we are back
 *   here"); nothing earlier changes;
 * - otherwise: a jump there, which ticks every earlier step and keeps later
 *   progress.
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
  const shared = (j: number) => steps[j].lane === undefined;

  if (block.kind === 'sync') {
    const finished = finishedSteps(blocks, done, stepCount);
    if (done.has(index)) {
      for (let j = index; j < stepCount; j += 1) done.delete(j);
    } else if (waitsFor(blocks, index).every((j) => finished.has(j))) {
      done.add(index);
    } else {
      for (let j = 0; j < index; j += 1) done.add(j);
    }
    return fromDoneSet(done, stepCount);
  }

  const lane = steps[index].lane;
  if (done.has(index)) {
    for (let j = index; j < stepCount; j += 1) {
      if (shared(j) || steps[j].lane === lane) done.delete(j);
    }
  } else {
    // In step order, so a shared step sees the ticks made before it.
    const finished = new Set<number>();
    for (let j = 0; j <= index; j += 1) {
      const waitsFinished = waitsFor(blocks, j).every((k) => finished.has(k));
      if (steps[j].lane === lane || (shared(j) && waitsFinished)) done.add(j);
      if (done.has(j) && waitsFinished) finished.add(j);
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
  // At most MAX_LANES lanes in the result, so the diff shows what saving
  // keeps (compactSteps keeps the first MAX_LANES). Lanes the proposal states
  // come first; a carried lane that would be one too many is left off and
  // its steps are shared.
  const lanes = new Set<string>();
  for (const step of proposed) {
    if (step.lane && lanes.size < MAX_LANES) lanes.add(step.lane);
  }
  return proposed.map((step, i) => {
    if (step.lane === '') return { text: step.text };
    if (step.lane !== undefined) return step;
    const j = matched.get(i);
    const lane = j === undefined ? undefined : stored[j].lane;
    if (lane === undefined) return step;
    if (!lanes.has(lane)) {
      if (lanes.size >= MAX_LANES) return { text: step.text };
      lanes.add(lane);
    }
    return { ...step, lane };
  });
}
