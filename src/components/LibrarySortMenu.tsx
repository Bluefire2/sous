import { useT, type TextKey } from '../i18n';
import { ChevronDownIcon } from '../lib/icons';
import { DEFAULT_LIBRARY_SORT, LIBRARY_SORTS, type LibrarySort } from '../lib/librarySort';
import { chipClass, menuItem } from '../lib/uiClasses';
import { useDisclosureMenu } from '../lib/useDisclosureMenu';

const SORT_LABELS: Readonly<Record<LibrarySort, TextKey>> = {
  updated: 'library.sortUpdated',
  title: 'library.sortTitle',
  created: 'library.sortCreated',
  cooked: 'library.sortCooked',
};

/**
 * Library list order, beside the search box. The trigger reads "Sort" and is
 * filled while an order other than the default is on; its accessible name
 * names the current order. Same disclosure pattern as the language menu, so
 * Escape and focus behave the same.
 */
export default function LibrarySortMenu({
  sort,
  onChange,
}: {
  sort: LibrarySort;
  onChange: (sort: LibrarySort) => void;
}) {
  const t = useT();
  const { open, panelId, wrapperRef, initialItemRef, triggerProps, close, choose, onBlur } =
    useDisclosureMenu();

  return (
    <div ref={wrapperRef} className="relative shrink-0" onBlur={onBlur}>
      <button
        {...triggerProps}
        type="button"
        aria-label={t('library.sortMenu', { order: t(SORT_LABELS[sort]) })}
        className={`${chipClass(sort !== DEFAULT_LIBRARY_SORT)} inline-flex items-center gap-1`}
      >
        <span>{t('library.sort')}</span>
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
            aria-label={t('library.sortOptions')}
            className="absolute top-full right-0 z-20 mt-1 w-max max-w-[calc(100vw-2rem)] min-w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
          >
            {LIBRARY_SORTS.map((option, index) => {
              const current = option === sort;
              return (
                <button
                  key={option}
                  ref={current ? initialItemRef : undefined}
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  onClick={() => choose(() => onChange(option))}
                  className={`${menuItem} flex items-center justify-between gap-2 ${
                    index > 0 ? 'border-t border-line' : ''
                  } ${current ? 'font-semibold' : ''}`}
                >
                  <span>{t(SORT_LABELS[option])}</span>
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
