import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import { languageName, useLocale, useT } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import { encodeImageForStorage } from '../lib/image';
import { MemoryBlobImage, StoredPhotoImage } from './BlobImage';
import { photoStore } from '../lib/photoStore';
import { blankDraft } from '../lib/recipeDraft';
import { defaultRecipeFormLang, detectedLangHint } from '../lib/recipeFormLang';
import { MAX_GALLERY_PHOTOS } from '../lib/recipePhotos';
import { MAX_LANE_CHARS, compactLane } from '../lib/recipeSteps';
import { settings } from '../lib/settings';
import { getDetectedLang } from '../lib/translationStore';
import type { Ingredient, IngredientSection, Recipe, RecipeDraft } from '../lib/types';
import { COMMON_UNITS, CUSTOM_UNIT, resolveUnit, unitChoice, type UnitChoice } from '../lib/units';
import LanguagePicker from './LanguagePicker';
import PhotoPickerField from './PhotoPickerField';
import {
  addBtn,
  addBtnDanger,
  cellClass,
  iconBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';

interface ItemFields {
  quantity: string;
  unit: string;
  item: string;
  note: string;
}

interface SectionFields {
  name: string;
  items: ItemFields[];
}

/**
 * `lane` is raw text, '' for none (`docs/plans/parallel-steps.md`). `key`
 * identifies the card for this form's lifetime, so a card typing a new lane
 * stays in that mode when it moves; `toDraft` drops it.
 */
interface StepFields {
  key: number;
  text: string;
  lane: string;
}

let stepKeySeq = 0;
function stepFields(text: string, lane = ''): StepFields {
  stepKeySeq += 1;
  return { key: stepKeySeq, text, lane };
}

/** The lane select's "New lane…" option. */
const NEW_LANE = '__new_lane__';

/** Distinct non-blank lanes in the form, trimmed, in order of first use. */
function formLanes(steps: readonly StepFields[]): string[] {
  const lanes: string[] = [];
  for (const step of steps) {
    const lane = step.lane.trim();
    if (lane !== '' && !lanes.includes(lane)) lanes.push(lane);
  }
  return lanes;
}

/** Cards whose lane no other step uses start as a text field, so a lone lane stays editable. */
function loneLaneKeys(steps: readonly StepFields[]): Set<number> {
  const keys = new Set<number>();
  for (const step of steps) {
    const lane = step.lane.trim();
    if (lane !== '' && steps.filter((other) => other.lane.trim() === lane).length === 1) {
      keys.add(step.key);
    }
  }
  return keys;
}

/**
 * Numbers live in state as raw strings so a half-typed or emptied field stays
 * exactly what the user typed; they only become numbers (or `undefined`) on
 * submit. Parsing on every keystroke is how an empty box turns into `NaN`.
 */
interface FormState {
  title: string;
  description: string;
  servings: string;
  prepMinutes: string;
  cookMinutes: string;
  tags: string;
  notes: string;
  sections: SectionFields[];
  steps: StepFields[];
  /**
   * Recipe language. A new recipe starts as the UI language. An edit keeps
   * the stored tag. Unknown clears it, and the key is then omitted.
   */
  lang?: string;
}

function numberText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `uiLocale` is the current UI language for a new recipe, and fills in a
 * missing `lang` after `detectedLang`. Pass `undefined` on edit and when the
 * field is hidden. An edit keeps the stored tag, then a detection for this
 * version, and otherwise stays unlabelled. The UI language is not a
 * detection. The import preview sets `lang` at save.
 */
export function fromDraft(
  draft: RecipeDraft,
  uiLocale: string | undefined,
  detectedLang?: string,
): FormState {
  const fallback = blankDraft();
  const sections =
    draft.ingredientSections.length > 0
      ? draft.ingredientSections
      : fallback.ingredientSections;
  const steps = draft.steps.length > 0 ? draft.steps : fallback.steps;
  const lang = defaultRecipeFormLang(draft.lang, uiLocale, detectedLang);

  return {
    title: draft.title,
    description: draft.description ?? '',
    servings: numberText(draft.servings),
    prepMinutes: numberText(draft.prepMinutes),
    cookMinutes: numberText(draft.cookMinutes),
    tags: draft.tags.join(', '),
    notes: draft.notes ?? '',
    sections: sections.map((section) => ({
      name: section.name ?? '',
      items:
        section.items.length > 0
          ? section.items.map((item) => ({
              quantity: numberText(item.quantity),
              unit: item.unit ?? '',
              item: item.item,
              note: item.note ?? '',
            }))
          : [blankItem()],
    })),
    steps: steps.map((step) => stepFields(step.text, step.lane ?? '')),
    ...(lang !== undefined ? { lang } : {}),
  };
}

function toIngredient(fields: ItemFields): Ingredient {
  const quantity = toNumber(fields.quantity);
  const unit = fields.unit.trim();
  const note = fields.note.trim();
  return {
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unit !== '' ? { unit } : {}),
    item: fields.item.trim(),
    ...(note !== '' ? { note } : {}),
  };
}

