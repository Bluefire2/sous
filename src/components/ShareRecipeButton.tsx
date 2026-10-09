import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '../i18n';
import { recipeToText } from '../lib/recipeText';
import { shareOrCopy } from '../lib/shareText';
import type { Recipe } from '../lib/types';
import { ghostBtn } from '../lib/uiClasses';
import NoticeToast, { type Notice } from './NoticeToast';

/**
 * Shares a recipe as plain text: the system share sheet where the browser has
 * one, otherwise the clipboard and a notice. It only reads the recipe it is
 * given, so it is the same for an own, a shared and a public recipe. Pass the
 * stored recipe, never a display translation (`docs/constitutions/i18n.md`
 * principle 1).
 */
export function useRecipeTextShare(recipe: Recipe): {
  share: () => Promise<void>;
  notice: Notice | null;
} {
  const t = useT();
  const locale = useLocale();
  const [notice, setNotice] = useState<Notice | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const share = async () => {
    const text = recipeToText(recipe, locale, t);
    const outcome = await shareOrCopy(navigator, { title: recipe.title, text });
    if (!mountedRef.current) return;
    if (outcome === 'copied' || outcome === 'failed') {
      const kind = outcome === 'copied' ? 'success' : 'error';
      const message = outcome === 'copied' ? t('recipe.textCopied') : t('recipe.textCopyFailed');
      setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, kind, message }));
    }
  };

  return { share, notice };
}

/** The Share control that sends the recipe as text, with no other choice. */
export default function ShareRecipeButton({ recipe }: { recipe: Recipe }) {
  const t = useT();
  const { share, notice } = useRecipeTextShare(recipe);
  return (
    <>
      <button type="button" onClick={() => void share()} className={`${ghostBtn} print:hidden`}>
        {t('common.share')}
      </button>
      <NoticeToast notice={notice} />
    </>
  );
}
