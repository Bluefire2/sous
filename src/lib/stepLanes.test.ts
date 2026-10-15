import { describe, expect, it } from 'vitest';
import {
  activeSteps,
  carryStepLanes,
  isStepDone,
  normalizeStepProgress,
  recipeLanes,
  stepBlocks,
  tapStep,
  stepsWaitingForLanes,
  type StepProgress,
} from './stepLanes';
import type { RecipeStep } from './types';

const plain = (n: number): RecipeStep[] =>
  Array.from({ length: n }, (_, i) => ({ text: `step ${i + 1}` }));

/** 0 sync, 1–2 Sauce, 3–4 Pasta, 5 sync. */
const pasta: RecipeStep[] = [
  { text: 'Boil water' },
  { text: 'Fry garlic', lane: 'Sauce' },
  { text: 'Add tomatoes', lane: 'Sauce' },
  { text: 'Cook pasta', lane: 'Pasta' },
  { text: 'Drain', lane: 'Pasta' },
  { text: 'Toss' },
];

const at = (currentStep: number, doneSteps: number[] = []): StepProgress => ({
  currentStep,
  doneSteps,
});

describe('stepBlocks', () => {
  it('makes every step a sync point when there are no lanes', () => {
    expect(stepBlocks(plain(3))).toEqual([
      { kind: 'sync', index: 0 },
      { kind: 'sync', index: 1 },
      { kind: 'sync', index: 2 },
    ]);
  });

  it('groups a run of laned steps into one block of lanes', () => {
    expect(stepBlocks(pasta)).toEqual([
      { kind: 'sync', index: 0 },
      {
        kind: 'parallel',
        start: 1,
        end: 5,
        lanes: [
          { lane: 'Sauce', steps: [1, 2] },
          { lane: 'Pasta', steps: [3, 4] },
        ],
      },
      { kind: 'sync', index: 5 },
    ]);
  });

  it('keeps a run with one lane name as a block', () => {
    const steps = [{ text: 'a' }, { text: 'b', lane: 'Sauce' }, { text: 'c' }];
    expect(stepBlocks(steps)[1]).toEqual({
      kind: 'parallel',
      start: 1,
      end: 2,
      lanes: [{ lane: 'Sauce', steps: [1] }],
    });
  });

  it('lets a lane recur in a later block and a block end the recipe', () => {
    const steps = [
      { text: 'a', lane: 'A' },
      { text: 'b', lane: 'B' },
      { text: 'sync' },
      { text: 'c', lane: 'B' },
      { text: 'd', lane: 'A' },
    ];
    const blocks = stepBlocks(steps);
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toEqual({
      kind: 'parallel',
      start: 3,
      end: 5,
      lanes: [
        { lane: 'B', steps: [3] },
        { lane: 'A', steps: [4] },
      ],
    });
  });

  it('keeps interleaved lane steps in their own lanes', () => {
    const steps = [
      { text: 'a', lane: 'A' },
      { text: 'b', lane: 'B' },
      { text: 'c', lane: 'A' },
    ];
    expect(stepBlocks(steps)).toEqual([
      {
        kind: 'parallel',
        start: 0,
        end: 3,
        lanes: [
          { lane: 'A', steps: [0, 2] },
          { lane: 'B', steps: [1] },
        ],
      },
    ]);
  });
});

describe('recipeLanes', () => {
  it('lists distinct lanes in order of first appearance', () => {
    expect(recipeLanes(pasta)).toEqual(['Sauce', 'Pasta']);
    expect(recipeLanes(plain(2))).toEqual([]);
  });
});

