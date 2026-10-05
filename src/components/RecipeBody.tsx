import type { ReactNode } from 'react';
import { useLocale, useT, type Locale } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import { formatQuantity } from '../lib/quantity';
import type { Ingredient, Recipe } from '../lib/types';

/**
 * The parts of a recipe page that only display: shared by `RecipeView` (your
 * library) and `PublicRecipe` (a public link). Nothing here reads a store,
 * fetches, or knows who is looking; state and photos come in as props.
 */

/**
 * The source is whatever the user pasted on import, so it is only ever linked
 * after it turns out to be an ordinary web address.
 */
export function sourceLink(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function ingredientLabel(
  ing: Ingredient,
  scale: number,
  locale: Locale,
  labelUnit: (token: string) => string,
): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity * scale, locale) : null,
    ing.unit ? labelUnit(ing.unit) : null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

/** The floating Ask pill at the bottom right of a recipe. */
export const askButtonClass =
  'fixed right-5 bottom-8 z-10 flex h-14 items-center gap-2 rounded-full bg-amber-500 px-5 font-medium text-white shadow-lg hover:bg-amber-600 active:bg-amber-600 print:hidden';

/** The recipe's one translate / original control (`docs/constitutions/i18n.md` principle 3). */
export const translateChipClass =
  'inline-flex max-w-full items-center gap-1.5 rounded-full border border-amber-600/70 bg-accent-soft px-3 py-1.5 text-left text-sm font-medium text-ink shadow-sm hover:enabled:opacity-90 active:enabled:opacity-80 disabled:opacity-60 print:hidden';

/**
 * A recipe page's outer column. On paper it takes the page width, and the
 * room kept clear of the floating Ask pill goes.
 */
export const recipePageClass = 'mx-auto max-w-xl px-4 pb-24 print:max-w-none print:px-0 print:pb-0';

export function SourceCredit({ source }: { source: URL }) {
  const t = useT();
  const label = t('recipe.source', { source: source.hostname });
  const at = label.indexOf(source.hostname);
  // On paper a link is only its text, so the full address prints after it.
  const printedHref = (
    <span className="hidden break-all print:inline"> ({source.href})</span>
  );
  const link = (
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline hover:text-ink"
    >
      {source.hostname}
    </a>
  );
  if (at < 0) {
    return (
      <p className="mt-6 text-sm text-ink-muted">
        <a
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline hover:text-ink"
        >
          {label}
        </a>
        {printedHref}
      </p>
    );
  }
  return (
    <p className="mt-6 text-sm text-ink-muted">
      {label.slice(0, at)}
      {link}
      {label.slice(at + source.hostname.length)}
      {printedHref}
    </p>
  );
}

export function RecipeTimes({ recipe }: { recipe: Pick<Recipe, 'prepMinutes' | 'cookMinutes'> }) {
  const t = useT();
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-ink-muted">
      {recipe.prepMinutes != null && (
        <span>{t('recipe.prepMinutes', { count: recipe.prepMinutes })}</span>
      )}
      {recipe.prepMinutes != null && recipe.cookMinutes != null && (
        <span aria-hidden="true">·</span>
      )}
      {recipe.cookMinutes != null && (
        <span>{t('recipe.cookMinutes', { count: recipe.cookMinutes })}</span>
      )}
    </p>
  );
}

