import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCALE_KEY,
  localeFromBrowserLanguage,
  RECIPE_TEXT_SIZE_KEY,
  settings,
  THEME_KEY,
  WAKE_LOCK_KEY,
} from './settings';

const store = new Map<string, string>();
const originalNavigator = globalThis.navigator;

function stubBrowserLanguage(language: string | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: language === undefined ? undefined : { language },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  store.clear();
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

describe('theme settings', () => {
  it("getTheme() is 'dark' when the key is missing", () => {
    expect(settings.getTheme()).toBe('dark');
  });

  it("getTheme() is 'dark' when the stored value is invalid", () => {
    localStorage.setItem(THEME_KEY, 'system');
    expect(settings.getTheme()).toBe('dark');
  });

  it("setTheme('light') then getTheme() is 'light'", () => {
    settings.setTheme('light');
    expect(settings.getTheme()).toBe('light');
  });

  it("setTheme('dark') then getTheme() is 'dark'", () => {
    settings.setTheme('dark');
    expect(settings.getTheme()).toBe('dark');
  });
});

describe('localeFromBrowserLanguage', () => {
  it('normalizes a supported browser language', () => {
    expect(localeFromBrowserLanguage('en-US')).toBe('en');
    expect(localeFromBrowserLanguage('uk-UA')).toBe('uk');
    expect(localeFromBrowserLanguage('ua')).toBe('uk');
    expect(localeFromBrowserLanguage('ru')).toBe('ru');
    expect(localeFromBrowserLanguage('zh-CN')).toBe('zh-Hans');
  });

  it('picks the Simplified Chinese UI for a bare zh', () => {
    expect(localeFromBrowserLanguage('zh')).toBe('zh-Hans');
  });

  it("falls back to 'en' for Traditional Chinese, other languages, and garbage", () => {
    expect(localeFromBrowserLanguage('zh-TW')).toBe('en');
    expect(localeFromBrowserLanguage('zh-Hant')).toBe('en');
    expect(localeFromBrowserLanguage('it-IT')).toBe('en');
    expect(localeFromBrowserLanguage('')).toBe('en');
    expect(localeFromBrowserLanguage(undefined)).toBe('en');
  });
});

describe('locale settings', () => {
  it('getLocale() returns the stored locale when it is supported', () => {
    stubBrowserLanguage('uk');
    localStorage.setItem(LOCALE_KEY, 'ru');
    expect(settings.getLocale()).toBe('ru');
  });

  it('getLocale() ignores an unsupported stored value and uses the browser language', () => {
    stubBrowserLanguage('zh-CN');
    localStorage.setItem(LOCALE_KEY, 'zh-CN');
    expect(settings.getLocale()).toBe('zh-Hans');
    localStorage.setItem(LOCALE_KEY, 'fr');
    expect(settings.getLocale()).toBe('zh-Hans');
  });

  it("getLocale() is 'en' without storage or a usable browser language", () => {
    stubBrowserLanguage(undefined);
    expect(settings.getLocale()).toBe('en');
    stubBrowserLanguage('it');
    expect(settings.getLocale()).toBe('en');
  });

  it('setLocale() writes storage, then notifies subscribers, who see the new value', () => {
    stubBrowserLanguage('en-US');
    const seen: string[] = [];
    const unsubscribe = settings.subscribeLocale(() => {
      seen.push(`${localStorage.getItem(LOCALE_KEY)}:${settings.getLocale()}`);
    });
    settings.setLocale('uk');
    expect(seen).toEqual(['uk:uk']);
    expect(settings.getLocale()).toBe('uk');
    unsubscribe();
    settings.setLocale('ru');
    expect(seen).toEqual(['uk:uk']);
    expect(settings.getLocale()).toBe('ru');
  });

  it('setLocale() sets <html lang> when a document exists', () => {
    const root = { lang: 'en' };
    Object.defineProperty(globalThis, 'document', {
      value: { documentElement: root },
      configurable: true,
      writable: true,
    });
    try {
      settings.setLocale('zh-Hans');
      expect(root.lang).toBe('zh-Hans');
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });
});

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new Error('storage is blocked');
  };
  return {
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    clear: fail,
    key: fail,
    get length(): number {
      return fail();
    },
  };
}

