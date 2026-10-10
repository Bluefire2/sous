import { useMemo, useReducer } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import CreateCollectionSheet from '../components/CreateCollectionSheet';
import { useT } from '../i18n';
import { libraryHref, libraryPathFromState } from '../lib/collectionHref';
import { recipeCounts } from '../lib/collectionMembership';
import { collectionStore, useCollections } from '../lib/collectionStore';
import {
  initialLibraryFlow,
  libraryFlowReducer,
  sheetError,
  submitCollectionCreate,
} from '../lib/libraryFlow';
import { persistScopedLibraryView } from '../lib/librarySearchMemory';
import { SharedIcon } from '../lib/icons';
import { useRecipes } from '../lib/recipeStore';
import { useSession } from '../lib/session';
import { useMountedFlow } from '../lib/useMountedFlow';
import type { Collection } from '../lib/types';
import { backLink } from '../lib/uiClasses';

/**
 * The list of collections. Rows only switch; share, rename, and delete stay
 * on the open collection. See docs/plans/library-collections-region.md.
 */
export default function CollectionsIndex() {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const collections = useCollections();
  const recipes = useRecipes();
  const { status: sessionStatus } = useSession();
  const [flow, dispatch] = useReducer(libraryFlowReducer, initialLibraryFlow);
  const { sheet } = flow;
  const { isCurrent } = useMountedFlow(flow);
  const collectionName = sheet.kind === 'create' ? sheet.name : '';
  const collectionError = sheetError(sheet);
  const sheetSaving = sheet.kind === 'create' && sheet.saving;
  const loaded = collections !== undefined && recipes !== undefined;
  const hasCollections = loaded && collections.length > 0;
  // Signed out with nothing loaded is the sign-in sentence. A library that
  // already has collections still lists them.
  const signedOutEmpty = sessionStatus === 'signedOut' && !hasCollections;
  const counts = useMemo(() => {
    if (collections === undefined || recipes === undefined) return undefined;
    return recipeCounts(recipes, collections);
  }, [recipes, collections]);

  const submitCreate = () => {
    if (sheet.kind !== 'create') return;
    void submitCollectionCreate({
      name: sheet.name,
      created: sheet.created,
      moveRecipeIds: sheet.moveRecipeIds,
      saving: sheet.saving,
      token: flow.token,
      isCurrent,
      dispatch,
      failureMessage: t('error.collectionSave'),
      create: (name) => collectionStore.create(name),
      rename: (id, name) => collectionStore.rename(id, name),
      move: async (recipeIds, collectionId) => {
        await collectionStore.moveRecipes(recipeIds, collectionId);
      },
      onSuccess: (id) => {
        dispatch({ type: 'close' });
        persistScopedLibraryView();
        navigate(libraryHref(id));
      },
    });
  };

  const sharedName = (collection: Collection): string | undefined => {
    if (!collectionStore.isShared(collection.id)) return undefined;
    const email = collectionStore.sharedBy(collection.id);
    return email
      ? t('library.sharedByLabel', { name: collection.name, email })
      : t('library.sharedLabel', { name: collection.name });
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={libraryPathFromState(location.state) ?? '/'} className={backLink}>
          &larr; {t('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('library.collectionsNav')}</h1>
        {loaded && !signedOutEmpty && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'startCreate' })}
            className="mt-3 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.newCollection')}
          </button>
        )}
      </header>

      {signedOutEmpty ? (
        <p className="py-12 text-center text-ink-muted">{t('library.emptySignedOut')}</p>
      ) : !loaded ? (
        <p className="py-12 text-center text-ink-muted">{t('common.loadingCollections')}</p>
      ) : collections.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('library.collectionsEmpty')}</p>
      ) : (
        <ul>
          <li>
            <Link
              to="/"
              onClick={() => persistScopedLibraryView()}
              className="flex items-baseline justify-between gap-3 py-3"
            >
              <span className="min-w-0 truncate font-medium">{t('library.recipes')}</span>
              <span className="shrink-0 text-sm text-ink-muted">
                {t('library.recipeCount', { count: counts?.unfiled ?? 0 })}
              </span>
            </Link>
          </li>
          {collections.map((collection) => {
            const label = sharedName(collection);
            return (
              <li key={collection.id}>
                <Link
                  to={libraryHref(collection.id)}
                  onClick={() => persistScopedLibraryView()}
                  className="flex items-baseline justify-between gap-3 py-3"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                    {label !== undefined && <SharedIcon className="block h-3.5 w-3.5 shrink-0" />}
                    {label === undefined ? (
                      <span className="truncate">{collection.name}</span>
                    ) : (
                      <span className="truncate">
                        <span aria-hidden="true">{collection.name}</span>
                        <span className="sr-only">{label}</span>
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm text-ink-muted">
                    {t('library.recipeCount', {
                      count: counts?.byCollection.get(collection.id) ?? 0,
                    })}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {sheet.kind === 'create' && (
        <CreateCollectionSheet
          name={collectionName}
          saving={sheetSaving}
          error={collectionError}
          onName={(name) => dispatch({ type: 'setName', name })}
          onSubmit={submitCreate}
          onClose={() => dispatch({ type: 'close' })}
        />
      )}
    </div>
  );
}
