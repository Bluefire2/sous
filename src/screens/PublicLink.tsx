import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '../i18n';
import LanguageMenu from '../components/LanguageMenu';
import {
  AiLockedSheet,
  LockedAiButton,
  lockedIconBtn,
  PublicSignInLink,
} from '../components/LockedAi';
import { ChatBubbleIcon } from '../lib/icons';
import { publicPhotoUrl } from '../lib/publicApi';
import { useSession } from '../lib/session';
import { ghostBtn, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import type { PublicLinkResult } from '../lib/publicApi';
import { usePublicLink } from '../lib/usePublicLink';
import { usePublicJoin } from '../lib/usePublicJoin';
import PublicSharedRecipe from './PublicSharedRecipe';

/**
 * `/p/<token>`: what anyone with the link can read. A public collection
 * (`docs/plans/public-collections.md`) or, for a recipe link, one recipe
 * (`docs/plans/recipe-links.md`, `PublicSharedRecipe`). No library, sync, or
 * session data is read or written here; a signed-in member can add the
 * collection, or save a copy of the recipe, to their library.
 */
export default function PublicLink() {
  const { token = '' } = useParams<{ token: string }>();
  const { result, retry } = usePublicLink(token);
  if (result?.kind === 'ok' && result.data.kind === 'recipe') {
    return <PublicSharedRecipe token={token} data={result.data} />;
  }
  return <PublicCollection token={token} result={result} retry={retry} />;
}

function PublicCollection({
  token,
  result,
  retry,
}: {
  token: string;
  result: PublicLinkResult | undefined;
  retry: () => void;
}) {
  const t = useT();
  const { status } = useSession();
  const member = status === 'signedIn';
  const join = usePublicJoin(token);
  const [lockedOpen, setLockedOpen] = useState(false);
  // Until the link reads as a collection (loading, missing, an error), it may
  // be a recipe link: offer nothing that only a collection can do.
  const isCollection = result?.kind === 'ok' && result.data.kind === 'collection';

  const header = (
    <header className="flex items-center justify-between py-4">
      <span className="text-2xl font-bold">Sous</span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-y-1">
        {/* A visitor gets no assistant control at all: Sign in is the way in. */}
        {isCollection && member && (
          <LockedAiButton
            label={t('assistant.ask')}
            hint={t('public.aiLockedMember')}
            onOpen={() => setLockedOpen(true)}
            className={lockedIconBtn}
            placement="below-end"
          >
            <ChatBubbleIcon className="block h-5 w-5" />
          </LockedAiButton>
        )}
        {!member && (
          <PublicSignInLink token={token} className={ghostBtn}>
            {t('public.signIn')}
          </PublicSignInLink>
        )}
        <LanguageMenu />
      </div>
    </header>
  );

  let body;
  if (result === undefined) {
    body = <p className="py-12 text-center text-ink-muted">{t('common.loading')}</p>;
  } else if (result.kind === 'missing' || join.state.kind === 'missing') {
    body = <p className="py-12 text-center text-ink-muted">{t('public.missing')}</p>;
  } else if (result.kind === 'error') {
    body = (
      <div className="py-12 text-center text-ink-muted">
        <p>{t('public.loadFailed')}</p>
        <button
          type="button"
          onClick={retry}
          className={`${secondaryBtn} mt-3 px-4 py-2 text-sm`}
        >
          {t('common.tryAgain')}
        </button>
      </div>
    );
  } else if (result.data.kind === 'collection') {
    const { collection, recipes } = result.data;
    body = (
      <>
        <div className="mb-4">
          <h1 className="text-xl font-semibold break-words">{collection.name}</h1>
          <p className="mt-0.5 text-sm text-ink-muted">{t('public.badge')}</p>
          {member && (
            <div className="mt-3">
              <button
                type="button"
                disabled={join.state.kind === 'busy'}
                onClick={() => void join.add()}
                className={`${primaryBtn} px-4 py-2 text-sm`}
              >
                {join.state.kind === 'busy' ? t('public.adding') : t('public.addToLibrary')}
              </button>
              {join.state.kind === 'error' && !lockedOpen && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {join.state.message}
                </p>
              )}
            </div>
          )}
        </div>
        {recipes.length === 0 ? (
          <p className="py-12 text-center text-ink-muted">{t('library.emptyCollection')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {recipes.map((recipe) => (
              <li key={recipe.id}>
                <Link
                  to={`/p/${encodeURIComponent(token)}/r/${encodeURIComponent(recipe.id)}`}
                  className="flex gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm hover:border-line-strong hover:bg-surface-muted active:bg-surface-muted"
                >
                  {recipe.photoId !== undefined && (
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-surface-muted">
                      <img
                        src={publicPhotoUrl(token, recipe.id, recipe.photoId)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold">{recipe.title}</h2>
                    {recipe.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                        {recipe.description}
                      </p>
                    )}
                    {recipe.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {recipe.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      {header}
      {body}
      {lockedOpen && isCollection && member && (
        <AiLockedSheet
          token={token}
          member={member}
          subject="collection"
          action={{ state: join.state, run: join.add }}
          onClose={() => setLockedOpen(false)}
        />
      )}
    </div>
  );
}
