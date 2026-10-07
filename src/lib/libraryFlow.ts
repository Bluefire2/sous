import { t } from '../i18n';
import { recipeIdsAfterMove, wouldExceedRecipeIdCap } from './collectionMembership';

/**
 * The Library screen's dialogs. At most one sheet is open, and each sheet
 * carries the data its workflow needs, so a move into a new collection keeps
 * its recipe ids and a retried create reuses the collection it already made.
 *
 * `token` changes whenever a sheet opens or closes. An async submit captures
 * it at the start; completions from an older token are ignored, so a late
 * result cannot close or overwrite a sheet the user opened since.
 *
 * `saving` on create, move and rename is true from `submitting` until the
 * attempt fails or the sheet closes. It disables the sheet's inputs and
 * submit controls, so one submit runs at a time and what lands is what was
 * submitted. A second create before `created` lands would make a second
 * collection; a second move or rename could land a different choice.
 */
export type LibrarySheet =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'deleteRecipe'; recipeId: string }
  | { kind: 'move'; recipeIds: readonly string[]; saving: boolean; error?: string }
  | {
      kind: 'create';
      /** Set when the new collection is the destination of a move. */
      moveRecipeIds?: readonly string[];
      name: string;
      /** A collection an earlier attempt already created; retries reuse it. */
      created?: { id: string; name: string };
      saving: boolean;
      error?: string;
    }
  | { kind: 'rename'; collectionId: string; name: string; saving: boolean; error?: string }
  | { kind: 'deleteCollection'; collectionId: string; error?: string }
  /** `name` is kept so the sheet can still title itself once the collection has left the list. */
  | { kind: 'leave'; collectionId: string; name: string; error?: string }
  | { kind: 'share' }
  | { kind: 'inviteConfirm' }
  /** The new-member intro (`docs/plans/new-member-intro.md`); `step` is 0-based. */
  | { kind: 'intro'; step: number };

/** How many steps the new-member intro has. */
export const INTRO_STEP_COUNT = 5;

export type LibraryFlow = { token: number; sheet: LibrarySheet };

export type LibraryFlowAction =
  | { type: 'openAdd' }
  | { type: 'openDeleteRecipe'; recipeId: string }
  | { type: 'openMove'; recipeIds: readonly string[] }
  /** From the move sheet the new collection becomes the move's destination. */
  | { type: 'startCreate' }
  | { type: 'openRename'; collectionId: string; name: string }
  | { type: 'openDeleteCollection'; collectionId: string }
  | { type: 'openLeave'; collectionId: string; name: string }
  | { type: 'openShare' }
  | { type: 'openInviteConfirm' }
  /** Ignored unless every sheet is closed, so it never replaces one the person opened. */
  | { type: 'openIntro' }
  | { type: 'introStep'; step: number }
  | { type: 'setName'; name: string }
  | { type: 'submitting'; token: number }
  | { type: 'created'; token: number; created: { id: string; name: string } }
  | { type: 'failed'; token: number; error: string }
  | { type: 'close' }
  | { type: 'closeInviteConfirm' };

export const initialLibraryFlow: LibraryFlow = { token: 0, sheet: { kind: 'closed' } };

function open(state: LibraryFlow, sheet: LibrarySheet): LibraryFlow {
  return { token: state.token + 1, sheet };
}

export function libraryFlowReducer(
  state: LibraryFlow,
  action: LibraryFlowAction,
): LibraryFlow {
  const { sheet } = state;
  switch (action.type) {
    case 'openAdd':
      return open(state, { kind: 'add' });
    case 'openDeleteRecipe':
      return open(state, { kind: 'deleteRecipe', recipeId: action.recipeId });
    case 'openMove':
      return open(state, { kind: 'move', recipeIds: action.recipeIds, saving: false });
    case 'startCreate':
      return open(state, {
        kind: 'create',
        name: '',
        saving: false,
        ...(sheet.kind === 'move' && sheet.recipeIds.length > 0
          ? { moveRecipeIds: sheet.recipeIds }
          : {}),
      });
    case 'openRename':
      return open(state, {
        kind: 'rename',
        collectionId: action.collectionId,
        name: action.name,
        saving: false,
      });
    case 'openDeleteCollection':
      return open(state, { kind: 'deleteCollection', collectionId: action.collectionId });
    case 'openLeave':
      return open(state, {
        kind: 'leave',
        collectionId: action.collectionId,
        name: action.name,
      });
    case 'openShare':
      return open(state, { kind: 'share' });
    case 'openInviteConfirm':
      return open(state, { kind: 'inviteConfirm' });
    case 'openIntro':
      return sheet.kind === 'closed' ? open(state, { kind: 'intro', step: 0 }) : state;
    case 'introStep': {
      if (sheet.kind !== 'intro') {
        return state;
      }
      const step = Math.min(Math.max(Math.trunc(action.step), 0), INTRO_STEP_COUNT - 1);
      return step === sheet.step || Number.isNaN(step) ? state : { ...state, sheet: { kind: 'intro', step } };
    }
    case 'setName':
      if (sheet.kind !== 'create' && sheet.kind !== 'rename') {
        return state;
      }
      return { ...state, sheet: { ...sheet, name: action.name } };
    case 'submitting':
      if (action.token !== state.token) {
        return state;
      }
      switch (sheet.kind) {
        case 'create':
        case 'move':
        case 'rename':
          return { ...state, sheet: { ...sheet, saving: true, error: undefined } };
        case 'leave':
        case 'deleteCollection':
          return { ...state, sheet: { ...sheet, error: undefined } };
        default:
          return state;
      }
    case 'created':
      if (action.token !== state.token || sheet.kind !== 'create') {
        return state;
      }
      return { ...state, sheet: { ...sheet, created: action.created } };
    case 'failed':
      if (action.token !== state.token) {
        return state;
      }
      switch (sheet.kind) {
        case 'create':
        case 'move':
        case 'rename':
          return { ...state, sheet: { ...sheet, saving: false, error: action.error } };
        case 'leave':
        case 'deleteCollection':
          return { ...state, sheet: { ...sheet, error: action.error } };
        default:
          return state;
      }
    case 'close':
      return open(state, { kind: 'closed' });
    case 'closeInviteConfirm':
      return sheet.kind === 'inviteConfirm' ? open(state, { kind: 'closed' }) : state;
  }
}

