import { useEffect } from 'react';
import { useWakeLockSetting } from './useDeviceSettings';

/**
 * Keeps the screen awake while the component is mounted (iOS Safari 16.4+),
 * unless Settings → Cooking turned that off on this device. Re-acquires the
 * lock when the page becomes visible again, since the browser releases it on
 * tab switch / screen off. Turning the setting off releases a held lock.
 */
export function useWakeLock(): void {
  const enabled = useWakeLockSetting();

  useEffect(() => {
    if (!enabled) return;
    let sentinel: WakeLockSentinel | null = null;
    let active = true;

    const request = async () => {
      if (!('wakeLock' in navigator)) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (active) {
          sentinel = next;
        } else {
          // The screen closed or the setting went off while the request was pending.
          void next.release();
        }
      } catch {
        // Denied (e.g. low battery mode) — nothing to do.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, [enabled]);
}
