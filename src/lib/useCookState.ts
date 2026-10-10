import { useCallback, useMemo } from 'react';
import { getCook, upsertCook } from './libraryMemory';
import { selectCookRow } from './librarySelectors';
import { withLocalWrite } from './localWrite';
import { useLibrarySelect } from './useLibrary';
import { finiteCookUpdatedAt, pushOps } from './remote';
import type { CookStateRow, Recipe } from './types';

export interface CookState {
  servings: number;
  currentStep: number;
  checkedKeys: ReadonlySet<string>;
}

export interface CookStateApi extends CookState {
  setServings: (n: number) => void;
  setCurrentStep: (i: number) => void;
  toggleChecked: (key: string) => void;
  /** Ingredient item names for the checked keys, skipping stale ones. */
  checkedItemNames: (recipe: Recipe) => string[];
}

type Progress = Omit<CookStateRow, 'recipeId' | 'recipeUpdatedAt' | 'updatedAt'>;

/** Shared so the memo below keeps a stable `Set` identity across renders. */
const NO_KEYS: string[] = [];

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
    return { servings, currentStep: 0, checkedKeys: NO_KEYS };
  }
  return {
    servings,
    currentStep: row.currentStep,
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
    const next: CookStateRow = {
      ...change(prev),
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

  const { servings, currentStep, checkedKeys } = progressFor(row, recipe);
  const checkedSet = useMemo(() => new Set(checkedKeys), [checkedKeys]);

  const setServings = useCallback(
    (n: number) => {
      if (!recipe) return;
      void updateCookState(recipe, (prev) => ({ ...prev, servings: n }));
    },
    [recipe],
  );

  const setCurrentStep = useCallback(
    (i: number) => {
      if (!recipe) return;
      void updateCookState(recipe, (prev) => ({
        ...prev,
        currentStep: i,
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
    checkedKeys: checkedSet,
    setServings,
    setCurrentStep,
    toggleChecked,
    checkedItemNames,
  };
}
