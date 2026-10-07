import { useCallback, useMemo } from 'react';
import { getCook, upsertCook } from './libraryMemory';
import { selectCookRow } from './librarySelectors';
import { withLocalWrite } from './localWrite';
import { useLibrarySelect } from './useLibrary';
import { finiteCookUpdatedAt, pushOps } from './remote';
import { normalizeStepProgress, tapStep as tapStepProgress } from './stepLanes';
import type { CookStateRow, Recipe } from './types';

export interface CookState {
  servings: number;
  /** Every step before this index is done. */
  currentStep: number;
  /** Steps done ahead of `currentStep` in a parallel block, sorted. */
  doneSteps: readonly number[];
  checkedKeys: ReadonlySet<string>;
}

export interface CookStateApi extends CookState {
  setServings: (n: number) => void;
  /** Applies a tap on step `index` (`tapStep` in `stepLanes.ts`). */
  tapStep: (index: number) => void;
  toggleChecked: (key: string) => void;
  /** Ingredient item names for the checked keys, skipping stale ones. */
  checkedItemNames: (recipe: Recipe) => string[];
}

type Progress = Omit<CookStateRow, 'recipeId' | 'recipeUpdatedAt' | 'updatedAt' | 'doneSteps'> & {
  doneSteps: number[];
};

/** Shared so the memo below keeps a stable `Set` identity across renders. */
const NO_KEYS: string[] = [];
/** Shared so a row without block progress hands out one stable empty list. */
const NO_DONE: number[] = [];

/**
 * Positional keys and a step index only mean something against the recipe they
 * were recorded against, so a shape change discards them rather than trying to
 * remap. Servings survives: it is the user's choice of how much food to make.
 */
function progressFor(
  row: CookStateRow | undefined,
  recipe: Recipe | null | undefined,
): Progress {
  const servings = row?.servings ?? recipe?.servings ?? 1;
  if (!row || !recipe || row.recipeUpdatedAt !== recipe.updatedAt) {
    return { servings, currentStep: 0, doneSteps: NO_DONE, checkedKeys: NO_KEYS };
  }
  return {
    servings,
    currentStep: row.currentStep,
    doneSteps: row.doneSteps ?? NO_DONE,
    checkedKeys: row.checkedKeys,
  };
}

/**
 * Bumped only by a cook-progress write. A pull replaces the row object, so
 * identity cannot tell a later tap from the server snapshot that arrived
 * during the follow-up's quiet window.
 */
const cookWriteGeneration = new Map<string, number>();

function bumpCookWrite(recipeId: string): number {
  const generation = (cookWriteGeneration.get(recipeId) ?? 0) + 1;
  cookWriteGeneration.set(recipeId, generation);
  return generation;
}

const cookStateStore = {
  get(recipeId: string): CookStateRow | undefined {
    return getCook(recipeId);
  },

  async update(
    recipe: Recipe,
    change: (prev: Progress) => Progress,
  ): Promise<void> {
    const prev = progressFor(getCook(recipe.id), recipe);
    const updatedAt = Date.now();
    const { doneSteps: rawDone, ...changed } = change(prev);
    // Fold and clean block progress on every write; the key is left out when
    // empty, so a recipe without lanes writes exactly the old row.
    const { currentStep, doneSteps } = normalizeStepProgress(
      { currentStep: changed.currentStep, doneSteps: rawDone },
      recipe.steps.length,
    );
    const next: CookStateRow = {
      ...changed,
      currentStep,
      ...(doneSteps.length > 0 ? { doneSteps } : {}),
      recipeId: recipe.id,
      recipeUpdatedAt: recipe.updatedAt,
      updatedAt,
    };
    const generation = bumpCookWrite(recipe.id);
    await withLocalWrite(async () => {
      upsertCook(next);
      const result = await pushOps([{ kind: 'cookState.put', payload: { ...next, updatedAt } }]);
      // A failed push keeps the optimistic row. An overlapping pull is reread
      // and would otherwise paint the pre-tap row back, so put this one back
      // when that read publishes, unless a later tap already replaced it or
      // the published row's progress clock is strictly newer.
      const failed = result !== 'ok' && result !== 'signedOut';
      return {
        value: undefined,
        reconcile: result === 'ok',
        preserve: failed
          ? () => {
              const publishedAt = finiteCookUpdatedAt(getCook(recipe.id)?.updatedAt) ?? 0;
              if (publishedAt > updatedAt) {
                return;
              }
              upsertCook(next);
            }
          : undefined,
        stillCurrent: failed ? () => cookWriteGeneration.get(recipe.id) === generation : undefined,
      };
    });
  },
};

/** Persisted cook progress. The recipe screen calls this on each tap. */
export function updateCookState(
  recipe: Recipe,
  change: (prev: Progress) => Progress,
): Promise<void> {
  return cookStateStore.update(recipe, change);
}

/** Persisted per recipe. Resets when the recipe's shape changes. */
export function useCookState(recipe: Recipe | null | undefined): CookStateApi {
  const recipeId = recipe?.id;
  const row = useLibrarySelect(selectCookRow(recipeId));

  const { servings, currentStep, doneSteps, checkedKeys } = progressFor(row, recipe);
  const checkedSet = useMemo(() => new Set(checkedKeys), [checkedKeys]);

  const setServings = useCallback(
    (n: number) => {
      if (!recipe) return;
      void updateCookState(recipe, (prev) => ({ ...prev, servings: n }));
    },
    [recipe],
  );

  const tapStep = useCallback(
    (index: number) => {
      if (!recipe) return;
      void updateCookState(recipe, (prev) => ({
        ...prev,
        ...tapStepProgress(recipe.steps, prev, index),
      }));
    },
    [recipe],
  );

  const toggleChecked = useCallback(
    (key: string) => {
      if (!recipe) return;
      void updateCookState(recipe, (prev) => ({
        ...prev,
        checkedKeys: prev.checkedKeys.includes(key)
          ? prev.checkedKeys.filter((k) => k !== key)
          : [...prev.checkedKeys, key],
      }));
    },
    [recipe],
  );

  const checkedItemNames = useCallback(
    (forRecipe: Recipe) =>
      [...checkedSet]
        .map((key) => {
          const [si, ii] = key.split('-').map(Number);
          return forRecipe.ingredientSections[si]?.items[ii]?.item;
        })
        .filter((item): item is string => item !== undefined),
    [checkedSet],
  );

  return {
    servings,
    currentStep,
    doneSteps,
    checkedKeys: checkedSet,
    setServings,
    tapStep,
    toggleChecked,
    checkedItemNames,
  };
}
