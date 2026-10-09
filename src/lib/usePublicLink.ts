import { useEffect, useState } from 'react';
import { fetchPublicLink, type PublicLinkResult } from './publicApi';

/**
 * One public link (a collection or a recipe), fetched when the screen opens
 * (and on retry). Held in this component's state only: a public page never
 * writes the library. `undefined` while the first read for this token is in
 * flight.
 */
export function usePublicLink(token: string): {
  result: PublicLinkResult | undefined;
  retry: () => void;
} {
  const [loaded, setLoaded] = useState<{ token: string; result: PublicLinkResult } | null>(null);
  // A fresh object per try: a retry is a new request, not a render counter.
  const [request, setRequest] = useState<object>(() => ({}));
  useEffect(() => {
    let current = true;
    void fetchPublicLink(token).then((result) => {
      if (current) setLoaded({ token, result });
    });
    return () => {
      current = false;
    };
  }, [token, request]);
  return {
    // A result for the previous token is not this page's.
    result: loaded !== null && loaded.token === token ? loaded.result : undefined,
    retry: () => {
      setLoaded(null);
      setRequest({});
    },
  };
}
