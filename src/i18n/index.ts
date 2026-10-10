import { useCallback, useSyncExternalStore } from 'react';
import { settings } from '../lib/settings';
import { en, type MessageKey, type Messages, type PluralForms } from './en';
import type { Locale } from './lang';
import { ru } from './ru';
import { uk } from './uk';
import { zhHans } from './zh-Hans';

export type { Messages, MessageKey, PluralForms, PluralKey, TextKey } from './en';
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLang,
  primaryLanguage,
  sameLanguage,
  toSupportedLocale,
  type LanguageComparison,
  type Locale,
} from './lang';

export const CATALOGS: Readonly<Record<Locale, Messages>> = {
  en,
  uk,
  ru,
  'zh-Hans': zhHans,
};

export type TranslateParams = Readonly<Record<string, string | number>>;

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralRulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();

/** Locale-aware number for display; grouping is off because quantities read as one token. */
export function formatNumber(value: number, locale: Locale): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false });
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

function selectPlural(forms: PluralForms, count: number, locale: Locale): string {
  const category = pluralRulesFor(locale).select(count);
  return forms[category] ?? forms.other;
}

function interpolate(template: string, params: TranslateParams | undefined, locale: Locale): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      return match;
    }
    return typeof value === 'number' ? formatNumber(value, locale) : value;
  });
}

/**
 * Looks up `key` in the catalog for `locale`. A plural key needs a numeric
 * `count` param, which also selects the form. Placeholders are `{name}`;
 * number params are formatted for the locale.
 */
export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const entry: string | PluralForms = CATALOGS[locale][key];
  if (typeof entry === 'string') {
    return interpolate(entry, params, locale);
  }
  const count = params?.count;
  const template = selectPlural(entry, typeof count === 'number' ? count : Number.NaN, locale);
  return interpolate(template, params, locale);
}

/** `translate` for the current UI language. Outside React; components use `useT()`. */
export function t(key: MessageKey, params?: TranslateParams): string {
  return translate(settings.getLocale(), key, params);
}

/** Name of a language tag in the UI language (`it` → "Italian" / "італійська"); `undefined` when unknown. */
export function languageName(tag: string, uiLocale: Locale): string | undefined {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language', fallback: 'none' }).of(tag) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A UI language's own name as a standalone label, first letter capitalized
 * ("Українська", "Русский"). `Intl.DisplayNames` gives the mid-sentence form.
 */
export function localeDisplayName(locale: Locale): string {
  const name = languageName(locale, locale) ?? locale;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

function getLocaleSnapshot(): Locale {
  return settings.getLocale();
}

/** Current UI language; re-renders on `settings.setLocale`. */
export function useLocale(): Locale {
  return useSyncExternalStore(settings.subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
}

/** `t` bound to the current UI language; a new function after each locale change. */
export function useT(): (key: MessageKey, params?: TranslateParams) => string {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, params?: TranslateParams) => translate(locale, key, params),
    [locale],
  );
}
