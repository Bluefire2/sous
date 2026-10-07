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
 * The steps that read as "now": the first undone step when it is a sync
 * step, or each lane's first undone step in the block that holds the first
 * undone step. Empty when every step is done.
 */
export function activeSteps(
  steps: readonly RecipeStep[],
  progress: StepProgress,
): ReadonlySet<number> {
  const done = doneSet(progress, steps.length);
  const first = firstUndone(done, steps.length);
  const active = new Set<number>();
  if (first >= steps.length) return active;
  const block = blockAt(stepBlocks(steps), first);
  if (!block || block.kind === 'sync') {
    active.add(first);
    return active;
  }
  for (const run of block.lanes) {
    const next = run.steps.find((index) => !done.has(index));
    if (next !== undefined) active.add(next);
  }
  return active;
}

/**
 * Progress after tapping step `index`. Without lanes this is the recipe
 * screen's old rule: tapping the current step ticks it, tapping any other
 * step jumps there. Inside a block the same rule applies per lane, and other
 * lanes keep their progress:
 * - an undone lane step ticks everything before the block and the lane up to it;
 * - a done lane step un-ticks itself, the rest of its lane, and everything after the block.
 */
export function tapStep(
  steps: readonly RecipeStep[],
  progress: StepProgress,
  index: number,
): { currentStep: number; doneSteps: number[] } {
  const stepCount = steps.length;
  const done = doneSet(progress, stepCount);
  const block = blockAt(stepBlocks(steps), index);
  if (!block) return normalizeStepProgress(progress, stepCount);

  if (block.kind === 'sync') {
    if (index === firstUndone(done, stepCount)) {
      done.add(index);
      return fromDoneSet(done, stepCount);
    }
    return { currentStep: index, doneSteps: [] };
  }

  const run = block.lanes.find((candidate) => candidate.steps.includes(index));
  if (!run) return normalizeStepProgress(progress, stepCount);
  const next = new Set<number>();
  if (done.has(index)) {
    for (const doneIndex of done) {
      const laterInLane = doneIndex >= index && run.steps.includes(doneIndex);
      if (doneIndex < block.end && !laterInLane) next.add(doneIndex);
    }
  } else {
    for (const doneIndex of done) next.add(doneIndex);
    for (let i = 0; i < block.start; i += 1) next.add(i);
    for (const laneIndex of run.steps) {
      if (laneIndex <= index) next.add(laneIndex);
    }
  }
  return fromDoneSet(next, stepCount);
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
 */
export function carryStepLanes(
  stored: readonly RecipeStep[],
  proposed: readonly RecipeStep[],
): RecipeStep[] {
  const matched = new Map<number, number>();
  const used = new Set<number>();
  proposed.forEach((step, i) => {
    if (step.lane === undefined && stored[i]?.text === step.text) {
      matched.set(i, i);
      used.add(i);
    }
  });
  proposed.forEach((step, i) => {
    if (step.lane !== undefined || matched.has(i)) return;
    const j = stored.findIndex((candidate, k) => !used.has(k) && candidate.text === step.text);
    if (j >= 0) {
      matched.set(i, j);
      used.add(j);
    }
  });
  return proposed.map((step, i) => {
    if (step.lane === '') return { text: step.text };
    if (step.lane !== undefined) return step;
    const j = matched.get(i);
    const lane = j === undefined ? undefined : stored[j].lane;
    return lane === undefined ? step : { ...step, lane };
  });
}
