import { useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useT } from '../i18n';
import { libraryHref } from '../lib/collectionHref';
import { FolderIcon, ShareIcon, SharedIcon } from '../lib/icons';
import type { Collection } from '../lib/types';
import { chipClass, menuItem, menuItemDanger } from '../lib/uiClasses';
import { useDisclosureMenu } from '../lib/useDisclosureMenu';

function edgeMask(lead: boolean, trail: boolean): string | undefined {
  if (!lead && !trail) return undefined;
  const left = lead ? 'transparent, #000 1.25rem' : '#000';
  const right = trail ? '#000 calc(100% - 1.25rem), transparent' : '#000';
  return `linear-gradient(to right, ${left}, ${right})`;
}

/** Move only the row. scrollIntoView would also scroll the page. */
function revealChip(chip: HTMLElement, scroller: HTMLElement) {
  const pad = 20;
  const scrollerBox = scroller.getBoundingClientRect();
  const chipBox = chip.getBoundingClientRect();
  const leftInset = chipBox.left - scrollerBox.left;
  const rightInset = chipBox.right - scrollerBox.right;
  if (leftInset < pad) scroller.scrollLeft += leftInset - pad;
  else if (rightInset > -pad) scroller.scrollLeft += rightInset + pad;
}

/**
 * Rename and delete for the open owned collection. Share is the icon beside
 * this menu. The sheets stay in Library's flow.
 */
function CollectionActionsMenu({
  name,
  onRename,
  onDelete,
}: {
  name: string;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { open, panelId, wrapperRef, initialItemRef, triggerProps, close, choose, onBlur } =
    useDisclosureMenu();
  const label = t('library.collectionActions', { name });

  return (
    // The negative margin keeps the 44px target from making the label row
    // taller than it is when no owned collection is open.
    <div ref={wrapperRef} className="relative -my-1.5 shrink-0" onBlur={onBlur}>
      <button
        {...triggerProps}
        type="button"
        aria-label={label}
        className="flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-ink-subtle hover:bg-surface-muted hover:text-ink active:bg-surface-muted"
      >
        ⋮
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
            className="absolute top-full right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
          >
            <button
              ref={initialItemRef}
              type="button"
              onClick={() => choose(onRename)}
              className={menuItem}
            >
              {t('library.rename')}
            </button>
            <button
              type="button"
              onClick={() => choose(onDelete)}
              className={`${menuItemDanger} border-t border-line`}
            >
              {t('common.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Collections on the library: a label and one sideways row of names, on the
 * page background. See docs/plans/library-collections-region.md.
 */
export default function CollectionSection({
  collections,
  sharedLabels,
  currentId,
  browseAll,
  ownedName,
  onCreate,
  onShare,
  onRename,
  onDelete,
  onOpenList,
}: {
  collections: readonly Collection[];
  /** Accessible name for a shared collection, already including its name. */
  sharedLabels: ReadonlyMap<string, string>;
  currentId: string | undefined;
  browseAll: boolean;
  /** Name of the open collection when it is owned and named; undefined otherwise. */
  ownedName: string | undefined;
  onCreate: () => void;
  onShare: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** Clears “all collections” browsing when a chip is chosen. */
  onOpenList: () => void;
}) {
  const t = useT();
  const location = useLocation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLAnchorElement>(null);
  const [edges, setEdges] = useState({ lead: false, trail: false });
  const selectedKey = browseAll ? '' : (currentId ?? '/');

  const onChipFocus = (event: FocusEvent<HTMLAnchorElement>) => {
    const scroller = scrollerRef.current;
    if (scroller) revealChip(event.currentTarget, scroller);
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const chip = selectedRef.current;
    if (scroller && chip) revealChip(chip, scroller);
  }, [selectedKey]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const overflow = el.scrollWidth - el.clientWidth > 1;
      setEdges({
        lead: overflow && el.scrollLeft > 1,
        trail: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [collections, selectedKey]);

  const mask = edgeMask(edges.lead, edges.trail);
  const recipesActive = !browseAll && currentId === undefined;

  return (
    <section className="mb-3" aria-labelledby="collections-label">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          id="collections-label"
          to="/collections"
          state={{ from: location.pathname }}
          className="inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          <FolderIcon className="block h-5 w-5 shrink-0" />
          {t('library.collectionsNav')}
        </Link>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onCreate}
            className="shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            {t('common.newCollection')}
          </button>
          {ownedName !== undefined && (
            <>
              <button
                type="button"
                onClick={onShare}
                aria-label={t('common.share')}
                className="-my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-muted hover:text-ink active:bg-surface-muted"
              >
                <ShareIcon className="block h-5 w-5" />
              </button>
              <CollectionActionsMenu
                key={currentId}
                name={ownedName}
                onRename={onRename}
                onDelete={onDelete}
              />
            </>
          )}
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="flex w-full min-w-0 gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [@media(pointer:fine)]:[scrollbar-width:thin] [&::-webkit-scrollbar]:h-0 [@media(pointer:fine)]:[&::-webkit-scrollbar]:h-1.5"
        style={
          mask
            ? { maskImage: mask, WebkitMaskImage: mask, scrollPaddingInline: '1.25rem' }
            : undefined
        }
      >
        <Link
          to="/"
          ref={recipesActive ? selectedRef : undefined}
          onClick={onOpenList}
          onFocus={onChipFocus}
          className={`${chipClass(recipesActive)} shrink-0`}
        >
          {t('library.recipes')}
        </Link>
        {collections.map((collection) => {
          const sharedLabel = sharedLabels.get(collection.id);
          const active = !browseAll && collection.id === currentId;
          return (
            <Link
              key={collection.id}
              ref={active ? selectedRef : undefined}
              to={libraryHref(collection.id)}
              onClick={onOpenList}
              onFocus={onChipFocus}
              aria-label={sharedLabel ?? collection.name}
              title={sharedLabel}
              className={`${chipClass(active)} inline-flex shrink-0 items-center gap-1.5`}
            >
              {sharedLabel !== undefined && <SharedIcon className="block h-3.5 w-3.5 shrink-0" />}
              {collection.name}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
