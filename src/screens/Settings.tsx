import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isSupportedLocale, localeDisplayName, SUPPORTED_LOCALES, t as translate, useLocale, useT } from '../i18n';
import { exportLibrary, importLibrary } from '../lib/backup';
import {
  disconnectApp,
  listConnectedApps,
  mcpServerUrl,
  type ConnectedApp,
} from '../lib/connectedAppsApi';
import { createMemberInvite } from '../lib/inviteApi';
import { relativeAgoLabel } from '../lib/relativeTime';
import { notifyImportComplete, sync, useSyncStatus } from '../lib/syncEngine';
import { signInHref, signOut, useSession } from '../lib/session';
import { settings, type Theme } from '../lib/settings';
import { applyTheme } from '../lib/theme';
import { backLink, inputClass, inputFocus, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import { useRecipeTextSize, useWakeLockSetting } from '../lib/useDeviceSettings';

function MemberInvite() {
  const t = useT();
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = async () => {
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const created = await createMemberInvite();
      setMintedUrl(created.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : translate('common.somethingWentWrong'));
    } finally {
      setCreating(false);
    }
  };

  const copyMintedUrl = async () => {
    if (mintedUrl === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mintedUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section>
      <h2 className="mt-8 text-lg font-semibold">{t('settings.inviteTitle')}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t('settings.inviteIntro')}</p>
      <button
        type="button"
        onClick={() => void mint()}
        disabled={creating}
        className={`${primaryBtn} mt-3 px-4 py-2.5 disabled:opacity-40`}
      >
        {creating ? t('admin.creating') : t('admin.createLink')}
      </button>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
      {mintedUrl !== null && (
        <div className="mt-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <label className="text-xs text-ink-muted" htmlFor="member-invite-url">
            {t('admin.newInviteLink')}
          </label>
          <input
            id="member-invite-url"
            className={`${inputClass} mt-1 font-mono text-sm`}
            readOnly
            value={mintedUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => void copyMintedUrl()}
            className={`${secondaryBtn} mt-2 px-3 py-1.5 text-sm`}
          >
            {copied ? t('admin.copied') : t('admin.copy')}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * AI apps connected through the MCP server. The list is this component's own
 * state, loaded when Settings opens; nothing else reads it.
 */
function ConnectedApps() {
  const t = useT();
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const serverUrl = mcpServerUrl(window.location.origin);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    listConnectedApps().then(
      (list) => {
        if (!cancelled) setApps(list);
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : translate('common.somethingWentWrong'));
      },
    );
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  const disconnect = async (app: ConnectedApp) => {
    setPendingId(app.id);
    setDisconnectError(null);
    try {
      await disconnectApp(app.id);
      if (mountedRef.current) {
        setApps((current) => current?.filter((row) => row.id !== app.id) ?? current);
      }
    } catch {
      if (mountedRef.current) {
        setDisconnectError(translate('settings.connectedAppsDisconnectError', { app: app.clientHost }));
      }
    } finally {
      if (mountedRef.current) setPendingId(null);
    }
  };

  const copyServerUrl = async () => {
    try {
      await navigator.clipboard.writeText(serverUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section>
      <h2 className="mt-8 text-lg font-semibold">{t('settings.connectedApps')}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t('settings.connectedAppsIntro')}</p>
      {apps === null && loadError === null && (
        <p className="mt-3 text-sm text-ink-muted">{t('common.loading')}</p>
      )}
      {loadError !== null && <p className="mt-3 text-sm text-danger">{loadError}</p>}
      {apps !== null && apps.length === 0 && (
        <p className="mt-3 text-sm">{t('settings.connectedAppsEmpty')}</p>
      )}
      {apps !== null && apps.length > 0 && (
        <ul className="mt-3 space-y-2">
          {apps.map((app) => (
            <li key={app.id} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{app.clientHost}</p>
                  {app.clientName !== undefined && (
                    <p className="truncate text-sm text-ink-muted">
                      {t('settings.connectedAppsSelfName', { name: app.clientName })}
                    </p>
                  )}
                  <p className="mt-1 text-sm">
                    {app.canEdit ? t('settings.connectedAppsCanEdit') : t('settings.connectedAppsCanRead')}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {t('settings.connectedAppsConnected', { time: relativeAgoLabel(app.createdAt) })}
                  </p>
                  {app.lastUsedAt !== undefined && (
                    <p className="text-xs text-ink-muted">
                      {t('settings.connectedAppsLastUsed', { time: relativeAgoLabel(app.lastUsedAt) })}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void disconnect(app)}
                  disabled={pendingId !== null}
                  className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-sm disabled:opacity-40`}
                >
                  {pendingId === app.id
                    ? t('settings.connectedAppsDisconnecting')
                    : t('settings.connectedAppsDisconnect')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {disconnectError !== null && <p className="mt-2 text-sm text-danger">{disconnectError}</p>}
      {/* Always shown: a second app needs the address as much as the first. */}
      <div className="mt-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
        <label className="block text-xs text-ink-muted" htmlFor="mcp-server-url">
          {t('settings.connectedAppsServerUrl')}
        </label>
        <input
          id="mcp-server-url"
          className={`${inputClass} mt-1 font-mono text-sm`}
          readOnly
          value={serverUrl}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          onClick={() => void copyServerUrl()}
          className={`${secondaryBtn} mt-2 px-3 py-1.5 text-sm`}
        >
          {copied ? t('admin.copied') : t('admin.copy')}
        </button>
      </div>
    </section>
  );
}

export default function Settings() {
  const { user, status: sessionStatus } = useSession();
  const syncStatus = useSyncStatus();
  const t = useT();
  const locale = useLocale();
  const wakeLock = useWakeLockSetting();
  const textSize = useRecipeTextSize();
  const [theme, setTheme] = useState(settings.getTheme());
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chooseTheme = (next: Theme) => {
    settings.setTheme(next);
    applyTheme(next);
    setTheme(next);
  };

  const doExport = async () => {
    if (!user) {
      return;
    }
    const blob = await exportLibrary(user.sub);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    if (!user) {
      return;
    }
    try {
      const { imported, skipped } = await importLibrary(file, user.sub);
      const importedLine = t('settings.importedRecipes', { count: imported });
      const skippedLine =
        skipped > 0 ? t('settings.importSkipped', { count: skipped }) : '';
      setStatus(skippedLine === '' ? importedLine : `${importedLine} ${skippedLine}`);
      setStatusKind(skipped > 0 ? 'err' : 'ok');
      notifyImportComplete();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : t('error.importFailed'));
      setStatusKind('err');
    }
  };

  const doRefresh = async () => {
    setBusy(true);
    try {
      await sync();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const syncedLabel = (() => {
    const at = syncStatus.lastSyncedAt;
    if (at === null) {
      return t('settings.notLoaded');
    }
    return t('settings.loadedAgo', { time: relativeAgoLabel(at) });
  })();

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; {t('common.library')}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('settings.title')}</h1>
      </header>

      {sessionStatus !== 'loading' && (
        <>
          <h2 className="mt-2 text-lg font-semibold">{t('settings.account')}</h2>
          {sessionStatus === 'signedOut' && (
            <>
              <p className="mt-1 text-sm text-ink-muted">
                {t('settings.signInPrompt')}
              </p>
              <a
                href={signInHref('/settings')}
                className={`${primaryBtn} mt-3 inline-block px-4 py-2.5`}
              >
                {t('settings.signInWithGoogle')}
              </a>
            </>
          )}
          {sessionStatus === 'signedIn' && user && (
            <>
              <div className="mt-3 flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {user.email}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className={`${secondaryBtn} shrink-0 px-4 py-2.5`}
                >
                  {t('settings.signOut')}
                </button>
              </div>
              {user.isOwner === true && (
                <>
                  <p className="mt-4 text-sm text-ink-muted">
                    {t('settings.ownerHint')}
                  </p>
                  <Link
                    to="/admin"
                    className={`${secondaryBtn} mt-2 inline-block px-4 py-2.5`}
                  >
                    {t('admin.title')}
                  </Link>
                </>
              )}
              {user.isOwner !== true && <MemberInvite />}
            </>
          )}
          {sessionStatus === 'offline' && (
            <>
              {user && (
                <span className="mt-3 block truncate text-sm">
                  {user.email}
                </span>
              )}
              <p className="mt-1 text-sm text-ink-muted">
                {t('settings.offline')}
              </p>
            </>
          )}
        </>
      )}

      {sessionStatus === 'signedIn' && (
        <>
          <h2 className="mt-8 text-lg font-semibold">{t('common.library')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{syncedLabel}</p>
          {syncStatus.status === 'error' && (
            <p className="mt-1 text-sm text-danger">
              {t('settings.loadError')}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void doRefresh()}
              disabled={busy || syncStatus.status === 'loading'}
              className={`${secondaryBtn} flex-1 py-2.5`}
            >
              {busy || syncStatus.status === 'loading' ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
        </>
      )}

      {sessionStatus === 'signedIn' && <ConnectedApps />}

      <h2 className="mt-8 text-lg font-semibold">{t('settings.appearance')}</h2>
      <div className="mt-3 flex gap-2">
        {(['dark', 'light'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={theme === option}
            onClick={() => chooseTheme(option)}
            className={`flex-1 rounded-full py-2.5 font-medium ${
              theme === option
                ? 'bg-ink text-page'
                : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
            }`}
          >
            {option === 'dark' ? t('settings.dark') : t('settings.light')}
          </button>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold">{t('settings.cooking')}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t('settings.cookingDeviceOnly')}</p>
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={wakeLock}
          onChange={(event) => settings.setWakeLock(event.target.checked)}
          className={`mt-1 h-4 w-4 shrink-0 accent-ink ${inputFocus}`}
        />
        <span>{t('settings.keepScreenAwake')}</span>
      </label>
      <p id="settings-text-size" className="mt-4">
        {t('settings.recipeTextSize')}
      </p>
      <div role="group" aria-labelledby="settings-text-size" className="mt-2 flex gap-2">
        {(['normal', 'large'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={textSize === option}
            onClick={() => settings.setRecipeTextSize(option)}
            className={`flex-1 rounded-full py-2.5 font-medium ${
              textSize === option
                ? 'bg-ink text-page'
                : 'border border-line-strong text-ink-muted hover:bg-surface-muted active:bg-surface-muted'
            }`}
          >
            {option === 'normal' ? t('settings.textSizeNormal') : t('settings.textSizeLarge')}
          </button>
        ))}
      </div>

      <label htmlFor="settings-language" className="mt-8 block text-lg font-semibold">
        {t('settings.language')}
      </label>
      <select
        id="settings-language"
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isSupportedLocale(next)) {
            settings.setLocale(next);
          }
        }}
        className={`${inputClass} mt-3`}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {localeDisplayName(code)}
          </option>
        ))}
      </select>

      <h2 className="mt-8 text-lg font-semibold">{t('settings.backup')}</h2>
      <p className="mt-1 text-sm text-ink-muted">
        {sessionStatus === 'signedIn'
          ? t('settings.backupSignedIn')
          : t('settings.backupSignedOut')}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          {t('settings.exportLibrary')}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sessionStatus !== 'signedIn'}
          className={`${secondaryBtn} flex-1 py-2.5 disabled:opacity-40`}
        >
          {t('settings.importBackup')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void doImport(file);
            e.target.value = '';
          }}
        />
      </div>
      {status && (
        <p
          className={`mt-2 text-sm ${statusKind === 'ok' ? 'text-success' : 'text-danger'}`}
        >
          {status}
        </p>
      )}

      {sessionStatus === 'signedIn' && (
        <>
          <h2 className="mt-8 text-lg font-semibold">{t('settings.feedback')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('settings.feedbackBody')}</p>
          <Link
            to="/suggest"
            state={{ from: 'settings' }}
            className={`${secondaryBtn} mt-3 inline-block px-4 py-2.5`}
          >
            {t('settings.suggestButton')}
          </Link>
        </>
      )}

      <footer className="mt-8">
        <a
          href="/about"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3 pr-4`}
        >
          {t('settings.about')}
        </a>
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3 pr-4`}
        >
          {t('settings.privacy')}
        </a>
        <a
          href="/terms"
          target="_blank"
          rel="noreferrer"
          className={`${backLink} inline-block py-3`}
        >
          {t('settings.terms')}
        </a>
      </footer>
    </div>
  );
}
