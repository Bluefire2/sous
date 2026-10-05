import { useEffect, useState } from 'react';
import { decideSyncToast, onSyncFinished } from '../lib/syncEngine';

export default function SyncToast() {
  const [toast, setToast] = useState<{
    id: number;
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    return onSyncFinished((result) => {
      const spec = decideSyncToast(result);
      if (spec === null) {
        return;
      }
      // Reset shown in the same batch so a replacement toast's first commit
      // renders hidden and animates in; the old pill unmounts in that commit
      // (key change), so it never flashes.
      setShown(false);
      setToast((prev) => ({ id: (prev?.id ?? 0) + 1, ...spec }));
    });
  }, []);

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
      className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-30 flex justify-center px-4 print:hidden"
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
