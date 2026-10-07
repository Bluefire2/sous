import { formatDistance, type Locale as DateFnsLocale } from 'date-fns';
import { enUS, ru, uk, zhCN } from 'date-fns/locale';
import { translate } from '../i18n';
import type { Locale } from '../i18n/lang';
import { settings } from './settings';

// date-fns 4.4.0 writes the genitive singular of "day" as "днi" with a Latin
// "i" (U+0069), not Cyrillic "і" (U+0456): `xDays.singularGenitive` in
// date-fns/locale/uk/_lib/formatDistance.js, line 151 (line 154 of the .cjs),
// still there in 5.0.0-alpha.0. So "4 днi тому" for 2–4, 22–24, … days.
// Swap a Latin "i" that touches a Cyrillic letter; drop this once upstream
// ships the fix.
const LATIN_I_IN_CYRILLIC = /(?<=\p{Script=Cyrillic})i|i(?=\p{Script=Cyrillic})/gu;

const ukCyrillic: DateFnsLocale = {
  ...uk,
  formatDistance: (token, count, options) =>
    uk.formatDistance(token, count, options).replace(LATIN_I_IN_CYRILLIC, '\u0456'),
};

const DATE_FNS_LOCALES: Readonly<Record<Locale, DateFnsLocale>> = {
  en: enUS,
  uk: ukCyrillic,
  ru,
  'zh-Hans': zhCN,
};

/** date-fns locale for a UI language; every supported language has one. */
export function dateFnsLocale(locale: Locale): DateFnsLocale {
  return DATE_FNS_LOCALES[locale];
}

/**
 * Past relative time for the invitations menu. date-fns picks the unit
 * (minutes, hours, days, and beyond) from the delta. A future or unusable
 * timestamp stays "just now", so a row never reads as upcoming and a bad
 * value cannot throw through the admin list.
 */
export function relativeAgoLabel(
  at: number,
  now: number = Date.now(),
  locale: Locale = settings.getLocale(),
): string {
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) {
    return translate(locale, 'time.justNow');
  }
  return formatDistance(at, now, { addSuffix: true, locale: dateFnsLocale(locale) });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Last cooked 3 days ago" for a cook log's `cookedOn` (`YYYY-MM-DD`, the
 * person's local date, never an instant). Counted in whole local days:
 * both dates go to UTC midnight, so a daylight-saving change can't make
 * yesterday read as "about 23 hours ago". Today, or a date after today,
 * is "today". `undefined` for a malformed date.
 */
export function lastCookedLabel(
  cookedOn: string,
  now: number = Date.now(),
  locale: Locale = settings.getLocale(),
): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cookedOn);
  if (!match || !Number.isFinite(now)) return undefined;
  const cooked = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const local = new Date(now);
  const today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
  if (!Number.isFinite(cooked)) return undefined;
  if (today - cooked < DAY_MS) {
    return translate(locale, 'library.lastCookedToday');
  }
  const time = formatDistance(cooked, today, {
    addSuffix: true,
    locale: dateFnsLocale(locale),
  });
  return translate(locale, 'library.lastCooked', { time });
}

/** Future timestamp for an unused invite link ("expires in 7 days"). */
export function relativeExpiryLabel(
  at: number,
  now: number = Date.now(),
  locale: Locale = settings.getLocale(),
): string {
  const base = Number.isFinite(now) ? now : Date.now();
  // date-fns reads an equal instant as past; a 1 ms lead keeps the future wording.
  const target = Number.isFinite(at) && at > base ? at : base + 1;
  const distance = formatDistance(target, base, {
    addSuffix: true,
    locale: dateFnsLocale(locale),
  });
  return translate(locale, 'time.expiresIn', { in: distance });
}