describe('wake lock setting (cook.wakeLock)', () => {
  it('is on when the key is missing', () => {
    expect(WAKE_LOCK_KEY).toBe('cook.wakeLock');
    expect(settings.getWakeLock()).toBe(true);
  });

  it("is off only for a stored 'off'; anything else keeps the default", () => {
    localStorage.setItem(WAKE_LOCK_KEY, 'off');
    expect(settings.getWakeLock()).toBe(false);
    for (const value of ['on', 'false', 'OFF', '0', '']) {
      localStorage.setItem(WAKE_LOCK_KEY, value);
      expect(settings.getWakeLock()).toBe(true);
    }
  });

  it('setWakeLock() writes storage, then notifies subscribers, who see the new value', () => {
    const seen: string[] = [];
    const unsubscribe = settings.subscribeWakeLock(() => {
      seen.push(`${localStorage.getItem(WAKE_LOCK_KEY)}:${settings.getWakeLock()}`);
    });
    settings.setWakeLock(false);
    settings.setWakeLock(true);
    expect(seen).toEqual(['off:false', 'on:true']);
    unsubscribe();
    settings.setWakeLock(false);
    expect(seen).toHaveLength(2);
    expect(settings.getWakeLock()).toBe(false);
  });

  it('does not notify text size or locale subscribers', () => {
    let other = 0;
    const offSize = settings.subscribeRecipeTextSize(() => other++);
    const offLocale = settings.subscribeLocale(() => other++);
    settings.setWakeLock(false);
    offSize();
    offLocale();
    expect(other).toBe(0);
  });

  it('falls back to on, and setting it does not throw, when storage throws', () => {
    globalThis.localStorage = throwingStorage();
    expect(settings.getWakeLock()).toBe(true);
    let notified = 0;
    const unsubscribe = settings.subscribeWakeLock(() => notified++);
    expect(() => settings.setWakeLock(false)).not.toThrow();
    unsubscribe();
    expect(notified).toBe(1);
    expect(settings.getWakeLock()).toBe(true);
  });

  it('is on, and setting it does not throw, without any storage', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(settings.getWakeLock()).toBe(true);
    expect(() => settings.setWakeLock(false)).not.toThrow();
  });
});

describe('recipe text size setting (cook.recipeTextSize)', () => {
  it("is 'normal' when the key is missing", () => {
    expect(RECIPE_TEXT_SIZE_KEY).toBe('cook.recipeTextSize');
    expect(settings.getRecipeTextSize()).toBe('normal');
  });

  it("is 'large' only for a stored 'large'; unknown values fall back to 'normal'", () => {
    localStorage.setItem(RECIPE_TEXT_SIZE_KEY, 'large');
    expect(settings.getRecipeTextSize()).toBe('large');
    for (const value of ['huge', 'LARGE', 'small', '']) {
      localStorage.setItem(RECIPE_TEXT_SIZE_KEY, value);
      expect(settings.getRecipeTextSize()).toBe('normal');
    }
  });

  it('setRecipeTextSize() writes storage, then notifies subscribers, who see the new value', () => {
    const seen: string[] = [];
    const unsubscribe = settings.subscribeRecipeTextSize(() => {
      seen.push(`${localStorage.getItem(RECIPE_TEXT_SIZE_KEY)}:${settings.getRecipeTextSize()}`);
    });
    settings.setRecipeTextSize('large');
    settings.setRecipeTextSize('normal');
    expect(seen).toEqual(['large:large', 'normal:normal']);
    unsubscribe();
    settings.setRecipeTextSize('large');
    expect(seen).toHaveLength(2);
    expect(settings.getRecipeTextSize()).toBe('large');
  });

  it('does not notify wake lock subscribers', () => {
    let other = 0;
    const unsubscribe = settings.subscribeWakeLock(() => other++);
    settings.setRecipeTextSize('large');
    unsubscribe();
    expect(other).toBe(0);
  });

  it("falls back to 'normal', and setting it does not throw, when storage throws", () => {
    globalThis.localStorage = throwingStorage();
    expect(settings.getRecipeTextSize()).toBe('normal');
    expect(() => settings.setRecipeTextSize('large')).not.toThrow();
    expect(settings.getRecipeTextSize()).toBe('normal');
  });
});
