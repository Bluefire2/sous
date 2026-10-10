import { useId, type ReactNode } from 'react';
import { useT } from '../i18n';
import { PUBLIC_RETURN_PATH, rememberPublicReturn } from '../lib/publicApi';
import type { PublicMemberAction } from '../lib/usePublicJoin';
import { signInHref } from '../lib/session';
import { primaryBtn, secondaryBtn } from '../lib/uiClasses';
import Sheet from './Sheet';

/**
 * AI controls on a public page (`docs/plans/public-collections.md`). A
 * visitor sees them grayed out. Hover or keyboard focus shows why; a tap
 * (touch has no hover) opens the sign-in sheet. Nothing here calls an AI
 * route: the visitor never reaches one.
 */

const TOOLTIP_PLACEMENT = {
  'below-end': 'right-0 top-full mt-2',
  'below-start': 'left-0 top-full mt-2',
  'above-end': 'right-0 bottom-full mb-2',
} as const;

export function LockedAiButton({
  label,
  hint,
  onOpen,
  className,
  wrapperClassName = 'relative',
  placement,
  children,
}: {
  /** The control's own name (Ask, Translate); the lock reason is its description. */
  label?: string;
  /** Why it is locked: `public.aiLocked` for a visitor, `public.aiLockedMember` for a member. */
  hint: string;
  onOpen: () => void;
  className: string;
  /** Positions the control and anchors its tooltip; `relative` unless it floats (`fixed …`). */
  wrapperClassName?: string;
  placement: keyof typeof TOOLTIP_PLACEMENT;
  children: ReactNode;
}) {
  const tipId = useId();
  return (
    <span className={`group inline-flex ${wrapperClassName}`}>
      <button
        type="button"
        aria-label={label}
        aria-disabled="true"
        aria-describedby={tipId}
        onClick={onOpen}
        className={className}
      >
        {children}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={`pointer-events-none invisible absolute z-20 w-max max-w-56 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-page opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 ${TOOLTIP_PLACEMENT[placement]}`}
      >
        {hint}
      </span>
    </span>
  );
}

/** Grayed versions of the AI controls' usual looks. */
export const lockedAskBtn =
  'flex h-14 items-center gap-2 rounded-full border border-line bg-surface-muted px-5 font-medium text-ink-subtle shadow-lg hover:bg-surface active:bg-surface';

export const lockedChipBtn =
  'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-muted px-3 py-1.5 text-left text-sm font-medium text-ink-subtle shadow-sm hover:bg-surface active:bg-surface';

/**
 * Sign-in link for a public page. It returns to `/p`, and the token waits in
 * sessionStorage, so the token never rides the OAuth round trip.
 */
export function PublicSignInLink({
  token,
  className,
  children,
}: {
  token: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      href={signInHref(PUBLIC_RETURN_PATH)}
      onClick={() => rememberPublicReturn(token)}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * What a tap on a locked AI control opens. A visitor is asked to sign in. A
 * signed-in member is offered the page's action: add the collection (AI on a
 * shared recipe runs through their grant, which a public link alone does not
 * give), or save a copy of a link's recipe (AI then runs on their own copy).
 */
export function AiLockedSheet({
  token,
  member,
  subject,
  action,
  onClose,
}: {
  token: string;
  member: boolean;
  subject: 'collection' | 'recipe';
  action: PublicMemberAction;
  onClose: () => void;
}) {
  const t = useT();
  const busy = action.state.kind === 'busy';
  const recipe = subject === 'recipe';
  const memberTitle = recipe ? t('public.memberAiRecipeTitle') : t('public.memberAiTitle');
  const memberBody = recipe ? t('public.memberAiRecipeBody') : t('public.memberAiBody');
  const actionLabel = recipe
    ? busy
      ? t('public.saving')
      : t('public.saveCopy')
    : busy
      ? t('public.adding')
      : t('public.addToLibrary');
  return (
    <Sheet onClose={onClose} dismissible={!busy}>
      <h2 className="text-lg font-semibold">{member ? memberTitle : t('public.signInTitle')}</h2>
      <p className="mt-2 text-sm text-ink-muted">{member ? memberBody : t('public.signInBody')}</p>
      {member ? (
        <>
          {action.state.kind === 'error' && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {action.state.message}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void action.run()}
            className={`${primaryBtn} mt-4 w-full py-3`}
          >
            {actionLabel}
          </button>
        </>
      ) : (
        <PublicSignInLink
          token={token}
          className={`${primaryBtn} mt-4 block w-full py-3 text-center`}
        >
          {t('public.signInWithGoogle')}
        </PublicSignInLink>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onClose}
        className={`${secondaryBtn} mt-2 w-full py-3 disabled:opacity-40`}
      >
        {t('public.notNow')}
      </button>
    </Sheet>
  );
}
