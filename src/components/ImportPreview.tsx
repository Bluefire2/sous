import { useCallback, useEffect, useRef, useState } from 'react';
import { languageName, useLocale, useT } from '../i18n';
import type { ImportCheck } from '../lib/importCheck';
import type { ImportRecipeResult } from '../lib/importApi';
import type { ImportSource } from '../lib/importFeedback';
import { importPreviewRules, translatedPreviewDraft } from '../lib/importPreview';
import { translateRecipe } from '../lib/translateApi';
import { SpinnerIcon } from '../lib/icons';
import type { Recipe, RecipeDraft } from '../lib/types';
import { inputFocus } from '../lib/uiClasses';
import CreateRecipeForm, { type CreateRecipeSubmitStatus } from './CreateRecipeForm';
import ImportFeedbackCard from './ImportFeedbackCard';
import ImportFeedbackRating from './ImportFeedbackRating';
import ImportWarningList from './ImportWarningList';
import LanguagePicker from './LanguagePicker';

const noticeClass = 'rounded-2xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink';

/**
 * Put before Google's Search Suggestions snippet in its frame. `<base>` makes
 * its links open a new tab, which the sandbox allows: Google's chips are plain
 * links, and google.com refuses to be framed, so a click inside the frame
 * would show nothing. The color-scheme meta lets the frame's page take the
 * scheme `.chip-frame` (src/index.css) gives the frame, so Google's own light
 * or dark styles follow the app's theme and the frame is never an opaque box.
 * The snippet itself is passed through unchanged.
 */
const CHIP_FRAME_HEAD = '<meta name="color-scheme" content="light dark"><base target="_blank">';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function pastedImport(recipe: RecipeDraft): boolean {
  return recipe.sourceUrl === undefined || recipe.sourceUrl.trim() === '';
}

/**
 * Single-recipe import preview. `sourceLang` is the original text's language.
 * The translated draft's language is the UI language, applied at save.
 * The form's own language field is hidden. This line owns `sourceLang`, and
 * each draft's `lang` is set at save.
 */
