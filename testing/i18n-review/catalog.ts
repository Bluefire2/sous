/**
 * The app's UI catalogs, for finding controls by their label in the language
 * being captured. The app has no test ids; a control's catalog text is its
 * stable name in every language.
 */
import { en } from '../../src/i18n/en.ts';
import { ru } from '../../src/i18n/ru.ts';
import { uk } from '../../src/i18n/uk.ts';
import { zhHans } from '../../src/i18n/zh-Hans.ts';

export const LANGS = ['en', 'uk', 'ru', 'zh-Hans'] as const;
export type Lang = (typeof LANGS)[number];
export const TARGET_LANGS: readonly Lang[] = ['uk', 'ru', 'zh-Hans'];

export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  'zh-Hans': 'Simplified Chinese',
};

export type MessageKey = keyof typeof en;

/** Each value is a string or, for a plural key, an object of plural forms. */
export const CATALOGS: Record<Lang, Record<MessageKey, unknown>> = { en, uk, ru, 'zh-Hans': zhHans };

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

/** A plain catalog string with `{name}` params filled. Plural keys are not labels and throw. */
export function label(lang: Lang, key: MessageKey, params: Record<string, string | number> = {}): string {
  const value = CATALOGS[lang][key];
  if (typeof value !== 'string') {
    throw new Error(`${key} is not a plain string in ${lang}`);
  }
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * Matches a key's text in any of its forms (each plural form, with every
 * `{param}` matching any text), for waiting on text whose values a state does
 * not fix.
 */
export function pattern(lang: Lang, key: MessageKey): RegExp {
  const value = CATALOGS[lang][key];
  const forms = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
  const escaped = forms.map((form) =>
    form
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+?'),
  );
  return new RegExp(escaped.join('|'));
}
