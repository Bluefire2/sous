import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLocale, useT } from '../i18n';
import CollectionSection from '../components/CollectionSection';
import CreateCollectionSheet from '../components/CreateCollectionSheet';
import LanguageMenu from '../components/LanguageMenu';
import NoticeToast, { type Notice } from '../components/NoticeToast';
import LibrarySortMenu from '../components/LibrarySortMenu';
import ShareCollectionSheet from '../components/ShareCollectionSheet';
import Sheet from '../components/Sheet';
import { createInvite } from '../lib/adminApi';
import { createMemberInvite } from '../lib/inviteApi';
import { copyStrategy, inviteMintClient, isInviteQuotaError } from '../lib/inviteMint';
import { FolderIcon, InviteIcon, PlusIcon, SettingsIcon, SpinnerIcon } from '../lib/icons';
import {
  importHref,
  libraryHref,
  missingCollectionAction,
  newRecipeHref,
} from '../lib/collectionHref';
import { collectionStore, useCollections, useFullPull } from '../lib/collectionStore';
import {
  recipeIdsAfterMove,
  recipesInCollection,
  unfiledRecipes,
  wouldExceedRecipeIdCap,
} from '../lib/collectionMembership';
import {
  initialLibraryFlow,
  libraryFlowReducer,
  sheetError,
  submitCollectionCreate,
} from '../lib/libraryFlow';
import {
  readPersistedLibraryView,
  writePersistedLibraryView,
} from '../lib/librarySearchMemory';
import { sortLibraryRecipes } from '../lib/librarySort';
import { useLastCookedOn } from '../lib/cookLogStore';
import { lastCookedLabel } from '../lib/relativeTime';
import { isLibrarySearchShortcut } from '../lib/librarySearchShortcut';
import { recipeStore, useRecipes } from '../lib/recipeStore';
import { visibleLibraryRecipes } from '../lib/visibleLibraryRecipes';
import { useSession } from '../lib/session';
import { useMountedFlow } from '../lib/useMountedFlow';
import { useSyncStatus } from '../lib/syncEngine';
import { AssistantEntryLink } from '../agent/index';
import {
  backLink,
  chipClass,
  dangerBtn,
  ghostBtn,
  ghostIconBtn,
  inputClass,
  inputFocus,
  menuItem,
  menuItemDanger,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import { StoredPhotoImage } from '../components/BlobImage';

function CardThumb({ photoId }: { photoId: string }) {
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-surface-muted">
      <StoredPhotoImage photoId={photoId} alt="" className="h-full w-full object-cover" />
    </div>
  );
}

