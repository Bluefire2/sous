import { formatDistance } from 'date-fns';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  dateFnsLocale,
  lastCookedLabel,
  relativeAgoLabel,
  relativeExpiryLabel,
} from './relativeTime';
import { LOCALE_KEY } from './settings';

// The default locale comes from `cook.locale`, then the browser language, so
// the English cases below pin the stored locale instead of trusting the
// machine's `navigator.language`.
beforeAll(() => {
  const store = new Map<string, string>([[LOCALE_KEY, 'en']]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

describe('relativeAgoLabel', () => {
  const now = 1_000_000_000_000;

  it("is 'just now' for a future or unusable timestamp", () => {
    expect(relativeAgoLabel(now + 1, now)).toBe('just now');
    expect(relativeAgoLabel(now + 5 * 60_000, now)).toBe('just now');
    expect(relativeAgoLabel(Number.NaN, now)).toBe('just now');
    expect(relativeAgoLabel(now, Number.NaN)).toBe('just now');
  });

  it('switches unit at the date-fns boundaries', () => {
    expect(relativeAgoLabel(now - 29_999, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 30_000, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 89_999, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 90_000, now)).toBe('2 minutes ago');
    expect(relativeAgoLabel(now - (44 * 60_000 + 29_000), now)).toBe('44 minutes ago');
    expect(relativeAgoLabel(now - (44 * 60_000 + 30_000), now)).toBe('about 1 hour ago');
    expect(relativeAgoLabel(now - ((23 * 60 + 59) * 60_000 + 30_000), now)).toBe('1 day ago');
    expect(relativeAgoLabel(now - 30 * 24 * 60 * 60_000, now)).toBe('about 1 month ago');
  });

  it('uses minutes, hours, and days as the delta grows', () => {
    expect(relativeAgoLabel(now, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 20_000, now)).toBe('less than a minute ago');
    expect(relativeAgoLabel(now - 60_000, now)).toBe('1 minute ago');
    expect(relativeAgoLabel(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeAgoLabel(now - 3 * 60 * 60_000, now)).toBe('about 3 hours ago');
    expect(relativeAgoLabel(now - 10112 * 60_000, now)).toBe('7 days ago');
    expect(relativeAgoLabel(now - 11828 * 60_000, now)).toBe('8 days ago');
  });

  it('speaks the UI language, including the "just now" fallback', () => {
    const sevenDays = now - 7 * 24 * 60 * 60_000;
    expect(relativeAgoLabel(sevenDays, now, 'en')).toBe('7 days ago');
    expect(relativeAgoLabel(sevenDays, now, 'uk')).toBe('7 днів тому');
    expect(relativeAgoLabel(sevenDays, now, 'ru')).toBe('7 дней назад');
    expect(relativeAgoLabel(sevenDays, now, 'zh-Hans')).toBe('7 天前');
    expect(relativeAgoLabel(now + 1, now, 'uk')).toBe('щойно');
    expect(relativeAgoLabel(now + 1, now, 'ru')).toBe('только что');
    expect(relativeAgoLabel(now + 1, now, 'zh-Hans')).toBe('刚刚');
  });

  it('reads the UI language from settings when no locale is passed', () => {
    localStorage.setItem(LOCALE_KEY, 'uk');
    try {
      expect(relativeAgoLabel(now - 5 * 60_000, now)).toBe('5 хвилин тому');
    } finally {
      localStorage.setItem(LOCALE_KEY, 'en');
    }
  });
});

describe('relativeExpiryLabel', () => {
  const now = 1_000_000_000_000;

  it('describes the last minute, hours, and days', () => {
    expect(relativeExpiryLabel(now, now)).toBe('expires in less than a minute');
    expect(relativeExpiryLabel(now + 5 * 60_000, now)).toBe('expires in 5 minutes');
    expect(relativeExpiryLabel(now + 3 * 60 * 60_000, now)).toBe('expires in about 3 hours');
    expect(relativeExpiryLabel(now + 7 * 24 * 60 * 60_000, now)).toBe('expires in 7 days');
  });

  it('never reads as already past, and never throws on a bad value', () => {
    expect(relativeExpiryLabel(now - 60 * 60_000, now)).toBe('expires in less than a minute');
    expect(relativeExpiryLabel(Number.NaN, now)).toBe('expires in less than a minute');
  });

  it('speaks the UI language', () => {
    const sevenDays = now + 7 * 24 * 60 * 60_000;
    expect(relativeExpiryLabel(sevenDays, now, 'uk')).toBe('закінчується за 7 днів');
    expect(relativeExpiryLabel(sevenDays, now, 'ru')).toBe('истекает через 7 дней');
    expect(relativeExpiryLabel(sevenDays, now, 'zh-Hans')).toBe('7 天内过期');
  });
});

describe('lastCookedLabel', () => {
  // Local wall-clock times, since `cookedOn` is the person's local date.
  const morning = new Date(2026, 9, 5, 0, 30).getTime();
  const evening = new Date(2026, 9, 5, 23, 30).getTime();

  it('is "today" for today and for a date after today', () => {
    expect(lastCookedLabel('2026-10-05', morning, 'en')).toBe('Last cooked today');
    expect(lastCookedLabel('2026-10-05', evening, 'en')).toBe('Last cooked today');
    expect(lastCookedLabel('2026-10-07', evening, 'en')).toBe('Last cooked today');
  });

  it('counts whole local days, whatever the time of day', () => {
    for (const now of [morning, evening]) {
      expect(lastCookedLabel('2026-10-04', now, 'en')).toBe('Last cooked 1 day ago');
      expect(lastCookedLabel('2026-10-02', now, 'en')).toBe('Last cooked 3 days ago');
      expect(lastCookedLabel('2026-09-14', now, 'en')).toBe('Last cooked 21 days ago');
    }
    expect(lastCookedLabel('2026-08-05', morning, 'en')).toBe('Last cooked 2 months ago');
    expect(lastCookedLabel('2025-09-01', morning, 'en')).toBe('Last cooked about 1 year ago');
  });

  it('crosses a daylight-saving change as whole days', () => {
    // The last Sunday of March moves clocks in Europe; the count is still days.
    const afterSpring = new Date(2026, 2, 30, 12, 0).getTime();
    expect(lastCookedLabel('2026-03-29', afterSpring, 'en')).toBe('Last cooked 1 day ago');
    expect(lastCookedLabel('2026-03-28', afterSpring, 'en')).toBe('Last cooked 2 days ago');
  });

  it('speaks the UI language', () => {
    expect(lastCookedLabel('2026-09-28', morning, 'uk')).toBe('Востаннє готували 7 днів тому');
    expect(lastCookedLabel('2026-09-28', morning, 'ru')).toBe('Последний раз готовили 7 дней назад');
    expect(lastCookedLabel('2026-09-28', morning, 'zh-Hans')).toBe('上次烹饪：7 天前');
    expect(lastCookedLabel('2026-10-05', morning, 'uk')).toBe('Востаннє готували сьогодні');
  });

  it('is undefined for a malformed date', () => {
    expect(lastCookedLabel('2026-10', morning, 'en')).toBeUndefined();
    expect(lastCookedLabel('yesterday', morning, 'en')).toBeUndefined();
    expect(lastCookedLabel('2026-10-01', Number.NaN, 'en')).toBeUndefined();
  });
});

describe('dateFnsLocale', () => {
  it('maps every UI language to a date-fns locale', () => {
    expect(dateFnsLocale('en').code).toBe('en-US');
    expect(dateFnsLocale('uk').code).toBe('uk');
    expect(dateFnsLocale('ru').code).toBe('ru');
    expect(dateFnsLocale('zh-Hans').code).toBe('zh-CN');
  });
});

describe('Ukrainian day counts', () => {
  // date-fns' uk locale spells "дні" with a Latin "i"; see relativeTime.ts.
  const MIXED_SCRIPT = /\p{Script=Cyrillic}\p{Script=Latin}|\p{Script=Latin}\p{Script=Cyrillic}/u;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 9, 6, 12).getTime();
  const dayCounts = [2, 3, 4, 22, 24];
  const localDate = (at: number) => {
    const d = new Date(at);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
      .map((part) => String(part).padStart(2, '0'))
      .join('-');
  };

  it.each(dayCounts)('%i days has no Latin letter inside a Cyrillic word', (days) => {
    const then = now - days * DAY_MS;
    const labels = [
      formatDistance(then, now, { locale: dateFnsLocale('uk') }),
      relativeAgoLabel(then, now, 'uk'),
      relativeExpiryLabel(now + days * DAY_MS, now, 'uk'),
      lastCookedLabel(localDate(then), now, 'uk') ?? '',
    ];
    for (const label of labels) {
      expect(label).toContain(`${days} дні`);
      expect(label).not.toMatch(MIXED_SCRIPT);
    }
  });

  it('reads "4 дні тому" and "за 3 дні" in Cyrillic', () => {
    expect(relativeAgoLabel(now - 4 * DAY_MS, now, 'uk')).toBe('4 дні тому');
    expect(formatDistance(now + 3 * DAY_MS, now, { addSuffix: true, locale: dateFnsLocale('uk') }))
      .toBe('за 3 дні');
  });

  it('leaves the other Ukrainian forms alone', () => {
    expect(relativeAgoLabel(now - DAY_MS, now, 'uk')).toBe('1 день тому');
    expect(relativeAgoLabel(now - 13 * DAY_MS, now, 'uk')).toBe('13 днів тому');
  });
});
