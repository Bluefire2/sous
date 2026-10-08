import { useSyncExternalStore } from 'react';
import { settings, type RecipeTextSize } from './settings';

/*
 * Device-local cooking-screen settings (`docs/plans/cooking-screen-settings.md`).
 * Both getters return primitives, so `useSyncExternalStore` sees an unchanged
 * value as unchanged (`docs/constitutions/client-state.md`, principle 3).
 */

function getWakeLockSnapshot(): boolean {
  return settings.getWakeLock();
}

function getRecipeTextSizeSnapshot(): RecipeTextSize {
  return settings.getRecipeTextSize();
}

/** Whether recipe screens keep the screen awake; re-renders on `settings.setWakeLock`. */
export function useWakeLockSetting(): boolean {
  return useSyncExternalStore(settings.subscribeWakeLock, getWakeLockSnapshot, getWakeLockSnapshot);
}

/** Recipe ingredient and step text size; re-renders on `settings.setRecipeTextSize`. */
export function useRecipeTextSize(): RecipeTextSize {
  return useSyncExternalStore(
    settings.subscribeRecipeTextSize,
    getRecipeTextSizeSnapshot,
    getRecipeTextSizeSnapshot,
  );
}
