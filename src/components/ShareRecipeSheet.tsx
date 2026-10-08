import { useState } from 'react';
import { useT } from '../i18n';
import { recipeStore } from '../lib/recipeStore';
import type { Recipe } from '../lib/types';
import { ghostBtn, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import NoticeToast from './NoticeToast';
import PublicLinkPane from './PublicLinkPane';
import { useRecipeTextShare } from './ShareRecipeButton';
import Sheet from './Sheet';

/**
 * Share on the owner's own recipe: a sheet with the two ways to share it,
 * as text (what Share always did) or as a recipe link anyone can read and a
 * member can save a copy from (`docs/plans/recipe-links.md`). A shared
 * recipe keeps the text-only `ShareRecipeButton`: the link is the owner's.
 */
export default function ShareRecipeControl({ recipe }: { recipe: Recipe }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { share, notice } = useRecipeTextShare(recipe);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${ghostBtn} print:hidden`}>
        {t('common.share')}
      </button>
      {open && (
        <ShareRecipeSheet
          recipe={recipe}
          onShareText={() => {
            setOpen(false);
            void share();
          }}
          onClose={() => setOpen(false)}
        />
      )}
      <NoticeToast notice={notice} />
    </>
  );
}

function ShareRecipeSheet({
  recipe,
  onShareText,
  onClose,
}: {
  recipe: Recipe;
  onShareText: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [method, setMethod] = useState<'text' | 'link'>('text');
  const [busy, setBusy] = useState(false);
  const tab = (active: boolean) =>
    `flex-1 rounded-full py-2.5 font-medium disabled:opacity-40 ${
      active
        ? 'bg-ink text-page'
        : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
    }`;
  return (
    <Sheet onClose={onClose} dismissible={!busy}>
      <h2 className="text-lg font-semibold break-words">
        {t('share.title', { name: recipe.title })}
      </h2>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          aria-pressed={method === 'text'}
          disabled={busy}
          onClick={() => setMethod('text')}
          className={tab(method === 'text')}
        >
          {t('shareRecipe.byText')}
        </button>
        <button
          type="button"
          aria-pressed={method === 'link'}
          disabled={busy}
          onClick={() => setMethod('link')}
          className={tab(method === 'link')}
        >
          {t('shareRecipe.byLink')}
        </button>
      </div>
      {method === 'text' ? (
        <>
          <p className="mt-3 text-sm text-ink-muted">{t('shareRecipe.textIntro')}</p>
          <button type="button" onClick={onShareText} className={`${primaryBtn} mt-3 w-full py-3`}>
            {t('shareRecipe.sendText')}
          </button>
        </>
      ) : (
        <PublicLinkPane
          source={{
            id: recipe.id,
            load: () => recipeStore.recipeLink(recipe.id),
            enable: () => recipeStore.enableRecipeLink(recipe.id),
            disable: () => recipeStore.disableRecipeLink(recipe.id),
            inputId: 'recipe-link',
            text: {
              intro: 'shareRecipe.linkIntro',
              off: 'shareRecipe.linkOff',
              turnOn: 'shareRecipe.linkTurnOn',
              label: 'shareRecipe.linkLabel',
              turnOffLabel: 'shareRecipe.linkTurnOffLabel',
            },
          }}
          onBusyChange={setBusy}
        />
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onClose}
        className={`${secondaryBtn} mt-3 w-full py-3 disabled:opacity-40`}
      >
        {t('common.done')}
      </button>
    </Sheet>
  );
}
