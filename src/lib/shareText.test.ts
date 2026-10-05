import { describe, expect, it } from 'vitest';
import { shareOrCopy, type ShareNavigator } from './shareText';

const DATA = { title: 'Shakshuka', text: 'Shakshuka\n4 servings' };

function fakeNavigator(options: {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
  writeText?: (text: string) => Promise<void>;
}): ShareNavigator & { calls: string[] } {
  const calls: string[] = [];
  const nav: ShareNavigator & { calls: string[] } = { calls };
  if (options.share) {
    const share = options.share;
    nav.share = (data) => {
      calls.push('share');
      return share(data);
    };
  }
  if (options.canShare) nav.canShare = options.canShare;
  if (options.writeText) {
    const writeText = options.writeText;
    nav.clipboard = {
      writeText: (text) => {
        calls.push(`copy:${text}`);
        return writeText(text);
      },
    };
  }
  return nav;
}

const abort = () => Promise.reject(new DOMException('Share canceled', 'AbortError'));
const refuse = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
const ok = () => Promise.resolve();

describe('shareOrCopy', () => {
  it('opens the share sheet when the browser accepts the text', async () => {
    const nav = fakeNavigator({ share: ok, canShare: () => true, writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('shared');
    expect(nav.calls).toEqual(['share']);
  });

  it('is silent when the person closes the share sheet', async () => {
    const nav = fakeNavigator({ share: abort, canShare: () => true, writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('cancelled');
    expect(nav.calls).toEqual(['share']);
  });

  it('copies when there is no share sheet', async () => {
    const nav = fakeNavigator({ writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('copied');
    expect(nav.calls).toEqual([`copy:${DATA.text}`]);
  });

  it('copies when the share sheet does not accept the text', async () => {
    const nav = fakeNavigator({ share: ok, canShare: () => false, writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('copied');
    expect(nav.calls).toEqual([`copy:${DATA.text}`]);
  });

  it('copies when share exists without canShare', async () => {
    const nav = fakeNavigator({ share: ok, writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('copied');
  });

  it('copies when the share sheet fails for another reason', async () => {
    const nav = fakeNavigator({ share: refuse, canShare: () => true, writeText: ok });
    expect(await shareOrCopy(nav, DATA)).toBe('copied');
    expect(nav.calls).toEqual(['share', `copy:${DATA.text}`]);
  });

  it('fails when the copy is refused or there is no clipboard', async () => {
    expect(await shareOrCopy(fakeNavigator({ writeText: refuse }), DATA)).toBe('failed');
    expect(await shareOrCopy(fakeNavigator({}), DATA)).toBe('failed');
  });

  it('treats a throwing canShare as no share sheet', async () => {
    const nav = fakeNavigator({
      share: ok,
      canShare: () => {
        throw new TypeError('bad data');
      },
      writeText: ok,
    });
    expect(await shareOrCopy(nav, DATA)).toBe('copied');
  });
});