describe('normalizeStepProgress', () => {
  it('folds a done run into currentStep', () => {
    expect(normalizeStepProgress({ currentStep: 1, doneSteps: [1, 2, 4] })).toEqual({
      currentStep: 3,
      doneSteps: [4],
    });
  });

  it('drops duplicates, entries before currentStep, and malformed entries, and sorts', () => {
    expect(
      normalizeStepProgress({ currentStep: 2, doneSteps: [5, 0, 5, -1, 2.5, '4', null, 4] }),
    ).toEqual({ currentStep: 2, doneSteps: [4, 5] });
  });

  it('drops entries past the last step when the step count is known', () => {
    expect(normalizeStepProgress({ currentStep: 0, doneSteps: [3, 9] }, 6)).toEqual({
      currentStep: 0,
      doneSteps: [3],
    });
  });

  it('accepts a missing doneSteps and never clamps currentStep', () => {
    expect(normalizeStepProgress({ currentStep: 9 }, 6)).toEqual({ currentStep: 9, doneSteps: [] });
  });

  it('caps the list', () => {
    const many = Array.from({ length: 300 }, (_, i) => i * 2 + 2);
    expect(normalizeStepProgress({ currentStep: 0, doneSteps: many }).doneSteps).toHaveLength(200);
  });
});

describe('activeSteps', () => {
  it('is the current step when it is a sync point', () => {
    expect([...activeSteps(pasta, at(0))]).toEqual([0]);
    expect([...activeSteps(pasta, at(5))]).toEqual([5]);
  });

  it('is each lane’s first undone step inside a block', () => {
    expect([...activeSteps(pasta, at(1))]).toEqual([1, 3]);
    expect([...activeSteps(pasta, at(1, [3]))]).toEqual([1, 4]);
  });

  it('leaves out a finished lane', () => {
    expect([...activeSteps(pasta, at(1, [3, 4]))]).toEqual([1]);
  });

  it('is empty when every step is done', () => {
    expect(activeSteps(pasta, at(6)).size).toBe(0);
  });
});

