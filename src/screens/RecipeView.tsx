import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { languageName, sameLanguage, useLocale, useT } from '../i18n';
import { StoredPhotoImage } from '../components/BlobImage';
import ChatPanel from '../components/ChatPanel';
import CookLogCard from '../components/CookLogCard';
import ImportWarningBanner from '../components/ImportWarningBanner';
import ShareRecipeButton from '../components/ShareRecipeButton';
import VariantLinks from '../components/VariantLinks';
import {
  askButtonClass,
  GallerySection,
  IngredientsSection,
  NotesSection,
  recipePageClass,
  RecipeTimes,
  SourceCredit,
  sourceLink,
  StepsSection,
  translateChipClass,
} from '../components/RecipeBody';
import { libraryHref, libraryPathFromState } from '../lib/collectionHref';
import { useCookLogs } from '../lib/cookLogStore';
import { SpinnerIcon, TranslateIcon } from '../lib/icons';
import {
  useRecipe,
  useRecipeAccess,
  useRecipeCollectionId,
  useRecipeSharedBy,
} from '../lib/recipeStore';
import { sync } from '../lib/syncEngine';
import { translateChipMode, type TranslateChipMode } from '../lib/translateChip';
import {
  displayRecipe as recipeForDisplay,
  effectiveRecipeLang,
  getDetectedLang,
  showOriginal,
  translateRecipe,
} from '../lib/translationStore';
import { backLink, ghostBtn, secondaryBtn } from '../lib/uiClasses';
import { useRecipeTextSize } from '../lib/useDeviceSettings';
import { useWakeLock } from '../lib/useWakeLock';
import { useCookState } from '../lib/useCookState';
import type { Locale } from '../i18n';

function TranslateChip({
  mode,
  label,
  onTranslate,
  onOriginal,
}: {
  mode: Exclude<TranslateChipMode, 'hidden'>;
  label: string;
  onTranslate: () => void;
  onOriginal: () => void;
}) {
  const busy = mode === 'loading';
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy ? true : undefined}
      onClick={mode === 'translated' ? onOriginal : onTranslate}
      className={translateChipClass}
    >
      {busy ? (
        <SpinnerIcon className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        <TranslateIcon className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 text-left">{label}</span>
    </button>
  );
}

function GalleryImage({ photoId }: { photoId: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-surface-muted shadow-sm">
      <StoredPhotoImage photoId={photoId} alt="" className="aspect-square w-full object-cover" />
    </div>
  );
}

