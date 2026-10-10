import { useState } from 'react';
import { useT } from '../i18n';
import { ThumbDownIcon, ThumbUpIcon } from '../lib/icons';
import { ratingUp, type FeedbackCardInput } from '../lib/importFeedback';
import { sendImportFeedback } from '../lib/importFeedbackApi';
import ImportFeedbackCard from './ImportFeedbackCard';

/** Smaller than `ghostIconBtn`: a footnote under Save, not a header control. */
const ratingIconBtn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted';

export default function ImportFeedbackRating({
  input,
}: {
  input: Omit<FeedbackCardInput, 'trigger'>;
}) {
  const t = useT();
  const [choice, setChoice] = useState<'ask' | 'up' | 'down'>('ask');

  if (choice === 'up') {
    return (
      <p role="status" className="mt-3 text-right text-xs text-ink-muted">
        {t('importFeedback.ratingThanks')}
      </p>
    );
  }
  if (choice === 'down') {
    return <ImportFeedbackCard input={{ ...input, trigger: 'down' }} />;
  }
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-ink-muted">
      <span>{t('importFeedback.ratingPrompt')}</span>
      <span className="inline-flex items-center">
        <button
          type="button"
          className={ratingIconBtn}
          aria-label={t('importFeedback.ratingUp')}
          onClick={() => {
            setChoice('up');
            // Best effort: a lost thumbs-up costs nothing, so the person sees no error.
            void sendImportFeedback(ratingUp(input.source)).catch(() => {});
          }}
        >
          <ThumbUpIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={ratingIconBtn}
          aria-label={t('importFeedback.ratingDown')}
          onClick={() => setChoice('down')}
        >
          <ThumbDownIcon className="h-4 w-4" />
        </button>
      </span>
    </div>
  );
}
