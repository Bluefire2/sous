import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { COOKING_ANIMATIONS } from './CookingAnimations';
import { pickAnimationIndex } from '../lib/loadingAnimation';

/** The animation the last overlay showed, so the next one picks another. */
let lastShown: number | null = null;

export type ImportBusyProgress = {
  current: number;
  total: number;
  /** The progress bar's accessible name. */
  label: string;
  /** Read out in place of the raw numbers, e.g. "Reading 2 of 5". */
  valueText: string;
};

/**
 * Dims the Import screen while a recipe is being read or generated and plays
 * one of the cooking animations in the middle, picked at random on mount.
 * The text is the screen's own busy wording; the animation is decorative.
 *
 * Rendered into document.body because the screen marks itself inert while
 * busy, and an inert subtree would hide this status from screen readers.
 * z-[25] keeps it under toasts and sheets (z-30).
 */
export default function ImportBusyOverlay({
  label,
  hint,
  progress,
}: {
  label: string;
  hint: string;
  progress?: ImportBusyProgress;
}) {
  const [index] = useState(() => pickAnimationIndex(COOKING_ANIMATIONS.length, lastShown));
  useEffect(() => {
    lastShown = index;
  }, [index]);
  const Animation = COOKING_ANIMATIONS[index];

  return createPortal(
    <div className="ca-overlay fixed inset-0 z-[25] flex flex-col items-center justify-center gap-5 bg-stone-950/75 px-4 backdrop-blur-[3px]">
      <div className="ca-stage w-[min(55vw,12.5rem)]">
        <Animation />
      </div>
      <div role="status" className="flex max-w-sm flex-col items-center gap-1 text-center">
        <p className="font-semibold text-stone-50">{label}</p>
        <p className="text-sm text-stone-300">{hint}</p>
      </div>
      {progress && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.current}
          aria-valuetext={progress.valueText}
          aria-label={progress.label}
          className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-white/20"
        >
          <div
            className="h-full rounded-full bg-amber-400 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
