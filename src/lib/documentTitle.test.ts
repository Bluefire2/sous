import { describe, expect, it } from 'vitest';
import { CATALOGS, translate, type TextKey, type TranslateParams } from '../i18n';
import { SUPPORTED_LOCALES } from '../i18n/lang';
import { APP_TITLE, namedTitle, TITLE_NAME_MAX, titleName } from './documentTitle';

const en = (key: TextKey, params?: TranslateParams) => translate('en', key, params);

describe('titleName', () => {
  it('keeps an ordinary name as it is', () => {
    expect(titleName('Borscht')).toBe('Borscht');
    expect(titleName('Борщ з пампушками')).toBe('Борщ з пампушками');
  });

  it('is undefined for a missing, non-string, or blank name', () => {
    expect(titleName(undefined)).toBeUndefined();
    expect(titleName(42)).toBeUndefined();
    expect(titleName('')).toBeUndefined();
    expect(titleName(' \n\t ')).toBeUndefined();
    expect(titleName('‮‏')).toBeUndefined();
  });

  it('puts a name on one line and collapses its whitespace', () => {
    expect(titleName('  Weeknight\n\n dal\t ')).toBe('Weeknight dal');
    expect(titleName('Soup\u0000of\u0085the day')).toBe('Soup of the day');
  });

  it('drops bidi controls so a name cannot reorder the rest of the title', () => {
    expect(titleName('‮etalocohc‬ cake')).toBe('etalocohc cake');
    expect(titleName('a⁦b⁩c‎')).toBe('abc');
  });

  it('keeps a name of exactly the limit and cuts a longer one on a grapheme', () => {
    const exact = 'a'.repeat(TITLE_NAME_MAX);
    expect(titleName(exact)).toBe(exact);
    const family = '👨‍👩‍👧';
    const long = family.repeat(TITLE_NAME_MAX + 5);
    expect(titleName(long)).toBe(`${family.repeat(TITLE_NAME_MAX - 1)}…`);
  });

  it('does not leave a space before the ellipsis', () => {
    const name = `${'a'.repeat(TITLE_NAME_MAX - 2)} ${'b'.repeat(10)}`;
    expect(titleName(name)).toBe(`${'a'.repeat(TITLE_NAME_MAX - 2)}…`);
  });
});

describe('namedTitle', () => {
  it('puts the name before the app name', () => {
    expect(namedTitle(en, 'Borscht')).toBe('Borscht · Sous');
  });

  it('is just the app name when there is no name', () => {
    expect(namedTitle(en, '   ')).toBe(APP_TITLE);
    expect(namedTitle(en, undefined)).toBe(APP_TITLE);
  });

  it('leaves braces in a name alone', () => {
    expect(namedTitle(en, 'Cake {name}')).toBe('Cake {name} · Sous');
  });

  // A fixed screen with a heading is titled with that heading and the brand,
  // so the tab and the page never name the screen differently. The in-context
  // review judges the tab title too (testing/i18n-review/capture.ts).
  const HEADINGS: Record<string, TextKey> = {
    'title.collections': 'library.collectionsNav',
    'title.cooks': 'library.cooks',
    'title.import': 'import.title',
    'title.newRecipe': 'recipeEdit.newRecipe',
    'title.editRecipe': 'recipeEdit.editRecipe',
    'title.logCook': 'recipe.logACook',
    'title.editCook': 'cookLog.editCook',
    'title.settings': 'settings.title',
    'title.suggest': 'suggest.title',
    'title.admin': 'admin.title',
  };
  /** Titles with no heading to follow: a name, and `/assistant`, which shows no heading. */
  const OWN_WORDS = ['title.named', 'title.assistant'];

  it.each(SUPPORTED_LOCALES)('%s titles a fixed screen with its heading', (locale) => {
    const titleKeys = Object.keys(CATALOGS[locale]).filter((key) => key.startsWith('title.'));
    expect(titleKeys.sort()).toEqual([...Object.keys(HEADINGS), ...OWN_WORDS].sort());
    for (const [titleKey, headingKey] of Object.entries(HEADINGS)) {
      expect(translate(locale, titleKey as TextKey), `${locale}.${titleKey}`).toBe(
        `${translate(locale, headingKey)} · Sous`,
      );
    }
  });

  it.each(SUPPORTED_LOCALES)('%s names the app in every title', (locale) => {
    expect(namedTitle((key, params) => translate(locale, key, params), 'X')).toContain('X');
    for (const [key, text] of Object.entries(CATALOGS[locale])) {
      if (key.startsWith('title.')) {
        expect(text, `${locale}.${key}`).toMatch(/ · Sous$/);
      }
    }
  });
});
