import { useState } from 'react';
import { MAX_FEEDBACK_COMMENT_CHARS } from '../../server/importFeedbackShape.ts';
import { useT } from '../i18n';
import { SpinnerIcon } from '../lib/icons';
import { buildImportFeedback, includedSummary, type FeedbackCardInput } from '../lib/importFeedback';
import { sendImportFeedback } from '../lib/importFeedbackApi';
import { ghostBtn, inputClass, secondaryBtn } from '../lib/uiClasses';

/**
 * What a card must keep across an unmount: its report id (the server dedupes
 * a repeat id, so a resend never writes a second report), whether it was sent,
 * and the note typed so far.
 */
export interface FeedbackCardMemory {
  id: string;
  sent: boolean;
  note: string;
  noteOpen: boolean;
}

export function newFeedbackCardMemory(): FeedbackCardMemory {
  return { id: crypto.randomUUID(), sent: false, note: '', noteOpen: false };
}

/**
 * Without `memory`, the card keeps it itself, which is enough where the card
 * stays mounted for as long as its import is on screen. A parent that can
 * unmount the card (bulk rows under a filter) owns `memory` instead.
 */
export default function ImportFeedbackCard({
  input,
  compact = false,
  memory: ownedMemory,
  onMemoryChange,
}: {
  input: FeedbackCardInput;
  compact?: boolean;
  memory?: FeedbackCardMemory;
  onMemoryChange?: (memory: FeedbackCardMemory) => void;
}) {
  const t = useT();
  const [localMemory, setLocalMemory] = useState(newFeedbackCardMemory);
  const memory = ownedMemory ?? localMemory;
  const update = (patch: Partial<FeedbackCardMemory>) => {
    const next = { ...memory, ...patch };
    if (onMemoryChange !== undefined) onMemoryChange(next);
    else setLocalMemory(next);
  };
  const { id, note, noteOpen } = memory;
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  async function send() {
    setStatus('sending');
    setErrorText(null);
    try {
      await sendImportFeedback(buildImportFeedback({ ...input, id, comment: note }));
      // The note is disabled while sending, so `memory` is still current here.
      update({ sent: true });
    } catch (e) {
      setStatus('error');
      setErrorText(e instanceof Error ? e.message : t('importFeedback.sendFailed'));
    }
  }

  if (memory.sent) {
    return (
      <p role="status" className="mt-3 text-sm text-ink-subtle">
        {t('importFeedback.sent')}
      </p>
    );
  }

  const sending = status === 'sending';
  const summary = includedSummary(input.source);

  return (
    <section
      aria-label={t('importFeedback.heading')}
      className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink"
    >
      <p className="font-medium">{t('importFeedback.heading')}</p>
      {!compact && <p className="mt-0.5 text-ink-subtle">{t('importFeedback.body')}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          aria-busy={sending}
          className={`${secondaryBtn} inline-flex items-center gap-2 px-4 py-1.5 disabled:opacity-40`}
        >
          {sending ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t('importFeedback.sending')}
            </>
          ) : (
            t('importFeedback.send')
          )}
        </button>
        {!noteOpen && (
          <button
            type="button"
            className={ghostBtn}
            aria-expanded={false}
            onClick={() => update({ noteOpen: true })}
          >
            {t('importFeedback.addNote')}
          </button>
        )}
      </div>
      {noteOpen && (
        <label className="mt-2 block">
          <span className="text-ink-muted">{t('importFeedback.noteLabel')}</span>
          <textarea
            rows={3}
            maxLength={MAX_FEEDBACK_COMMENT_CHARS}
            placeholder={t('importFeedback.notePlaceholder')}
            className={`mt-1 ${inputClass}`}
            value={note}
            onChange={(e) => update({ note: e.target.value })}
            disabled={sending}
          />
        </label>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-ink-muted">{t('importFeedback.included')}</summary>
        <ul className="mt-1 list-disc pl-5 text-ink-subtle">
          {summary.kind === 'url' && (
            <li className="break-all">{t('importFeedback.includedLink', { url: summary.url })}</li>
          )}
          {summary.kind === 'paste' && (
            <li>
              {t('importFeedback.includedPaste', { count: summary.chars, preview: summary.preview })}
            </li>
          )}
          {summary.kind === 'brief' && (
            <li>
              {t('importFeedback.includedBrief', { count: summary.chars, preview: summary.preview })}
            </li>
          )}
          {summary.kind === 'photos' && <li>{t('importFeedback.includedPhotos')}</li>}
          <li>{t('importFeedback.includedDetails')}</li>
        </ul>
      </details>
      {status === 'error' && (
        <p role="alert" className="mt-2 text-danger">
          {errorText}
        </p>
      )}
    </section>
  );
}
