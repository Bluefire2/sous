import { useEffect, useState } from 'react';

/**
 * True once `active` has stayed true for `delayMs`; false as soon as it is
 * false. Keeps a loading cue out of the page, and out of the accessibility
 * tree, for a load that finishes quickly.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}