describe('tapStep', () => {
  it('matches the old rule exactly when there are no lanes', () => {
    const steps = plain(5);
    for (let current = 0; current <= 5; current += 1) {
      for (let tapped = 0; tapped < 5; tapped += 1) {
        const expected = tapped === current ? tapped + 1 : tapped;
        expect(tapStep(steps, at(current), tapped)).toEqual({
          currentStep: expected,
          doneSteps: [],
        });
      }
    }
  });

  it('ticks a lane’s current step without moving the other lane', () => {
    expect(tapStep(pasta, at(1), 3)).toEqual({ currentStep: 1, doneSteps: [3] });
    expect(tapStep(pasta, at(1, [3]), 1)).toEqual({ currentStep: 2, doneSteps: [3] });
  });

  it('reaches the sync step only when both lanes are done', () => {
    let progress = at(1);
    for (const index of [1, 3, 2, 4]) progress = tapStep(pasta, progress, index);
    expect(progress).toEqual({ currentStep: 5, doneSteps: [] });
    expect([...activeSteps(pasta, progress)]).toEqual([5]);
  });

  it('ticks the lane up to a step tapped further ahead, and everything before the block', () => {
    expect(tapStep(pasta, at(0), 4)).toEqual({ currentStep: 1, doneSteps: [3, 4] });
  });

  it('ticks the whole block when the sync step after it is tapped', () => {
    expect(tapStep(pasta, at(1, [3]), 5)).toEqual({ currentStep: 5, doneSteps: [] });
  });

  it('un-ticks a done lane step, the rest of its lane, and the shared steps after it', () => {
    expect(tapStep(pasta, at(6), 3)).toEqual({ currentStep: 3, doneSteps: [] });
    expect(tapStep(pasta, at(2, [3, 4]), 3)).toEqual({ currentStep: 2, doneSteps: [] });
    expect(tapStep(pasta, at(3, [4]), 1)).toEqual({ currentStep: 1, doneSteps: [4] });
  });

  it('clears the block when a sync step before it is tapped', () => {
    expect(tapStep(pasta, at(1, [3]), 0)).toEqual({ currentStep: 0, doneSteps: [] });
  });

  /** 0 Curry, 1 Rice, 2 shared check, 3 Curry, 4 Rice: one lane name per cook across two blocks. */
  const split: RecipeStep[] = [
    { text: 'Chop the onion', lane: 'Curry' },
    { text: 'Rinse the rice', lane: 'Rice' },
    { text: 'Taste together' },
    { text: 'Simmer the curry', lane: 'Curry' },
    { text: 'Fluff the rice', lane: 'Rice' },
  ];

  it('ticks its own lane in a later block but leaves the shared step where the lanes meet', () => {
    expect(tapStep(split, at(0), 4)).toEqual({ currentStep: 0, doneSteps: [1, 4] });
    // The check waits for Curry's onion, so it stays undone; the Curry cook
    // has one current step and the Rice cook waits.
    expect([...activeSteps(split, at(0, [1, 4]))]).toEqual([0]);
    expect([...stepsWaitingForLanes(split, at(0, [1, 4]))]).toEqual([2]);
  });

  it('ticks the shared step once the other lane catches up, then the lanes go on', () => {
    const riceAhead = at(0, [1, 4]);
    const curryCaughtUp = tapStep(split, riceAhead, 0);
    expect(curryCaughtUp).toEqual({ currentStep: 2, doneSteps: [4] });
    const checked = tapStep(split, curryCaughtUp, 2);
    expect(checked).toEqual({ currentStep: 3, doneSteps: [4] });
    expect([...activeSteps(split, checked)]).toEqual([3]);
  });

  it('un-ticks only its own lane and the shared steps after it', () => {
    expect(tapStep(split, at(5), 1)).toEqual({ currentStep: 1, doneSteps: [3] });
  });

  it('un-ticks a done shared step and everything after it, never filling in earlier ones', () => {
    expect(tapStep(split, at(5), 2)).toEqual({ currentStep: 2, doneSteps: [] });
    // Rice ran ahead and the onion is still to do: un-ticking the check is
    // impossible (it is not done), and un-ticking Rice's rinse leaves the onion alone.
    expect(tapStep(split, at(0, [1, 4]), 1)).toEqual({ currentStep: 0, doneSteps: [] });
    // The Rice cook is ahead; un-ticking an undone onion is not possible, and
    // tapping the check (not current) jumps there without losing Rice's step.
    expect(tapStep(split, at(0, [1, 4]), 2)).toEqual({ currentStep: 2, doneSteps: [4] });
  });

  it('does not make a step current while a step it waits for through a chain is undone', () => {
    // 0 X, 1 shared, 2 Y, 3 shared. The Y cook ticks Fold ahead of Rest.
    const steps: RecipeStep[] = [
      { text: 'Whisk', lane: 'X' },
      { text: 'Rest' },
      { text: 'Fold', lane: 'Y' },
      { text: 'Bake' },
    ];
    const foldAhead = tapStep(steps, at(0), 2);
    expect(foldAhead).toEqual({ currentStep: 0, doneSteps: [2] });
    expect([...activeSteps(steps, foldAhead)]).toEqual([0]);
    const whisked = tapStep(steps, foldAhead, 0);
    expect([...activeSteps(steps, whisked)]).toEqual([1]);
    expect([...activeSteps(steps, tapStep(steps, whisked, 1))]).toEqual([3]);
  });

  it('keeps one current step per lane when a lane runs ahead into the next block', () => {
    // 0 shared, 1 A, 2 B, 3 shared, 4 A, 5 B, 6 shared.
    const steps: RecipeStep[] = [
      { text: 's0' },
      { text: 'a1', lane: 'A' },
      { text: 'b2', lane: 'B' },
      { text: 's3' },
      { text: 'a4', lane: 'A' },
      { text: 'b5', lane: 'B' },
      { text: 's6' },
    ];
    const aAhead = tapStep(steps, at(1), 4);
    expect(aAhead).toEqual({ currentStep: 2, doneSteps: [4] });
    expect([...activeSteps(steps, aAhead)]).toEqual([2]);
  });

  it('only reaches "done" when every step is done', () => {
    // 0 A, 1 C, 2 shared, 3 A, 4 B, 5 shared. C's step is never ticked.
    const steps: RecipeStep[] = [
      { text: 'a0', lane: 'A' },
      { text: 'c1', lane: 'C' },
      { text: 's2' },
      { text: 'a3', lane: 'A' },
      { text: 'b4', lane: 'B' },
      { text: 's5' },
    ];
    let progress = at(0);
    for (const index of [0, 3, 4]) progress = tapStep(steps, progress, index);
    expect(progress.currentStep).toBeLessThan(steps.length);
    expect(isStepDone(progress, 2)).toBe(false);
    expect([...activeSteps(steps, progress)]).toEqual([1]);
    // The last step is not current and says it waits for every lane.
    expect([...stepsWaitingForLanes(steps, progress)]).toEqual([2, 5]);
  });
});

