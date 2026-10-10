import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { resolveCollectionDestination } from '../lib/collectionDestination';
import { useCollections } from '../lib/collectionStore';
import { reconcileImportCheck, type ImportCheck } from '../lib/importCheck';
import { photoStore } from '../lib/photoStore';
import { recipePhotoIds, remapPhotoIds } from '../lib/recipePhotos';
import { CreateRollbackError, recipeStore } from '../lib/recipeStore';
import { SpinnerIcon } from '../lib/icons';
import type { Recipe, RecipeDraft } from '../lib/types';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';
import RecipeForm from './RecipeForm';
import SaveToCollectionSheet from './SaveToCollectionSheet';

function replaceLang(draft: RecipeDraft, lang: string | undefined): RecipeDraft {
  if (lang !== undefined) {
    return { ...draft, lang };
  }
  if (draft.lang === undefined) {
    return draft;
  }
  const next = { ...draft };
  delete next.lang;
  return next;
}

export type CreateRecipeSubmitStatus = {
  /** Same disabled condition as the form's own Save button. */
  locked: boolean;
  /** A write is in flight and the collection sheet is not already showing it. */
  saving: boolean;
  /**
   * A submitted draft is waiting on a save, a retry, or the collection sheet.
   * A destination changed now would be used by Try again.
   */
  pending: boolean;
};

/** Owns a staged creation draft until saved or explicitly abandoned. */
export default function CreateRecipeForm({
  initial,
  collectionId,
  destinationId,
  onCreated,
  onCancel,
  formId,
  onSubmitStatusChange,
  formKey,
  resolveLang,
  onEditStateChange,
  submitLocked,
  hideLanguage,
  importCheck,
}: {
  initial: RecipeDraft;
  collectionId?: string;
  /**
   * Explicit destination. `null` is unfiled. `undefined` follows `collectionId`.
   */
  destinationId?: string | null;
  onCreated: (recipe: Recipe) => void;
  onCancel: () => void;
  /** Lets a Save button outside this form submit it (the import header). */
  formId?: string;
  /** Header Save state. Pass a stable callback; this runs in a layout effect. */
  onSubmitStatusChange?: (status: CreateRecipeSubmitStatus) => void;
  /** Remounts the form. RecipeForm copies `initial` into state once. */
  formKey?: string;
  /** Replaces `lang` on the draft at save. `undefined` omits it. */
  resolveLang?: () => string | undefined;
  onEditStateChange?: (state: { dirty: boolean; photosPicked: boolean }) => void;
  /** Disables Save without disabling the rest of the form. */
  submitLocked?: boolean;
  /** Hides RecipeForm's language field. Import preview sets `lang` at save. */
  hideLanguage?: boolean;
  /**
   * The import check for a draft from the import preview. Saved on the
   * recipe, reconciled with any edits made to `initial` before saving.
   */
  importCheck?: ImportCheck;
}) {
  const t = useT();
  const collections = useCollections();
  const destination = resolveCollectionDestination(collections, collectionId, destinationId);
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSubmit, setCanSubmit] = useState(true);
  const inFlight = useRef(false);
  const stagedPhotoIds = useRef<string[]>([]);
  const failureRef = useRef<HTMLDivElement>(null);

  const discardPhotos = () => {
    for (const id of stagedPhotoIds.current) {
      // A failed save may already have uploaded some photos. Only discard
      // bytes that are still local; never remove an existing photo's metadata.
      if (!photoStore.isRemote(id)) photoStore.discardLocal(id);
    }
    stagedPhotoIds.current = [];
  };
  useEffect(() => () => {
    if (!inFlight.current) discardPhotos();
  }, []);
  useEffect(() => {
    if (draft && destination.kind === 'choose' && !busy) setChoosing(true);
  }, [draft, destination.kind, busy]);
  const headerLocked =
    destination.kind === 'loading' || draft !== null || !canSubmit || submitLocked === true;
  const saving = busy && !choosing;
  const pending = draft !== null;
  useLayoutEffect(() => {
    onSubmitStatusChange?.({ locked: headerLocked, saving, pending });
  }, [headerLocked, saving, pending, onSubmitStatusChange]);
  useEffect(() => {
    if (error) failureRef.current?.scrollIntoView({ block: 'center' });
  }, [error]);

  const cancelDraft = () => {
    if (inFlight.current) return;
    discardPhotos();
    setDraft(null);
    setChoosing(false);
    setError(null);
  };

  const save = async (pending: RecipeDraft, id: string | undefined) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const recipe = await recipeStore.create(pending, id ? { collectionId: id } : undefined);
      stagedPhotoIds.current = [];
      setDraft(null);
      onCreated(recipe);
    } catch (err) {
      // The failed recipe may still be on the server under the old photo ids;
      // Try again must submit the ids the bytes were moved to.
      if (err instanceof CreateRollbackError && err.photoIdRemap.size > 0) {
        const remap = err.photoIdRemap;
        stagedPhotoIds.current = stagedPhotoIds.current.map((photoId) => remap.get(photoId) ?? photoId);
        setDraft(remapPhotoIds(pending, remap));
      }
      throw err;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const saveDirect = async (pending: RecipeDraft) => {
    if (destination.kind !== 'save') return;
    try {
      await save(pending, destination.collectionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.recipeSave'));
    }
  };

  return (
    <>
      <fieldset disabled={destination.kind === 'loading' || draft !== null} className="min-w-0">
        <RecipeForm
          key={formKey}
          initial={initial}
          formId={formId}
          onCanSubmitChange={setCanSubmit}
          onEditStateChange={onEditStateChange}
          submitLocked={submitLocked}
          hideLanguage={hideLanguage}
          submitLabel={t('recipeEdit.saveToLibrary')}
          onCancel={onCancel}
          onSubmit={async (pending) => {
            const withLang = resolveLang ? replaceLang(pending, resolveLang()) : pending;
            const next =
              importCheck === undefined
                ? withLang
                : {
                    ...withLang,
                    importCheck: reconcileImportCheck(importCheck, initial, withLang, Date.now()),
                  };
            const existingPhotos = new Set(recipePhotoIds(initial));
            stagedPhotoIds.current = recipePhotoIds(next).filter((id) => !existingPhotos.has(id));
            setDraft(next);
            await saveDirect(next);
          }}
        />
      </fieldset>
      {destination.kind === 'loading' && <p role="status">{t('common.loadingCollections')}</p>}
      {busy && !choosing && (
        <p role="status" className="flex items-center gap-2">
          <SpinnerIcon className="h-5 w-5 animate-spin" /> {t('common.saving')}
        </p>
      )}
      {draft && choosing && (
        <SaveToCollectionSheet onSave={(id) => save(draft, id)} onCancel={cancelDraft} />
      )}
      {draft && error && !choosing && destination.kind === 'save' && (
        <div ref={failureRef}>
          <p role="alert" className="mt-2 text-sm text-danger">{error}</p>
          <button type="button" disabled={busy} onClick={() => void saveDirect(draft)} className={`${primaryBtn} mt-2 px-4 py-2`}>
            {t('common.tryAgain')}
          </button>
          <button type="button" disabled={busy} onClick={cancelDraft} className={`${secondaryBtn} mt-2 ml-2 px-4 py-2`}>
            {t('common.backToRecipe')}
          </button>
        </div>
      )}
    </>
  );
}
