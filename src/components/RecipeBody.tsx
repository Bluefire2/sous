import { useId, useMemo, type ReactNode } from 'react';
import { useLocale, useT } from '../i18n';
import { displayTemperatures, ingredientLine } from '../lib/recipeText';
import type { RecipeTextSize } from '../lib/settings';
import { activeSteps, isStepDone, stepBlocks, stepsWaitingForLanes } from '../lib/stepLanes';
import type { Recipe } from '../lib/types';
import type { UnitSystem } from '../lib/unitConversion';

/**
 * The parts of a recipe page that only display: shared by `RecipeView` (your
 * library) and `PublicRecipe` (a public link). Nothing here reads a store,
 * fetches, or knows who is looking; state and photos come in as props.
 */

export { sourceLink } from '../lib/recipeText';

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

/**
 * Ingredient and step rows one size step up for reading from across the
 * kitchen (Settings → Cooking). Paper keeps the normal size.
 */
const largeRowText = 'text-lg print:text-base';

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
  textSize = 'normal',
  units = 'asWritten',
}: {
  recipe: Recipe;
  /** The text shown, possibly translated; quantities always come from `recipe`. */
  displayRecipe: Recipe;
  servings: number;
  onServings: (servings: number) => void;
  checkedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** The device's recipe text size, read by the screen (`useRecipeTextSize`). */
  textSize?: RecipeTextSize;
  /** The member's measurement units, read by the screen (`useUnitSystem`). */
  units?: UnitSystem;
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
                        textSize === 'large' ? `${largeRowText} ` : ''
                      }${
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
                        {ingredientLine(
                          { ...(translatedItem ?? ing), quantity: ing.quantity },
                          scale,
                          locale,
                          t,
                          { units, storedUnit: ing.unit },
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

/** One step row: a full-width button with no control inside it (i18n principle 3). */
function StepButton({
  index,
  text,
  isCurrent,
  isDone,
  dimmed,
  afterLanes,
  large,
  onTap,
}: {
  index: number;
  text: string;
  isCurrent: boolean;
  isDone: boolean;
  dimmed: boolean;
  /** A shared step that waits for lanes not finished yet (`stepsWaitingForLanes`). */
  afterLanes: boolean;
  /** The device's large recipe text (Settings → Cooking). */
  large: boolean;
  onTap: (index: number) => void;
}) {
  const t = useT();
  // The current step stays one step above the others at either size.
  const currentText = large ? 'text-xl print:text-base' : 'text-lg print:text-base';
  return (
    <button
      type="button"
      onClick={() => onTap(index)}
      aria-current={isCurrent ? 'step' : undefined}
      className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left shadow-sm transition outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid print:px-0 print:py-1 print:text-ink print:opacity-100 ${
        large ? `${largeRowText} ` : ''
      }${
        isCurrent
          ? 'bg-surface ring-2 ring-amber-400'
          : isDone
            ? 'bg-surface-muted text-ink-subtle'
            : 'bg-surface hover:bg-surface-muted active:bg-surface-muted'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      <span
        className={`font-semibold print:text-ink ${isCurrent ? 'text-amber-500' : 'text-ink-subtle'}`}
      >
        {/* Paper shows every step's number, whatever the cook progress. A
            screen reader hears the number and "Done", not the tick. */}
        {isDone ? (
          <>
            <span aria-hidden="true" className="print:hidden">
              ✓
            </span>
            <span className="sr-only">{index + 1}</span>
            <span aria-hidden="true" className="hidden print:inline">
              {index + 1}
            </span>
          </>
        ) : (
          index + 1
        )}
      </span>
      <span className="min-w-0">
        <span className={isCurrent ? currentText : ''}>{text}</span>
        {isDone && <span className="sr-only"> {t('common.done')}</span>}
        {afterLanes && (
          <span className="mt-0.5 block text-sm text-ink-muted print:hidden">
            {t('recipe.afterEveryLane')}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Which lane this person follows when two people cook
 * (`docs/plans/parallel-steps.md`). Only rendered for a recipe with lanes.
 * `active` undefined is Everyone. The pick dims other lanes; it never hides
 * a step and never changes progress.
 */
export function LaneChips({
  lanes,
  active,
  onChange,
}: {
  lanes: readonly string[];
  active: string | undefined;
  onChange: (lane: string | undefined) => void;
}) {
  const t = useT();
  const labelId = useId();
  const chip = (pressed: boolean) =>
    `rounded-full border px-3 py-1 text-sm font-medium shadow-sm ${
      pressed
        ? 'border-amber-600/70 bg-accent-soft text-ink'
        : 'border-line bg-surface text-ink-muted hover:bg-surface-muted'
    }`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="mt-2 flex flex-wrap items-center gap-2 print:hidden"
    >
      <span id={labelId} className="text-sm text-ink-muted">
        {t('recipe.laneChips')}
      </span>
      <button
        type="button"
        aria-pressed={active === undefined}
        onClick={() => onChange(undefined)}
        className={chip(active === undefined)}
      >
        {t('recipe.laneEveryone')}
      </button>
      {lanes.map((lane) => (
        <button
          key={lane}
          type="button"
          aria-pressed={active === lane}
          onClick={() => onChange(lane)}
          className={chip(active === lane)}
        >
          {lane}
        </button>
      ))}
    </div>
  );
}

export function StepsSection({
  recipe,
  displayRecipe,
  currentStep,
  doneSteps,
  onTap,
  activeLane,
  lanePicker,
  afterDone,
  textSize = 'normal',
  units = 'asWritten',
}: {
  recipe: Recipe;
  displayRecipe: Recipe;
  /** Every step before this index is done. */
  currentStep: number;
  /** Steps done ahead of `currentStep` in a parallel block. */
  doneSteps: readonly number[];
  onTap: (index: number) => void;
  /** The lane this person follows; other lanes' steps are dimmed. */
  activeLane?: string;
  /** Shown under the heading, such as `LaneChips`. */
  lanePicker?: ReactNode;
  /** Shown under "Done" once every step is ticked, such as the cook-log link. */
  afterDone?: ReactNode;
  /** The device's recipe text size, read by the screen (`useRecipeTextSize`). */
  textSize?: RecipeTextSize;
  /** Fahrenheit in the shown text reads in Celsius when metric. */
  units?: UnitSystem;
}) {
  const t = useT();
  // Structure always comes from the stored recipe; a translation only
  // supplies text (i18n principle 4).
  const blocks = useMemo(() => stepBlocks(recipe.steps), [recipe.steps]);
  const large = textSize === 'large';
  const progress = { currentStep, doneSteps };
  const active = activeSteps(recipe.steps, progress);
  const waiting = stepsWaitingForLanes(recipe.steps, progress);
  const row = (index: number, dimmed: boolean) => (
    <StepButton
      index={index}
      text={displayTemperatures(
        displayRecipe.steps[index]?.text ?? recipe.steps[index].text,
        units,
        t,
      )}
      isCurrent={active.has(index)}
      isDone={isStepDone(progress, index)}
      dimmed={dimmed}
      afterLanes={waiting.has(index)}
      large={large}
      onTap={onTap}
    />
  );
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">{t('common.steps')}</h2>
      {lanePicker}
      <ol className="mt-2 flex flex-col gap-2">
        {blocks.map((block) => {
          if (block.kind === 'sync') {
            return <li key={block.index}>{row(block.index, false)}</li>;
          }
          const headingId = `steps-together-${block.start}`;
          // One lane alone runs at the same time as nothing, so its box is
          // named by the lane, without the "At the same time" heading.
          const together = block.lanes.length > 1;
          return (
            <li key={block.start}>
              <div
                role="group"
                aria-labelledby={headingId}
                className="rounded-xl border border-line p-2 print:border-0 print:p-0"
              >
                {together && (
                  <p
                    id={headingId}
                    className="px-1 text-xs font-semibold tracking-wide text-amber-600 uppercase print:text-ink"
                  >
                    {t('recipe.atTheSameTime')}
                  </p>
                )}
                {/* At most MAX_LANES lanes, so they fit side by side. */}
                <div
                  className={`grid gap-3 sm:auto-cols-fr sm:grid-flow-col ${together ? 'mt-2' : ''}`}
                >
                  {block.lanes.map((run) => {
                    const dimmed = activeLane !== undefined && run.lane !== activeLane;
                    return (
                      <div key={run.lane} className="min-w-0">
                        {/* A lane name is recipe text, shown as written. */}
                        <h3
                          id={together ? undefined : headingId}
                          className={`px-1 text-sm font-semibold print:opacity-100 ${dimmed ? 'opacity-50' : ''}`}
                        >
                          {run.lane}
                        </h3>
                        <ol className="mt-1 flex flex-col gap-2">
                          {run.steps.map((index) => (
                            <li key={index}>{row(index, dimmed)}</li>
                          ))}
                        </ol>
                      </div>
                    );
                  })}
                </div>
              </div>
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

export function NotesSection({ notes, units = 'asWritten' }: { notes: string; units?: UnitSystem }) {
  const t = useT();
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">{t('common.notes')}</h2>
      <p className="mt-2 rounded-lg bg-surface px-3 py-3 whitespace-pre-line text-ink-muted shadow-sm print:p-0">
        {displayTemperatures(notes, units, t)}
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
