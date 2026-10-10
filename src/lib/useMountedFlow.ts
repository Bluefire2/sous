import { useEffect, useLayoutEffect, useRef } from 'react';
import type { LibraryFlow } from './libraryFlow';

/**
 * Whether this screen is still showing `flow`. An async submit captures the
 * token it started with and checks `isCurrent` after each await, so a sheet
 * the user closed, or a screen they left, cannot finish on the next one.
 */
export function useMountedFlow(flow: LibraryFlow): {
  mountedRef: { current: boolean };
  isCurrent: (token: number) => boolean;
} {
  const flowRef = useRef(flow);
  useLayoutEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const isCurrent = (token: number) => mountedRef.current && flowRef.current.token === token;
  return { mountedRef, isCurrent };
}
