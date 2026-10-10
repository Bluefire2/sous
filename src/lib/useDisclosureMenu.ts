import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';

/**
 * Open state, focus, and dismissal for a small menu disclosed by a trigger
 * button (the Library language menu, the collection actions menu). The
 * component renders the trigger, backdrop, and panel; this wires them up.
 */
export function useDisclosureMenu<Item extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The item that takes focus when the menu opens. */
  const initialItemRef = useRef<Item>(null);

  /** Closes the menu and returns focus to the trigger. */
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  /**
   * Closes the menu, then runs the chosen item's action. Focus is on the
   * trigger before the action runs, so a sheet the action opens records the
   * trigger as its opener, not the item that unmounts with the menu.
   */
  const choose = (action: () => void) => {
    close();
    action();
  };

  useEffect(() => {
    if (!open) return;
    initialItemRef.current?.focus({ preventScroll: true });
    // Capture phase, and stopped, so Library's own Escape handling (closing a
    // recipe menu, leaving Select) does not also run. Only while focus is in
    // the menu: an Escape meant for something else (a sheet opened from
    // Select's bar) closes the menu and passes through.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!wrapperRef.current?.contains(document.activeElement)) {
        setOpen(false);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // Focus leaving the menu (Tab, or a tap on something above the backdrop,
  // such as Select's bar) closes it, so it can't stay open under a sheet.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) {
      setOpen(false);
    }
  };

  const triggerProps = {
    ref: triggerRef,
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    onClick: () => setOpen((value) => !value),
  };

  return { open, panelId, wrapperRef, initialItemRef, triggerProps, close, choose, onBlur };
}
