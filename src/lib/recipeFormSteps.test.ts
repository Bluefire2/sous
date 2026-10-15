import { describe, expect, it } from 'vitest';
import { fromDraft, toDraft } from '../components/RecipeForm';
import { blankDraft } from './recipeDraft';
import type { RecipeDraft } from './types';

const laned: RecipeDraft = {
  ...blankDraft(),
  title: 'Pasta',
  steps: [
    { text: 'Boil water.' },
    { text: 'Fry garlic.', lane: 'Sauce' },
    { text: 'Cook pasta.', lane: 'Pasta' },
    { text: 'Toss.' },
  ],
};

describe('recipe form steps and lanes (docs/plans/parallel-steps.md)', () => {
  it('round-trips step lanes unchanged', () => {
    const form = fromDraft(laned, undefined);
    expect(toDraft(form, laned, undefined, []).steps).toEqual(laned.steps);
  });

  it('trims lanes, drops a blank one, and drops empty steps', () => {
    const form = fromDraft(laned, undefined);
    const edited = {
      ...form,
      steps: [
        { ...form.steps[0], lane: '   ' },
        { ...form.steps[1], lane: ' Sauce ' },
        { ...form.steps[2], text: '   ', lane: 'Pasta' },
        form.steps[3],
      ],
    };
    expect(toDraft(edited, laned, undefined, []).steps).toEqual([
      { text: 'Boil water.' },
      { text: 'Fry garlic.', lane: 'Sauce' },
      { text: 'Toss.' },
    ]);
  });

  it('gives every step card its own key, which the saved steps never carry', () => {
    const form = fromDraft(laned, undefined);
    expect(new Set(form.steps.map((step) => step.key)).size).toBe(form.steps.length);
    for (const step of toDraft(form, laned, undefined, []).steps) {
      expect(Object.keys(step).sort()).toEqual(step.lane === undefined ? ['text'] : ['lane', 'text']);
    }
  });
});
