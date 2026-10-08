import { useCallback, useEffect, useRef, useState } from 'react';
import { useT, type MessageKey } from '../i18n';
import { dangerBtn, inputClass, primaryBtn, secondaryBtn } from '../lib/uiClasses';

/**
 * Which link the pane manages and its words: a collection's public link
 * (`docs/plans/public-collections.md`) or a recipe link
 * (`docs/plans/recipe-links.md`). `id` keys the load; the calls go to the
 * owner's store.
 */
export type PublicLinkSource = {
  id: string;
  load: () => Promise<string | null>;
  enable: () => Promise<string | null>;
  disable: () => Promise<void>;
  inputId: string;
  text: {
    intro: MessageKey;
    off: MessageKey;
    turnOn: MessageKey;
    label: MessageKey;
    turnOffLabel: MessageKey;
  };
};

/**
 * A share sheet's link pane: turn the link on, copy it, or turn it off.
 * Unlike a join link, the server keeps the URL, so it can be shown again.
 */
export default function PublicLinkPane({
  source,
  onBusyChange,
}: {
  source: PublicLinkSource;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const { id: sourceId, load: loadLink, enable, disable, inputId, text } = source;
  // `undefined` until a load succeeds; null means the collection is not public.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);
  // Only the newest read or write may set the URL.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(null);
    try {
      const next = await loadLink();
      if (mine === seq.current) setUrl(next);
    } catch (err) {
      if (mine === seq.current) {
        setLoadError(err instanceof Error ? err.message : t('error.sharingLoad'));
      }
    }
    // `sourceId` names the link; the callbacks are rebuilt each render.
  }, [sourceId]);

  useEffect(() => {
    void load();
    return () => {
      // A result that lands after the pane closed is stale.
      seq.current += 1;
    };
  }, [load]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be refused; the URL stays selectable.
      setCopied(false);
    }
  };

  const run = async (write: () => Promise<string | null>, copyAfter: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    setError(null);
    setBusy(true);
    onBusyChange(true);
    setCopied(false);
    try {
      const next = await write();
      if (mine !== seq.current) return;
      setUrl(next);
      if (copyAfter && next !== null) await copy(next);
    } catch (err) {
      if (mine === seq.current) {
        setError(err instanceof Error ? err.message : t('error.sharingUpdate'));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };

  const turnOn = () => run(enable, true);
  const turnOff = () =>
    run(async () => {
      await disable();
      return null;
    }, false);

  return (
    <>
      <p className="mt-3 text-sm text-ink-muted">{t(text.intro)}</p>
      {url === undefined && loadError === null && (
        <p className="mt-3 text-sm text-ink-muted">{t('common.loading')}</p>
      )}
      {url === undefined && loadError !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span role="alert" className="min-w-0 flex-1 text-danger">
            {loadError}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
          >
            {t('common.tryAgain')}
          </button>
        </div>
      )}
      {url === null && (
        <>
          <p className="mt-3 text-sm text-ink-muted">{t(text.off)}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOn()}
            className={`${primaryBtn} mt-3 w-full py-3`}
          >
            {busy ? t('common.saving') : t(text.turnOn)}
          </button>
        </>
      )}
      {typeof url === 'string' && (
        <div className="mt-3">
          <label className="text-xs text-ink-muted" htmlFor={inputId}>
            {t(text.label)}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={inputId}
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => void copy(url)}
              className={`${secondaryBtn} shrink-0 px-3 py-1.5 text-xs`}
            >
              {copied ? t('share.copied') : t('share.copy')}
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOff()}
            aria-label={t(text.turnOffLabel)}
            className={`${dangerBtn} mt-3 px-4 py-2 text-sm disabled:opacity-40`}
          >
            {busy ? t('common.saving') : t('share.publicTurnOff')}
          </button>
          <p className="mt-2 text-xs text-ink-muted">{t('share.publicOffHint')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