describe('stepsWaitingForLanes', () => {
  it('holds the sync step after a block until every lane is done', () => {
    expect([...stepsWaitingForLanes(pasta, at(1))]).toEqual([5]);
    expect([...stepsWaitingForLanes(pasta, at(3))]).toEqual([5]);
    expect(stepsWaitingForLanes(pasta, at(5)).size).toBe(0);
    expect(stepsWaitingForLanes(pasta, at(6)).size).toBe(0);
  });

  it('is empty without lanes and after a one-lane block', () => {
    expect(stepsWaitingForLanes(plain(3), at(0)).size).toBe(0);
    const oneLane: RecipeStep[] = [{ text: 'a' }, { text: 'b', lane: 'Wash-up' }, { text: 'c' }];
    expect(stepsWaitingForLanes(oneLane, at(0)).size).toBe(0);
  });
});

describe('progress merges by union (a future shared cooking session)', () => {
  it('two cooks on different lanes add up to one cook doing both', () => {
    const start = at(1);
    const sauce = tapStep(pasta, tapStep(pasta, start, 1), 2);
    const pastaCook = tapStep(pasta, tapStep(pasta, start, 3), 4);
    const union = pasta
      .map((_, i) => i)
      .filter((i) => isStepDone(sauce, i) || isStepDone(pastaCook, i));
    const merged = normalizeStepProgress({ currentStep: 0, doneSteps: union }, pasta.length);
    const oneCook = [1, 2, 3, 4].reduce((p, i) => tapStep(pasta, p, i), start);
    expect(merged).toEqual(oneCook);
    expect(merged).toEqual({ currentStep: 5, doneSteps: [] });
  });
});

