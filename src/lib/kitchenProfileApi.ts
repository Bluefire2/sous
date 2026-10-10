import { t } from '../i18n';
import { invalidateSession } from './session';

/**
 * The kitchen profile (`docs/plans/kitchen-profile.md`), edited in Settings.
 * The server adds it to Ask, the assistant, and Generate; the client only
 * reads and saves it. The lists and the cap mirror `server/kitchenProfile.ts`,
 * which the client cannot import; `kitchenProfileApi.test.ts` keeps them equal.
 */
export const ALLERGENS = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soy',
  'milk',
  'treeNuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const DIETS = ['vegetarian', 'vegan', 'pescatarian', 'glutenFree', 'dairyFree', 'halal', 'kosher'] as const;
export type Diet = (typeof DIETS)[number];

export const MAX_KITCHEN_TEXT_CHARS = 500;

export interface KitchenProfile {
  allergens: Allergen[];
  diets: Diet[];
  avoid: string;
  dislikes: string;
  equipment: string;
  notes: string;
}

export const EMPTY_KITCHEN_PROFILE: KitchenProfile = {
  allergens: [],
  diets: [],
  avoid: '',
  dislikes: '',
  equipment: '',
  notes: '',
};

/** `{ profile }` from the server as a profile (empty when none is saved), or null for any other body. */
export function parseKitchenProfile(data: unknown): KitchenProfile | null {
  if (typeof data !== 'object' || data === null || !('profile' in data)) return null;
  const raw = (data as { profile: unknown }).profile;
  if (raw === null) return { ...EMPTY_KITCHEN_PROFILE };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const codes = <T extends string>(value: unknown, known: readonly T[]): T[] =>
    Array.isArray(value) ? known.filter((code) => value.includes(code)) : [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    allergens: codes(row.allergens, ALLERGENS),
    diets: codes(row.diets, DIETS),
    avoid: text(row.avoid),
    dislikes: text(row.dislikes),
    equipment: text(row.equipment),
    notes: text(row.notes),
  };
}

/** A 401 signs the session out; anything else is the caller's to word. */
function failure(response: Response): Error {
  if (response.status === 401) {
    invalidateSession();
    return new Error(t('error.sessionExpired'));
  }
  return new Error(t('error.requestFailed', { status: response.status }));
}

export async function fetchKitchenProfile(): Promise<KitchenProfile> {
  const response = await fetch('/api/settings/kitchen', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw failure(response);
  const profile = parseKitchenProfile(await response.json().catch(() => null));
  if (profile === null) throw new Error(t('error.requestFailed', { status: response.status }));
  return profile;
}

/** Saves the whole profile and returns what the server stored. */
export async function saveKitchenProfile(profile: KitchenProfile): Promise<KitchenProfile> {
  const response = await fetch('/api/settings/kitchen', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!response.ok) throw failure(response);
  const saved = parseKitchenProfile(await response.json().catch(() => null));
  if (saved === null) throw new Error(t('error.requestFailed', { status: response.status }));
  return saved;
}
