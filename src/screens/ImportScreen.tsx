import { useCallback, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { t as translateNow, useLocale, useT } from '../i18n';
import ImportFeedbackCard, {
  newFeedbackCardMemory,
  type FeedbackCardMemory,
} from '../components/ImportFeedbackCard';
import ImportPreview from '../components/ImportPreview';
import { importWarningText } from '../components/ImportWarningList';
import { type CreateRecipeSubmitStatus } from '../components/CreateRecipeForm';
import SaveToCollectionSheet from '../components/SaveToCollectionSheet';
import { libraryHref } from '../lib/collectionHref';
import { collectionStore, useCollections } from '../lib/collectionStore';
import { resolveCollectionDestination } from '../lib/collectionDestination';
import { CameraIcon, SpinnerIcon } from '../lib/icons';
import { encodeImageForImport, type EncodedImage } from '../lib/image';
import {
  checkImportPhotoBytes,
  fitImportPhotos,
  importRecipe,
  MAX_GENERATE_BRIEF_CHARS,
  MAX_IMPORT_PHOTOS,
  type ImportRecipeResult,
} from '../lib/importApi';
import type { ImportWarning } from '../lib/importCheck';
import {
  importFailureDetails,
  type ImportFailure,
  type ImportSource,
} from '../lib/importFeedback';
import { translatedPreviewDraft } from '../lib/importPreview';
import {
  parseImportInput,
  validateImportInput,
} from '../lib/importInput';
import { recipeStore } from '../lib/recipeStore';
import type { IngredientSection, RecipeDraft } from '../lib/types';
import { backLink, inputFocus, primaryBtn, secondaryBtn } from '../lib/uiClasses';

const IMPORT_FORM_ID = 'import-recipe-form';

type BulkResult =
  | {
      url: string;
      ok: true;
      id: string;
      title: string;
      /** 0 for the first import of the row; each Retry adds one, so a card is per attempt. */
      attempt: number;
      untranslated?: true;
      /** The import check's warnings, saved on the recipe as `importCheck`. */
      warnings?: ImportWarning[];
      /** The original extraction, kept only for a report on a flagged row. */
      extracted?: RecipeDraft;
      translatedTo?: string;
      /** The saved recipe's ingredients, so a warning can name one. */
      sections: IngredientSection[];
    }
  | {
      url: string;
      ok: false;
      error: string;
      attempt: number;
      failure?: ImportFailure;
      retrying?: true;
    };

type BulkFilter = 'all' | 'attention' | 'failed';

type ScreenError = { message: string; feedback?: { source: ImportSource; failure: ImportFailure } };

function needsAttention(row: BulkResult): boolean {
  return row.ok && row.warnings !== undefined;
}

type ImportPhoto = { key: string; image: EncodedImage; src: string };

/**
 * Import extracts a recipe from a link, text, or photos. Create asks the
 * model to write one from an idea (`docs/plans/recipe-generation.md`); it
 * has no photos or bulk, and the result lands in the same preview.
 */
type ImportMode = 'import' | 'create';

export default function ImportScreen() {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const { collectionId } = useParams();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<ImportMode>(
    searchParams.get('mode') === 'create' ? 'create' : 'import',
  );
  const [search, setSearch] = useState(false);
  // Subscribed, not a one-shot store read: on a cold load of a collection
  // import path the pull has not landed yet, and only a subscriber re-renders
  // once it does.
  const collections = useCollections();
  const knownCollectionId =
    collectionId &&
    collections?.some((c) => c.id === collectionId && !collectionStore.isShared(c.id))
      ? collectionId
      : undefined;
  const [input, setInput] = useState('');
  const [bulk, setBulk] = useState(false);
  const [bulkTranslate, setBulkTranslate] = useState(true);
  const [photos, setPhotos] = useState<ImportPhoto[]>([]);
  const photosRef = useRef(photos);
  const [encoding, setEncoding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<ScreenError | null>(null);
  const [preview, setPreview] = useState<{ result: ImportRecipeResult; source: ImportSource } | null>(
    null,
  );
  const [pendingUrls, setPendingUrls] = useState<string[] | null>(null);
  // undefined follows the URL folder; null is an explicit unfiled choice; a
  // string overrides the folder. Kept on screen, so editing the input does
  // not clear it.
  const [picked, setPicked] = useState<string | null | undefined>();
  const [choosingDestination, setChoosingDestination] = useState(false);
  const destination = resolveCollectionDestination(collections, knownCollectionId, picked);
  const [retrying, setRetrying] = useState(false);
  const inFlight = useRef(false);
  const [summary, setSummary] = useState<BulkResult[] | null>(null);
  const [filter, setFilter] = useState<BulkFilter>('all');
  // Bulk report cards, keyed by row and attempt. A filter switch unmounts a card,
  // so its report id, sent flag, and note live here: coming back never mints a
  // second report. A Retry is a new attempt and starts a fresh card.
  const [reportMemory, setReportMemory] = useState<Record<string, FeedbackCardMemory>>({});
  const openReport = (key: string) =>
    setReportMemory((all) => (all[key] !== undefined ? all : { ...all, [key]: newFeedbackCardMemory() }));
  const rememberReport = (key: string) => (memory: FeedbackCardMemory) =>
    setReportMemory((all) => ({ ...all, [key]: memory }));
  const [saveStatus, setSaveStatus] = useState<CreateRecipeSubmitStatus>({
    locked: false,
    saving: false,
    pending: false,
  });
  const onSubmitStatusChange = useCallback((status: CreateRecipeSubmitStatus) => {
    setSaveStatus((prev) =>
      prev.locked === status.locked && prev.saving === status.saving && prev.pending === status.pending
        ? prev
        : status,
    );
  }, []);
  // Back follows the destination on screen: the collection in the URL until
  // one is chosen, then the choice. Unfiled, or a chosen collection that was
  // deleted, goes back to Recipes.
  const backTo = libraryHref(destination.kind === 'save' ? destination.collectionId : undefined);

  /** One bulk row: import the URL with a fresh fetch and save it to the batch destination. */
  const importOne = async (url: string, destinationId: string | undefined): Promise<BulkResult> => {
    if (destinationId && !collectionStore.get(destinationId)) {
      throw new Error(t('import.collectionNotFoundChoose'));
    }
    const imported = await importRecipe(
      bulkTranslate ? { url, translateTo: locale } : { url },
    );
    const untranslated = bulkTranslate && imported.translationFailed === true;
    const draft =
      bulkTranslate && imported.translation && !untranslated
        ? {
            ...translatedPreviewDraft(imported.recipe, imported.translation.recipe),
            lang: locale,
          }
        : imported.recipe;
    // Bulk saves without a preview, so the warnings go on the recipe for its banner.
    const warnings = imported.warnings;
    const recipe = await recipeStore.create(
      warnings !== undefined ? { ...draft, importCheck: { at: Date.now(), warnings } } : draft,
      destinationId ? { collectionId: destinationId } : undefined,
    );
    return {
      url,
      ok: true,
      id: recipe.id,
      title: recipe.title.trim() || url,
      attempt: 0,
      sections: recipe.ingredientSections,
      ...(untranslated ? { untranslated: true as const } : {}),
      ...(warnings !== undefined ? { warnings, extracted: imported.recipe } : {}),
      ...(bulkTranslate && imported.translation && !untranslated ? { translatedTo: locale } : {}),
    };
  };

  const runBulk = async (urls: string[], destinationId: string | undefined) => {
    if (inFlight.current) return;
    if (destinationId && !collectionStore.get(destinationId)) {
      throw new Error(t('import.collectionNotFoundChoose'));
    }
    inFlight.current = true;
    setPicked(destinationId ?? null);
    // A new batch numbers its attempts from 0 again.
    setReportMemory({});
    setPendingUrls(null);
    setBusy(true);
    setError(null);
    try {
      const results: BulkResult[] = [];
      for (const [i, url] of urls.entries()) {
        setProgress({ current: i + 1, total: urls.length });
        try {
          results.push(await importOne(url, destinationId));
        } catch (e) {
          const message = e instanceof Error ? e.message : t('error.importFailed');
          const failure = importFailureDetails(e);
          results.push({ url, ok: false, error: message, attempt: 0, ...(failure ? { failure } : {}) });
          if (message === translateNow('error.sessionExpired') || (destinationId && !collectionStore.get(destinationId))) {
            for (const rest of urls.slice(i + 1)) {
              results.push({ url: rest, ok: false, error: message, attempt: 0 });
            }
            break;
          }
        }
      }
      setSummary(results);
      setFilter('all');
    } finally {
      inFlight.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  const setPhotoList = (next: ImportPhoto[]) => {
    photosRef.current = next;
    setPhotos(next);
  };

  const addPhotos = async (files: File[]) => {
    const { accepted, overflow } = fitImportPhotos(photosRef.current.length, files);
    setError(overflow ? { message: t('import.photoLimit') } : null);
    setRetrying(false);
    if (accepted.length === 0) return;
    setEncoding(true);
    try {
      for (const file of accepted) {
        let image: EncodedImage;
        try {
          image = await encodeImageForImport(file);
        } catch {
          setError({ message: t('import.photoUnreadable') });
          continue;
        }
        const check = checkImportPhotoBytes(
          photosRef.current.map((p) => p.image),
          image,
        );
        if (check === 'photo_too_large') {
          setError({ message: t('import.photoTooLarge') });
          continue;
        }
        if (check === 'total_too_large') {
          setError({ message: t('import.photosTotalTooLarge') });
          continue;
        }
        setPhotoList([
          ...photosRef.current,
          {
            key: crypto.randomUUID(),
            image,
            src: `data:${image.mediaType};base64,${image.base64}`,
          },
        ]);
      }
    } finally {
      setEncoding(false);
    }
  };

  const removePhoto = (key: string) => {
    setPhotoList(photosRef.current.filter((p) => p.key !== key));
    setError(null);
  };

  const switchMode = (next: ImportMode) => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setRetrying(false);
    if (next === 'create') {
      // Create has no photos or bulk; the typed text is kept.
      setPhotoList([]);
      setBulk(false);
    }
  };

  const extract = async () => {
    if (inFlight.current || pendingUrls || collections === undefined) return;
    if (mode === 'create') {
      const brief = input.trim();
      if (brief === '') return;
      setError(null);
      inFlight.current = true;
      setBusy(true);
      // The brief is the only text; a report carries it the way a paste report carries pasted text.
      const source: ImportSource = { via: 'generate', pastedText: brief };
      try {
        setPreview({
          result: await importRecipe({ brief, search, translateTo: locale }),
          source,
        });
      } catch (e) {
        const failure = importFailureDetails(e);
        setError({
          message: e instanceof Error ? e.message : t('error.importFailed'),
          ...(failure ? { feedback: { source, failure } } : {}),
        });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      return;
    }
    if (photosRef.current.length > 0) {
      setError(null);
      inFlight.current = true;
      setBusy(true);
      // Photos only ever report their count: never the photos or the typed notes.
      const source: ImportSource = { via: 'photos', photos: photosRef.current.length };
      try {
        setPreview({
          result: await importRecipe({
            images: photosRef.current.map((p) => p.image),
            text: input.trim() || undefined,
            translateTo: locale,
          }),
          source,
        });
      } catch (e) {
        const failure = importFailureDetails(e);
        setError({
          message: e instanceof Error ? e.message : t('error.importFailed'),
          ...(failure ? { feedback: { source, failure } } : {}),
        });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      return;
    }
    const parsed = parseImportInput(input);
    if (parsed.kind === 'empty') return;
    const validated = validateImportInput(parsed, bulk);
    if (!validated.ok) {
      setError({ message: validated.error });
      return;
    }
    setError(null);
    const urls = validated.mode === 'bulk'
      ? validated.urls
      : retrying && validated.mode === 'url' ? [validated.url] : null;
    if (urls) {
      if (destination.kind === 'choose') {
        setPendingUrls(urls);
      } else if (destination.kind === 'save') {
        try {
          await runBulk(urls, destination.collectionId);
        } catch (e) {
          setError({ message: e instanceof Error ? e.message : t('error.importFailed') });
          setPendingUrls(urls);
        }
      }
      return;
    }
    if (validated.mode === 'bulk') return;
    inFlight.current = true;
    setBusy(true);
    const source: ImportSource =
      validated.mode === 'url'
        ? { via: 'url', url: validated.url }
        : { via: 'paste', pastedText: validated.text };
    try {
      setPreview({
        result: await importRecipe({
          ...(validated.mode === 'url' ? { url: validated.url } : { text: validated.text }),
          translateTo: locale,
        }),
        source,
      });
    } catch (e) {
      const failure = importFailureDetails(e);
      setError({
        message: e instanceof Error ? e.message : t('error.importFailed'),
        ...(failure ? { feedback: { source, failure } } : {}),
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const tryAgain = () => {
    if (summary === null) return;
    const failed = summary.filter((row) => !row.ok).map((row) => row.url);
    setInput(failed.join('\n'));
    setRetrying(true);
    setSummary(null);
    setError(null);
  };

  /**
   * Re-runs one failed row, with a fresh fetch, into the destination shown on
   * screen: the batch's collection (Change is locked on the summary), or a new
   * choice if that collection was deleted.
   */
  const retryRow = async (url: string) => {
    if (inFlight.current || summary === null) return;
    inFlight.current = true;
    const next = (summary.find((r) => r.url === url)?.attempt ?? 0) + 1;
    const replace = (row: BulkResult) =>
      setSummary((rows) => rows?.map((r) => (r.url === url ? row : r)) ?? rows);
    setSummary(
      (rows) =>
        rows?.map((r) => (r.url === url && !r.ok ? { ...r, retrying: true as const } : r)) ?? rows,
    );
    try {
      if (destination.kind !== 'save') {
        replace({
          url,
          ok: false,
          error: t('import.collectionNotFoundChoose'),
          attempt: next,
        });
        return;
      }
      replace({ ...(await importOne(url, destination.collectionId)), attempt: next });
    } catch (e) {
      const failure = importFailureDetails(e);
      replace({
        url,
        ok: false,
        error: e instanceof Error ? e.message : t('error.importFailed'),
        attempt: next,
        ...(failure ? { failure } : {}),
      });
    } finally {
      inFlight.current = false;
    }
  };

  const successCount = summary?.filter((row) => row.ok).length ?? 0;
  const attentionCount = summary?.filter(needsAttention).length ?? 0;
  const failedCount = summary === null ? 0 : summary.length - successCount;
  const retryingRow = summary?.some((row) => !row.ok && row.retrying === true) ?? false;
  // A filter whose last row a Retry fixed shows everything rather than an empty list.
  const activeFilter: BulkFilter =
    (filter === 'attention' && attentionCount === 0) || (filter === 'failed' && failedCount === 0)
      ? 'all'
      : filter;
  const shownRows =
    summary?.filter((row) =>
      activeFilter === 'attention'
        ? needsAttention(row)
        : activeFilter === 'failed'
          ? !row.ok
          : true,
    ) ?? [];
  // A held preview draft would be retried into whatever is picked now.
  const destinationLocked =
    busy ||
    encoding ||
    saveStatus.saving ||
    (preview !== null && saveStatus.pending) ||
    retryingRow ||
    pendingUrls !== null;
  // A batch's rows retry into the batch's collection, so it cannot be changed
  // while the summary shows. If that collection is deleted, Choose still works.
  const changeLocked = destinationLocked || summary !== null;
  // Unfiled is the sheet's own label, not "Import into {name}": that label is
  // a phrase, and stuffing it into the sentence does not read in every language.
  let destinationLabel: string | undefined;
  if (destination.kind === 'save') {
    if (destination.collectionId === undefined) {
      destinationLabel = t('saveSheet.noCollection');
    } else {
      const name = collections?.find((collection) => collection.id === destination.collectionId)?.name;
      if (name !== undefined) destinationLabel = t('import.destination', { name });
    }
  }
  const filterClass = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${
      active
        ? 'border-ink bg-ink text-page'
        : 'border-line bg-surface text-ink hover:bg-surface-muted'
    }`;

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={backTo} className={backLink}>
          &larr; {t('common.library')}
        </Link>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{t('import.title')}</h1>
          {summary === null && preview !== null && (
            <button
              type="submit"
              form={IMPORT_FORM_ID}
              disabled={saveStatus.locked}
              aria-busy={saveStatus.saving || undefined}
              className={`${primaryBtn} inline-flex shrink-0 items-center justify-center gap-2 px-5 py-2`}
              style={saveStatus.saving ? { opacity: 1 } : undefined}
            >
              {saveStatus.saving && (
                <SpinnerIcon className="block h-5 w-5 animate-spin" />
              )}
              {t('common.save')}
            </button>
          )}
        </div>
        {/* The preview's form shows its own loading line. */}
        {destination.kind === 'loading' && preview === null && (
          <p role="status" className="mt-2 text-sm text-ink-muted">
            {t('common.loadingCollections')}
          </p>
        )}
        {destination.kind === 'save' && destinationLabel !== undefined && (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 text-sm text-ink">
            <span>{destinationLabel}</span>
            <button
              type="button"
              disabled={changeLocked}
              onClick={() => setChoosingDestination(true)}
              className="font-medium text-ink-muted underline hover:text-ink disabled:opacity-40"
            >
              {t('import.changeDestination')}
            </button>
          </p>
        )}
        {destination.kind === 'choose' && (
          <p className="mt-2">
            <button
              type="button"
              disabled={destinationLocked}
              onClick={() => setChoosingDestination(true)}
              className="text-sm font-medium text-ink underline hover:text-ink disabled:opacity-40"
            >
              {t('import.chooseDestination')}
            </button>
          </p>
        )}
      </header>

      {summary !== null ? (
        <>
          <h2 className="text-lg font-semibold">
            {t('import.summaryImported', { count: successCount })}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={activeFilter === 'attention'}
              disabled={attentionCount === 0}
              onClick={() => setFilter('attention')}
              className={filterClass(activeFilter === 'attention')}
            >
              {t('import.summaryAttention', { count: attentionCount })}
            </button>
            <button
              type="button"
              aria-pressed={activeFilter === 'failed'}
              disabled={failedCount === 0}
              onClick={() => setFilter('failed')}
              className={filterClass(activeFilter === 'failed')}
            >
              {t('import.summaryFailed', { count: failedCount })}
            </button>
            {activeFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={filterClass(false)}
              >
                {t('import.showAll')}
              </button>
            )}
          </div>
          <ul className="mt-3 space-y-2">
            {shownRows.map((row) => {
              const firstWarning =
                row.ok && row.warnings !== undefined
                  ? row.warnings
                      .map((warning) => importWarningText(warning, row.sections, t))
                      .find((text) => text !== null)
                  : undefined;
              const reportKey = `${row.url}#${row.attempt}`;
              const memory = reportMemory[reportKey];
              const canReport = row.ok
                ? row.warnings !== undefined && row.extracted !== undefined
                : row.failure !== undefined;
              const border = !row.ok
                ? 'border-danger'
                : firstWarning !== undefined
                  ? 'border-amber-600/70'
                  : 'border-line';
              return (
                <li
                  key={row.url}
                  className={`rounded-xl border bg-surface px-4 py-3 text-sm shadow-sm ${border}`}
                >
                  {row.ok ? (
                    <>
                      <Link
                        to={`/recipe/${row.id}`}
                        state={{ from: backTo }}
                        className="font-medium text-ink hover:underline"
                      >
                        {row.title}
                      </Link>
                      <p className="mt-1 break-all text-ink-subtle">{row.url}</p>
                      {firstWarning !== undefined && (
                        <p className="mt-1 flex gap-1.5 text-ink">
                          <span aria-hidden="true" className="text-amber-600">
                            ⚠
                          </span>
                          <span>{firstWarning}</span>
                        </p>
                      )}
                      {row.untranslated && (
                        <p className="mt-1 text-ink-subtle">{t('import.savedUntranslated')}</p>
                      )}
                      {canReport && memory === undefined && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openReport(reportKey)}
                          className="mt-2 text-sm text-ink-muted underline hover:text-ink disabled:opacity-40"
                        >
                          {t('importFeedback.reportRow')}
                        </button>
                      )}
                      {canReport && memory !== undefined && row.warnings !== undefined && row.extracted !== undefined && (
                        <ImportFeedbackCard
                          compact
                          memory={memory}
                          onMemoryChange={rememberReport(reportKey)}
                          input={{
                            trigger: 'warnings',
                            source: { via: 'url', url: row.url },
                            locale,
                            result: {
                              recipe: row.extracted,
                              warnings: row.warnings,
                              translationFailed: row.untranslated === true,
                              translatedTo: row.translatedTo,
                            },
                          }}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <p className="break-all text-ink">{row.url}</p>
                      <p className="mt-1 flex gap-1.5 font-medium text-danger">
                        <span aria-hidden="true">✕</span>
                        <span>{t('import.rowFailed')}</span>
                      </p>
                      <p className="mt-0.5 text-danger">{row.error}</p>
                      <button
                        type="button"
                        disabled={busy || retryingRow}
                        aria-busy={row.retrying || undefined}
                        onClick={() => void retryRow(row.url)}
                        className={`${secondaryBtn} mt-2 inline-flex items-center gap-2 px-4 py-1.5 disabled:opacity-40`}
                      >
                        {row.retrying && <SpinnerIcon className="h-4 w-4 animate-spin" />}
                        {row.retrying ? t('importWarning.retrying') : t('import.retryRow')}
                      </button>
                      {canReport && memory === undefined && (
                        <button
                          type="button"
                          disabled={busy || row.retrying === true}
                          onClick={() => openReport(reportKey)}
                          className="mt-2 ml-3 text-sm text-ink-muted underline hover:text-ink disabled:opacity-40"
                        >
                          {t('importFeedback.reportRow')}
                        </button>
                      )}
                      {canReport && memory !== undefined && row.failure !== undefined && (
                        <ImportFeedbackCard
                          compact
                          memory={memory}
                          onMemoryChange={rememberReport(reportKey)}
                          input={{
                            trigger: 'failed',
                            source: { via: 'url', url: row.url },
                            locale,
                            failure: row.failure,
                          }}
                        />
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => navigate(backTo)}
            className={`${primaryBtn} mt-4 w-full py-3`}
          >
            {t('common.backToLibrary')}
          </button>
          {failedCount > 0 && (
            <button
              type="button"
              disabled={retryingRow}
              onClick={tryAgain}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {t('common.tryAgain')}
            </button>
          )}
        </>
      ) : preview === null ? (
        <>
          <div
            role="group"
            aria-label={t('import.mode')}
            className="mb-3 flex flex-wrap items-center gap-2"
          >
            {(['import', 'create'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                disabled={busy || encoding || pendingUrls !== null}
                onClick={() => switchMode(option)}
                className={filterClass(mode === option)}
              >
                {option === 'import' ? t('import.modeImport') : t('import.modeCreate')}
              </button>
            ))}
          </div>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setRetrying(false);
            }}
            rows={mode === 'create' ? 4 : 5}
            readOnly={busy || pendingUrls !== null}
            maxLength={
              mode === 'create' ? MAX_GENERATE_BRIEF_CHARS : photos.length > 0 ? 2000 : undefined
            }
            placeholder={
              mode === 'create'
                ? t('import.placeholderCreate')
                : photos.length > 0
                  ? t('import.placeholderPhotos')
                  : bulk
                    ? t('import.placeholderBulk')
                    : t('import.placeholder')
            }
            className={`w-full rounded-xl border border-line bg-surface px-4 py-3 shadow-sm ${inputFocus}`}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length > 0) void addPhotos(files);
            }}
          />
          {mode === 'create' ? (
            <>
              <p className="mt-1 text-sm text-ink-subtle">{t('import.createHint')}</p>
              <Link to="/settings" className="mt-1 inline-block text-sm text-ink-subtle underline hover:text-ink">
                {t('import.kitchenHint')}
              </Link>
              <label className="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={search}
                  disabled={busy}
                  onChange={(e) => setSearch(e.target.checked)}
                  className={`mt-1 h-4 w-4 shrink-0 accent-ink disabled:opacity-40 ${inputFocus}`}
                />
                <span>
                  <span className="block font-medium text-ink">{t('import.searchWeb')}</span>
                  <span className="mt-0.5 block text-sm text-ink-subtle">
                    {t('import.searchWebHint')}
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  busy ||
                  encoding ||
                  bulk ||
                  pendingUrls !== null ||
                  photos.length >= MAX_IMPORT_PHOTOS
                }
                className={`${secondaryBtn} mt-3 inline-flex items-center gap-2 px-4 py-2 disabled:opacity-40`}
              >
                <CameraIcon className="h-5 w-5" />
                {t('import.addPhotos')}
              </button>
              <p className="mt-1 text-sm text-ink-subtle">{t('import.photoHint')}</p>
              {photos.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {photos.map((photo, i) => (
                    <li key={photo.key} className="relative">
                      <div className="h-20 w-20 overflow-hidden rounded-lg bg-surface-muted">
                        <img
                          src={photo.src}
                          alt={t('import.photoAlt', { n: i + 1 })}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={t('import.removePhoto', { n: i + 1 })}
                        onClick={() => removePhoto(photo.key)}
                        disabled={busy}
                        className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs text-page hover:opacity-80 active:opacity-80 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="mt-3 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={bulk}
                  disabled={busy || pendingUrls !== null || encoding || photos.length > 0}
                  onChange={(e) => {
                    setBulk(e.target.checked);
                    setRetrying(false);
                    setError(null);
                  }}
                  className={`mt-1 h-4 w-4 shrink-0 accent-ink disabled:opacity-40 ${inputFocus}`}
                />
                <span>
                  <span className="block font-medium text-ink">{t('import.bulk')}</span>
                  <span className="mt-0.5 block text-sm text-ink-subtle">
                    {t('import.bulkHint')}
                  </span>
                </span>
              </label>
              {bulk && (
                <label className="mt-3 flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={bulkTranslate}
                    disabled={busy || pendingUrls !== null}
                    onChange={(event) => setBulkTranslate(event.target.checked)}
                    className={`mt-1 h-4 w-4 shrink-0 accent-ink disabled:opacity-40 ${inputFocus}`}
                  />
                  <span className="block font-medium text-ink">
                    {t('import.translateInto')}
                  </span>
                </label>
              )}
            </>
          )}
          {error && (
            <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
              {error.message}
            </p>
          )}
          {error?.feedback && (
            <ImportFeedbackCard
              input={{
                trigger: 'failed',
                source: error.feedback.source,
                locale,
                failure: error.feedback.failure,
              }}
            />
          )}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={
              busy ||
              encoding ||
              pendingUrls !== null ||
              collections === undefined ||
              (input.trim() === '' && photos.length === 0)
            }
            aria-busy={busy || undefined}
            className={`${primaryBtn} mt-3 inline-flex w-full items-center justify-center gap-2 py-3`}
            style={{ opacity: busy ? 1 : undefined }}
          >
            {busy && <SpinnerIcon className="block h-5 w-5 animate-spin" />}
            {mode === 'create'
              ? busy
                ? t('import.generating')
                : t('import.generateRecipe')
              : busy
                ? t('import.extracting')
                : bulk
                  ? t('import.extractRecipes')
                  : t('import.extractRecipe')}
          </button>
          {busy && progress && (
            <div className="mt-3">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.current}
                aria-valuetext={t('import.readingProgress', {
                  current: progress.current,
                  total: progress.total,
                })}
                aria-label={t('import.progressLabel')}
                className="h-2 w-full overflow-hidden rounded-full bg-line"
              >
                <div
                  className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.round(
                      (progress.current / progress.total) * 100,
                    )}%`,
                  }}
                />
              </div>
              <p
                className="mt-2 text-center text-sm text-ink-subtle"
                role="status"
              >
                {t('import.readingProgressHint', {
                  current: progress.current,
                  total: progress.total,
                })}
              </p>
            </div>
          )}
          {busy && !progress && (
            <p className="mt-3 text-center text-sm text-ink-subtle" role="status">
              {mode === 'create'
                ? t('import.generatingHint')
                : photos.length > 0
                  ? t('import.readingPhotosHint')
                  : t('import.readingHint')}
            </p>
          )}
        </>
      ) : (
        <>
          <ImportPreview
            result={preview.result}
            feedbackSource={preview.source}
            collectionId={knownCollectionId}
            destinationId={picked}
            formId={IMPORT_FORM_ID}
            onSubmitStatusChange={onSubmitStatusChange}
            onCreated={(recipe) => navigate(`/recipe/${recipe.id}`, { replace: true })}
            onCancel={() => setPreview(null)}
          />
        </>
      )}
      {choosingDestination && pendingUrls === null && (
        <SaveToCollectionSheet
          title={t('import.destinationTitle')}
          createLabel={t('import.createCollection')}
          onSave={(id) => {
            setPicked(id ?? null);
            setChoosingDestination(false);
          }}
          onCancel={() => setChoosingDestination(false)}
        />
      )}
      {pendingUrls && (
        <SaveToCollectionSheet
          title={t('import.saveTo')}
          createLabel={t('import.createAndImport')}
          onSave={(id) => runBulk(pendingUrls, id)}
          onCancel={() => setPendingUrls(null)}
        />
      )}
    </div>
  );
}