function toSection(fields: SectionFields): IngredientSection {
  const name = fields.name.trim();
  return {
    ...(name !== '' ? { name } : {}),
    items: fields.items
      .filter((item) => item.item.trim() !== '')
      .map(toIngredient),
  };
}

function toTags(text: string): string[] {
  const tags = new Set<string>();
  for (const raw of text.split(',')) {
    const tag = raw.trim().toLowerCase();
    if (tag !== '') tags.add(tag);
  }
  return [...tags];
}

/**
 * Optional fields are spread in only when present, so clearing one drops the
 * key instead of storing `undefined` in a record that gets fully replaced.
 * `sourceUrl` is carried through untouched because the form has no UI for it.
 * `lang` is the recipe-language field: the UI language on a new recipe, the
 * stored tag on edit, or omitted when Unknown is chosen. `photoId` and
 * `galleryPhotoIds` are passed in because they are only known once picked
 * blobs are stored.
 */
export function toDraft(
  form: FormState,
  initial: RecipeDraft,
  photoId: string | undefined,
  galleryPhotoIds: string[],
): RecipeDraft {
  const description = form.description.trim();
  const notes = form.notes.trim();
  const prepMinutes = toNumber(form.prepMinutes);
  const cookMinutes = toNumber(form.cookMinutes);

  return {
    title: form.title.trim(),
    ...(description !== '' ? { description } : {}),
    ...(initial.sourceUrl !== undefined
      ? { sourceUrl: initial.sourceUrl }
      : {}),
    ...(form.lang !== undefined ? { lang: form.lang } : {}),
    servings: Math.max(1, toNumber(form.servings) ?? 1),
    ...(prepMinutes !== undefined ? { prepMinutes } : {}),
    ...(cookMinutes !== undefined ? { cookMinutes } : {}),
    ingredientSections: form.sections
      .map(toSection)
      .filter((section) => section.items.length > 0),
    steps: form.steps
      .map((step) => ({ text: step.text.trim(), lane: compactLane(step.lane) }))
      .filter((step) => step.text !== '')
      .map(({ text, lane }) => (lane === undefined ? { text } : { text, lane })),
    tags: toTags(form.tags),
    ...(notes !== '' ? { notes } : {}),
    ...(photoId !== undefined ? { photoId } : {}),
    ...(galleryPhotoIds.length > 0 ? { galleryPhotoIds } : {}),
  };
}

function blankItem(): ItemFields {
  return { quantity: '', unit: '', item: '', note: '' };
}

function moved<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

function unitKey(sectionIndex: number, itemIndex: number): string {
  return `${sectionIndex}-${itemIndex}`;
}

function idList(ids: readonly string[] | undefined): string {
  return (ids ?? []).join('\0');
}

