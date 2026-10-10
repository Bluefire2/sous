import { useSyncExternalStore } from 'react';

// The part of the layout viewport the person can actually see. When the
// on-screen keyboard opens, iOS (Safari and Chrome, both WebKit) shrinks only
// the visual viewport and pans it; a `fixed inset-0` overlay keeps the full
// layout height, so a bottom sheet ends behind the keyboard and the page shows
// through between them. Sizing the overlay to this box keeps it flush with the
// keyboard.

function subscribe(listener: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener('resize', listener);
  vv.addEventListener('scroll', listener);
  return () => {
    vv.removeEventListener('resize', listener);
    vv.removeEventListener('scroll', listener);
  };
}

// Pinch zoom also shrinks the visual viewport; following it then would shrink
// the sheet with the zoom, so only an unzoomed viewport is reported.
function unzoomed(): VisualViewport | null {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return null;
  return vv;
}

const getTop = () => unzoomed()?.offsetTop ?? null;
const getHeight = () => unzoomed()?.height ?? null;

// Whether something (the keyboard) covers the bottom of the layout viewport.
// The home-indicator inset belongs to the screen's bottom edge, so a sheet
// that ends above the keyboard should not pad for it.
const getCoveredBelow = () => {
  const vv = unzoomed();
  if (!vv) return false;
  const layoutHeight = document.documentElement.clientHeight;
  return layoutHeight - (vv.offsetTop + vv.height) > 1;
};

const getServer = () => null;
const getServerFalse = () => false;

/**
 * Top and height of the visible viewport in CSS px, and whether the bottom of
 * the layout viewport is hidden below it; null when unknown or zoomed.
 */
export function useVisualViewport(): {
  top: number;
  height: number;
  coveredBelow: boolean;
} | null {
  const top = useSyncExternalStore(subscribe, getTop, getServer);
  const height = useSyncExternalStore(subscribe, getHeight, getServer);
  const coveredBelow = useSyncExternalStore(
    subscribe,
    getCoveredBelow,
    getServerFalse,
  );
  return top === null || height === null ? null : { top, height, coveredBelow };
}
