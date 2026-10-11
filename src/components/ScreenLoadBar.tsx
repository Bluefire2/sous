import { useT } from '../i18n';
import { useScreenLoadPending } from '../lib/chunkReload';
import { useDelayedFlag } from '../lib/useDelayedFlag';

/**
 * A thin bar along the top while a screen's chunk loads. Navigation runs in a
 * transition, so the old screen stays up meanwhile; without this a tap on a
 * slow network shows nothing (docs/plans/route-code-splitting.md). Hidden for
 * a load under 200 ms.
 */
export default function ScreenLoadBar() {
  const t = useT();
  const visible = useDelayedFlag(useScreenLoadPending(), 200);
  if (!visible) return null;
  return (
    <div
      role="progressbar"
      aria-label={t('common.loading')}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden"
    >
      <div className="h-full w-1/3 animate-screen-load bg-ink-muted motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}