function isSavedRecipe(draft: RecipeDraft | Recipe): draft is Recipe {
  return 'id' in draft && 'updatedAt' in draft && typeof draft.updatedAt === 'number';
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="mt-3 block">
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function PhotoField({
  photoId,
  picked,
  onPick,
  onRemove,
}: {
  photoId: string | undefined;
  picked: File | undefined;
  onPick: (file: File) => void;
  onRemove: () => void;
}): ReactElement {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const showPreview = picked !== undefined || photoId !== undefined;

  return (
    <div className="mt-3">
      <span className="text-sm font-medium text-ink-muted">{t('form.mainPhoto')}</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = '';
        }}
      />
      {!showPreview ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`mt-2 block ${addBtn}`}
        >
          {t('form.addPhoto')}
        </button>
      ) : (
        <div className="mt-1">
          {picked ? (
            <MemoryBlobImage
              blob={picked}
              alt=""
              className="h-44 w-full rounded-xl object-cover shadow-sm"
            />
          ) : (
            <StoredPhotoImage
              photoId={photoId}
              alt=""
              className="h-44 w-full rounded-xl object-cover shadow-sm"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={addBtn}
            >
              {t('form.replace')}
            </button>
            <button
              type="button"
              onClick={onRemove}
              className={addBtnDanger}
            >
              {t('common.remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RecipeForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  formId,
  onCanSubmitChange,
  onEditStateChange,
  submitLocked,
  hideLanguage,
  photosEditable = true,
}: {
  /** Starting values. Use a blank draft for create-from-scratch. An edit passes the saved recipe so a detection can pre-fill a missing lang. */
  initial: RecipeDraft | Recipe;
  /** Label for the primary button, e.g. 'Save' or 'Save to library'. */
  submitLabel: string;
  onSubmit: (draft: RecipeDraft) => void | Promise<void>;
  onCancel: () => void;
  /** Sets the form's `id` so a `type="submit" form=…` button can live
   * outside the form (e.g. a second Save button up in the screen header). */
  formId?: string;
  /** Mirrors whether the submit button is enabled, for a header Save.
   * Pass a stable callback; this runs in a layout effect. */
  onCanSubmitChange?: (canSubmit: boolean) => void;
  /** Import preview: edits, and whether a remount would drop picked photos. */
  onEditStateChange?: (state: { dirty: boolean; photosPicked: boolean }) => void;
  /** Keeps Save disabled while a preview translation is in flight. */
  submitLocked?: boolean;
  /**
   * Import preview hides this field. The guessed-language line owns the
   * language there, and save sets `lang` from that preview state.
   */
  hideLanguage?: boolean;
  /** False for an editor of someone else's recipe: photos stay as they are
   * and their controls are not shown. */
  photosEditable?: boolean;
}): ReactElement {
  // Captured once. A later UI-language change must not rewrite this recipe's lang.
  // A detection only fills a missing lang. It is not a background write.
  // The UI language is a default for a new recipe only.
  const [detectedLang] = useState(() => {
    if (hideLanguage || !isSavedRecipe(initial)) return undefined;
    return getDetectedLang(initial.id, initial.updatedAt);
  });
  const [form, setForm] = useState(() =>
    fromDraft(
      initial,
      hideLanguage || isSavedRecipe(initial) ? undefined : settings.getLocale(),
      detectedLang,
    ),
  );
  const baseline = useRef(form);
  const [photoId, setPhotoId] = useState(initial.photoId);
  const [picked, setPicked] = useState<File>();
  const [galleryPhotoIds, setGalleryPhotoIds] = useState(
    () => initial.galleryPhotoIds ?? [],
  );
  const [galleryPicked, setGalleryPicked] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // resolveUnit(CUSTOM_UNIT, '') is undefined, so without this positional
  // "row is in custom mode" set, a custom row whose text is empty (or exactly
  // a listed unit) would snap back to — and hide the text field mid-typing.
  const [customUnits, setCustomUnits] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Step cards showing the lane text field, by card key. Kept outside `form`
  // so switching modes never marks the form dirty.
  const [typingLanes, setTypingLanes] = useState<ReadonlySet<number>>(() =>
    loneLaneKeys(form.steps),
  );
  const setTypingLane = (key: number, typing: boolean) =>
    setTypingLanes((prev) => {
      if (prev.has(key) === typing) return prev;
      const next = new Set(prev);
      if (typing) next.add(key);
      else next.delete(key);
      return next;
    });
  const t = useT();
  const locale = useLocale();
  const hintTag = detectedLangHint(form.lang, detectedLang);

  const patch = (fields: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...fields }));

  const patchSections = (next: (sections: SectionFields[]) => SectionFields[]) =>
    setForm((prev) => ({ ...prev, sections: next(prev.sections) }));

  const patchSection = (index: number, next: (s: SectionFields) => SectionFields) =>
    patchSections((sections) =>
      sections.map((section, i) => (i === index ? next(section) : section)),
    );

  const patchItem = (
    sectionIndex: number,
    itemIndex: number,
    fields: Partial<ItemFields>,
  ) =>
    patchSection(sectionIndex, (section) => ({
      ...section,
      items: section.items.map((item, i) =>
        i === itemIndex ? { ...item, ...fields } : item,
      ),
    }));

  // customUnits keys are positional, so every structural edit (move, remove
  // ingredient, remove section) must remap them exactly the way it moves the
  // rows — otherwise a Custom… row's state would jump to a neighbour. The
  // remap returns the key's new position, or null to drop it.
  const remapCustomUnits = (
    remap: (
      sectionIndex: number,
      itemIndex: number,
    ) => readonly [number, number] | null,
  ) =>
    setCustomUnits((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        const dash = key.indexOf('-');
        const mapped = remap(
          Number(key.slice(0, dash)),
          Number(key.slice(dash + 1)),
        );
        if (mapped !== null) next.add(unitKey(mapped[0], mapped[1]));
      }
      return next;
    });

  const moveItem = (sectionIndex: number, from: number, to: number) => {
    // moved() is bounds-guarded and only adjacent moves exist, so a real move
    // is exactly a swap; the positional custom-mode flags swap with it.
    if (to >= 0 && to < form.sections[sectionIndex].items.length) {
      remapCustomUnits((si, ii) => {
        if (si !== sectionIndex) return [si, ii];
        if (ii === from) return [si, to];
        if (ii === to) return [si, from];
        return [si, ii];
      });
    }
    patchSection(sectionIndex, (section) => ({
      ...section,
      items: moved(section.items, from, to),
    }));
  };

  const patchSteps = (next: (steps: StepFields[]) => StepFields[]) =>
    setForm((prev) => ({ ...prev, steps: next(prev.steps) }));

  const patchStep = (key: number, fields: Partial<Omit<StepFields, 'key'>>) =>
    patchSteps((steps) =>
      steps.map((step) => (step.key === key ? { ...step, ...fields } : step)),
    );
  const lanesInForm = formLanes(form.steps);

  // A lone unnamed section is the common case and needs no naming or removal
  // controls; they only appear once the recipe actually has sections.
  const showSectionChrome =
    form.sections.length > 1 || form.sections.some((s) => s.name.trim() !== '');

  const canSubmit = form.title.trim() !== '' && !busy && submitLocked !== true;
  useLayoutEffect(() => {
    onCanSubmitChange?.(canSubmit);
  }, [canSubmit, onCanSubmitChange]);

  const photosPicked = picked !== undefined || galleryPicked.length > 0;
  const dirty =
    JSON.stringify(form) !== JSON.stringify(baseline.current) ||
    photoId !== initial.photoId ||
    idList(galleryPhotoIds) !== idList(initial.galleryPhotoIds) ||
    photosPicked;
  useLayoutEffect(() => {
    onEditStateChange?.({ dirty, photosPicked });
  }, [dirty, photosPicked, onEditStateChange]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setPhotoError(null);
    try {
      // Decode every selection before registering photos, so an unreadable
      // file leaves nothing to clean up locally or on the server.
      let encodedCover: Blob | undefined;
      const encodedGallery: Blob[] = [];
      try {
        if (picked) {
          encodedCover = await encodeImageForStorage(picked);
        }
        for (const file of galleryPicked) {
          encodedGallery.push(await encodeImageForStorage(file));
        }
      } catch {
        setPhotoError(t('error.photoUnreadableTryAnother'));
        return;
      }
      let stored: string | undefined;
      const storedGallery: string[] = [];
      try {
        if (encodedCover) {
          stored = await photoStore.add(encodedCover);
        }
        for (const blob of encodedGallery) {
          storedGallery.push(await photoStore.add(blob));
        }
        await onSubmit(
          toDraft(form, initial, stored ?? photoId, [
            ...galleryPhotoIds,
            ...storedGallery,
          ]),
        );
      } catch (e) {
        // A retry stages the picked files onto fresh ids, so forget these
        // bytes. Local only: `recipeStore.save` decides whether an uploaded id
        // is safe to tombstone on the server.
        if (stored) photoStore.discardLocal(stored);
        for (const id of storedGallery) photoStore.discardLocal(id);
        throw e;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={formId}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        // Enter in any of these one-line fields would submit the whole recipe;
        // saving is explicit and only the button does it.
        if (
          e.key === 'Enter' &&
          (e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLSelectElement)
        ) {
          e.preventDefault();
        }
      }}
    >
      <Field label={t('form.title')}>
        <input
          type="text"
          value={form.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder={t('form.titlePlaceholder')}
          className={inputClass}
        />
      </Field>

      <Field label={t('form.description')}>
        <textarea
          value={form.description}
          onChange={(e) => patch({ description: e.target.value })}
          rows={2}
          placeholder={t('form.descriptionPlaceholder')}
          className={inputClass}
        />
      </Field>

      {photosEditable && (
        <PhotoField
          photoId={photoId}
          picked={picked}
          onPick={(file) => {
            setPhotoError(null);
            setPicked(file);
          }}
          onRemove={() => {
            setPicked(undefined);
            setPhotoId(undefined);
          }}
        />
      )}
      {photoError && (
        <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
          {photoError}
        </p>
      )}

      {/* items-end keeps the inputs level when one label wraps (uk/ru "Cook, min"). */}
      <div className="mt-3 grid grid-cols-3 items-end gap-2">
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">{t('common.servings')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.servings}
            onChange={(e) => patch({ servings: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">{t('form.prepMin')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.prepMinutes}
            onChange={(e) => patch({ prepMinutes: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-muted">{t('form.cookMin')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={form.cookMinutes}
            onChange={(e) => patch({ cookMinutes: e.target.value })}
            className={`mt-1 ${inputClass}`}
          />
        </label>
      </div>

      <Field label={t('form.tags')}>
        <input
          type="text"
          value={form.tags}
          onChange={(e) => patch({ tags: e.target.value })}
          placeholder={t('form.tagsPlaceholder')}
          className={inputClass}
        />
      </Field>

      {!hideLanguage && (
        <div>
          <Field label={t('form.recipeLanguage')}>
            <LanguagePicker
              id="recipe-language"
              value={form.lang}
              onChange={(lang) => patch({ lang })}
              className="mt-0"
            />
          </Field>
          {hintTag !== undefined && (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
              <span>{t('form.looksLikeLanguage', { language: languageName(hintTag, locale) ?? hintTag })}</span>
              <button
                type="button"
                onClick={() => patch({ lang: hintTag })}
                className="underline hover:text-ink"
              >
                {t('form.useDetectedLanguage', {
                  language: languageName(hintTag, locale) ?? hintTag,
                })}
              </button>
            </p>
          )}
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{t('common.ingredients')}</h2>
        {form.sections.map((section, si) => (
          <div key={si} className="mt-3">
            {showSectionChrome && (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  aria-label={t('form.sectionName', { n: si + 1 })}
                  value={section.name}
                  onChange={(e) =>
                    patchSection(si, (s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder={t('form.sectionNamePlaceholder')}
                  className={`flex-1 ${inputClass}`}
                />
                <button
                  type="button"
                  aria-label={t('form.removeSection', { n: si + 1 })}
                  onClick={() => {
                    patchSections((sections) =>
                      sections.filter((_, i) => i !== si),
                    );
                    remapCustomUnits((s, i) => {
                      if (s === si) return null;
                      return [s > si ? s - 1 : s, i];
                    });
                  }}
                  className={iconBtn}
                >
                  ✕
                </button>
              </div>
            )}

            <ul className="mt-2 flex flex-col gap-2">
              {section.items.map((item, ii) => {
                const key = unitKey(si, ii);
                const choice = customUnits.has(key)
                  ? CUSTOM_UNIT
                  : unitChoice(item.unit);
                return (
                  <li
                    key={ii}
                    className="rounded-xl border border-line bg-surface p-2 shadow-sm"
                  >
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={t('form.quantity')}
                        value={item.quantity}
                        onChange={(e) =>
                          patchItem(si, ii, { quantity: e.target.value })
                        }
                        placeholder="1"
                        className={`w-14 ${cellClass}`}
                      />
                      <select
                        aria-label={t('form.unit')}
                        value={choice}
                        onChange={(e) => {
                          const next = e.target.value as UnitChoice;
                          // One uniform call: — clears, a listed unit writes
                          // itself, Custom… carries the current text through.
                          patchItem(si, ii, {
                            unit: resolveUnit(next, item.unit) ?? '',
                          });
                          setCustomUnits((prev) => {
                            const updated = new Set(prev);
                            if (next === CUSTOM_UNIT) {
                              updated.add(key);
                            } else {
                              updated.delete(key);
                            }
                            return updated;
                          });
                        }}
                        className={`w-24 ${cellClass} bg-surface text-ink`}
                      >
                        <option value="">—</option>
                        {COMMON_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {unitLabel(u, t)}
                          </option>
                        ))}
                        <option value={CUSTOM_UNIT}>{t('form.custom')}</option>
                      </select>
                      <input
                        type="text"
                        aria-label={t('form.ingredient')}
                        value={item.item}
                        onChange={(e) =>
                          patchItem(si, ii, { item: e.target.value })
                        }
                        placeholder={t('form.ingredientPlaceholder')}
                        className={`flex-1 ${cellClass}`}
                      />
                    </div>
                    {choice === CUSTOM_UNIT && (
                      <div className="mt-1.5 flex gap-1.5">
                        <input
                          type="text"
                          aria-label={t('form.customUnit')}
                          placeholder={t('form.unitPlaceholder')}
                          value={item.unit}
                          onChange={(e) => {
                            // Raw value, untrimmed — trimming per keystroke
                            // makes a space impossible to type; toIngredient
                            // trims on submit. Pinning the key keeps a
                            // resolver-entered custom row (e.g. a stored
                            // 'knob') in custom mode when an edit makes the
                            // text empty or exactly a listed unit.
                            patchItem(si, ii, { unit: e.target.value });
                            setCustomUnits((prev) => {
                              const updated = new Set(prev);
                              updated.add(key);
                              return updated;
                            });
                          }}
                          className={`w-24 ${cellClass}`}
                        />
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <input
                        type="text"
                        aria-label={t('form.ingredientNote')}
                        value={item.note}
                        onChange={(e) =>
                          patchItem(si, ii, { note: e.target.value })
                        }
                        placeholder={t('form.notePlaceholder')}
                        className={`flex-1 text-sm ${cellClass}`}
                      />
                      <button
                        type="button"
                        aria-label={t('form.moveIngredientUp')}
                        disabled={ii === 0}
                        onClick={() => moveItem(si, ii, ii - 1)}
                        className={iconBtn}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={t('form.moveIngredientDown')}
                        disabled={ii === section.items.length - 1}
                        onClick={() => moveItem(si, ii, ii + 1)}
                        className={iconBtn}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={t('form.removeIngredient')}
                        onClick={() => {
                          patchSection(si, (s) => ({
                            ...s,
                            items: s.items.filter((_, i) => i !== ii),
                          }));
                          remapCustomUnits((s, i) => {
                            if (s !== si || i < ii) return [s, i];
                            if (i === ii) return null;
                            return [s, i - 1];
                          });
                        }}
                        className={iconBtn}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() =>
                patchSection(si, (s) => ({ ...s, items: [...s.items, blankItem()] }))
              }
              className={`mt-2 block ${addBtn}`}
            >
              {t('form.addIngredient')}
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            patchSections((sections) => [
              ...sections,
              { name: '', items: [blankItem()] },
            ])
          }
          className={`mt-2 block ${addBtn}`}
        >
          {t('form.addSection')}
        </button>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{t('common.steps')}</h2>
        <p className="mt-1 text-sm text-ink-muted">{t('form.lanesHint')}</p>
        <ol className="mt-2 flex flex-col gap-2">
          {form.steps.map((step, i) => {
            const typing = typingLanes.has(step.key);
            return (
              <li
                key={step.key}
                className="rounded-xl border border-line bg-surface p-2 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="pl-1 text-sm font-semibold text-ink-subtle">
                      {i + 1}
                    </span>
                    <select
                      aria-label={t('form.stepLane', { n: i + 1 })}
                      value={typing ? NEW_LANE : step.lane.trim()}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next === NEW_LANE) {
                          patchStep(step.key, { lane: '' });
                          setTypingLane(step.key, true);
                        } else {
                          patchStep(step.key, { lane: next });
                          setTypingLane(step.key, false);
                        }
                      }}
                      className={`max-w-40 min-w-0 ${cellClass} bg-surface text-ink`}
                    >
                      <option value="">{t('form.noLane')}</option>
                      {lanesInForm.map((lane) => (
                        <option key={lane} value={lane}>
                          {lane}
                        </option>
                      ))}
                      <option value={NEW_LANE}>{t('form.newLane')}</option>
                    </select>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={t('form.moveStepUp', { n: i + 1 })}
                      disabled={i === 0}
                      onClick={() => patchSteps((steps) => moved(steps, i, i - 1))}
                      className={iconBtn}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t('form.moveStepDown', { n: i + 1 })}
                      disabled={i === form.steps.length - 1}
                      onClick={() => patchSteps((steps) => moved(steps, i, i + 1))}
                      className={iconBtn}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={t('form.removeStep', { n: i + 1 })}
                      onClick={() => {
                        patchSteps((steps) => steps.filter((_, j) => j !== i));
                        setTypingLane(step.key, false);
                      }}
                      className={iconBtn}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {typing && (
                  <input
                    type="text"
                    aria-label={t('form.laneName')}
                    placeholder={t('form.lanePlaceholder')}
                    maxLength={MAX_LANE_CHARS}
                    value={step.lane}
                    // Raw value: compactLane trims on submit.
                    onChange={(e) => patchStep(step.key, { lane: e.target.value })}
                    className={`mt-1.5 w-40 ${cellClass}`}
                  />
                )}
                <textarea
                  aria-label={t('form.step', { n: i + 1 })}
                  value={step.text}
                  onChange={(e) => patchStep(step.key, { text: e.target.value })}
                  rows={2}
                  placeholder={t('form.stepPlaceholder')}
                  className={`mt-1 w-full ${cellClass}`}
                />
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          onClick={() => patchSteps((steps) => [...steps, stepFields('')])}
          className={`mt-2 block ${addBtn}`}
        >
          {t('form.addStep')}
        </button>
      </section>

      <Field label={t('common.notes')}>
        <textarea
          value={form.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          rows={3}
          placeholder={t('form.notesPlaceholder')}
          className={inputClass}
        />
      </Field>

      {photosEditable && (
        <PhotoPickerField
          label={t('form.gallery')}
          hint={t('form.galleryHint')}
          max={MAX_GALLERY_PHOTOS}
          removeLabel={t('form.removeGalleryPhoto')}
          photoIds={galleryPhotoIds}
          picked={galleryPicked}
          onPick={(files) => {
            setPhotoError(null);
            setGalleryPicked((prev) => {
              const room = MAX_GALLERY_PHOTOS - galleryPhotoIds.length - prev.length;
              return room <= 0 ? prev : [...prev, ...files.slice(0, room)];
            });
          }}
          onRemoveStored={(id) =>
            setGalleryPhotoIds((prev) => prev.filter((item) => item !== id))
          }
          onRemovePicked={(index) =>
            setGalleryPicked((prev) => prev.filter((_, i) => i !== index))
          }
        />
      )}

      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`${secondaryBtn} flex-1 py-3`}
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`${primaryBtn} flex-1 py-3`}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
