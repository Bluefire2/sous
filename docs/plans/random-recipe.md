# Random recipe

Status: planned, not built. Issue #113.

Constitutions applied: client-state (a new Library sheet under principle 6),
i18n (new copy in every catalog and a review state under principle 16).

## Goal

A member who doesn't know what to cook can narrow the library ("I'm feeling
chicken") and let a dice roll pick one recipe from what is left, then roll
again until something appeals.

## Out of scope

- Pool modifiers such as "not cooked in the last 30 days" (from cook logs) or
  "under 30 minutes" (from `prepMinutes` + `cookMinutes`). They fit later as
  toggles in the roll sheet.
- Rolling from the assistant ("what should I cook?"). The dice is instant and
  works offline; the assistant needs the model.
- Remembering past rolls, weighting by rating, or any server, sync, or log
  change.

## Decisions

- **The pool is the list Library is showing.** The search already matches
  titles, tags, and ingredient names (`visibleLibraryRecipes`) and respects
  the collection scope and All collections. Filtering is typing a word, and
  the person sees what the dice will choose from. There is no second filter UI.
- **The entry point is a dice button in the search row**, beside Select, All
  collections, and Sort. The header already holds five controls
  (`feature-requests.md`). The button shows only when the visible list holds at
  least two recipes, and not while selecting.
- **The result is a sheet, not a navigation**, because rolling again is the
  point. The sheet shows the picked recipe's cover photo, title, and times,
  a "From N recipes" line naming the pool size, Open recipe (a link to
  `/recipe/<id>`), and Roll again.
- **The pool is frozen when the sheet opens.** A pull that lands mid-roll
  does not change it. The pick resolves against the live snapshot; if a pull
  removed the picked recipe, the sheet rolls again from the pool recipes that
  still exist, and closes if none do.
- **Roll again never repeats the previous pick** when the pool holds two or
  more recipes.
- **Shared recipes in the visible list are in the pool**; the person can
  already open them.
- **The pick is decided before the animation starts.** The animation is
  presentation only: the dice icon tumbles (rotate and hop, 900 ms) and the
  pick appears when it stops. Cycling through other titles first was tried
  and dropped: with a small pool it reads as a wrong result that then
  changes. The tumble is a CSS keyframe with no animation library. With
  `prefers-reduced-motion`, the result shows at once. Only the final result
  is in an `aria-live` region.
- **No `Recipe` field, route, fetch, storage, or log line.**

## Steps

1. `[core]` `src/lib/randomRecipe.ts`: `pickRandom(ids, previous, random =
   Math.random)` returns one id, never `previous` when another id exists.
   Unit tests inject `random`: deterministic picks, no repeat, a pool of one.
2. `[core]` `src/lib/libraryFlow.ts`: sheet kind `{ kind: 'roll'; poolIds:
   readonly string[]; pickId: string }` and actions `openRoll` and `reroll`.
   The handler calls `pickRandom`; the reducer stays pure. Reducer tests for
   open, reroll, close, and a stale token.
3. `[ui]` Dice icon in `src/lib/icons.tsx` and the button in the search row
   of `src/screens/Library.tsx` (both the switcher and no-switcher layouts).
4. `[ui]` The roll sheet: result card, Open recipe, Roll again, pool size,
   the animation, the reduced-motion path, and the removed-pick reroll.
5. `[ui]` Copy in every catalog (`en`, `ru`, `uk`, `zh-Hans`): the button's
   label, the sheet title, Roll again, Open recipe, and "From {count}
   recipes" with plural forms. Add the roll sheet to
   `docs/i18n-review/screens.json` and `testing/i18n-review/states.ts`.
6. `[ui]` Verify in test mode (below). `npm run test:i18n` for the new state
   needs `GEMINI_API_KEY`; the main developer runs it on this branch and fixes
   any blockers before the PR merges.

## Verification

In test mode as `member` (`testing/README.md`):

- With an empty search, the dice picks from the whole visible list, and the
  pool line matches the number of cards.
- With All collections on, searching `chicken` leaves the two roast chickens;
  Roll again alternates between them.
- A search leaving one recipe, or none, hides the dice. So does Select.
- With All collections on, a recipe from another collection can come up.
- Open recipe lands on that recipe; Escape and the backdrop close the sheet.
- With reduced motion emulated, the result shows with no animation.
- Deleting the picked recipe from another tab and refreshing rolls again
  rather than showing a missing recipe.
- Each UI language fits the sheet at phone width.
