import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  normalizeLang,
  toSupportedLocale,
  type Locale,
} from '../i18n/lang';

export const THEME_KEY = 'cook.theme';
export const LOCALE_KEY = 'cook.locale';
/** Device-local: a recipe screen keeps the screen awake. Default on. */
export const WAKE_LOCK_KEY = 'cook.wakeLock';
/** Device-local: ingredient and step text size on a recipe screen. Default normal. */
export const RECIPE_TEXT_SIZE_KEY = 'cook.recipeTextSize';

export type Theme = 'dark' | 'light';
export type RecipeTextSize = 'normal' | 'large';

const localeListeners = new Set<() => void>();
const wakeLockListeners = new Set<() => void>();
const recipeTextSizeListeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Best-effort write: storage can be full, blocked, or missing. A failed write
 * leaves the stored value, which the getters keep returning.
 */
function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Nothing to do: the setting stays as it was.
  }
}

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    listener();
  }
}

function addListener(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * UI language implied by a browser language. A bare `zh` picks the only
 * Chinese UI, `zh-Hans`; anything unsupported (including `zh-Hant`) is `en`.
 */
export function localeFromBrowserLanguage(browserLanguage: unknown): Locale {
  if (normalizeLang(browserLanguage) === 'zh') {
    return 'zh-Hans';
  }
  return toSupportedLocale(browserLanguage) ?? DEFAULT_LOCALE;
}

/** Mirrors the current locale onto `<html lang>` so CSS and screen readers agree with the copy. */
export function applyLocale(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

export const settings = {
  getTheme(): Theme {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  },
  setTheme(value: Theme): void {
    localStorage.setItem(THEME_KEY, value);
  },
  getLocale(): Locale {
    const stored = readStorage(LOCALE_KEY);
    if (isSupportedLocale(stored)) {
      return stored;
    }
    return localeFromBrowserLanguage(
      typeof navigator === 'undefined' ? undefined : navigator.language,
    );
  },
  setLocale(value: Locale): void {
    localStorage.setItem(LOCALE_KEY, value);
    applyLocale(value);
    notify(localeListeners);
  },
  subscribeLocale(listener: () => void): () => void {
    return addListener(localeListeners, listener);
  },
  /** Whether a recipe screen keeps the screen awake. Only a stored `off` turns it off. */
  getWakeLock(): boolean {
    return readStorage(WAKE_LOCK_KEY) !== 'off';
  },
  setWakeLock(on: boolean): void {
    writeStorage(WAKE_LOCK_KEY, on ? 'on' : 'off');
    notify(wakeLockListeners);
  },
  subscribeWakeLock(listener: () => void): () => void {
    return addListener(wakeLockListeners, listener);
  },
  /** Ingredient and step text size on a recipe screen. Anything but a stored `large` is normal. */
  getRecipeTextSize(): RecipeTextSize {
    return readStorage(RECIPE_TEXT_SIZE_KEY) === 'large' ? 'large' : 'normal';
  },
  setRecipeTextSize(value: RecipeTextSize): void {
    writeStorage(RECIPE_TEXT_SIZE_KEY, value);
    notify(recipeTextSizeListeners);
  },
  subscribeRecipeTextSize(listener: () => void): () => void {
    return addListener(recipeTextSizeListeners, listener);
  },
};