export default function Library() {
  const t = useT();
  const locale = useLocale();
  const allRecipes = useRecipes();
  const lastCookedOn = useLastCookedOn();
  const collections = useCollections();
  const fullPull = useFullPull();
  const { status: sessionStatus, user } = useSession();
  const syncStatus = useSyncStatus();
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const named =
    collectionId && collections
      ? collections.find((c) => c.id === collectionId)
      : undefined;
  const currentId = named?.id;

  // The collection the URL shows now. A save that finishes after the user has
  // moved on must not touch the sheets or the route of the collection they are on.
  const shownCollectionId = useRef(collectionId);
  const [query, setQuery] = useState(() => readPersistedLibraryView().query);
  const [browseAll, setBrowseAll] = useState(
    () => readPersistedLibraryView().browseAll,
  );
  const [sort, setSort] = useState(() => readPersistedLibraryView().sort);
  useEffect(() => {
    writePersistedLibraryView({ query, browseAll, sort });
  }, [query, browseAll, sort]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [flow, dispatch] = useReducer(libraryFlowReducer, initialLibraryFlow);
  const { sheet } = flow;
  // A workflow is current while its sheet is the one open and Library is
  // still mounted: after unmount, a late result must not navigate away from
  // the screen the user went to.
  const { mountedRef, isCurrent } = useMountedFlow(flow);
  // In-flight delete and leave, by collection id. They outlive the sheet,
  // so a missing-collection redirect waits for the request that removed it.
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<Notice | null>(null);
  const [inviteQuota, setInviteQuota] = useState<{ id: number; message: string } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLAnchorElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const scoped =
    allRecipes === undefined || collections === undefined
      ? undefined
      : named
        ? recipesInCollection(allRecipes, named, collections)
        : unfiledRecipes(allRecipes, collections);

  const q = query.trim().toLowerCase();
  const recipes = visibleLibraryRecipes({
    all: allRecipes,
    scoped,
    query,
    browseAll,
  });

  const pendingDelete =
    sheet.kind === 'deleteRecipe'
      ? allRecipes?.find((r) => r.id === sheet.recipeId)
      : undefined;
  const movingIds = sheet.kind === 'move' ? sheet.recipeIds : undefined;
  const moveOne =
    movingIds?.length === 1
      ? allRecipes?.find((recipe) => recipe.id === movingIds[0])
      : undefined;
  const collectionName = sheet.kind === 'create' || sheet.kind === 'rename' ? sheet.name : '';
  const collectionError = sheetError(sheet);
  // While a create, move or rename is saving, its inputs and submit controls
  // are disabled, so one submit runs at a time and what lands is what was sent.
  const sheetSaving =
    (sheet.kind === 'create' || sheet.kind === 'move' || sheet.kind === 'rename') &&
    sheet.saving;
  const setCollectionName = (name: string) => dispatch({ type: 'setName', name });
  const namedIsShared = named ? collectionStore.isShared(named.id) : false;
  const sharedLabels = new Map<string, string>();
  for (const collection of collections ?? []) {
    if (!collectionStore.isShared(collection.id)) continue;
    const email = collectionStore.sharedBy(collection.id);
    sharedLabels.set(
      collection.id,
      email
        ? t('library.sharedByLabel', { name: collection.name, email })
        : t('library.sharedLabel', { name: collection.name }),
    );
  }
  const leaveBusy = leavingId !== null && leavingId === collectionId;
  const showSwitcher = (collections?.length ?? 0) > 0;
  const addCollectionId =
    currentId && !namedIsShared ? currentId : undefined;
  const ownedCollections =
    collections?.filter((collection) => !collectionStore.isShared(collection.id)) ?? [];
  const ownedVisibleIds =
    recipes === undefined || namedIsShared
      ? []
      : recipes
          .filter((recipe) => !recipeStore.isShared(recipe.id))
          .map((recipe) => recipe.id);
  const canSelect = ownedVisibleIds.length > 0;
  // The selection the bar, Move, and the header act on. A search can hide a
  // checked recipe one render before the effect below drops it from
  // selectedIds; counting only what is on screen keeps them in agreement.
  // While the library loads nothing is on screen, so keep the whole set.
  const activeSelectedIds =
    recipes === undefined
      ? [...selectedIds]
      : ownedVisibleIds.filter((id) => selectedIds.has(id));
  const allOwnedSelected =
    canSelect && activeSelectedIds.length === ownedVisibleIds.length;
  const someOwnedSelected = activeSelectedIds.length > 0 && !allOwnedSelected;
  // Undefined while the library is still loading, so a refresh does not
  // clear a selection that has not been shown yet. An empty string means
  // the list is loaded and no owned recipe is on screen.
  const selectionScope =
    recipes === undefined ? undefined : namedIsShared ? '' : ownedVisibleIds.join('\n');

  const beginSelect = () => {
    setMenuId(null);
    setSelecting(true);
  };

  const cancelSelect = () => {
    setMenuId(null);
    setSelecting(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allOwnedSelected ? new Set() : new Set(ownedVisibleIds));
  };

  // indeterminate is DOM-only. A ref callback also sets it on an input that
  // remounts while someOwnedSelected is unchanged, which an effect would miss.
  const selectAllRef = useCallback(
    (input: HTMLInputElement | null) => {
      if (input) input.indeterminate = someOwnedSelected;
    },
    [someOwnedSelected],
  );

  const remove = async (id: string) => {
    dispatch({ type: 'close' });
    setDeleteError(null);
    // The sheet is already closed, so there is no sheet token to check. The
    // error belongs to the collection the delete started on, and only while
    // Library is still showing it.
    const startedOn = shownCollectionId.current;
    try {
      await recipeStore.remove(id);
    } catch (err) {
      if (!mountedRef.current || shownCollectionId.current !== startedOn) return;
      setDeleteError(err instanceof Error ? err.message : t('error.recipeDelete'));
    }
  };

  const closeSheets = () => dispatch({ type: 'close' });

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
        setSelecting(false);
        setSelectedIds(new Set());
        closeSheets();
        setBrowseAll(false);
        navigate(libraryHref(id));
      },
    });
  };

  const submitMove = async (dest: 'default' | string) => {
    if (sheet.kind !== 'move' || sheet.saving) {
      return;
    }
    const { token } = flow;
    dispatch({ type: 'submitting', token });
    try {
      const ids = sheet.recipeIds;
      await collectionStore.moveRecipes(ids, dest);
      if (!isCurrent(token)) return;
      setSelecting(false);
      setSelectedIds(new Set());
      closeSheets();
      if (ids.length <= 1) {
        setBrowseAll(false);
        navigate(dest === 'default' ? '/' : libraryHref(dest));
      }
    } catch (err) {
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionMove'),
      });
    }
  };

  const submitRename = async () => {
    if (sheet.kind !== 'rename' || sheet.saving) {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    try {
      await collectionStore.rename(sheet.collectionId, sheet.name);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionSave'),
      });
    }
  };

  const submitDeleteCollection = async () => {
    if (sheet.kind !== 'deleteCollection') {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    // The collection leaves the list before the server answers. Hold only
    // this id, so Back to a different missing collection is not stuck.
    setDeletingId(sheet.collectionId);
    try {
      await collectionStore.remove(sheet.collectionId);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
      navigate('/');
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.collectionDelete'),
      });
    } finally {
      setDeletingId(null);
    }
  };

  const submitLeave = async () => {
    if (sheet.kind !== 'leave') {
      return;
    }
    const { token } = flow;
    const startedOn = shownCollectionId.current;
    dispatch({ type: 'submitting', token });
    setLeavingId(sheet.collectionId);
    try {
      await collectionStore.leave(sheet.collectionId);
      if (shownCollectionId.current !== startedOn || !isCurrent(token)) return;
      closeSheets();
      navigate('/');
    } catch (err) {
      if (shownCollectionId.current !== startedOn) return;
      dispatch({
        type: 'failed',
        token,
        error: err instanceof Error ? err.message : t('error.leaveCollection'),
      });
    } finally {
      setLeavingId(null);
    }
  };

  const showInviteToast = (kind: 'success' | 'error', message: string) => {
    setInviteNotice((prev) => ({
      id: (prev?.id ?? 0) + 1,
      kind,
      message,
    }));
  };

  const mint = async () => {
    if (user === null || invitePending) {
      return;
    }
    setInvitePending(true);
    const client = inviteMintClient(user);
    const urlPromise =
      client === 'admin'
        ? createInvite().then((created) => created.url)
        : createMemberInvite().then((created) => created.url);
    let writeStarted: Promise<void> | undefined;
    if (
      copyStrategy({ hasClipboardItem: typeof ClipboardItem !== 'undefined' }) ===
      'clipboard-item'
    ) {
      try {
        writeStarted = navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': urlPromise.then((u) => new Blob([u], { type: 'text/plain' })),
          }),
        ]);
        void writeStarted.catch(() => {});
      } catch {
        writeStarted = undefined;
      }
    }
    try {
      const url = await urlPromise;
      if (!mountedRef.current) {
        return;
      }
      setInviteQuota(null);
      let copied = false;
      if (writeStarted !== undefined) {
        try {
          await writeStarted;
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!mountedRef.current) {
        return;
      }
      dispatch({ type: 'closeInviteConfirm' });
      if (copied) {
        setRevealedUrl(null);
        setInviteCopied(false);
        showInviteToast('success', t('library.inviteCopied'));
      } else {
        setRevealedUrl(url);
        setInviteCopied(false);
        showInviteToast('error', t('library.inviteCopyFailed'));
      }
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : t('common.somethingWentWrong');
      dispatch({ type: 'closeInviteConfirm' });
      if (isInviteQuotaError(err)) {
        setInviteQuota((prev) => ({ id: (prev?.id ?? 0) + 1, message }));
        return;
      }
      setInviteQuota(null);
      showInviteToast('error', message);
    } finally {
      if (mountedRef.current) {
        setInvitePending(false);
      }
    }
  };

  const copyRevealedUrl = async () => {
    if (revealedUrl === null) {
      return;
    }
    const url = revealedUrl;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setInviteCopied(false);
      return;
    }
    if (!mountedRef.current) {
      return;
    }
    setRevealedUrl(null);
    setInviteCopied(true);
    showInviteToast('success', t('library.inviteCopied'));
  };

  // Library stays mounted across collection routes, so per-collection state
  // (open sheets, the typed name, scope) must not leak into the next one.
  useLayoutEffect(() => {
    if (shownCollectionId.current === collectionId) return;
    shownCollectionId.current = collectionId;
    setBrowseAll(false);
    setMenuId(null);
    setDeleteError(null);
    setSelecting(false);
    setSelectedIds(new Set());
    closeSheets();
  }, [collectionId]);

  // A loaded library that no longer contains this id is not that collection.
  // Redirect only when the snapshot on screen is a full pull. An owned-only
  // publish, a sign-out, and a pull that has not finished are not that.
  // Delete and leave hold only their own id. Sheet reset closes rename,
  // delete, leave, and share; Create and Move are not collection sheets, so
  // their name and error stay.
  useLayoutEffect(() => {
    const action = missingCollectionAction({
      collectionId,
      collectionIds: collections?.map((collection) => collection.id),
      snapshotConfirmed: fullPull,
      hold: deletingId === collectionId || leavingId === collectionId,
    });
    const collectionSheetOpen =
      sheet.kind === 'rename' ||
      sheet.kind === 'deleteCollection' ||
      sheet.kind === 'leave' ||
      sheet.kind === 'share';
    // A failed leave or delete sets its error in the same turn the hold
    // ends. Closing here would drop that message.
    const showingFailure =
      (sheet.kind === 'leave' || sheet.kind === 'deleteCollection') &&
      sheet.error !== undefined;
    if (action.resetCollectionSheets && collectionSheetOpen && !showingFailure) {
      closeSheets();
    }
    if (action.redirectHome) {
      navigate('/', { replace: true });
    }
  }, [collectionId, collections, fullPull, deletingId, leavingId, sheet, navigate]);

  useEffect(() => {
    if (!menuId) return;
    firstActionRef.current?.focus({ preventScroll: true });
  }, [menuId]);

  // A search or All collections change hides recipes. Drop checks for ids
  // that are no longer on screen; changing collection clears the set itself.
  useEffect(() => {
    if (selectionScope === undefined) {
      return;
    }
    const visible = new Set(selectionScope === '' ? [] : selectionScope.split('\n'));
    setSelectedIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectionScope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // `/` jumps to the search. Not while a recipe menu or sheet is open,
      // nor while a disclosure menu (language, collection actions) is: those
      // keep their open state in their own hook, and their trigger says so.
      const overlayOpen =
        menuId !== null ||
        sheet.kind !== 'closed' ||
        document.querySelector('[aria-expanded="true"]') !== null;
      if (isLibrarySearchShortcut(event, overlayOpen)) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key !== 'Escape') return;
      if (menuId !== null) {
        event.preventDefault();
        setMenuId(null);
        menuTriggerRef.current?.focus();
        return;
      }
      if (selecting && sheet.kind === 'closed') {
        event.preventDefault();
        setMenuId(null);
        setSelecting(false);
        setSelectedIds(new Set());
        return;
      }
      // A rendered Sheet takes Escape first (capture phase) and stops it, so
      // this only clears a sheet state that rendered nothing, such as a
      // delete confirmation whose recipe vanished in a refresh.
      if (sheet.kind !== 'closed' && sheet.kind !== 'share') {
        event.preventDefault();
        closeSheets();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuId, selecting, sheet.kind]);

  const emptyCopy = () => {
    if (q !== '') {
      return t('library.emptySearch');
    }
    if (sessionStatus === 'signedOut') {
      return t('library.emptySignedOut');
    }
    if (syncStatus.status === 'error') {
      return t('library.emptyError');
    }
    if (named) {
      return t('library.emptyCollection');
    }
    return t('library.empty');
  };

  const selectControl =
    canSelect && !selecting ? (
      <button
        type="button"
        onClick={beginSelect}
        className={`${chipClass(false)} shrink-0`}
      >
        {t('library.select')}
      </button>
    ) : null;

  // Ordering one recipe means nothing, and an empty library has no list.
  const sortControl =
    (allRecipes?.length ?? 0) > 1 ? <LibrarySortMenu sort={sort} onChange={setSort} /> : null;

  return (
    <div className={`mx-auto max-w-xl px-4 ${selecting ? 'pb-40' : 'pb-24'}`}>
      <NoticeToast notice={inviteNotice} />
      <header className="flex items-center justify-between py-4">
        <h1 className="text-2xl font-bold">Sous</h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-y-1">
          <AssistantEntryLink />
          {user !== null && (
            <button
              type="button"
              className={`${ghostIconBtn} disabled:opacity-40`}
              aria-label={invitePending ? t('admin.creating') : t('library.inviteLink')}
              aria-busy={invitePending}
              disabled={invitePending || sheet.kind === 'inviteConfirm'}
              onClick={() => {
                if (inviteMintClient(user) === 'member') {
                  dispatch({ type: 'openInviteConfirm' });
                  return;
                }
                void mint();
              }}
            >
              {invitePending ? (
                <SpinnerIcon className="block h-5 w-5 animate-spin" />
              ) : (
                <InviteIcon className="block h-5 w-5" />
              )}
            </button>
          )}
          <Link to="/cooks" className={ghostBtn}>
            {t('library.cooks')}
          </Link>
          <Link
            to="/settings"
            className={ghostIconBtn}
            aria-label={t('settings.title')}
          >
            <SettingsIcon className="block h-5 w-5" />
          </Link>
          <LanguageMenu />
        </div>
      </header>

      {inviteQuota !== null && (
        <p key={inviteQuota.id} className="mb-3 text-sm text-danger" role="alert">
          {inviteQuota.message}
        </p>
      )}

      {revealedUrl !== null && (
        <div className="mb-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <label className="text-xs text-ink-muted" htmlFor="library-invite-url">
            {t('admin.newInviteLink')}
          </label>
          <input
            id="library-invite-url"
            className={`${inputClass} mt-1 font-mono text-sm`}
            readOnly
            value={revealedUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => void copyRevealedUrl()}
            className={`${secondaryBtn} mt-2 px-3 py-1.5 text-sm`}
          >
            {inviteCopied ? t('admin.copied') : t('admin.copy')}
          </button>
        </div>
      )}

      {collections !== undefined && collections.length === 0 && sessionStatus === 'signedIn' && (
        // Nothing shared by you or with you yet: say where sharing starts.
        <div className="mb-3 flex items-start gap-1.5">
          <FolderIcon className="mt-1.5 block h-5 w-5 shrink-0 text-ink-muted" />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
            <span>{t('library.collectionsEmpty')}</span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'startCreate' })}
              className="rounded-full px-3 py-1.5 text-sm text-ink-muted underline hover:text-ink"
            >
              {t('common.newCollection')}
            </button>
          </div>
        </div>
      )}

      {showSwitcher && collections !== undefined && (
        <CollectionSection
          collections={collections}
          sharedLabels={sharedLabels}
          currentId={currentId}
          browseAll={browseAll}
          ownedName={named && !namedIsShared ? named.name : undefined}
          onCreate={() => dispatch({ type: 'startCreate' })}
          onShare={() => dispatch({ type: 'openShare' })}
          onRename={() =>
            named && dispatch({ type: 'openRename', collectionId: named.id, name: named.name })
          }
          onDelete={() => named && dispatch({ type: 'openDeleteCollection', collectionId: named.id })}
          onOpenList={() => setBrowseAll(false)}
        />
      )}

      {named && namedIsShared && !browseAll && (
        <div className="-mt-1 mb-3 flex items-center justify-between gap-2 text-sm text-ink-muted">
          <span className="min-w-0 break-words">
            {/* One catalog sentence per case: joining two with a space breaks Chinese punctuation. */}
            {(() => {
              const email = collectionStore.sharedBy(named.id);
              const editor = collectionStore.access(named.id) === 'editor';
              if (email) {
                return editor
                  ? t('library.sharedBannerByEdit', { email })
                  : t('library.sharedBannerByView', { email });
              }
              return editor ? t('library.sharedBannerEdit') : t('library.sharedBannerView');
            })()}
          </span>
          <button
            type="button"
            onClick={() =>
              dispatch({ type: 'openLeave', collectionId: named.id, name: named.name })
            }
            className="-my-1.5 -mr-2 shrink-0 rounded-full px-3 py-2 text-sm text-danger hover:bg-danger-bg active:bg-danger-bg"
          >
            {t('library.leave')}
          </button>
        </div>
      )}

      {/* The search keeps at least 14rem so its placeholder isn't clipped;
          narrower than that, the buttons wrap under it. */}
      {showSwitcher ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            ref={searchRef}
            type="search"
            placeholder={
              browseAll
                ? t('library.searchAll')
                : named
                  ? t('library.searchIn', { name: named.name })
                  : t('library.search')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} min-w-0 flex-1 basis-56 text-ellipsis`}
          />
          {/* Sort comes last, so its menu, aligned to its right edge, opens
              inside the page on a phone; the chips wrap rather than overflow. */}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {selectControl}
            <button
              type="button"
              onClick={() => setBrowseAll((on) => !on)}
              className={`${chipClass(browseAll)} shrink-0`}
            >
              {t('library.allCollections')}
            </button>
            {sortControl}
          </div>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            ref={searchRef}
            type="search"
            placeholder={t('library.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} min-w-0 flex-1 basis-56 text-ellipsis`}
          />
          {(sortControl || selectControl) && (
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
              {selectControl}
              {sortControl}
            </div>
          )}
        </div>
      )}

      {deleteError && (
        <p className="mb-3 text-sm text-danger">{deleteError}</p>
      )}

      {recipes === undefined ? (
        <p className="py-12 text-center text-ink-muted">{t('library.loadingRecipes')}</p>
      ) : recipes.length === 0 ? (
        <p className="py-12 text-center text-ink-muted">{emptyCopy()}</p>
      ) : (
        <>
          {selecting && canSelect && (
            <label className="mb-1 flex cursor-pointer items-center gap-1">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allOwnedSelected}
                  onChange={toggleSelectAll}
                  className={`h-5 w-5 accent-ink ${inputFocus}`}
                />
              </span>
              <span className="text-sm font-medium">{t('library.selectAll')}</span>
            </label>
          )}
          <ul className="flex flex-col gap-3">
            {sortLibraryRecipes(recipes, sort, { lastCooked: lastCookedOn, locale }).map((recipe) => {
              const shared = recipeStore.isShared(recipe.id);
              const checked = selectedIds.has(recipe.id);
              const cookedOn = shared ? undefined : lastCookedOn.get(recipe.id);
              const cooked = cookedOn === undefined ? undefined : lastCookedLabel(cookedOn, Date.now(), locale);
              return (
                <li key={recipe.id} className="flex items-start gap-1">
                  {selecting && !shared && (
                    <label className="mt-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={t('library.selectRecipe', { title: recipe.title })}
                        onChange={() => toggleSelected(recipe.id)}
                        className={`h-5 w-5 accent-ink ${inputFocus}`}
                      />
                    </label>
                  )}
                  <div className="relative min-w-0 flex-1">
                {/* The card is not one link: its tag chips are buttons, and a
                    button inside an anchor is invalid. The title link's ::after
                    covers the card, so a tap anywhere else still opens the
                    recipe; the chips sit above it. */}
                <div className="relative flex gap-3 rounded-2xl border border-line bg-surface p-4 pr-14 shadow-sm hover:border-line-strong hover:bg-surface-muted active:bg-surface-muted">
                  {recipe.photoId !== undefined && (
                    <CardThumb photoId={recipe.photoId} />
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold">
                      <Link
                        to={`/recipe/${recipe.id}`}
                        state={{ from: libraryHref(collectionId) }}
                        className="after:absolute after:inset-0 after:rounded-2xl"
                      >
                        {recipe.title}
                      </Link>
                    </h2>
                    {recipe.description && (
                      <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                        {recipe.description}
                      </p>
                    )}
                    {cooked !== undefined && (
                      <p className="mt-1 text-xs text-ink-subtle">{cooked}</p>
                    )}
                    {recipe.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {recipe.tags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            aria-label={t('library.filterByTag', { tag })}
                            onClick={() => setQuery(tag)}
                            className="relative rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted hover:bg-line hover:text-ink active:bg-line"
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {!shared && !selecting && (
                <button
                  type="button"
                  aria-label={t('library.actionsFor', { title: recipe.title })}
                  aria-expanded={menuId === recipe.id}
                  onClick={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                    setMenuId(menuId === recipe.id ? null : recipe.id);
                  }}
                  className="absolute top-2 right-2 flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-ink-subtle hover:bg-surface-muted active:bg-surface-muted"
                >
                  ⋯
                </button>
                )}

                {menuId === recipe.id && !shared && !selecting && (
                  <div
                    role="group"
                    aria-label={t('library.actionsFor', { title: recipe.title })}
                    className="absolute top-13 right-3 z-20 w-40 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
                  >
                    <Link
                      to={`/recipe/${recipe.id}/edit`}
                      ref={firstActionRef}
                      className={menuItem}
                    >
                      {t('common.edit')}
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuId(null);
                        dispatch({ type: 'openMove', recipeIds: [recipe.id] });
                      }}
                      className={`${menuItem} border-t border-line`}
                    >
                      {t('library.moveTo')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuId(null);
                        dispatch({ type: 'openDeleteRecipe', recipeId: recipe.id });
                      }}
                      className={`${menuItemDanger} border-t border-line`}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {sessionStatus === 'signedIn' && recipes !== undefined && !selecting && (
        // Quiet on purpose: after the last card, centered so the + button never covers it.
        <p className="mt-6 text-center text-sm text-ink-subtle">
          {t('library.suggestPrompt')}{' '}
          <Link
            to="/suggest"
            state={{ from: 'library' }}
            className={`${backLink} inline-block py-3 underline underline-offset-2`}
          >
            {t('library.suggestLink')}
          </Link>
        </p>
      )}

      {menuId !== null && !selecting && (
        <button
          type="button"
          aria-label={t('library.closeMenu')}
          tabIndex={-1}
          onClick={() => setMenuId(null)}
          className="fixed inset-0 z-10"
        />
      )}

      {selecting && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-page px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-xl flex-col gap-2">
            <p className="text-sm font-medium">
              {t('library.selectedCount', { count: activeSelectedIds.length })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleSelectAll}
                disabled={!canSelect}
                className={`${ghostBtn} disabled:opacity-40`}
              >
                {allOwnedSelected ? t('library.selectNone') : t('library.selectAll')}
              </button>
              <button
                type="button"
                disabled={activeSelectedIds.length === 0}
                onClick={() => {
                  setMenuId(null);
                  dispatch({ type: 'openMove', recipeIds: activeSelectedIds });
                }}
                className={`${primaryBtn} px-4 py-2 text-sm disabled:opacity-40`}
              >
                {t('library.moveSelected')}
              </button>
              <button type="button" onClick={cancelSelect} className={ghostBtn}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {sessionStatus === 'signedIn' && !namedIsShared && !selecting && (
        <button
          type="button"
          aria-label={t('library.addRecipe')}
          onClick={() => dispatch({ type: 'openAdd' })}
          className="fixed right-5 bottom-8 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-page shadow-lg hover:opacity-90 active:opacity-90"
        >
          <PlusIcon className="block h-8 w-8" />
        </button>
      )}

      {sheet.kind === 'add' && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.addRecipeTitle')}</h2>
          <Link
            to={importHref(addCollectionId)}
            className={`${primaryBtn} mt-3 block py-3 text-center`}
          >
            {t('library.importFromLink')}
          </Link>
          <Link
            to={importHref(addCollectionId, 'create')}
            className={`${secondaryBtn} mt-2 block py-3 text-center`}
          >
            {t('library.generateFromIdea')}
          </Link>
          <Link
            to={newRecipeHref(addCollectionId)}
            className={`${secondaryBtn} mt-2 block py-3 text-center`}
          >
            {t('library.writeFromScratch')}
          </Link>
          <button
            type="button"
            onClick={() => closeSheets()}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {pendingDelete && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">
            {t('library.deleteRecipeTitle', { title: pendingDelete.title })}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('library.deleteRecipeBody')}
          </p>
          <button
            type="button"
            onClick={() => void remove(pendingDelete.id)}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {t('common.delete')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {movingIds !== undefined && (movingIds.length > 1 || moveOne !== undefined) && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">
            {movingIds.length === 1 && moveOne
              ? t('library.moveTitle', { title: moveOne.title })
              : t('library.moveManyTitle', { count: movingIds.length })}
          </h2>
          <button
            type="button"
            disabled={sheetSaving}
            onClick={() => void submitMove('default')}
            className={`${secondaryBtn} mt-3 w-full py-3 disabled:opacity-40`}
          >
            {t('library.recipes')}
          </button>
          {ownedCollections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              disabled={sheetSaving}
              onClick={() => void submitMove(collection.id)}
              className={`${secondaryBtn} mt-2 w-full py-3 disabled:opacity-40`}
            >
              {collection.name}
            </button>
          ))}
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            disabled={sheetSaving}
            onClick={() => {
              if (
                movingIds !== undefined &&
                wouldExceedRecipeIdCap(recipeIdsAfterMove([], movingIds))
              ) {
                dispatch({
                  type: 'failed',
                  token: flow.token,
                  error: t('error.collectionFull'),
                });
                return;
              }
              dispatch({ type: 'startCreate' });
            }}
            className={`${primaryBtn} mt-2 w-full py-3`}
          >
            {t('common.newCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className="mt-2 w-full py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {sheet.kind === 'create' && (
        <CreateCollectionSheet
          name={collectionName}
          saving={sheetSaving}
          error={collectionError}
          onName={setCollectionName}
          onSubmit={submitCreate}
          onClose={closeSheets}
        />
      )}

      {sheet.kind === 'rename' && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.renameCollection')}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <input
              autoFocus
              value={collectionName}
              disabled={sheetSaving}
              onChange={(e) => setCollectionName(e.target.value)}
              className={`${inputClass} mt-3 disabled:opacity-60`}
            />
            {collectionError && (
              <p className="mt-2 text-sm text-danger">{collectionError}</p>
            )}
            <button
              type="submit"
              disabled={sheetSaving}
              className={`${primaryBtn} mt-3 w-full py-3`}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => closeSheets()}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              {t('common.cancel')}
            </button>
          </form>
        </Sheet>
      )}

      {sheet.kind === 'deleteCollection' && named && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">{t('library.deleteCollectionTitle', { name: named.name })}</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('library.deleteCollectionBody')}
          </p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitDeleteCollection()}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {t('library.deleteCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {sheet.kind === 'leave' && (named && namedIsShared ? named.name : sheet.name) && (
        <Sheet onClose={() => closeSheets()}>
          <h2 className="text-lg font-semibold">
            {t('library.leaveTitle', {
              name: named && namedIsShared ? named.name : sheet.name,
            })}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">{t('library.leaveBody')}</p>
          {collectionError && (
            <p className="mt-2 text-sm text-danger">{collectionError}</p>
          )}
          <button
            type="button"
            onClick={() => void submitLeave()}
            disabled={leaveBusy}
            className={`${dangerBtn} mt-3 w-full py-3`}
          >
            {leaveBusy ? t('library.leaving') : t('library.leaveCollection')}
          </button>
          <button
            type="button"
            onClick={() => closeSheets()}
            className={`${secondaryBtn} mt-2 w-full py-3`}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {sheet.kind === 'share' && named && !namedIsShared && (
        <ShareCollectionSheet
          collection={named}
          onClose={() => closeSheets()}
        />
      )}

      {sheet.kind === 'inviteConfirm' && user !== null && inviteMintClient(user) === 'member' && (
        <Sheet
          dismissible={!invitePending}
          onClose={() => {
            if (!invitePending) closeSheets();
          }}
        >
          <h2 className="text-lg font-semibold">{t('settings.inviteTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('settings.inviteIntro')}</p>
          <button
            type="button"
            disabled={invitePending}
            className={`${primaryBtn} mt-3 w-full py-3`}
            onClick={() => {
              void mint();
            }}
          >
            {invitePending ? t('admin.creating') : t('admin.createLink')}
          </button>
          <button
            type="button"
            disabled={invitePending}
            className={`${secondaryBtn} mt-2 w-full py-3`}
            onClick={() => {
              if (!invitePending) dispatch({ type: 'closeInviteConfirm' });
            }}
          >
            {t('common.cancel')}
          </button>
        </Sheet>
      )}
    </div>
  );
}
