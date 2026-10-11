import { describe, expect, it } from 'vitest';
import { en, type PluralForms } from './en';
import {
  CATALOGS,
  formatNumber,
  languageName,
  localeDisplayName,
  translate,
} from './index';
import { SUPPORTED_LOCALES } from './lang';

const NON_ENGLISH = SUPPORTED_LOCALES.filter((locale) => locale !== 'en');

function isPlural(entry: string | PluralForms): entry is PluralForms {
  return typeof entry !== 'string';
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('catalog parity', () => {
  it('has a catalog for every supported locale and nothing else', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES)('%s has exactly the English key set', (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(NON_ENGLISH)('%s keeps plural keys plural and text keys text', (locale) => {
    for (const [key, entry] of Object.entries(en)) {
      const translated = CATALOGS[locale][key as keyof typeof en];
      expect(isPlural(translated), key).toBe(isPlural(entry));
    }
  });

  it.each(['uk', 'ru'] as const)('%s plural keys carry one, few, many, and other', (locale) => {
    for (const [key, entry] of Object.entries(CATALOGS[locale])) {
      if (!isPlural(entry)) {
        continue;
      }
      for (const form of ['one', 'few', 'many', 'other'] as const) {
        expect(entry[form], `${locale}.${key}.${form}`).toBeTruthy();
      }
    }
  });

  // A Latin letter that looks Cyrillic ("i" for "і") reads fine and breaks
  // search and screen readers; date-fns shipped one in uk (relativeTime.ts).
  it.each(['uk', 'ru'] as const)('%s has no Latin letter inside a Cyrillic word', (locale) => {
    const mixedScript = /\p{Script=Cyrillic}\p{Script=Latin}|\p{Script=Latin}\p{Script=Cyrillic}/u;
    for (const [key, entry] of Object.entries(CATALOGS[locale])) {
      for (const text of isPlural(entry) ? Object.values(entry) : [entry]) {
        expect(text, `${locale}.${key}`).not.toMatch(mixedScript);
      }
    }
  });

  it('zh-Hans plural keys have other', () => {
    for (const entry of Object.values(CATALOGS['zh-Hans'])) {
      if (isPlural(entry)) {
        expect(entry.other).toBeTruthy();
      }
    }
  });

  it.each(NON_ENGLISH)('%s uses the same placeholders as English', (locale) => {
    for (const [key, entry] of Object.entries(en) as [keyof typeof en, string | PluralForms][]) {
      const translated = CATALOGS[locale][key];
      if (isPlural(entry)) {
        for (const form of Object.values(translated as PluralForms)) {
          expect(placeholders(form), `${locale}.${key}`).toEqual(placeholders(entry.other));
        }
      } else {
        expect(placeholders(translated as string), `${locale}.${key}`).toEqual(placeholders(entry));
      }
    }
  });

  it.each(NON_ENGLISH)('%s has no untranslated English text', (locale) => {
    for (const [key, entry] of Object.entries(en)) {
      const translated = CATALOGS[locale][key as keyof typeof en];
      const englishForms = isPlural(entry) ? Object.values(entry) : [entry];
      const forms = isPlural(translated) ? Object.values(translated) : [translated];
      for (const form of forms) {
        // A pattern with no words, like "{converted} ({original})", has nothing to translate.
        // Nor does the brand name, which is the same in every language ("{name} · Sous").
        if (!/\p{L}/u.test(form.replace(/\{\w+\}/g, '').replace(/\bSous\b/g, ''))) continue;
        expect(englishForms, `${locale}.${key}`).not.toContain(form);
      }
    }
  });
});

describe('translate', () => {
  it('fills named params and leaves unknown placeholders alone', () => {
    expect(translate('en', 'time.expiresIn', { in: 'in 7 days' })).toBe('expires in 7 days');
    expect(translate('en', 'time.expiresIn')).toBe('expires {in}');
    expect(translate('uk', 'settings.loadedAgo', { time: '7 днів тому' })).toBe('Завантажено 7 днів тому');
  });

  it('selects English plural forms', () => {
    expect(translate('en', 'common.servingsCount', { count: 1 })).toBe('1 serving');
    expect(translate('en', 'common.servingsCount', { count: 2 })).toBe('2 servings');
    expect(translate('en', 'common.servingsCount', { count: 0 })).toBe('0 servings');
  });

  it('selects Ukrainian plural forms for 1, 2, 5, and 21', () => {
    expect(translate('uk', 'common.servingsCount', { count: 1 })).toBe('1 порція');
    expect(translate('uk', 'common.servingsCount', { count: 2 })).toBe('2 порції');
    expect(translate('uk', 'common.servingsCount', { count: 5 })).toBe('5 порцій');
    expect(translate('uk', 'common.servingsCount', { count: 21 })).toBe('21 порція');
    expect(translate('uk', 'cookLog.stars', { count: 1 })).toBe('1 зірка');
    expect(translate('uk', 'cookLog.stars', { count: 2 })).toBe('2 зірки');
    expect(translate('uk', 'cookLog.stars', { count: 5 })).toBe('5 зірок');
    expect(translate('uk', 'cookLog.stars', { count: 21 })).toBe('21 зірка');
  });

  it('selects Russian plural forms for 1, 2, 5, and 21', () => {
    expect(translate('ru', 'common.servingsCount', { count: 1 })).toBe('1 порция');
    expect(translate('ru', 'common.servingsCount', { count: 2 })).toBe('2 порции');
    expect(translate('ru', 'common.servingsCount', { count: 5 })).toBe('5 порций');
    expect(translate('ru', 'common.servingsCount', { count: 21 })).toBe('21 порция');
    expect(translate('ru', 'cookLog.stars', { count: 1 })).toBe('1 звезда');
    expect(translate('ru', 'cookLog.stars', { count: 2 })).toBe('2 звезды');
    expect(translate('ru', 'cookLog.stars', { count: 5 })).toBe('5 звёзд');
    expect(translate('ru', 'cookLog.stars', { count: 21 })).toBe('21 звезда');
  });

  it('uses the single Chinese form and the locale decimal separator', () => {
    expect(translate('zh-Hans', 'common.servingsCount', { count: 1 })).toBe('1 份');
    expect(translate('zh-Hans', 'common.servingsCount', { count: 21 })).toBe('21 份');
    expect(translate('uk', 'common.servingsCount', { count: 1.5 })).toBe('1,5 порції');
    expect(translate('en', 'common.servingsCount', { count: 1.5 })).toBe('1.5 servings');
  });
});

describe('formatNumber', () => {
  it('follows the locale decimal separator without grouping', () => {
    expect(formatNumber(0.4, 'en')).toBe('0.4');
    expect(formatNumber(0.4, 'uk')).toBe('0,4');
    expect(formatNumber(0.4, 'ru')).toBe('0,4');
    expect(formatNumber(0.4, 'zh-Hans')).toBe('0.4');
    expect(formatNumber(1200, 'en')).toBe('1200');
    expect(formatNumber(1200, 'uk')).toBe('1200');
  });
});

describe('languageName', () => {
  it('names a language in the UI language', () => {
    expect(languageName('it', 'en')).toBe('Italian');
    expect(languageName('it', 'uk')).toBe('італійська');
    expect(languageName('it', 'ru')).toBe('итальянский');
    expect(languageName('it', 'zh-Hans')).toBe('意大利语');
    expect(languageName('zh-Hans', 'en')).toBe('Simplified Chinese');
  });

  it('is undefined for a tag it cannot name', () => {
    expect(languageName('xx', 'en')).toBeUndefined();
    expect(languageName('!!', 'en')).toBeUndefined();
  });
});

describe('localeDisplayName', () => {
  it('names each UI language in itself, capitalized as a standalone label', () => {
    expect(localeDisplayName('en')).toBe('English');
    expect(localeDisplayName('uk')).toBe('Українська');
    expect(localeDisplayName('ru')).toBe('Русский');
    expect(localeDisplayName('zh-Hans')).toBe('简体中文');
  });
});

describe('library.languageShort', () => {
  it('is a distinct, non-empty label in every catalog', () => {
    const labels = SUPPORTED_LOCALES.map((locale) => translate(locale, 'library.languageShort'));
    for (const label of labels) {
      expect(label.trim()).not.toBe('');
    }
    expect(new Set(labels).size).toBe(labels.length);
  });
});
