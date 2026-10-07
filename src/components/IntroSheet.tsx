import { useEffect, useId, useRef, type ComponentType } from 'react';
import { useT, type TextKey } from '../i18n';
import { CameraIcon, ChatBubbleIcon, InviteIcon, PlusIcon, PotIcon } from '../lib/icons';
import { INTRO_STEP_COUNT } from '../lib/libraryFlow';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';
import Sheet from './Sheet';

type IntroStep = {
  Icon: ComponentType<{ className?: string }>;
  title: TextKey;
  body: TextKey;
};

// Steps 3 and 4 show the header icons they point to (the assistant's chat
// bubble, the invite person-with-plus), so the member can spot them.
const STEPS: readonly IntroStep[] = [
  { Icon: CameraIcon, title: 'intro.importTitle', body: 'intro.importBody' },
  { Icon: PotIcon, title: 'intro.cookTitle', body: 'intro.cookBody' },
  { Icon: ChatBubbleIcon, title: 'intro.assistantTitle', body: 'intro.assistantBody' },
  { Icon: InviteIcon, title: 'intro.shareTitle', body: 'intro.shareBody' },
  { Icon: PlusIcon, title: 'intro.readyTitle', body: 'intro.readyBody' },
];

/**
 * The new-member intro (`docs/plans/new-member-intro.md`): one step at a
 * time in a Library sheet. Library owns the step (the `intro` sheet in
 * `libraryFlow`) and what closing does; every way out calls `onClose`, and
 * the last step's Import a recipe calls `onImport` instead, and its Do it
 * later is another close.
 */
export default function IntroSheet({
  step,
  onStep,
  onClose,
  onImport,
}: {
  step: number;
  onStep: (step: number) => void;
  onClose: () => void;
  onImport: () => void;
}) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const counterId = useId();
  const shownStep = useRef(step);
  const { Icon, title, body } = STEPS[step] ?? STEPS[0];
  const last = step >= INTRO_STEP_COUNT - 1;

  // On open the dialog focuses this heading (data-autofocus) and is labelled
  // by it. On a step change, move focus to the new heading so it is read out,
  // with the step counter as its description.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  return (
    <Sheet onClose={onClose}>
      <div className="flex items-baseline justify-between gap-3 text-sm text-ink-muted">
        <p>{t('intro.welcome')}</p>
        <p id={counterId}>{t('intro.stepOf', { n: step + 1, total: INTRO_STEP_COUNT })}</p>
      </div>
      <Icon className="mt-4 block h-8 w-8 text-ink-muted" />
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-autofocus
        aria-describedby={counterId}
        className="mt-2 text-lg font-semibold outline-none"
      >
        {t(title)}
      </h2>
      <p className="mt-1 text-ink-muted">{t(body)}</p>
      <div className="mt-4 flex justify-center gap-1.5" aria-hidden="true">
        {STEPS.map((_, index) => (
          <span
            key={index}
            className={`block h-1.5 w-1.5 rounded-full ${index === step ? 'bg-ink' : 'bg-line-strong'}`}
          />
        ))}
      </div>
      {last ? (
        <>
          <button type="button" onClick={onImport} className={`${primaryBtn} mt-4 block w-full py-3`}>
            {t('intro.importCta')}
          </button>
          <button type="button" onClick={onClose} className={`${secondaryBtn} mt-2 block w-full py-3`}>
            {t('intro.later')}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => onStep(step + 1)}
          className={`${primaryBtn} mt-4 block w-full py-3`}
        >
          {t('intro.next')}
        </button>
      )}
      <div className="mt-2 flex justify-between">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => onStep(step - 1)}
            className="px-1 py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('intro.back')}
          </button>
        ) : (
          <span />
        )}
        {!last && (
          <button
            type="button"
            onClick={onClose}
            className="px-1 py-2.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('intro.skip')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
