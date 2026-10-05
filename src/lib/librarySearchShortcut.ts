/** The parts of a `keydown` event the Library search shortcut reads. */
export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when a key pressed with this target would go into a field. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const { tagName, isContentEditable } = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  return (
    (typeof tagName === 'string' && TYPING_TAGS.has(tagName.toUpperCase())) ||
    isContentEditable === true
  );
}

/**
 * Whether `/` should move focus to the Library search. Shift is allowed,
 * because several layouts (German, and the Ukrainian and Russian ones) need
 * it to type `/`; Ctrl, Alt and Meta are not, so browser and OS shortcuts
 * keep working. A `/` typed into any field, during IME composition, or while
 * a sheet or menu is open is left alone.
 */
export function isLibrarySearchShortcut(
  event: ShortcutKeyEvent,
  overlayOpen: boolean,
): boolean {
  return (
    event.key === '/' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing &&
    !event.defaultPrevented &&
    !overlayOpen &&
    !isTypingTarget(event.target)
  );
}
