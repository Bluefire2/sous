import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MAX_FEATURE_REQUEST_CHARS } from '../../server/featureRequestShape.ts';
import { useLocale, useT } from '../i18n';
import { buildFeatureRequest, canSendFeatureRequest } from '../lib/featureRequest';
import { sendFeatureRequest } from '../lib/featureRequestApi';
import { SpinnerIcon } from '../lib/icons';
import { signInHref, useSession } from '../lib/session';
import { backLink, inputClass, inputFocus, primaryBtn, secondaryBtn } from '../lib/uiClasses';

/** Show the remaining-character count only this close to the cap. */
const COUNT_FROM_REMAINING = 200;

function fromState(state: unknown): unknown {
  return typeof state === 'object' && state !== null ? (state as { from?: unknown }).from : undefined;
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** `/suggest`: send the owner a feature suggestion (`docs/plans/feature-requests.md`). */
export default function SuggestFeature() {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const { status: sessionStatus } = useSession();
  const from = fromState(location.state);
  const back =
    from === 'settings'
      ? { to: '/settings', label: t('settings.title') }
      : { to: '/', label: t('common.library') };

  // The page has one job, so focus the box; but not on a phone, where the
  // keyboard would cover the intro and the contact choice.
  const [finePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true,
  );
  const [id, setId] = useState(() => crypto.randomUUID());
  const [text, setText] = useState('');
  const [contactOk, setContactOk] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const sending = status === 'sending';
  // `maxLength` stops typing and paste, not a script or extension setting the
  // value; the send caps the text either way.
  const remaining = Math.max(0, MAX_FEATURE_REQUEST_CHARS - text.length);

  async function send() {
    setStatus('sending');
    setError(null);
    try {
      await sendFeatureRequest(
        buildFeatureRequest({ id, text, contactOk, from, locale, standalone: isStandalone() }),
      );
      setStatus('sent');
    } catch (e) {
      setStatus('idle');
      setError(e instanceof Error ? e.message : t('suggest.sendFailed'));
    }
  }

  function startAnother() {
    setId(crypto.randomUUID());
    setText('');
    setContactOk(false);
    setError(null);
    setStatus('idle');
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={back.to} className={backLink}>
          &larr; {back.label}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t('suggest.title')}</h1>
      </header>

      {sessionStatus === 'signedOut' && (
        <>
          <p className="text-ink-muted">{t('suggest.signedOut')}</p>
          <a href={signInHref('/suggest')} className={`${primaryBtn} mt-3 inline-block px-4 py-2.5`}>
            {t('settings.signInWithGoogle')}
          </a>
        </>
      )}

      {sessionStatus !== 'signedOut' && sessionStatus !== 'loading' && status === 'sent' && (
        <>
          <p role="status" className="text-ink">
            {t('suggest.sent')}
          </p>
          <button type="button" onClick={startAnother} className={`${secondaryBtn} mt-4 px-4 py-2.5`}>
            {t('suggest.another')}
          </button>
        </>
      )}

      {sessionStatus !== 'signedOut' && sessionStatus !== 'loading' && status !== 'sent' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!sending && canSendFeatureRequest(text)) void send();
          }}
        >
          <p className="text-ink-muted">{t('suggest.intro')}</p>
          <label className="mt-4 block">
            <span className="font-medium">{t('suggest.label')}</span>
            <textarea
              autoFocus={finePointer}
              rows={6}
              maxLength={MAX_FEATURE_REQUEST_CHARS}
              placeholder={t('suggest.placeholder')}
              className={`mt-1 ${inputClass}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={sending}
            />
          </label>
          {remaining <= COUNT_FROM_REMAINING && (
            <p className="mt-1 text-right text-sm text-ink-subtle">
              {t('suggest.charsLeft', { count: remaining })}
            </p>
          )}
          <label className="mt-3 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={contactOk}
              onChange={(event) => setContactOk(event.target.checked)}
              disabled={sending}
              className={`mt-1 h-5 w-5 shrink-0 accent-ink ${inputFocus}`}
            />
            <span>
              <span className="block">{t('suggest.contact')}</span>
              <span className="block text-sm text-ink-subtle">{t('suggest.contactHint')}</span>
            </span>
          </label>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-ink-muted">{t('suggest.included')}</summary>
            <ul className="mt-1 list-disc pl-5 text-ink-subtle">
              <li>{t('suggest.includedText')}</li>
              <li>{t('suggest.includedContext')}</li>
              <li>{t('suggest.includedAccount')}</li>
            </ul>
          </details>
          <button
            type="submit"
            disabled={sending || !canSendFeatureRequest(text)}
            aria-busy={sending}
            className={`${primaryBtn} mt-5 inline-flex items-center gap-2 px-5 py-2.5`}
          >
            {sending ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                {t('suggest.sending')}
              </>
            ) : (
              t('suggest.send')
            )}
          </button>
          {error !== null && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
