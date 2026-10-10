import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLocale, useT } from '../i18n';
import { lessonInNotes } from '../lib/cookLogShape';
import { cookLogStore } from '../lib/cookLogStore';
import type { CookLog, Recipe } from '../lib/types';
import { addBtn, ghostBtn } from '../lib/uiClasses';
import { StoredPhotoImage } from './BlobImage';

/** Built from the date's parts, so no timezone can move it to another day. */
function formatCookedOn(cookedOn: string, locale: string): string {
  const [year, month, day] = cookedOn.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function CookPhoto({ photoId }: { photoId: string }) {
  return (
    <StoredPhotoImage
      photoId={photoId}
      alt=""
      className="aspect-square w-full rounded-xl object-cover shadow-sm"
    />
  );
}

export default function CookLogCard({
  log,
  recipe,
  recipeTitle,
}: {
  log: CookLog;
  /** The entry's recipe, read for the "In notes" check and promotion. */
  recipe: Recipe;
  /** Shown as a link to the recipe, for lists that mix recipes. */
  recipeTitle?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = formatCookedOn(log.cookedOn, locale);
  const inNotes = lessonInNotes(recipe.notes, log.lessons);

  const promote = async () => {
    setPromoting(true);
    setError(null);
    try {
      await cookLogStore.promoteLesson(recipe.id, log);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.recipeSave'));
    } finally {
      setPromoting(false);
    }
  };

  const servingsLabel =
    log.servings !== undefined
      ? t('common.servingsCount', { count: log.servings })
      : undefined;

  return (
    <article className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      {recipeTitle && (
        <Link
          to={`/recipe/${log.recipeId}`}
          className="text-lg font-semibold hover:underline"
        >
          {recipeTitle}
        </Link>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{date}</p>
          {(log.rating !== undefined || servingsLabel) && (
            <p className="mt-0.5 flex items-center gap-2 text-sm text-ink-muted">
              {log.rating !== undefined && (
                <span
                  role="img"
                  aria-label={t('cookLog.starsOfFive', { count: log.rating })}
                  className="text-amber-500"
                >
                  {'★'.repeat(log.rating)}
                  <span className="text-ink-subtle">{'☆'.repeat(5 - log.rating)}</span>
                </span>
              )}
              {servingsLabel && <span>{servingsLabel}</span>}
            </p>
          )}
        </div>
        <Link
          to={`/recipe/${log.recipeId}/cooks/${log.id}/edit`}
          aria-label={t('cookLog.editCookOn', { date })}
          className={`${ghostBtn} shrink-0`}
        >
          {t('common.edit')}
        </Link>
      </div>

      {log.notes && <p className="mt-2 whitespace-pre-line">{log.notes}</p>}

      {log.lessons && (
        <div className="mt-3">
          <h3 className="text-sm font-medium text-ink-muted">{t('cookLog.lessons')}</h3>
          <p className="mt-1 whitespace-pre-line">{log.lessons}</p>
          {inNotes ? (
            <p className="mt-2 text-sm text-ink-subtle">{t('cookLog.inNotes')}</p>
          ) : (
            <button
              type="button"
              disabled={promoting}
              onClick={() => void promote()}
              className={`mt-2 ${addBtn} disabled:opacity-40`}
            >
              {t('cookLog.addToNotes')}
            </button>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </div>
      )}

      {log.photoIds && log.photoIds.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {log.photoIds.map((id) => (
            <CookPhoto key={id} photoId={id} />
          ))}
        </div>
      )}
    </article>
  );
}
