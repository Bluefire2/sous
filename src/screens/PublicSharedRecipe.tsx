import { useState } from 'react';
import { useT } from '../i18n';
import LanguageMenu from '../components/LanguageMenu';
import { AiLockedSheet, PublicSignInLink } from '../components/LockedAi';
import { recipePageClass } from '../components/RecipeBody';
import ShareRecipeButton from '../components/ShareRecipeButton';
import type { PublicRecipeLinkData } from '../lib/publicApi';
import { useSession } from '../lib/session';
import { ghostBtn, primaryBtn } from '../lib/uiClasses';
import { usePublicSave } from '../lib/usePublicSave';
import { useWakeLock } from '../lib/useWakeLock';
import { PublicRecipeBody } from './PublicRecipe';

/**
 * `/p/<token>` for a recipe link (`docs/plans/recipe-links.md`): one recipe
 * anyone with the link can read, with the sharer's display name. A signed-in
 * member can save a copy into their own library; that copy is theirs, and
 * AI works on it. Nothing here reads or writes the library: saving goes
 * through `usePublicSave`, which only pulls after the server made the copy.
 */
export default function PublicSharedRecipe({
  token,
  data,
}: {
  token: string;
  data: PublicRecipeLinkData;
}) {
  const t = useT();
  const { status } = useSession();
  const member = status === 'signedIn';
  const save = usePublicSave(token);
  const [lockedOpen, setLockedOpen] = useState(false);
  useWakeLock();
  const { recipe, sharedBy } = data;
  const busy = save.state.kind === 'busy';

  if (save.state.kind === 'missing') {
    return (
      <div className={recipePageClass}>
        <p className="p-6 text-center text-ink-muted">{t('public.recipeLinkMissing')}</p>
      </div>
    );
  }

  return (
    <div className={recipePageClass}>
      <header className="flex items-center justify-between pt-4 print:hidden">
        <span className="text-2xl font-bold">Sous</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-y-1">
          {/* Read-only, like the rest of this page: it shares the text the visitor already sees. */}
          <ShareRecipeButton recipe={recipe} />
          {!member && (
            <PublicSignInLink token={token} className={ghostBtn}>
              {t('public.signIn')}
            </PublicSignInLink>
          )}
          <LanguageMenu />
        </div>
      </header>
      <div className="mt-3 rounded-xl bg-surface-muted px-3 py-2 text-sm text-ink-muted print:hidden">
        <p className="break-words">
          {sharedBy !== undefined
            ? t('public.sharedBy', { name: sharedBy })
            : t('public.recipeBadge')}
        </p>
        {member ? (
          <div className="mt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save.run()}
              className={`${primaryBtn} px-4 py-2 text-sm`}
            >
              {busy ? t('public.saving') : t('public.saveCopy')}
            </button>
            <p className="mt-2 text-xs">{t('public.saveHint')}</p>
            {save.state.kind === 'error' && !lockedOpen && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {save.state.message}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-xs">{t('public.signInToSave')}</p>
        )}
      </div>
      <PublicRecipeBody
        token={token}
        recipe={recipe}
        member={member}
        subject="recipe"
        onLocked={() => setLockedOpen(true)}
      />
      {lockedOpen && (
        <AiLockedSheet
          token={token}
          member={member}
          subject="recipe"
          action={save}
          onClose={() => setLockedOpen(false)}
        />
      )}
    </div>
  );
}
