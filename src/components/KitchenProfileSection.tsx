import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useT, type TextKey } from '../i18n';
import {
  ALLERGENS,
  DIETS,
  MAX_KITCHEN_TEXT_CHARS,
  fetchKitchenProfile,
  saveKitchenProfile,
  type Allergen,
  type Diet,
  type KitchenProfile,
} from '../lib/kitchenProfileApi';
import { chipClass, inputClass, primaryBtn } from '../lib/uiClasses';

const ALLERGEN_LABELS: Readonly<Record<Allergen, TextKey>> = {
  gluten: 'settings.allergen.gluten',
  crustaceans: 'settings.allergen.crustaceans',
  eggs: 'settings.allergen.eggs',
  fish: 'settings.allergen.fish',
  peanuts: 'settings.allergen.peanuts',
  soy: 'settings.allergen.soy',
  milk: 'settings.allergen.milk',
  treeNuts: 'settings.allergen.treeNuts',
  celery: 'settings.allergen.celery',
  mustard: 'settings.allergen.mustard',
  sesame: 'settings.allergen.sesame',
  sulphites: 'settings.allergen.sulphites',
  lupin: 'settings.allergen.lupin',
  molluscs: 'settings.allergen.molluscs',
};

const DIET_LABELS: Readonly<Record<Diet, TextKey>> = {
  vegetarian: 'settings.diet.vegetarian',
  vegan: 'settings.diet.vegan',
  pescatarian: 'settings.diet.pescatarian',
  glutenFree: 'settings.diet.glutenFree',
  dairyFree: 'settings.diet.dairyFree',
  halal: 'settings.diet.halal',
  kosher: 'settings.diet.kosher',
};

/** The section's anchor; the Generate hint on `/import` links to `/settings#kitchen-profile`. */
export const KITCHEN_PROFILE_ANCHOR = 'kitchen-profile';

type TextField = 'avoid' | 'dislikes' | 'equipment' | 'notes';

const TEXT_FIELDS: readonly { field: TextField; label: TextKey; placeholder: TextKey }[] = [
  { field: 'avoid', label: 'settings.kitchenAvoid', placeholder: 'settings.kitchenAvoidPlaceholder' },
  { field: 'dislikes', label: 'settings.kitchenDislikes', placeholder: 'settings.kitchenDislikesPlaceholder' },
  { field: 'equipment', label: 'settings.kitchenEquipment', placeholder: 'settings.kitchenEquipmentPlaceholder' },
  { field: 'notes', label: 'settings.kitchenNotes', placeholder: 'settings.kitchenNotesPlaceholder' },
];

function toggled<T extends string>(list: readonly T[], code: T, order: readonly T[]): T[] {
  const next = list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
  return order.filter((c) => next.includes(c));
}

/**
 * Settings → Kitchen profile (`docs/plans/kitchen-profile.md`). Loaded when
 * the section mounts and saved whole; the server reads it for Ask, the
 * assistant, and Generate. Component state only: nothing else in the client
 * reads the profile.
 */
export default function KitchenProfileSection() {
  const t = useT();
  const [profile, setProfile] = useState<KitchenProfile | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const mountedRef = useRef(true);
  // Bumped on every edit, so a save that returns after the member kept typing
  // never replaces what they typed or claims it was saved.
  const editsRef = useRef(0);
  const { hash } = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const loaded = profile !== null;

  // Arriving from the Generate hint: scroll here once the form has its height.
  useEffect(() => {
    if (loaded && hash === `#${KITCHEN_PROFILE_ANCHOR}`) sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [loaded, hash]);

  useEffect(() => {
    mountedRef.current = true;
    fetchKitchenProfile().then(
      (loaded) => {
        if (mountedRef.current) setProfile(loaded);
      },
      () => {
        if (mountedRef.current) setLoadFailed(true);
      },
    );
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const edit = (next: KitchenProfile) => {
    editsRef.current += 1;
    setProfile(next);
    setStatus('idle');
  };

  const save = async () => {
    if (profile === null) return;
    const editsAtStart = editsRef.current;
    setSaving(true);
    setStatus('idle');
    try {
      const saved = await saveKitchenProfile(profile);
      if (mountedRef.current && editsRef.current === editsAtStart) {
        setProfile(saved);
        setStatus('saved');
      }
    } catch {
      // A failure replaces nothing, so it shows even if the member kept typing.
      if (mountedRef.current) setStatus('error');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <section id={KITCHEN_PROFILE_ANCHOR} ref={sectionRef}>
      <h2 className="mt-8 text-lg font-semibold">{t('settings.kitchenTitle')}</h2>
      <p className="mt-1 text-sm text-ink-muted">{t('settings.kitchenIntro')}</p>
      {profile === null && !loadFailed && <p className="mt-3 text-sm text-ink-muted">{t('common.loading')}</p>}
      {loadFailed && <p className="mt-3 text-sm text-danger">{t('settings.kitchenLoadError')}</p>}
      {profile !== null && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset>
            <legend className="text-sm font-medium">{t('settings.kitchenAllergens')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {ALLERGENS.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={profile.allergens.includes(code)}
                  onClick={() => edit({ ...profile, allergens: toggled(profile.allergens, code, ALLERGENS) })}
                  className={chipClass(profile.allergens.includes(code))}
                >
                  {t(ALLERGEN_LABELS[code])}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium">{t('settings.kitchenDiets')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {DIETS.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={profile.diets.includes(code)}
                  onClick={() => edit({ ...profile, diets: toggled(profile.diets, code, DIETS) })}
                  className={chipClass(profile.diets.includes(code))}
                >
                  {t(DIET_LABELS[code])}
                </button>
              ))}
            </div>
          </fieldset>
          {TEXT_FIELDS.map(({ field, label, placeholder }) => (
            <div key={field} className="mt-4">
              <label htmlFor={`kitchen-${field}`} className="block text-sm font-medium">
                {t(label)}
              </label>
              <textarea
                id={`kitchen-${field}`}
                rows={2}
                maxLength={MAX_KITCHEN_TEXT_CHARS}
                value={profile[field]}
                placeholder={t(placeholder)}
                onChange={(event) => edit({ ...profile, [field]: event.target.value })}
                className={`${inputClass} mt-1 resize-y`}
              />
            </div>
          ))}
          <div className="mt-4 flex items-center gap-3">
            <button type="submit" disabled={saving} className={`${primaryBtn} px-5 py-2.5`}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <p role="status" className="text-sm">
              {status === 'saved' && <span className="text-ink-muted">{t('settings.kitchenSaved')}</span>}
              {status === 'error' && <span className="text-danger">{t('settings.kitchenSaveError')}</span>}
            </p>
          </div>
        </form>
      )}
    </section>
  );
}
