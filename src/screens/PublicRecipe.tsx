import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { languageName, useLocale, useT } from '../i18n';
import {
  AiLockedSheet,
  LockedAiButton,
  lockedAskBtn,
  lockedChipBtn,
  PublicSignInLink,
} from '../components/LockedAi';
import {
  CoverPhoto,
  GalleryFrame,
  GallerySection,
  IngredientsSection,
  NotesSection,
  recipePageClass,
  RecipeTimes,
  SourceCredit,
  sourceLink,
  StepsSection,
} from '../components/RecipeBody';
import { TranslateIcon } from '../lib/icons';
import { publicPhotoUrl } from '../lib/publicApi';
import { useSession } from '../lib/session';
import { translateChipMode } from '../lib/translateChip';
import type { Recipe } from '../lib/types';
import { backLink, ghostBtn, secondaryBtn } from '../lib/uiClasses';
import { usePublicCollection } from '../lib/usePublicCollection';
import { usePublicJoin } from '../lib/usePublicJoin';
import { useWakeLock } from '../lib/useWakeLock';

/**
 * `/p/<token>/r/<recipeId>`: one recipe of a public collection. Cook mode
 * (servings, ticks, current step) lives only in this screen's state; a
 * visitor has no cook row to save it to. Ask and translate are locked.
 */
export default function PublicRecipe() {
  const t = useT();
  const { token = '', recipeId = '' } = useParams<{ token: string; recipeId: string }>();
  const { status } = useSession();
  const member = status === 'signedIn';
  const { result, retry } = usePublicCollection(token);
  const join = usePublicJoin(token);
  const [lockedOpen, setLockedOpen] = useState(false);
  useWakeLock();

  const collectionHref = `/p/${encodeURIComponent(token)}`;
  const recipe =
    result?.kind === 'ok' ? result.data.recipes.find((r) => r.id === recipeId) : undefined;

  const topBar = (
    <div className="flex items-center justify-between">
      <Link to={collectionHref} className={backLink}>
        &larr; {result?.kind === 'ok' ? result.data.collection.name : t('public.backToCollection')}
      </Link>
      {!member && (
        <PublicSignInLink token={token} className={ghostBtn}>
          {t('public.signIn')}
        </PublicSignInLink>
      )}
    </div>
  );

  let content;
  if (result === undefined) {
    content = <p className="p-6 text-center text-ink-muted">{t('common.loadingRecipe')}</p>;
  } else if (result.kind === 'missing' || join.state.kind === 'missing') {
    content = <p className="p-6 text-center text-ink-muted">{t('public.missing')}</p>;
  } else if (result.kind === 'error') {
    content = (
      <div className="p-6 text-center text-ink-muted">
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
  } else if (recipe === undefined) {
    content = (
      <p className="p-6 text-center text-ink-muted">
        {t('public.recipeMissing')}{' '}
        <Link to={collectionHref} className="underline hover:text-ink">
          {t('public.backToCollection')}
        </Link>
      </p>
    );
  } else {
    content = (
      <PublicRecipeBody
        // A fresh cook mode for each recipe.
        key={recipe.id}
        token={token}
        recipe={recipe}
        member={member}
        onLocked={() => setLockedOpen(true)}
      />
    );
  }

  return (
    <div className={recipePageClass}>
      <header className="pt-4 print:hidden">{topBar}</header>
      {content}
      {lockedOpen && (
        <AiLockedSheet
          token={token}
          member={member}
          join={join}
          onClose={() => setLockedOpen(false)}
        />
      )}
    </div>
  );
}

function PublicRecipeBody({
  token,
  recipe,
  member,
  onLocked,
}: {
  token: string;
  recipe: Recipe;
  member: boolean;
  onLocked: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [servings, setServings] = useState(recipe.servings);
  const [currentStep, setCurrentStep] = useState(0);
  const [checkedKeys, setCheckedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleChecked = (key: string) => {
    setCheckedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const hint = member ? t('public.aiLockedMember') : t('public.aiLocked');
  const source = sourceLink(recipe.sourceUrl);
  const hasTime = recipe.prepMinutes != null || recipe.cookMinutes != null;
  // The stored label only: a visitor has no language detection to fall back on.
  const mode = translateChipMode({ effectiveLang: recipe.lang, uiLang: locale });
  const chipLabel =
    mode === 'labelled' && recipe.lang !== undefined
      ? t('recipe.translateLabelled', {
          language: languageName(recipe.lang, locale) ?? recipe.lang,
        })
      : t('recipe.translate');

  return (
    <>
      <CoverPhoto
        url={recipe.photoId ? publicPhotoUrl(token, recipe.id, recipe.photoId) : undefined}
      />
      <h1 className="mt-2 text-2xl font-bold">{recipe.title}</h1>
      {recipe.description && <p className="mt-1 text-ink-muted">{recipe.description}</p>}
      {(hasTime || mode !== 'hidden') && (
        <div className="mt-2 text-sm">
          {hasTime && <RecipeTimes recipe={recipe} />}
          {mode !== 'hidden' && (
            <div className={hasTime ? 'mt-2 print:hidden' : 'print:hidden'}>
              <LockedAiButton
                hint={hint}
                onOpen={onLocked}
                className={lockedChipBtn}
                placement="below-start"
              >
                <TranslateIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 text-left">{chipLabel}</span>
              </LockedAiButton>
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <IngredientsSection
          recipe={recipe}
          displayRecipe={recipe}
          servings={servings}
          onServings={setServings}
          checkedKeys={checkedKeys}
          onToggle={toggleChecked}
        />
      </div>

      <StepsSection
        recipe={recipe}
        displayRecipe={recipe}
        currentStep={currentStep}
        onStep={setCurrentStep}
      />

      {recipe.notes && <NotesSection notes={recipe.notes} />}

      {recipe.galleryPhotoIds && recipe.galleryPhotoIds.length > 0 && (
        <GallerySection>
          {recipe.galleryPhotoIds.map((id) => (
            <GalleryFrame key={id} url={publicPhotoUrl(token, recipe.id, id)} />
          ))}
        </GallerySection>
      )}

      {source && <SourceCredit source={source} />}

      <LockedAiButton
        hint={hint}
        onOpen={onLocked}
        className={lockedAskBtn}
        wrapperClassName="fixed right-5 bottom-8 z-10 print:hidden"
        placement="above-end"
      >
        {t('recipe.ask')}
      </LockedAiButton>
    </>
  );
}
