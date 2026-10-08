# Cooking-screen settings

Two device-local settings for the recipe screens, in a new Settings →
Cooking section: keep the screen awake while cooking (on/off, default on) and
recipe text size (normal/large, default normal). They describe the device,
not the person, so they live in localStorage next to `cook.theme` and
`cook.locale` and are never synced, backed up, or sent to the server.

Constitutions applied: `docs/constitutions/client-state.md` (principles 3
and 5: React reads both settings through `useSyncExternalStore` with a
stable getter and a subscription, so a change in Settings reaches an open
recipe screen without a reload) and `docs/constitutions/i18n.md` (principles
9 and 16: every new string is in all four catalogs, and the new states are in
the review manifest).

## Decisions

- Keys: `cook.wakeLock` (`'on' | 'off'`) and `cook.recipeTextSize`
  (`'normal' | 'large'`). Only a stored `off` turns the wake lock off, and
  only a stored `large` makes text large; anything else, a missing key, or
  storage that throws reads as the default.
- Writes are best-effort: a write that throws leaves the stored value in
  place, and subscribers are still notified (they reread the old value).
- Large text is one Tailwind step up (`text-lg`) on ingredient and step rows,
  with the current step one step above that (`text-xl`). Headings, the
  servings control, and the page chrome keep their size. Paper always prints
  the normal size.
- `RecipeBody` stays store-free: RecipeView and PublicRecipe read the size
  and pass it in as `textSize`.
- The section shows signed in or out, because the settings belong to the
  device.

## Steps

### 1. [core] Settings and hooks

- `src/lib/settings.ts`: `WAKE_LOCK_KEY`, `RECIPE_TEXT_SIZE_KEY`,
  `getWakeLock` / `setWakeLock` / `subscribeWakeLock`, and
  `getRecipeTextSize` / `setRecipeTextSize` / `subscribeRecipeTextSize`,
  with reads and writes wrapped in try/catch.
- `src/lib/useDeviceSettings.ts`: `useWakeLockSetting` and
  `useRecipeTextSize` over `useSyncExternalStore`.
- `src/lib/useWakeLock.ts`: requests nothing while the setting is off;
  turning it off releases a held lock; a lock granted after unmount or after
  the setting went off is released at once.
- Tests in `src/lib/settings.test.ts`: defaults, unknown values, setters
  notifying only their own subscribers, storage that throws or is missing.

### 2. [ui] Settings → Cooking and the recipe screens

- `src/screens/Settings.tsx`: the Cooking section after Appearance, before
  Language: a device-only note, a checkbox for the wake lock, and Normal /
  Large buttons in the theme buttons' style (`aria-pressed`).
- `src/components/RecipeBody.tsx`: `textSize` on `IngredientsSection` and
  `StepsSection`; `src/screens/RecipeView.tsx` and
  `src/screens/PublicRecipe.tsx` pass it.
- Catalog keys `settings.cooking`, `settings.cookingDeviceOnly`,
  `settings.keepScreenAwake`, `settings.recipeTextSize`,
  `settings.textSizeNormal`, `settings.textSizeLarge` in `en`, `uk`, `ru`,
  `zh-Hans`.
- Review states `settings-cooking-changed` and `recipe-view-large-text` in
  `docs/i18n-review/screens.json` and `testing/i18n-review/states.ts`.

### 3. [core] Disclosure

- `public/privacy.html` (What is stored) names both keys; `AGENTS.md`
  (Product copy) lists them with what stays in localStorage.
