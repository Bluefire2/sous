import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../i18n';
import { savePublicRecipe } from './publicApi';
import { sync } from './syncEngine';
import type { PublicMemberAction, PublicActionState } from './usePublicJoin';

/**
 * "Save a copy to my library" on a recipe link (`docs/plans/recipe-links.md`):
 * one request, then a pull so the copy is in the library, then open it. A
 * second save of the same link opens the copy made the first time; the
 * owner's own link opens the original. One request at a time; a result that
 * lands after the person left the page does nothing.
 */
export function usePublicSave(token: string): PublicMemberAction {
  const navigate = useNavigate();
  const [state, setState] = useState<PublicActionState>({ kind: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'busy' });
    try {
      const result = await savePublicRecipe(token);
      if (!mounted.current) return;
      if (result.kind === 'ok') {
        // Wait for the pull so the recipe screen finds the copy.
        await sync();
        if (!mounted.current) return;
        navigate(`/recipe/${encodeURIComponent(result.recipeId)}`);
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
      if (mounted.current) setState({ kind: 'error', message: t('public.saveFailed') });
    } finally {
      inFlight.current = false;
    }
  };

  return { state, run };
}
