import { useEffect, useState, type RefObject } from 'react';

/** How far outside the viewport counts as near, so a photo is ready as its card scrolls in. */
const NEAR_MARGIN = '300px 0px';

/**
 * True once the element has come within `NEAR_MARGIN` of the viewport, and
 * from then on. Without IntersectionObserver it is true at once.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || element === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}
