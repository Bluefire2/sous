export function chipClass(active: boolean): string {
  return active
    ? 'rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-page'
    : 'rounded-full bg-surface-muted px-3 py-1.5 text-sm text-ink-muted hover:bg-surface hover:text-ink';
}

export const inputFocus =
  'outline-none focus:border-ink-subtle focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

export const inputClass = `w-full rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm ${inputFocus}`;

export const cellClass = `min-w-0 rounded-lg border border-line px-2 py-1.5 ${inputFocus}`;

export const primaryBtn =
  'rounded-full bg-ink font-medium text-page hover:enabled:opacity-90 active:enabled:opacity-90 disabled:opacity-40';

export const secondaryBtn =
  'rounded-full border border-line-strong font-medium text-ink-muted hover:bg-surface-muted active:bg-surface-muted';

export const ghostBtn =
  'rounded-full px-3 py-1 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted';

/** Round icon-only button for the Library header. Not `ghostBtn` plus `p-2`: its `px-3` would win. */
export const ghostIconBtn =
  'inline-flex items-center justify-center rounded-full p-2 text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted';

export const backLink = 'text-sm text-ink-muted hover:text-ink';

export const iconBtn =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted disabled:opacity-30';

export const addBtn =
  'rounded-full border border-line-strong px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted active:bg-surface-muted';

export const addBtnDanger =
  'rounded-full border border-line-strong px-3 py-1.5 text-sm text-danger hover:bg-danger-bg active:bg-danger-bg';

export const menuItem =
  'block w-full px-4 py-3 text-left hover:bg-surface-muted active:bg-surface-muted';

export const menuItemDanger =
  'block w-full px-4 py-3 text-left text-danger hover:bg-danger-bg active:bg-danger-bg';

export const dangerBtn =
  'rounded-full bg-danger-fill font-medium text-white hover:bg-danger-fill-hover active:bg-danger-fill-hover';
