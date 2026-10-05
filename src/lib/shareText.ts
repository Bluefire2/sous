/** The parts of `navigator` that sharing text uses; each may be missing in a given browser. */
export interface ShareNavigator {
  share?: Navigator['share'];
  canShare?: Navigator['canShare'];
  clipboard?: Pick<Clipboard, 'writeText'>;
}

/**
 * `shared`: the share sheet took it. `copied`: it went to the clipboard
 * instead. `cancelled`: the person closed the share sheet, which says
 * nothing. `failed`: neither worked.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Opens the system share sheet when the browser has one that accepts this
 * text, and otherwise copies the text. A share sheet that fails for another
 * reason (no user activation left, a refused target) falls back to the copy.
 */
export async function shareOrCopy(
  nav: ShareNavigator,
  data: { title: string; text: string },
): Promise<ShareOutcome> {
  let canShare = false;
  try {
    canShare = typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare(data);
  } catch {
    canShare = false;
  }
  if (canShare) {
    try {
      await nav.share?.(data);
      return 'shared';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
    }
  }
  if (nav.clipboard === undefined || typeof nav.clipboard.writeText !== 'function') {
    return 'failed';
  }
  try {
    await nav.clipboard.writeText(data.text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
