# Measurement units

Status: phase 1 merged (#180); phase 2 merged.
Constitutions applied: client state (principle 3: `useUnitSystem` reads a
module store through `useSyncExternalStore` with a primitive getter; scope
updated), i18n (catalogs, principle 1: share and copy keep the stored recipe;
the in-context review states below).

## Goal

Recipes imported from US sites arrive in pounds, ounces and °F, and a member
who cooks in metric converts them in their head. Settings gets
**Measurements: As written | Metric**, saved on the account. With Metric, the
recipe screen shows weights in g/kg and Fahrenheit in °C, with the original
beside each, at display time. The stored recipe never changes.

## Decisions (with the owner, 2026-10-09)

- **Volume is never converted.** Cups, tablespoons, teaspoons and fl oz stay
  as written: "1 cup flour" in grams needs each ingredient's density.
- **Round to what a cookbook would print**: the roundest amount within 5%.
- **Show the original beside it**: "450 g (1 lb) ground beef", "180°C
  (350°F)". The pattern is the catalog string `recipe.convertedQuantity`, so
  zh-Hans uses its own brackets.
- **On the account**, not the device, so every device agrees and phase 2 can
  have Generate and Ask write metric.

## Rounding

Weight (`niceWeight` in `src/lib/unitConversion.ts`):

1. Convert after servings scaling: 1 lb at 2× is converted from 2 lb.
2. Exact grams are lb × 453.592 or oz × 28.3495.
3. Try the steps 500, 250, 100, 50, 25, 10, 5 and 1 g in that order. Take the first one whose rounded value is above 0 and within 5% of the exact value.
4. Under 10 g, if no step qualifies, use tenths.
5. Show 1000 g and over in kg, judged on the rounded value.
6. Format converted numbers with `formatNumber`, never `formatQuantity`, so there is no "2¼ kg".

| Original | Shown |
| --- | --- |
| 1 oz | 28 g (30 g would be 5.8% off) |
| 4 oz | 110 g |
| 8 oz | 225 g |
| 12 oz | 350 g |
| 14 oz | 400 g |
| 1 lb | 450 g |
| 1½ lb | 700 g |
| 2 lb | 900 g |
| 3 lb | 1.4 kg |
| 5 lb | 2.25 kg |

Temperature (`fahrenheitToCelsius`):
- An oven setting rounds to the nearest 10 °C, so 350 °F in "Bake at 350°F" reads 180 °C.
  - A setting is a multiple of 25 °F from 250 to 550, with an oven word within 60 characters before it or 12 after.
  - The oven words are oven (not "Dutch oven"), preheat, bake, roast and broil.
  - In translated text they are духов, піч or печ (but not печінка or печень, liver), запек/випік, and 烤.
  - A frying word nearby (oil, fry, олі, масл, 油) keeps the exact degree.
- Everything else rounds to the degree, so oil and sugar keep their precision:
  - "Heat oil in a Dutch oven to 350°F" reads 177 °C;
  - 275 °F syrup reads 135 °C;
  - 165 °F reads 74 °C;
  - −10 °F reads −23 °C.

`convertTemperaturesInText` rewrites these forms in step and note text:
- `350°F`, `350 ºf`, `350˚ F`, `350℉`;
- `350 degrees F`, `350 deg. F` and `350 degrees Fahrenheit`;
- `350F` and `350 F`. This needs three digits, so a bare F after a shorter number ("a 12F probe") is left alone.
- Ranges joined by a dash, a slash, "to", "and" or "or" (`325–350°F`, `325 to 350 degrees F`, `between 350 and 375°F`), and negatives.
  - Two numbers count as a range only when they are at most 100 °F apart.
  - Otherwise only the second number is converted, as in "Gas mark 4 or 177°C (350°F)" or "between 10 and 177°C (350°F)".

It leaves two cases alone:
- a temperature whose own value, within 6 °C, is already written in Celsius within 25 characters on either side. Examples are `425°F / 220°C`, `180°C/350°F`, `300°F (150°C)`, `350°F (180 °С)` with a Cyrillic С, and `350°F（175摄氏度）`.
  - A Celsius value for a different temperature does not block a conversion: "Roast at 425°F (220°C), then reduce to 350°F" converts the 350.
  - "1C sugar" (a cup) is not Celsius.
- a bare `350°` or `350 degrees`, which could be Celsius.

Saves from Settings go to the server one at a time, so two quick taps leave the account on the last choice. After a failed save the store re-reads the account, and a failed read is tried again when the tab comes back into view or the device reconnects.

## Steps

### Phase 1

1. [core] `server/accountPreferences.ts`. `users/{sub}/settings/preferences` holds `{ units, updatedAt }`, in its own document, because the kitchen POST replaces its whole document.
   - Input parsing is strict, so an unknown value is a 400.
   - A store failure is a 503, and no error escapes.
   - A missing document reads as `asWritten`.
   - `GET`/`POST /api/settings/preferences` sit behind `withMembership`.
   - The `settings` collection was already classified for account deletion.
2. [core] `src/lib/unitConversion.ts`, pure: `toGrams`, `niceWeight`, `fahrenheitToCelsius`, `convertTemperaturesInText`.
3. [ui] `ingredientLine` takes `{ units, storedUnit }`.
   - The weight test reads the stored unit, because translation can change a unit like "lbs".
   - `displayTemperatures` covers step and note text.
   - Share and copy, the edit form, Ask's proposal card, and the assistant's shopping list stay as written.
4. [ui] `src/lib/accountPreferences.ts` is a module store read with `useUnitSystem`.
   - It loads on the first subscribe while signed in.
   - It caches `{ sub, units }` in `cook.units`, so another account on the device never sees it.
   - A save shows the new value at once. A failed save reverts, unless a newer choice was made meanwhile.
   - Sign-out clears it.
5. [ui] Wiring and Settings.
   - `RecipeView` and `PublicRecipe` pass `units` to `IngredientsSection`, `StepsSection`, and `NotesSection`. A signed-out public reader gets `asWritten`.
   - Settings has a Measurements section after Kitchen profile, shown when signed in.
6. [ui] i18n.
   - Catalog strings go in all four languages.
   - Review states: `settings-measurements`, `settings-measurements-save-error`, and `recipe-view-metric`.
   - The member's roast chicken fixture is now in lb and °F, and the member is seeded with `metric`.
7. [core] Docs and tests.
   - `/privacy` (stored setting, `cook.units`, deletion) and AGENTS.md.
   - `writeSmoke` round-trips the setting, and `deletionCheck` checks it is removed with the viewer.

### Phase 2 (separate PR, stacked on #180)

8. [core] Prompt context. `readPromptContext(sub)` reads the kitchen and preferences documents in one Firestore `getAll`.
   - It is used by `withKitchenProfile` (chat), the Generate branch of `server/importRoute.ts`, and `server/agent/route.ts`.
   - A failed read stays 503.
9. [core] Prompt lines, added when the account is set to `metric`:
   - **Generate:** write weights in g/kg and oven temperatures in °C, and volumes in ml/l or spoons.
   - **Ask and the assistant:** use metric for new quantities, and do not convert existing ones unless asked.
   - Read `evals/AGENTS.md` first, add a dev Generate eval with metric, and log it in `evals/EXPERIMENTS.md`.

## Known limits

- **"oz" is always a weight.** The import schema hint offers `oz` but not `fl oz` (`server/recipeImport.ts`), so "8 oz milk" shows as 225 g, about 5% under for water-like liquids. Adding `fl oz` to the hint changes the import prompt and goes through `evals/AGENTS.md`.
- **Weights inside free text.** A weight in a note or an ingredient name ("1 can (14 oz)") is not converted. Only the structured quantity and unit are.
