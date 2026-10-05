import { useEffect, useState } from 'react';

export type Notice = {
  id: number;
  kind: 'success' | 'error';
  message: string;
};

/**
 * Result pill for a screen's own action: the library's invite link, a
 * recipe copied as text. Timers and pill classes match SyncToast, and it
 * sits one pill below it. The parent bumps `notice.id` for each new
 * message; this component keeps the live region mounted and clears the
 * pill on its own timer so a faded toast does not clear the screen's state
 * (such as the library's revealed URL).
 */
export default function NoticeToast({ notice }: { notice: Notice | null }) {
  const [toast, setToast] = useState<Notice | null>(null);
  const [shown, setShown] = useState(false);
  const [seenId, setSeenId] = useState<number | null>(null);

  if (notice !== null && notice.id !== seenId) {
    setSeenId(notice.id);
    setShown(false);
    setToast(notice);
  }

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const duration = toast.kind === 'error' ? 5000 : 2500;
    const frame = requestAnimationFrame(() => setShown(true));
    // Start the fade-out one transition (200ms, matching duration-200) before
    // the toast clears.
    const fade = window.setTimeout(() => setShown(false), duration - 200);
    const clear = window.setTimeout(() => setToast(null), duration);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [toast]);

  // The live region stays mounted even when empty — a region inserted
  // together with its text is unreliably announced. key={toast.id} makes two
  // consecutive identical messages re-announce.
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+2.75rem)] z-30 flex justify-center px-4 print:hidden"
    >
      {toast !== null && (
        <p
          key={toast.id}
          className={`max-w-full rounded-full px-4 py-2 text-center text-sm font-medium shadow-lg transition-all duration-200 motion-reduce:transition-none ${
            shown ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
          } ${toast.kind === 'error' ? 'bg-danger-fill text-white' : 'bg-ink text-page'}`}
        >
          {toast.message}
        </p>
      )}
    </div>
  );
}
