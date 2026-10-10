import { useReducer, useState } from 'react';
import { toSupportedLocale, useT } from '../i18n';
import { showsImportWarnings, type ImportCheck } from '../lib/importCheck';
import { importRecipe, type ImportRecipeResult } from '../lib/importApi';
import { translatedPreviewDraft } from '../lib/importPreview';
import { importRetryReducer, initialImportRetryState } from '../lib/importRetryFlow';
import { SpinnerIcon } from '../lib/icons';
import { recipeStore } from '../lib/recipeStore';
import type { IngredientSection, Recipe, RecipeDraft } from '../lib/types';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';
import ImportWarningList from './ImportWarningList';
import Sheet from './Sheet';

/** The draft a retry saves: the translation when one came back, else the original. */
function retriedDraft(result: ImportRecipeResult): RecipeDraft {
  if (result.translation !== undefined && result.translationFailed !== true) {
    return {
      ...translatedPreviewDraft(result.recipe, result.translation.recipe),
      lang: result.translation.lang,
    };
  }
  return result.recipe;
}

function retriedCheck(result: ImportRecipeResult): ImportCheck | undefined {
  return result.warnings !== undefined ? { at: Date.now(), warnings: result.warnings } : undefined;
}

const actionClass =
  'rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted active:bg-surface-muted disabled:opacity-40';

/**
 * The specific problems the import check found, at the top of the recipe
 * view. Shown only to someone who can edit, until dismissed. `sections` are
 * the ingredients as displayed (possibly translated), for ingredient names.
 * `source` is the recipe's link after the http/https guard.
 */
export default function ImportWarningBanner({
  recipe,
  sections,
  source,
  canEdit,
}: {
  recipe: Recipe;
  sections: readonly IngredientSection[];
  source: URL | undefined;
  canEdit: boolean;
}) {
  const t = useT();
  const [flow, dispatch] = useReducer(importRetryReducer, initialImportRetryState);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const check = recipe.importCheck;
  if (!showsImportWarnings(check, canEdit) || check === undefined) {
    return null;
  }

  const dismiss = async () => {
    setDismissing(true);
    setDismissError(null);
    try {
      await recipeStore.dismissImportWarnings(recipe.id);
    } catch (err) {
      setDismissError(err instanceof Error ? err.message : t('error.recipeSave'));
    } finally {
      setDismissing(false);
    }
  };

  const retry = async () => {
    if (source === undefined) return;
    dispatch({ type: 'fetch' });
    // `fetch` advances the token; the result must carry the token it started with.
    const token = flow.token + 1;
    try {
      const translateTo = toSupportedLocale(recipe.lang);
      const result = await importRecipe(
        translateTo !== undefined ? { url: source.href, translateTo } : { url: source.href },
      );
      dispatch({ type: 'fetched', token, draft: retriedDraft(result), importCheck: retriedCheck(result) });
    } catch (err) {
      dispatch({
        type: 'fetchFailed',
        token,
        error: err instanceof Error ? err.message : t('error.importFailed'),
      });
    }
  };

  const sheet = flow.sheet;
  const confirm = async () => {
    if (sheet === null) return;
    const token = flow.token;
    dispatch({ type: 'submitting', token });
    try {
      await recipeStore.replaceFromImport(recipe.id, sheet.draft, sheet.importCheck);
      dispatch({ type: 'close' });
    } catch (err) {
      dispatch({
        type: 'saveFailed',
        token,
        error: err instanceof Error ? err.message : t('error.recipeSave'),
      });
    }
  };

  return (
    <section
      aria-label={t('importWarning.label')}
      className="mt-3 rounded-2xl border border-amber-600/70 bg-accent-soft px-4 py-3 text-sm text-ink print:hidden"
    >
      <ImportWarningList warnings={check.warnings} sections={sections} />
      <div className="mt-3 flex flex-wrap gap-2">
        {source !== undefined && (
          <button
            type="button"
            disabled={flow.fetching || dismissing}
            aria-busy={flow.fetching || undefined}
            onClick={() => void retry()}
            className={`${actionClass} inline-flex items-center gap-1.5`}
          >
            {flow.fetching && <SpinnerIcon className="h-4 w-4 animate-spin" />}
            {flow.fetching ? t('importWarning.retrying') : t('importWarning.retry')}
          </button>
        )}
        {source !== undefined && (
          <a href={source.href} target="_blank" rel="noreferrer noopener" className={actionClass}>
            {t('importWarning.viewOriginal')}
          </a>
        )}
        <button
          type="button"
          disabled={dismissing || flow.fetching}
          onClick={() => void dismiss()}
          className={actionClass}
        >
          {t('importWarning.dismiss')}
        </button>
      </div>
      {(flow.error ?? dismissError) !== null && (
        <p role="alert" className="mt-2 text-danger">
          {flow.error ?? dismissError}
        </p>
      )}

      {sheet !== null && (
        <Sheet onClose={() => dispatch({ type: 'close' })} dismissible={!sheet.saving}>
          <h2 className="text-lg font-semibold">{t('importWarning.replaceTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('importWarning.replaceBody')}</p>
          {sheet.importCheck !== undefined && (
            <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm text-ink">
              <p>{t('importWarning.replaceStillWarns')}</p>
              <ImportWarningList
                warnings={sheet.importCheck.warnings}
                sections={sheet.draft.ingredientSections}
                className="mt-1"
              />
            </div>
          )}
          {sheet.error !== null && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {sheet.error}
            </p>
          )}
          <button
            type="button"
            disabled={sheet.saving}
            aria-busy={sheet.saving || undefined}
            onClick={() => void confirm()}
            className={`${primaryBtn} mt-3 inline-flex w-full items-center justify-center gap-2 py-3`}
          >
            {sheet.saving && <SpinnerIcon className="h-5 w-5 animate-spin" />}
            {t('importWarning.replace')}
          </button>
          <button
            type="button"
            disabled={sheet.saving}
            onClick={() => dispatch({ type: 'close' })}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}
    </section>
  );
}
