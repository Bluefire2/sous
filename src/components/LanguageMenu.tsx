import { SUPPORTED_LOCALES, localeDisplayName, useLocale, useT } from '../i18n';
import { ChevronDownIcon } from '../lib/icons';
import { settings } from '../lib/settings';
import { useDisclosureMenu } from '../lib/useDisclosureMenu';
import { menuItem } from '../lib/uiClasses';

/**
 * UI language switcher for the Library header: the current language's short
 * label and a chevron, opening a list of every UI language by its own name.
 * Writes the same `cook.locale` setting as the select in Settings.
 */
export default function LanguageMenu() {
  const t = useT();
  const locale = useLocale();
  const { open, panelId, wrapperRef, initialItemRef, triggerProps, close, choose, onBlur } =
    useDisclosureMenu();

  const label = t('library.languageMenu');

  return (
    <div ref={wrapperRef} className="relative" onBlur={onBlur}>
      <button
        {...triggerProps}
        type="button"
        aria-label={label}
        className="inline-flex items-center rounded-full py-2 pr-1.5 pl-2 text-sm font-medium text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted"
      >
        <span lang={locale}>{t('library.languageShort')}</span>
        <ChevronDownIcon
          className={`block h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label={t('library.closeMenu')}
            tabIndex={-1}
            onClick={close}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            id={panelId}
            role="group"
            aria-label={label}
            className="absolute top-full right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
          >
            {SUPPORTED_LOCALES.map((code, index) => {
              const current = code === locale;
              return (
                <button
                  key={code}
                  ref={current ? initialItemRef : undefined}
                  type="button"
                  lang={code}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => choose(() => settings.setLocale(code))}
                  className={`${menuItem} flex items-center justify-between gap-2 ${
                    index > 0 ? 'border-t border-line' : ''
                  } ${current ? 'font-semibold' : ''}`}
                >
                  <span>{localeDisplayName(code)}</span>
                  {current && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
