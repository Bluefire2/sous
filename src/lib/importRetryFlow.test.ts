import { describe, expect, it } from 'vitest';
import {
  importRetryReducer,
  initialImportRetryState,
  type ImportRetryAction,
  type ImportRetryState,
} from './importRetryFlow';
import type { RecipeDraft } from './types';

const DRAFT: RecipeDraft = {
  title: 'Soup',
  servings: 2,
  ingredientSections: [],
  steps: [{ text: 'Simmer.' }],
  tags: [],
};

const run = (...actions: ImportRetryAction[]): ImportRetryState =>
  actions.reduce(importRetryReducer, initialImportRetryState);

describe('importRetryReducer', () => {
  it('fetches, then opens one confirm sheet with the draft', () => {
    const fetching = run({ type: 'fetch' });
    expect(fetching).toMatchObject({ fetching: true, sheet: null });
    const open = importRetryReducer(fetching, {
      type: 'fetched',
      token: fetching.token,
      draft: DRAFT,
      importCheck: undefined,
    });
    expect(open.fetching).toBe(false);
    expect(open.sheet).toEqual({ kind: 'confirm', draft: DRAFT, importCheck: undefined, saving: false, error: null });
    expect(open.token).not.toBe(fetching.token);
  });

  it('ignores a fetch result after the person closed the workflow', () => {
    const fetching = run({ type: 'fetch' });
    const closed = importRetryReducer(fetching, { type: 'close' });
    expect(
      importRetryReducer(closed, { type: 'fetched', token: fetching.token, draft: DRAFT, importCheck: undefined }),
    ).toBe(closed);
    expect(importRetryReducer(closed, { type: 'fetchFailed', token: fetching.token, error: 'x' })).toBe(closed);
  });

  it('shows a fetch failure outside any sheet', () => {
    const fetching = run({ type: 'fetch' });
    expect(importRetryReducer(fetching, { type: 'fetchFailed', token: fetching.token, error: 'Nope' }))
      .toMatchObject({ fetching: false, error: 'Nope', sheet: null });
  });

  it('runs one save at a time and keeps the sheet on failure', () => {
    const fetching = run({ type: 'fetch' });
    const open = importRetryReducer(fetching, { type: 'fetched', token: fetching.token, draft: DRAFT, importCheck: undefined });
    const saving = importRetryReducer(open, { type: 'submitting', token: open.token });
    expect(saving.sheet?.saving).toBe(true);
    expect(importRetryReducer(saving, { type: 'submitting', token: open.token })).toBe(saving);
    const failed = importRetryReducer(saving, { type: 'saveFailed', token: open.token, error: 'Offline' });
    expect(failed.sheet).toMatchObject({ saving: false, error: 'Offline', draft: DRAFT });
  });

  it('ignores a stale save result after close', () => {
    const fetching = run({ type: 'fetch' });
    const open = importRetryReducer(fetching, { type: 'fetched', token: fetching.token, draft: DRAFT, importCheck: undefined });
    const closed = importRetryReducer(open, { type: 'close' });
    expect(importRetryReducer(closed, { type: 'saveFailed', token: open.token, error: 'x' })).toBe(closed);
    expect(importRetryReducer(closed, { type: 'submitting', token: open.token })).toBe(closed);
  });

  it('does not start a second fetch while one runs or a sheet is open', () => {
    const fetching = run({ type: 'fetch' });
    expect(importRetryReducer(fetching, { type: 'fetch' })).toBe(fetching);
    const open = importRetryReducer(fetching, { type: 'fetched', token: fetching.token, draft: DRAFT, importCheck: undefined });
    expect(importRetryReducer(open, { type: 'fetch' })).toBe(open);
  });
});
