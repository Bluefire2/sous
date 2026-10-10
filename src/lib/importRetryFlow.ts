import type { ImportCheck } from './importCheck';
import type { RecipeDraft } from './types';

/**
 * Retry import on the recipe view's import-warning banner, as a pure reducer
 * (constitution `client-state.md`, principle 6). The workflow fetches a fresh
 * import, then opens one confirm sheet that carries the draft it would save.
 *
 * Every open or close changes `token`. A handler captures the token before it
 * awaits and passes it back with the result; the reducer ignores a result
 * whose token no longer matches, so a late import cannot open a sheet the
 * person has moved past, and a late save cannot close a newer one.
 */
export type ImportRetryState = {
  token: number;
  /** Fetching the new import. No sheet is open yet. */
  fetching: boolean;
  /** A failed fetch, shown on the banner. */
  error: string | null;
  sheet: null | {
    kind: 'confirm';
    draft: RecipeDraft;
    importCheck: ImportCheck | undefined;
    /** Set by `submitting` and cleared only by a failure. */
    saving: boolean;
    error: string | null;
  };
};

export type ImportRetryAction =
  | { type: 'fetch' }
  | { type: 'fetched'; token: number; draft: RecipeDraft; importCheck: ImportCheck | undefined }
  | { type: 'fetchFailed'; token: number; error: string }
  | { type: 'submitting'; token: number }
  | { type: 'saveFailed'; token: number; error: string }
  | { type: 'close' };

export const initialImportRetryState: ImportRetryState = {
  token: 0,
  fetching: false,
  error: null,
  sheet: null,
};

export function importRetryReducer(
  state: ImportRetryState,
  action: ImportRetryAction,
): ImportRetryState {
  switch (action.type) {
    case 'fetch':
      if (state.fetching || state.sheet !== null) return state;
      return { token: state.token + 1, fetching: true, error: null, sheet: null };
    case 'fetched':
      if (action.token !== state.token || !state.fetching) return state;
      return {
        token: state.token + 1,
        fetching: false,
        error: null,
        sheet: {
          kind: 'confirm',
          draft: action.draft,
          importCheck: action.importCheck,
          saving: false,
          error: null,
        },
      };
    case 'fetchFailed':
      if (action.token !== state.token || !state.fetching) return state;
      return { ...state, fetching: false, error: action.error };
    case 'submitting':
      if (action.token !== state.token || state.sheet === null || state.sheet.saving) return state;
      return { ...state, sheet: { ...state.sheet, saving: true, error: null } };
    case 'saveFailed':
      if (action.token !== state.token || state.sheet === null) return state;
      return { ...state, sheet: { ...state.sheet, saving: false, error: action.error } };
    case 'close':
      if (state.sheet === null && !state.fetching) return state;
      return { token: state.token + 1, fetching: false, error: null, sheet: null };
  }
}