/** The error a sheet shows, if any. */
export function sheetError(sheet: LibrarySheet): string | undefined {
  return 'error' in sheet ? sheet.error : undefined;
}

export type CreateResult = { kind: 'done'; id: string } | { kind: 'stale' };

/**
 * The create sheet's submit: make (or reuse) the collection, then move the
 * recipes into it when the create came from Move. `isCurrent` is checked after
 * each step, before the next one starts, so a create the user cancelled or
 * left behind cannot go on to move recipes they have since put elsewhere.
 * A collection already made stays made. A move into a new collection that
 * would pass the recipe cap fails before anything is created. Errors
 * propagate to the caller.
 */
export async function runCreate(input: {
  name: string;
  created: { id: string; name: string } | undefined;
  moveRecipeIds: readonly string[] | undefined;
  isCurrent: () => boolean;
  create: (name: string) => Promise<{ id: string }>;
  rename: (id: string, name: string) => Promise<void>;
  move: (recipeIds: readonly string[], collectionId: string) => Promise<void>;
  /** Record the collection so a retry after a failed move reuses it. */
  onCreated: (created: { id: string; name: string }) => void;
}): Promise<CreateResult> {
  const trimmed = input.name.trim();
  let id: string;
  if (input.created === undefined) {
    if (
      input.moveRecipeIds !== undefined &&
      wouldExceedRecipeIdCap(recipeIdsAfterMove([], input.moveRecipeIds))
    ) {
      throw new Error(t('error.collectionFull'));
    }
    id = (await input.create(input.name)).id;
    input.onCreated({ id, name: trimmed });
  } else {
    id = input.created.id;
    if (input.created.name !== trimmed) {
      await input.rename(id, input.name);
      input.onCreated({ id, name: trimmed });
    }
  }
  if (!input.isCurrent()) {
    return { kind: 'stale' };
  }
  if (input.moveRecipeIds !== undefined && input.moveRecipeIds.length > 0) {
    await input.move(input.moveRecipeIds, id);
    if (!input.isCurrent()) {
      return { kind: 'stale' };
    }
  }
  return { kind: 'done', id };
}

/**
 * The create sheet's submit for every screen that opens one. `onSuccess`
 * runs only after a create that is still current. A stale token and a
 * thrown error stop there, so a retry or a closed sheet is handled once.
 */
export async function submitCollectionCreate(input: {
  name: string;
  created: { id: string; name: string } | undefined;
  moveRecipeIds: readonly string[] | undefined;
  saving: boolean;
  token: number;
  isCurrent: (token: number) => boolean;
  dispatch: (action: LibraryFlowAction) => void;
  failureMessage: string;
  create: (name: string) => Promise<{ id: string }>;
  rename: (id: string, name: string) => Promise<void>;
  move: (recipeIds: readonly string[], collectionId: string) => Promise<void>;
  onSuccess: (id: string) => void;
}): Promise<void> {
  if (input.saving) return;
  const { token } = input;
  input.dispatch({ type: 'submitting', token });
  try {
    const result = await runCreate({
      name: input.name,
      created: input.created,
      moveRecipeIds: input.moveRecipeIds,
      isCurrent: () => input.isCurrent(token),
      create: input.create,
      rename: input.rename,
      move: input.move,
      onCreated: (created) => input.dispatch({ type: 'created', token, created }),
    });
    if (result.kind === 'stale') return;
    input.onSuccess(result.id);
  } catch (err) {
    input.dispatch({
      type: 'failed',
      token,
      error: err instanceof Error ? err.message : input.failureMessage,
    });
  }
}
