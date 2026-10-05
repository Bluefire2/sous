import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';

const OPENER_SELECTOR = 'button, a, input, textarea, select';

let lastOpener: HTMLElement | null = null;

function recordOpener(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const opener = target.closest(OPENER_SELECTOR);
  if (opener instanceof HTMLElement) lastOpener = opener;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', recordOpener, true);
  document.addEventListener('click', recordOpener, true);
}

function DialogFrame({
  onClose,
  dismissible,
  backdropLabel,
  overlayClassName,
  panelClassName,
  labelId,
  headingId,
  onLabel,
  openerRef,
  panelRef,
  children,
}: {
  onClose: () => void;
  dismissible: boolean;
  backdropLabel: string;
  overlayClassName: string;
  panelClassName: string;
  labelId: string | undefined;
  headingId: string;
  onLabel: (id: string | undefined) => void;
  openerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let opener: HTMLElement | null = null;
    if (lastOpener && !shell.contains(lastOpener)) opener = lastOpener;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !shell.contains(active)
    ) {
      opener = active;
    }
    openerRef.current = opener;
  }, [openerRef]);

  useEffect(() => {
    // Runs after FocusScope's effect, so this bubble listener is registered
    // second and runs after the trap. A control that disables itself (Share,
    // Delete, save) moves focus to body. The trap's last-focused node is that
    // disabled control, or still null when autoFocus beat the trap's listener,
    // so its focusin handler cannot pull focus back. The next Tab then leaves
    // the sheet. Cleanup removes this listener before FocusScope's unmount
    // timeout, so close can still focus the opener.
    const pullFocusInside = () => {
      const panel = panelRef.current;
      if (!panel?.isConnected) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || panel.contains(active)) return;
      panel.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', pullFocusInside);
    return () => document.removeEventListener('focusin', pullFocusInside);
  }, [panelRef]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const heading = panel.querySelector('h1, h2, h3');
    if (!(heading instanceof HTMLElement)) {
      onLabel(undefined);
      return;
    }
    if (!heading.id) heading.id = headingId;
    onLabel(heading.id);
  }, [children, headingId, onLabel, panelRef]);

  const focusOnOpen = (event: Event) => {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    // React focuses an `autoFocus` control itself and never renders the
    // attribute; `data-autofocus` marks a non-control, such as a heading.
    for (const candidate of panel.querySelectorAll('[autofocus], [data-autofocus]')) {
      if (candidate instanceof HTMLElement && !candidate.matches(':disabled')) {
        candidate.focus();
        return;
      }
    }
    panel.focus({ preventScroll: true });
  };

  const restoreOpener = (event: Event) => {
    event.preventDefault();
    // StrictMode replays the mount effect. FocusScope defers this handler
    // with a timeout, and that replay runs while the sheet is still open.
    // Focusing the opener then leaves Tab on the page underneath. A real
    // close has already detached the panel, or cleared this ref.
    if (panelRef.current?.isConnected) return;
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus();
  };

  const onEscape = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dismissible) onClose();
  };

  const swallowOutside = (event: { preventDefault(): void }) => {
    event.preventDefault();
  };

  return (
    <div ref={shellRef} className={overlayClassName} style={{ pointerEvents: 'auto' }}>
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label={backdropLabel}
        tabIndex={-1}
        disabled={!dismissible}
        onClick={onClose}
      />
      <Dialog.Content
        ref={panelRef}
        className={panelClassName}
        aria-modal={true}
        aria-labelledby={labelId}
        onOpenAutoFocus={focusOnOpen}
        onCloseAutoFocus={restoreOpener}
        onEscapeKeyDown={onEscape}
        onPointerDownOutside={swallowOutside}
        onInteractOutside={swallowOutside}
      >
        {children}
      </Dialog.Content>
    </div>
  );
}

export default function DialogShell({
  onClose,
  dismissible = true,
  backdropLabel,
  overlayClassName,
  panelClassName,
  children,
}: {
  onClose: () => void;
  dismissible?: boolean;
  backdropLabel: string;
  overlayClassName: string;
  panelClassName: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const [labelId, setLabelId] = useState<string | undefined>(undefined);

  return (
    <Dialog.Root
      open
      modal
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
    >
      <Dialog.Portal>
        <DialogFrame
          onClose={onClose}
          dismissible={dismissible}
          backdropLabel={backdropLabel}
          overlayClassName={overlayClassName}
          panelClassName={panelClassName}
          labelId={labelId}
          headingId={headingId}
          onLabel={setLabelId}
          openerRef={openerRef}
          panelRef={panelRef}
        >
          {children}
        </DialogFrame>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
