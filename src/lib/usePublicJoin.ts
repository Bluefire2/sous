import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../i18n';
import { libraryHref } from './collectionHref';
import { joinPublicCollection } from './publicApi';
import { sync } from './syncEngine';

/** Where a member's one action on a public page stands: add a collection, or save a recipe. */
export type PublicActionState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  /** The link died between loading the page and pressing the button. */
  | { kind: 'missing' };

export type PublicJoinState = PublicActionState;

/** A member's action on a public page; `run` sends it. */
export type PublicMemberAction = { state: PublicActionState; run: () => Promise<void> };

export type PublicJoin = { state: PublicJoinState; add: () => Promise<void> };

/**
 * "Add to my library" on a public page: one request, then a pull so the
 * collection is in the library, then open it there. One request at a time;
 * a result that lands after the person left the page does nothing.
 */
export function usePublicJoin(token: string): PublicJoin {
  const navigate = useNavigate();
  const [state, setState] = useState<PublicJoinState>({ kind: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const add = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'busy' });
    try {
      const result = await joinPublicCollection(token);
      if (!mounted.current) return;
      if (result.kind === 'ok') {
        // Wait for the pull so the library already lists the collection;
        // otherwise Library reads the id as missing and goes home.
        await sync();
        if (!mounted.current) return;
        navigate(libraryHref(result.collectionId));
        return;
      }
      if (result.kind === 'signedOut') {
        // The session store now says signed out; the page shows sign-in.
        setState({ kind: 'idle' });
        return;
      }
      if (result.kind === 'missing') {
        setState({ kind: 'missing' });
        return;
      }
      setState({ kind: 'error', message: result.message });
    } catch {
      if (mounted.current) setState({ kind: 'error', message: t('public.joinFailed') });
    } finally {
      inFlight.current = false;
    }
  };

  return { state, add };
}
