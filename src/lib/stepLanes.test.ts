import { describe, expect, it } from 'vitest';
import {
  activeSteps,
  carryStepLanes,
  isStepDone,
  normalizeStepProgress,
  recipeLanes,
  stepBlocks,
  tapStep,
  waitsForLanes,
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

  it('ticks only shared steps and the same lane before a step in a later block', () => {
    expect(tapStep(split, at(0), 4)).toEqual({ currentStep: 0, doneSteps: [1, 2, 4] });
    // The Curry cook's onion is still theirs to do, and their next step.
    expect([...activeSteps(split, at(0, [1, 2, 4]))]).toEqual([0, 3]);
  });

  it('un-ticks only its own lane and the shared steps after it', () => {
    const allDone = at(5);
    expect(tapStep(split, allDone, 1)).toEqual({ currentStep: 1, doneSteps: [3] });
  });

  it('makes the shared step current only once both lanes before it are done', () => {
    // The Rice cook rinsed; the check still waits for Curry's onion.
    expect([...activeSteps(split, at(0, [1]))]).toEqual([0]);
    expect(waitsForLanes(split, at(0, [1]), 2)).toBe(true);
  });

  it('ticks a current sync step without ticking another lane’s earlier step', () => {
    // 0 X, 1 shared, 2 Y, 3 shared. The Y cook finished their step, so the
    // last shared step is current while X's first step is still to do.
    const steps: RecipeStep[] = [
      { text: 'Whisk', lane: 'X' },
      { text: 'Rest' },
      { text: 'Fold', lane: 'Y' },
      { text: 'Bake' },
    ];
    const progress = tapStep(steps, at(0), 2);
    expect(progress).toEqual({ currentStep: 0, doneSteps: [1, 2] });
    expect([...activeSteps(steps, progress)]).toEqual([0, 3]);
    expect(tapStep(steps, progress, 3)).toEqual({ currentStep: 0, doneSteps: [1, 2, 3] });
  });
});

describe('waitsForLanes', () => {
  it('is true for the sync step after a block until every lane is done', () => {
    expect(waitsForLanes(pasta, at(1), 5)).toBe(true);
    expect(waitsForLanes(pasta, at(3), 5)).toBe(true);
    expect(waitsForLanes(pasta, at(5), 5)).toBe(false);
  });

  it('is false for lane steps, a sync step not after a block, and a done step', () => {
    expect(waitsForLanes(pasta, at(0), 1)).toBe(false);
    expect(waitsForLanes(pasta, at(0), 0)).toBe(false);
    expect(waitsForLanes(pasta, at(6), 5)).toBe(false);
    expect(waitsForLanes(plain(3), at(0), 2)).toBe(false);
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