export function IngredientsSection({
  recipe,
  displayRecipe,
  servings,
  onServings,
  checkedKeys,
  onToggle,
}: {
  recipe: Recipe;
  /** The text shown, possibly translated; quantities always come from `recipe`. */
  displayRecipe: Recipe;
  servings: number;
  onServings: (servings: number) => void;
  checkedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const scale = servings / recipe.servings;
  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('common.ingredients')}</h2>
        <div className="flex items-center gap-1 rounded-full border border-line bg-surface print:border-0">
          <button
            type="button"
            aria-label={t('recipe.fewerServings')}
            disabled={servings <= 1}
            onClick={() => onServings(servings - 1)}
            className="h-9 w-9 rounded-full text-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted disabled:opacity-30 print:hidden"
          >
            −
          </button>
          <span className="min-w-16 text-center text-sm">
            {t('common.servingsCount', { count: servings })}
          </span>
          <button
            type="button"
            aria-label={t('recipe.moreServings')}
            onClick={() => onServings(servings + 1)}
            className="h-9 w-9 rounded-full text-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted print:hidden"
          >
            +
          </button>
        </div>
      </div>

      {recipe.ingredientSections.map((section, si) => {
        const translatedSection = displayRecipe.ingredientSections[si];
        const sectionName = (translatedSection ?? section).name;
        return (
          <div key={si} className="mt-2">
            {sectionName && (
              <h3 className="mt-3 text-sm font-medium tracking-wide text-ink-muted uppercase">
                {sectionName}
              </h3>
            )}
            <ul className="mt-1 flex flex-col gap-1.5">
              {section.items.map((ing, ii) => {
                // Checkoff identity is the stored row index, so translated text cannot uncheck it.
                const key = `${si}-${ii}`;
                const isChecked = checkedKeys.has(key);
                const translatedItem = translatedSection?.items[ii];
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => onToggle(key)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left shadow-sm transition-colors print:p-0 print:text-ink ${
                        isChecked
                          ? 'bg-surface-muted text-ink-subtle hover:bg-surface active:bg-surface'
                          : 'bg-surface hover:bg-surface-muted active:bg-surface-muted'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs print:hidden ${
                          isChecked
                            ? 'border-line-strong bg-ink-subtle text-page'
                            : 'border-line-strong'
                        }`}
                      >
                        {isChecked ? '✓' : ''}
                      </span>
                      {/* Ticks are cook progress on this screen, not part of the printed recipe. */}
                      <span className={isChecked ? 'line-through print:no-underline' : ''}>
                        {ingredientLabel(
                          { ...(translatedItem ?? ing), quantity: ing.quantity },
                          scale,
                          locale,
                          (token) => unitLabel(token, t),
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export function StepsSection({
  recipe,
  displayRecipe,
  currentStep,
  onStep,
  afterDone,
}: {
  recipe: Recipe;
  displayRecipe: Recipe;
  currentStep: number;
  onStep: (step: number) => void;
  /** Shown under "Done" once every step is ticked, such as the cook-log link. */
  afterDone?: ReactNode;
}) {
  const t = useT();
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">{t('common.steps')}</h2>
      <ol className="mt-2 flex flex-col gap-2">
        {recipe.steps.map((step, i) => {
          const isCurrent = i === currentStep;
          const isDone = i < currentStep;
          const text = displayRecipe.steps[i]?.text ?? step.text;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onStep(i === currentStep ? i + 1 : i)}
                className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left shadow-sm transition-colors print:px-0 print:py-1 print:text-ink ${
                  isCurrent
                    ? 'bg-surface ring-2 ring-amber-400'
                    : isDone
                      ? 'bg-surface-muted text-ink-subtle'
                      : 'bg-surface hover:bg-surface-muted active:bg-surface-muted'
                }`}
              >
                <span
                  className={`font-semibold print:text-ink ${
                    isCurrent ? 'text-amber-500' : 'text-ink-subtle'
                  }`}
                >
                  {/* Paper shows every step's number, whatever the cook progress. */}
                  {isDone ? (
                    <>
                      <span className="print:hidden">✓</span>
                      <span className="hidden print:inline">{i + 1}</span>
                    </>
                  ) : (
                    i + 1
                  )}
                </span>
                <span className={isCurrent ? 'text-lg print:text-base' : ''}>{text}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {currentStep >= recipe.steps.length && (
        <div className="mt-4 text-center print:hidden">
          <p className="font-medium text-amber-600">{t('recipe.doneEnjoy')}</p>
          {afterDone}
        </div>
      )}
    </section>
  );
}

export function NotesSection({ notes }: { notes: string }) {
  const t = useT();
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">{t('common.notes')}</h2>
      <p className="mt-2 rounded-lg bg-surface px-3 py-3 whitespace-pre-line text-ink-muted shadow-sm print:p-0">
        {notes}
      </p>
    </section>
  );
}

/** One square gallery tile. `url` is undefined while a photo is still loading. */
export function GalleryFrame({ url }: { url: string | undefined }) {
  return (
    <div className="overflow-hidden rounded-xl bg-surface-muted shadow-sm">
      {url && <img src={url} alt="" className="aspect-square w-full object-cover" />}
    </div>
  );
}

export function GallerySection({ children }: { children: ReactNode }) {
  return <section className="mt-6 grid grid-cols-2 gap-2 print:hidden">{children}</section>;
}

export function CoverPhoto({ url }: { url: string | undefined }) {
  if (!url) return null;
  return (
    <img src={url} alt="" className="mt-3 h-52 w-full rounded-2xl object-cover shadow-sm" />
  );
}
