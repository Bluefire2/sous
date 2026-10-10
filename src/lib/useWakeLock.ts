import { useEffect } from 'react';
import { useWakeLockSetting } from './useDeviceSettings';
import { startWakeLock } from './wakeLockController';

/**
 * Keeps the screen awake while the component is mounted (iOS Safari 16.4+),
 * unless Settings → Cooking turned that off on this device. Re-acquires the
 * lock when the page becomes visible again, since the browser releases it on
 * tab switch / screen off. Turning the setting off releases a held lock.
 * The acquire and release rules are in `startWakeLock`.
 */
export function useWakeLock(): void {
  const enabled = useWakeLockSetting();

  useEffect(() => {
    if (!enabled) return;
    return startWakeLock({
      wakeLock: 'wakeLock' in navigator ? navigator.wakeLock : undefined,
      document,
    });
  }, [enabled]);
}