export default function ImportPreview({
  result,
  feedbackSource,
  collectionId,
  destinationId,
  formId,
  onSubmitStatusChange,
  onCreated,
  onCancel,
}: {
  result: ImportRecipeResult;
  feedbackSource: ImportSource;
  collectionId?: string;
  /** Explicit destination. `null` is unfiled. `undefined` follows `collectionId`. */
  destinationId?: string | null;
  formId?: string;
  onSubmitStatusChange?: (status: CreateRecipeSubmitStatus) => void;
  onCreated: (recipe: Recipe) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [original] = useState(result.recipe);
  // Computed on the original extraction; positions hold for the translation too.
  const [importCheck] = useState<ImportCheck | undefined>(() =>
    result.warnings !== undefined ? { at: Date.now(), warnings: result.warnings } : undefined,
  );
  const pasted = pastedImport(original);
  const [sourceLang, setSourceLang] = useState(original.lang);
  const [translationFailed, setTranslationFailed] = useState(result.translationFailed === true);
  const [held, setHeld] = useState<{ target: string; recipe: RecipeDraft } | undefined>(() => {
    if (result.translationFailed === true || result.translation === undefined) {
      return undefined;
    }
    return {
      target: result.translation.lang,
      recipe: translatedPreviewDraft(original, result.translation.recipe),
    };
  });
  const [translateChecked, setTranslateChecked] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heldForUi = held !== undefined && held.target === locale;
  const rules = importPreviewRules({
    sourceLang,
    uiLang: locale,
    translationFailed,
    pasted,
    translateChecked,
  });
  const showingTranslated = rules.showCheckbox && translateChecked && heldForUi;
  const [view, setView] = useState<'original' | 'translated'>(showingTranslated ? 'translated' : 'original');
  const viewRef = useRef(view);
  const editRef = useRef({ dirty: false, photosPicked: false });
  const sourceLangRef = useRef(sourceLang);
  sourceLangRef.current = sourceLang;

  const displayed: 'original' | 'translated' =
    view === 'translated' && heldForUi && rules.showCheckbox ? 'translated' : 'original';
  const saveRules = importPreviewRules({
    sourceLang,
    uiLang: locale,
    translationFailed,
    pasted,
    translateChecked: displayed === 'translated',
  });
  const saveLangRef = useRef(saveRules.saveLang);
  saveLangRef.current = saveRules.saveLang;
  const resolveLang = useCallback(() => saveLangRef.current, []);

  const onEditStateChange = useCallback((state: { dirty: boolean; photosPicked: boolean }) => {
    editRef.current = state;
  }, []);

  const confirmDiscardRef = useRef<() => boolean>(() => true);
  confirmDiscardRef.current = () => {
    const { dirty, photosPicked } = editRef.current;
    if (!dirty) {
      return true;
    }
    const message = photosPicked ? t('import.discardEditsAndPhotos') : t('import.discardEdits');
    return window.confirm(message);
  };

  const showVersion = (next: 'original' | 'translated') => {
    viewRef.current = next;
    setView(next);
  };

  useEffect(() => {
    if (translationFailed || !rules.showCheckbox || !translateChecked || heldForUi) {
      setTranslating(false);
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    setTranslating(true);
    const sourceAtFetch = sourceLangRef.current;
    translateRecipe({
      recipe: original,
      target: locale,
      ...(sourceAtFetch !== undefined ? { sourceLang: sourceAtFetch } : {}),
      signal: ac.signal,
    })
      .then((recipe) => {
        if (cancelled) {
          return;
        }
        setHeld({ target: locale, recipe: translatedPreviewDraft(original, recipe) });
        if (viewRef.current === 'translated') {
          return;
        }
        if (!confirmDiscardRef.current()) {
          setTranslateChecked(false);
          return;
        }
        viewRef.current = 'translated';
        setView('translated');
      })
      .catch((err: unknown) => {
        if (cancelled || isAbortError(err)) {
          return;
        }
        if (err instanceof Error && err.message === t('error.sessionExpired')) {
          setError(err.message);
          setTranslateChecked(false);
          return;
        }
        setTranslationFailed(true);
        viewRef.current = 'original';
        setView('original');
      })
      .finally(() => {
        if (!cancelled) {
          setTranslating(false);
        }
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [translationFailed, rules.showCheckbox, translateChecked, heldForUi, locale, original, t]);

  const onToggle = (checked: boolean) => {
    if (translating) {
      return;
    }
    if (checked) {
      if (heldForUi && viewRef.current !== 'translated' && !confirmDiscardRef.current()) {
        return;
      }
      setTranslateChecked(true);
      if (heldForUi) {
        showVersion('translated');
      }
      return;
    }
    if (viewRef.current === 'translated' && !confirmDiscardRef.current()) {
      return;
    }
    setTranslateChecked(false);
    showVersion('original');
  };

  const onSourceLang = (next: string | undefined) => {
    if (next === sourceLang || translating) {
      return;
    }
    const nextVisible = importPreviewRules({
      sourceLang: next,
      uiLang: locale,
      translationFailed,
      pasted,
      translateChecked: true,
    }).showCheckbox;
    const appearing = nextVisible && !rules.showCheckbox;
    const checked = nextVisible ? (appearing ? true : translateChecked) : translateChecked;
    const nextView: 'original' | 'translated' =
      nextVisible && checked && heldForUi ? 'translated' : 'original';
    if (nextView !== viewRef.current && !confirmDiscardRef.current()) {
      return;
    }
    setSourceLang(next);
    if (appearing) {
      setTranslateChecked(true);
    }
    if (nextView !== viewRef.current) {
      showVersion(nextView);
    }
  };

  const guessedName = sourceLang !== undefined ? languageName(sourceLang, locale) : undefined;
  const guessLine =
    sourceLang !== undefined
      ? t('import.looksLike', { language: guessedName ?? sourceLang })
      : t('import.couldNotTellLanguage');
  const shown = displayed === 'translated' && held ? held.recipe : original;
  // A report always carries the extraction (`original`), never the person's edits.
  const feedbackResult = {
    recipe: original,
    translationFailed,
    translatedTo: held !== undefined && !translationFailed ? held.target : undefined,
  };

  return (
    <>
      {importCheck !== undefined && (
        <div className={noticeClass} role="status">
          <p className="font-medium">{t('importWarning.previewHeading')}</p>
          <ImportWarningList
            warnings={importCheck.warnings}
            sections={shown.ingredientSections}
            className="mt-1"
          />
        </div>
      )}
      {importCheck !== undefined && (
        <ImportFeedbackCard
          compact
          input={{
            trigger: 'warnings',
            source: feedbackSource,
            locale,
            result: { ...feedbackResult, warnings: importCheck.warnings },
          }}
        />
      )}

      {translationFailed && (
        <p className={`${noticeClass} mt-3`} role="status">
          {t('import.translateFailedNotice')}
        </p>
      )}

      {result.grounding !== undefined && (
        <section className={`${noticeClass} mt-3`} aria-label={t('import.sources')}>
          {result.grounding.sources.length > 0 && (
            <>
              <p className="font-medium">{t('import.sources')}</p>
              {/* Google's links are redirects on its own host, so the title (usually the site) is the only useful label. */}
              <ul className="mt-1 list-disc pl-5">
                {result.grounding.sources.map((source) => (
                  <li key={source.url} className="break-words">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline hover:text-ink-muted"
                    >
                      {source.title !== '' ? source.title : t('import.untitledSource')}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.grounding.searchSuggestions !== undefined && (
            // Google's own snippet, shown as provided (its terms). No scripts run in it.
            // CHIP_FRAME_HEAD only frames it: its links open a new tab (Google can't be
            // framed) and the frame follows the app's light or dark theme. 64px fits
            // Google's one-row strip without a scrollbar.
            <iframe
              title={t('import.searchSuggestions')}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={`${CHIP_FRAME_HEAD}${result.grounding.searchSuggestions}`}
              className="chip-frame mt-2 h-16 w-full border-0"
            />
          )}
        </section>
      )}

      <div className={pasted ? `${noticeClass} mt-3` : 'mt-3'}>
        <label htmlFor="import-source-lang" className="block text-sm text-ink">
          {guessLine}
        </label>
        <LanguagePicker
          id="import-source-lang"
          value={sourceLang}
          disabled={translating}
          onChange={onSourceLang}
        />
      </div>

      {rules.showCheckbox && (
        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={translateChecked}
            disabled={translating}
            onChange={(event) => onToggle(event.target.checked)}
            className={`mt-1 h-4 w-4 shrink-0 accent-ink disabled:opacity-40 ${inputFocus}`}
          />
          <span>
            <span className="block font-medium text-ink">
              {t('import.translateInto')}
            </span>
            {rules.showPastedHint && (
              <span className="mt-0.5 block text-sm text-ink-subtle">
                {t('import.pastedOriginalNotKept')}
              </span>
            )}
          </span>
        </label>
      )}

      {translating && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm text-ink-subtle">
          <SpinnerIcon className="h-4 w-4 animate-spin" /> {t('import.translating')}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/* RecipeForm copies `initial` once, so the key remounts it on original vs translated. */}
      <CreateRecipeForm
        formKey={displayed}
        initial={shown}
        collectionId={collectionId}
        destinationId={destinationId}
        formId={formId}
        submitLocked={translating}
        resolveLang={resolveLang}
        hideLanguage
        onEditStateChange={onEditStateChange}
        onSubmitStatusChange={onSubmitStatusChange}
        importCheck={importCheck}
        onCreated={onCreated}
        onCancel={onCancel}
      />
      {importCheck === undefined && (
        <ImportFeedbackRating
          input={{ source: feedbackSource, locale, result: feedbackResult }}
        />
      )}
    </>
  );
}