export default function RecipeView() {
  const t = useT();
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const recipe = useRecipe(id);
  const access = useRecipeAccess(id);
  const sharedByEmail = useRecipeSharedBy(id);
  const collectionId = useRecipeCollectionId(id);
  // Back to the list the recipe was opened from; otherwise the one that files it.
  const location = useLocation();
  const libraryBack = libraryPathFromState(location.state) ?? libraryHref(collectionId);
  useWakeLock();
  const textSize = useRecipeTextSize();

  const {
    servings,
    currentStep,
    checkedKeys,
    setServings,
    setCurrentStep,
    toggleChecked,
    checkedItemNames,
  } = useCookState(recipe);
  const [chatOpen, setChatOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<{
    id: string;
    updatedAt: number;
    phase: 'loading' | 'error';
  } | null>(null);
  const [alreadyNotice, setAlreadyNotice] = useState<{
    id: string;
    updatedAt: number;
    locale: Locale;
  } | null>(null);
  const requestSerial = useRef(0);
  const displayBody = useMemo(
    () => (recipe == null ? recipe : recipeForDisplay(recipe, locale)),
    [recipe, locale, revision],
  );
  const cookLogs = useCookLogs(recipe?.id) ?? [];

  /**
   * A link from the Chrome extension is the first this device hears of a recipe
   * that was saved on the server, so an id missing from the library means "pull
   * and see", not "gone". Settled is tracked as the id it settled for: React
   * Router reuses this element across an id change, and the neutral state has
   * to be the initial one or not-found paints for a frame first.
   */
  const [settledId, setSettledId] = useState<string | undefined>(undefined);
  const lookedUpId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (recipe !== null || id === undefined || lookedUpId.current === id) return;
    lookedUpId.current = id;
    void sync().finally(() => setSettledId(id));
  }, [recipe, id]);

  if (recipe === undefined) {
    return (
      <div className="p-6 text-center text-ink-muted">{t('common.loadingRecipe')}</div>
    );
  }
  if (recipe === null) {
    if (settledId !== id) {
      return (
        <div className="p-6 text-center text-ink-muted">{t('recipe.lookingFor')}</div>
      );
    }
    return (
      <div className="p-6 text-center text-ink-muted">
        {t('common.recipeNotFound')}{' '}
        <Link to="/" className="underline hover:text-ink">
          {t('common.backToLibrary')}
        </Link>
      </div>
    );
  }

  const shared = access === 'viewer' || access === 'editor';
  const canEdit = access !== 'viewer';
  // One catalog sentence per case: joining two with a space breaks Chinese punctuation.
  const sharedBy = shared ? sharedByEmail : undefined;
  const sharedLine = !shared
    ? undefined
    : sharedBy
      ? canEdit
        ? t('recipe.sharedByEdit', { email: sharedBy })
        : t('recipe.sharedByView', { email: sharedBy })
      : canEdit
        ? t('recipe.sharedEdit')
        : t('recipe.sharedView');
  const source = sourceLink(recipe.sourceUrl);
  // A translation must not flow into chat or save, or it would overwrite the original (principle 1).
  const displayRecipe = displayBody ?? recipe;
  const effective = effectiveRecipeLang(recipe);
  const phase =
    pending !== null && pending.id === recipe.id && pending.updatedAt === recipe.updatedAt
      ? pending.phase
      : undefined;
  const mode = translateChipMode({
    effectiveLang: effective,
    uiLang: locale,
    viewingTranslation: displayRecipe !== recipe,
    pending: phase,
  });
  const sourceLanguage =
    effective !== undefined
      ? (languageName(effective, locale) ?? effective)
      : t('langPicker.unknown');
  const showAlready =
    mode === 'hidden' &&
    alreadyNotice !== null &&
    alreadyNotice.id === recipe.id &&
    alreadyNotice.updatedAt === recipe.updatedAt &&
    alreadyNotice.locale === locale;
  const hasTime = recipe.prepMinutes != null || recipe.cookMinutes != null;

  const onTranslate = () => {
    const id = recipe.id;
    const updatedAt = recipe.updatedAt;
    const target = locale;
    const serial = ++requestSerial.current;
    setPending({ id, updatedAt, phase: 'loading' });
    void translateRecipe(recipe, target)
      .then(() => {
        if (serial !== requestSerial.current) return;
        const detected = getDetectedLang(id, updatedAt);
        if (sameLanguage(detected, target) === 'same') {
          showOriginal(id);
          setAlreadyNotice({ id, updatedAt, locale: target });
        }
        setPending((current) =>
          current !== null && current.id === id && current.updatedAt === updatedAt ? null : current,
        );
        setRevision((n) => n + 1);
      })
      .catch(() => {
        if (serial !== requestSerial.current) return;
        setPending({ id, updatedAt, phase: 'error' });
      });
  };

  const onOriginal = () => {
    showOriginal(recipe.id);
    setPending((current) =>
      current !== null && current.id === recipe.id && current.updatedAt === recipe.updatedAt
        ? null
        : current,
    );
    setRevision((n) => n + 1);
  };

  const chipLabel =
    mode === 'labelled'
      ? t('recipe.translateLabelled', { language: sourceLanguage })
      : mode === 'unlabelled'
        ? t('recipe.translate')
        : mode === 'loading'
          ? t('recipe.translating')
          : mode === 'translated'
            ? t('recipe.translatedFrom', { language: sourceLanguage })
            : mode === 'error'
              ? t('recipe.translateRetry')
              : '';

  return (
    <div className={recipePageClass}>
      <header className="py-4">
        <div className="flex items-center justify-between print:hidden">
          <Link to={libraryBack} className={backLink}>
            &larr; {t('common.library')}
          </Link>
          <div className="flex items-center gap-1">
            {/* The stored recipe: a translation is a view and is never shared (i18n principle 1). */}
            <ShareRecipeButton recipe={recipe} />
            {canEdit && (
              <Link to={`/recipe/${recipe.id}/edit`} className={ghostBtn}>
                {t('common.edit')}
              </Link>
            )}
          </div>
        </div>
        {sharedLine !== undefined && (
          <p className="mt-2 rounded-xl bg-surface-muted px-3 py-2 text-sm break-words text-ink-muted print:hidden">
            {sharedLine}
          </p>
        )}
        <StoredPhotoImage
          photoId={recipe.photoId}
          alt=""
          className="mt-3 h-52 w-full rounded-2xl object-cover shadow-sm"
        />
        <h1 className="mt-2 text-2xl font-bold">{displayRecipe.title}</h1>
        {displayRecipe.description && (
          <p className="mt-1 text-ink-muted">{displayRecipe.description}</p>
        )}
        {(hasTime || mode !== 'hidden') && (
          <div className="mt-2 text-sm">
            {hasTime && <RecipeTimes recipe={recipe} />}
            {mode !== 'hidden' && (
              <div className={hasTime ? 'mt-2' : undefined}>
                <TranslateChip
                  mode={mode}
                  label={chipLabel}
                  onTranslate={onTranslate}
                  onOriginal={onOriginal}
                />
              </div>
            )}
          </div>
        )}
        {showAlready && (
          <p
            className="mt-3 rounded-2xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink print:hidden"
            role="status"
          >
            {t('recipe.alreadyInLanguage')}
          </p>
        )}
        <VariantLinks recipeId={recipe.id} />
        <ImportWarningBanner
          recipe={recipe}
          sections={displayRecipe.ingredientSections}
          source={source}
          canEdit={canEdit}
        />
      </header>

      <IngredientsSection
        recipe={recipe}
        displayRecipe={displayRecipe}
        servings={servings}
        onServings={setServings}
        checkedKeys={checkedKeys}
        onToggle={toggleChecked}
        textSize={textSize}
      />

      <StepsSection
        recipe={recipe}
        displayRecipe={displayRecipe}
        currentStep={currentStep}
        onStep={setCurrentStep}
        textSize={textSize}
        afterDone={
          !shared && (
            <Link
              to={`/recipe/${recipe.id}/cooks/new`}
              className={`${secondaryBtn} mt-3 inline-block px-5 py-2`}
            >
              {t('recipe.logThisCook')}
            </Link>
          )
        }
      />

      {displayRecipe.notes && <NotesSection notes={displayRecipe.notes} />}

      {recipe.galleryPhotoIds && recipe.galleryPhotoIds.length > 0 && (
        <GallerySection>
          {recipe.galleryPhotoIds.map((id) => (
            <GalleryImage key={id} photoId={id} />
          ))}
        </GallerySection>
      )}

      {!shared && (
        <section className="mt-6 print:hidden">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {t('recipe.yourCooks')}
              {cookLogs.length > 0 && (
                <span className="ml-2 font-normal text-ink-subtle">{cookLogs.length}</span>
              )}
            </h2>
            <Link to={`/recipe/${recipe.id}/cooks/new`} className={ghostBtn}>
              {t('recipe.logACook')}
            </Link>
          </div>
          {cookLogs.length > 0 && (
            <ul className="mt-2 flex flex-col gap-3">
              {cookLogs.map((log) => (
                <li key={log.id}>
                  <CookLogCard log={log} recipe={recipe} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {source && (
        <SourceCredit source={source} />
      )}

      <button
        type="button"
        onClick={() => setChatOpen(true)}
        className={`${askButtonClass}${chatOpen ? ' invisible' : ''}`}
      >
        {t('recipe.ask')}
      </button>
      {chatOpen && (
        <ChatPanel
          recipe={recipe}
          readOnly={shared}
          allowApply={canEdit}
          cookingState={{
            servings,
            currentStep: currentStep + 1,
            checkedIngredients: checkedItemNames(recipe),
          }}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}
