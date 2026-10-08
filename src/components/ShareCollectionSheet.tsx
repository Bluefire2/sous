import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '../i18n';
import PublicLinkPane from './PublicLinkPane';
import Sheet from './Sheet';
import {
  collectionStore,
  visibleMintedUrl,
  type MintedLink,
} from '../lib/collectionStore';
import { relativeExpiryLabel } from '../lib/relativeTime';
import type { CollectionGrant, CollectionLink, GrantRole } from '../lib/remote';
import { useSession } from '../lib/session';
import {
  deriveGrantRows,
  withGrant,
  withGrantRole,
  withoutGrant,
  type GrantPending,
} from '../lib/shareRows';
import {
  cellClass,
  dangerBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import type { Collection } from '../lib/types';

export default function ShareCollectionSheet({
  collection,
  onClose,
}: {
  collection: Collection;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { user } = useSession();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantRole>('viewer');
  // `undefined` until a load succeeds. A failed load leaves it `undefined`
  // (with `grantsLoadError` set) instead of showing an empty list, which
  // would claim nobody has access.
  const [grants, setGrants] = useState<CollectionGrant[] | undefined>(undefined);
  const [grantsLoadError, setGrantsLoadError] = useState<string | null>(null);
  // Add failures show under the email field; row failures show above the list.
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<GrantPending | null>(null);
  const [links, setLinks] = useState<CollectionLink[] | undefined>(undefined);
  const [linksLoadError, setLinksLoadError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  // Copy link says "Saving…" only while a mint is in flight, not during revoke.
  const [mintingLink, setMintingLink] = useState(false);
  // Set in the same turn as the mint request, before React disables the
  // switch, so a click cannot leave the link pane before the one-time URL
  // is on screen. The server does not return that URL again.
  const holdPane = useRef(false);
  // Link mint/revoke errors show in the link block, not under the email form.
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkRole, setLinkRole] = useState<GrantRole>('viewer');
  // Email is the pane that opens. Switching keeps the form, a minted URL,
  // and any request already in flight, except during a mint: the switch is
  // held so the one-time URL is visible when the request finishes.
  const [method, setMethod] = useState<'email' | 'link' | 'public'>('email');
  const [publicBusy, setPublicBusy] = useState(false);
  // The raw link is only in this state: the server never returns it again.
  const [minted, setMinted] = useState<MintedLink | null>(null);
  const [copied, setCopied] = useState(false);
  // Hidden as soon as its link is revoked or drops out of a refreshed list.
  const mintedUrl = visibleMintedUrl(minted, links);
  const busy = pending !== null || linkBusy || publicBusy;
  // One request at a time. State alone cannot stop a second submit that lands
  // before the re-render that disables the controls.
  const inFlight = useRef(false);
  // Only the newest load or write result may set a list. A slow first load
  // must not overwrite a list an add has already updated.
  const grantsSeq = useRef(0);
  const linksSeq = useRef(0);
  // `add`, `changeRole`, and `revoke` keep running after the render that
  // started them. This is the list from the latest load or write, updated
  // in the same turn as `setGrants`, so a saved change merges into the list
  // that arrived while the request was in flight.
  const grantsRef = useRef<CollectionGrant[] | undefined>(undefined);
  // Focusing the email field on a phone raises the keyboard over the people list.
  const [finePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true,
  );

  const rememberGrants = useCallback((rows: CollectionGrant[]) => {
    grantsRef.current = rows;
    setGrants(rows);
    setGrantsLoadError(null);
  }, []);

  const applyGrants = useCallback(
    (rows: CollectionGrant[]) => {
      grantsSeq.current += 1;
      rememberGrants(rows);
    },
    [rememberGrants],
  );

  const applyLinks = useCallback((rows: CollectionLink[]) => {
    linksSeq.current += 1;
    setLinks(rows);
    setLinksLoadError(null);
  }, []);

  // `quiet` keeps the list on screen when the read fails (a reconcile after a
  // write); otherwise a failure is shown as a load error with Try again.
  const loadGrants = useCallback(
    async (quiet: boolean) => {
      const seq = ++grantsSeq.current;
      try {
        const rows = await collectionStore.listGrants(collection.id);
        if (seq === grantsSeq.current) {
          rememberGrants(rows);
        }
      } catch (err) {
        if (seq === grantsSeq.current && !quiet) {
          setGrantsLoadError(err instanceof Error ? err.message : t('error.sharingLoad'));
        }
      }
    },
    [collection.id, rememberGrants],
  );

  const loadLinks = useCallback(
    async () => {
      const seq = ++linksSeq.current;
      try {
        const rows = await collectionStore.listLinks(collection.id);
        if (seq === linksSeq.current) {
          setLinks(rows);
          setLinksLoadError(null);
        }
      } catch (err) {
        if (seq === linksSeq.current) {
          setLinksLoadError(err instanceof Error ? err.message : t('error.sharingLoad'));
        }
      }
    },
    [collection.id],
  );

  // Merge a confirmed write into the newest list, then reread. A list that
  // has never loaded is reread instead of being replaced by one row.
  const commitGrants = (next: (current: readonly CollectionGrant[]) => CollectionGrant[]) => {
    const current = grantsRef.current;
    if (current === undefined) {
      void loadGrants(false);
      return;
    }
    applyGrants(next(current));
    void loadGrants(true);
  };

  useEffect(() => {
    void loadGrants(false);
    void loadLinks();
    return () => {
      // A result that lands after the sheet closed is stale.
      grantsSeq.current += 1;
      linksSeq.current += 1;
    };
  }, [loadGrants, loadLinks]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can be refused; the URL stays selectable below.
      setCopied(false);
    }
  };

  const createLink = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    holdPane.current = true;
    setLinkError(null);
    setLinkBusy(true);
    setMintingLink(true);
    setCopied(false);
    try {
      const created = await collectionStore.createLink(collection.id, linkRole);
      applyLinks(created.links);
      setMinted({ url: created.url, id: created.linkId });
      await copyUrl(created.url);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      inFlight.current = false;
      holdPane.current = false;
      setLinkBusy(false);
      setMintingLink(false);
    }
  };

  const revokeLink = async (linkId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLinkError(null);
    setLinkBusy(true);
    try {
      applyLinks(await collectionStore.revokeLink(collection.id, linkId, links ?? []));
      if (minted?.id === linkId) {
        setMinted(null);
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      inFlight.current = false;
      setLinkBusy(false);
    }
  };

  const add = async () => {
    const target = email.trim();
    if (inFlight.current || target === '') return;
    inFlight.current = true;
    setFormError(null);
    setListError(null);
    setPending({ kind: 'add', email: target, role });
    try {
      const grant = await collectionStore.addGrant(collection.id, target, role);
      setEmail('');
      setRole('viewer');
      // The server accepted the grant and sent it back. Show that row now;
      // a failed reread must not undo a saved add.
      commitGrants((current) => withGrant(current, grant));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('error.sharingUpdate'));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const changeRole = async (sub: string, next: GrantRole) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setListError(null);
    setPending({ kind: 'role', sub, role: next });
    try {
      await collectionStore.setGrantRole(collection.id, sub, next);
      commitGrants((current) => withGrantRole(current, sub, next));
    } catch (err) {
      setListError(err instanceof Error ? err.message : t('error.sharingUpdate'));
      // The row snaps back to the server's role; reread in case it changed elsewhere.
      void loadGrants(true);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const revoke = async (sub: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setListError(null);
    setPending({ kind: 'remove', sub });
    try {
      await collectionStore.revokeGrant(collection.id, sub);
      commitGrants((current) => withoutGrant(current, sub));
    } catch (err) {
      setListError(err instanceof Error ? err.message : t('error.sharingUpdate'));
      void loadGrants(true);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const rows = deriveGrantRows(grants ?? [], pending);
  const addingNew = pending?.kind === 'add';

  return (
    <Sheet onClose={onClose} dismissible={!busy}>
      <h2 className="text-lg font-semibold">{t('share.title', { name: collection.name })}</h2>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          aria-pressed={method === 'email'}
          disabled={mintingLink || publicBusy}
          onClick={() => {
            if (holdPane.current) return;
            setMethod('email');
          }}
          className={`flex-1 rounded-full py-2.5 font-medium disabled:opacity-40 ${
            method === 'email'
              ? 'bg-ink text-page'
              : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
          }`}
        >
          {t('share.byEmail')}
        </button>
        <button
          type="button"
          aria-pressed={method === 'link'}
          disabled={mintingLink || publicBusy}
          onClick={() => {
            if (holdPane.current) return;
            setMethod('link');
          }}
          className={`flex-1 rounded-full py-2.5 font-medium disabled:opacity-40 ${
            method === 'link'
              ? 'bg-ink text-page'
              : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
          }`}
        >
          {t('share.byLink')}
        </button>
        <button
          type="button"
          aria-pressed={method === 'public'}
          disabled={mintingLink || publicBusy}
          onClick={() => {
            if (holdPane.current) return;
            setMethod('public');
          }}
          className={`flex-1 rounded-full py-2.5 font-medium disabled:opacity-40 ${
            method === 'public'
              ? 'bg-ink text-page'
              : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
          }`}
        >
          {t('share.byPublic')}
        </button>
      </div>
      {method === 'public' ? (
        <PublicLinkPane
          source={{
            id: collection.id,
            load: () => collectionStore.publicLink(collection.id),
            enable: () => collectionStore.enablePublicLink(collection.id),
            disable: () => collectionStore.disablePublicLink(collection.id),
            inputId: 'public-collection-link',
            text: {
              intro: 'share.publicIntro',
              off: 'share.publicOff',
              turnOn: 'share.publicTurnOn',
              label: 'share.publicLinkLabel',
              turnOffLabel: 'share.publicTurnOffLabel',
            },
          }}
          onBusyChange={setPublicBusy}
        />
      ) : method === 'email' ? (
        <>
          <p className="mt-3 text-sm text-ink-muted">{t('share.intro')}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="mt-3 flex gap-2">
              <input
                autoFocus={finePointer}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFormError(null);
                }}
                placeholder={t('share.emailPlaceholder')}
                aria-label={t('share.emailPlaceholder')}
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                className={`${inputClass} min-w-0 flex-1`}
              />
              <RoleSelect
                value={role}
                onChange={(next) => {
                  setRole(next);
                  setFormError(null);
                }}
                disabled={busy}
              />
            </div>
            {formError && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {formError}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || email.trim() === ''}
              className={`${primaryBtn} mt-3 w-full py-3`}
            >
              {addingNew ? t('common.saving') : t('common.share')}
            </button>
          </form>
          <h3 className="mt-5 text-sm font-semibold">{t('share.peopleTitle')}</h3>
          {listError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {listError}
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-2.5">
            {user !== null && (
              <li className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={user.email}>
                  {user.email}
                </span>
                <span className="shrink-0 rounded-full bg-surface-muted px-2.5 py-1 text-xs text-ink-muted">
                  {t('share.owner')}
                </span>
              </li>
            )}
            {grants === undefined && grantsLoadError === null && (
              <li className="text-sm text-ink-muted">{t('common.loading')}</li>
            )}
            {grants === undefined && grantsLoadError !== null && (
              <LoadFailed message={grantsLoadError} onRetry={() => void loadGrants(false)} />
            )}
            {grants !== undefined && rows.length === 0 && (
              <li className="text-sm text-ink-muted">{t('share.nobodyYet')}</li>
            )}
            {rows.map((row) => (
              <li
                key={row.key}
                aria-busy={row.state !== 'saved'}
                className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${
                  row.state === 'saved' ? '' : 'opacity-60'
                }`}
              >
                {/* Phone: the whole email on its own line, controls below it. */}
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <span className="block truncate" title={row.email}>
                    {row.email}
                  </span>
                  {row.state !== 'saved' && (
                    <span className="block text-xs text-ink-muted" role="status">
                      {t('common.saving')}
                    </span>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {row.sub === undefined ? (
                    // Not saved yet, so no controls: there is nothing to change or remove.
                    <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-ink-muted">
                      {row.role === 'editor' ? t('share.editor') : t('share.viewer')}
                    </span>
                  ) : (
                    <>
                      <RoleSelect
                        value={row.role}
                        onChange={(next) => void changeRole(row.sub!, next)}
                        disabled={busy}
                        label={t('share.roleFor', { email: row.email })}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void revoke(row.sub!)}
                        aria-label={t('share.removeFor', { email: row.email })}
                        className={`${dangerBtn} px-3 py-1.5 text-xs disabled:opacity-40`}
                      >
                        {t('common.remove')}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-muted">{t('share.linkIntro')}</p>
          <div className="mt-3 flex gap-2">
            <RoleSelect
              value={linkRole}
              onChange={setLinkRole}
              disabled={busy}
              label={t('share.linkRoleLabel')}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void createLink()}
              className={`${secondaryBtn} min-w-0 flex-1 py-2 disabled:opacity-40`}
            >
              {mintingLink ? t('common.saving') : t('share.copyLink')}
            </button>
          </div>
          {linkError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {linkError}
            </p>
          )}
          {mintedUrl !== null && (
            <div className="mt-3">
              <label className="text-xs text-ink-muted" htmlFor="minted-collection-link">
                {copied ? t('share.linkCopiedHint') : t('share.linkCopyNowHint')}
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="minted-collection-link"
                  readOnly
                  value={mintedUrl}
                  onFocus={(event) => event.currentTarget.select()}
                  className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
                />
                <button
                  type="button"
                  onClick={() => void copyUrl(mintedUrl)}
                  className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
                >
                  {copied ? t('share.copied') : t('share.copy')}
                </button>
              </div>
            </div>
          )}
          <ul className="mt-3 flex flex-col gap-2">
            {links === undefined && linksLoadError === null && (
              <li className="text-sm text-ink-muted">{t('common.loading')}</li>
            )}
            {links === undefined && linksLoadError !== null && (
              <LoadFailed message={linksLoadError} onRetry={() => void loadLinks()} />
            )}
            {links?.length === 0 && (
              <li className="text-sm text-ink-muted">{t('share.noLinks')}</li>
            )}
            {links?.map((link) => (
              <li key={link.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {link.role === 'editor' ? t('share.editorLink') : t('share.viewerLink')}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {relativeExpiryLabel(link.expiresAt, Date.now(), locale)}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revokeLink(link.id)}
                  aria-label={
                    link.role === 'editor'
                      ? t('share.revokeEditorLink')
                      : t('share.revokeViewerLink')
                  }
                  className={`${dangerBtn} shrink-0 px-3 py-1.5 text-xs disabled:opacity-40`}
                >
                  {t('share.revoke')}
                </button>
              </li>
            ))}
          </ul>
          {links !== undefined && links.length > 0 && (
            // Once, under the list: Remove above does not stop a live link.
            <p className="mt-2 text-xs text-ink-muted">{t('share.linkRejoinWarning')}</p>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className={`${secondaryBtn} mt-3 w-full py-3`}
      >
        {t('common.done')}
      </button>
    </Sheet>
  );
}

/** A list that could not be read: the server's reason and a retry, never an empty list. */
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span role="alert" className="min-w-0 flex-1 text-danger">
        {message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
      >
        {t('common.tryAgain')}
      </button>
    </li>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: GrantRole;
  onChange: (role: GrantRole) => void;
  disabled: boolean;
  label?: string;
}) {
  const t = useT();
  return (
    <select
      aria-label={label ?? t('share.role')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === 'editor' ? 'editor' : 'viewer')}
      className={`${cellClass} shrink-0 bg-surface text-sm disabled:opacity-60`}
    >
      <option value="viewer">{t('share.viewer')}</option>
      <option value="editor">{t('share.editor')}</option>
    </select>
  );
}