describe('carryStepLanes', () => {
  it('puts stored lanes back on a lane-less proposal where the text is unchanged', () => {
    const proposed = pasta.map(({ text }) => ({ text }));
    proposed[2] = { text: 'Add tinned tomatoes' };
    const carried = carryStepLanes(pasta, proposed);
    expect(carried.map((s) => s.lane)).toEqual([
      undefined,
      'Sauce',
      undefined,
      'Pasta',
      'Pasta',
      undefined,
    ]);
  });

  it('follows unchanged text when a step is inserted before the others', () => {
    const proposed = [{ text: 'New first step' }, ...pasta.map(({ text }) => ({ text }))];
    expect(carryStepLanes(pasta, proposed).map((s) => s.lane)).toEqual([
      undefined,
      ...pasta.map((s) => s.lane),
    ]);
  });

  it('prefers the same position, then the first unmatched step with that text', () => {
    const stored = [
      { text: 'Stir', lane: 'A' },
      { text: 'Stir', lane: 'B' },
    ];
    expect(carryStepLanes(stored, [{ text: 'Stir' }, { text: 'Stir' }])).toEqual(stored);
    expect(carryStepLanes(stored, [{ text: 'New' }, { text: 'Stir' }, { text: 'Stir' }])).toEqual([
      { text: 'New' },
      { text: 'Stir', lane: 'B' },
      { text: 'Stir', lane: 'A' },
    ]);
  });

  it('treats a step with the same text and stated lane as that stored step', () => {
    const stored = [
      { text: 'Stir', lane: 'Sauce' },
      { text: 'Stir', lane: 'Pasta' },
    ];
    // The stated Pasta stir is stored[1] moved up; the other is the Sauce one.
    expect(
      carryStepLanes(stored, [{ text: 'Stir', lane: 'Pasta' }, { text: 'Chop' }, { text: 'Stir' }]),
    ).toEqual([{ text: 'Stir', lane: 'Pasta' }, { text: 'Chop' }, { text: 'Stir', lane: 'Sauce' }]);
  });

  it('keeps a moved step with a stated lane from lending that lane to its twin', () => {
    const stored = [
      { text: 'Boil', lane: 'Pasta' },
      { text: 'Stir', lane: 'Sauce' },
      { text: 'Stir', lane: 'Pasta' },
      { text: 'Serve' },
    ];
    const proposed = [{ text: 'Stir', lane: 'Sauce' }, { text: 'Stir' }, { text: 'Boil' }, { text: 'Serve' }];
    expect(carryStepLanes(stored, proposed)).toEqual([
      { text: 'Stir', lane: 'Sauce' },
      { text: 'Stir', lane: 'Pasta' },
      { text: 'Boil', lane: 'Pasta' },
      { text: 'Serve' },
    ]);
  });

  it('lets a step that states a new lane keep the stored step at its position', () => {
    const stored = [
      { text: 'Stir', lane: 'Sauce' },
      { text: 'Stir', lane: 'Pasta' },
    ];
    expect(carryStepLanes(stored, [{ text: 'Stir', lane: 'Garnish' }, { text: 'Stir' }])).toEqual([
      { text: 'Stir', lane: 'Garnish' },
      { text: 'Stir', lane: 'Pasta' },
    ]);
  });

  it('keeps lanes the proposal states over a carried lane past the cap', () => {
    const stored = [
      { text: 'x', lane: 'Old' },
      { text: 'n1', lane: 'Old2' },
    ];
    const proposed = [
      { text: 'x' },
      { text: 'n1', lane: 'D' },
      { text: 'n2', lane: 'E' },
      { text: 'n3', lane: 'F' },
    ];
    expect(carryStepLanes(stored, proposed)).toEqual([
      { text: 'x' },
      { text: 'n1', lane: 'D' },
      { text: 'n2', lane: 'E' },
      { text: 'n3', lane: 'F' },
    ]);
  });

  it('removes every lane when the proposal sets them to empty', () => {
    const proposed = pasta.map(({ text }) => ({ text, lane: '' }));
    expect(carryStepLanes(pasta, proposed)).toEqual(pasta.map(({ text }) => ({ text })));
  });

  it('decides each step on its own: a lane, an empty lane, or no field', () => {
    const proposed = [
      { text: 'Boil water', lane: 'Pasta' },
      { text: 'Fry garlic', lane: '' },
      { text: 'Add tomatoes' },
      { text: 'Cook pasta', lane: 'Sauce' },
      { text: 'Drain' },
      { text: 'Toss' },
    ];
    expect(carryStepLanes(pasta, proposed)).toEqual([
      { text: 'Boil water', lane: 'Pasta' },
      { text: 'Fry garlic' },
      { text: 'Add tomatoes', lane: 'Sauce' },
      { text: 'Cook pasta', lane: 'Sauce' },
      { text: 'Drain', lane: 'Pasta' },
      { text: 'Toss' },
    ]);
  });

  it('removes only the lane the proposal empties', () => {
    const proposed = pasta.map(({ text }, i) => (i === 1 ? { text, lane: '' } : { text }));
    expect(carryStepLanes(pasta, proposed).map((step) => step.lane)).toEqual([
      undefined,
      undefined,
      'Sauce',
      'Pasta',
      'Pasta',
      undefined,
    ]);
  });
});
