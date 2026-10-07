# Parallel steps ("cooking together")

Status: built on `claude/parallel-recipe-steps-857b23`, not deployed.

## Where the build departs from this plan

- **Cook-write tests** live in `src/lib/optimisticWrite.test.ts` (a new
  `describe` block), not a new `useCookState.test.ts`: that file already
  mocks `./remote` and seeds cook rows.
- **The agent module imports `compactSteps` through `server/store.ts`**,
  which re-exports it. `test/agentBoundary.test.ts` lets `server/agent/sous/`
  import only `server/store.ts` from the server, and the rule stays.
- **Ask's proposal diff shows what Apply saves**: `ChatPanel` diffs the
  proposal after `carryStepLanes`, so a proposal that forgot lanes does not
  show every laned step as changed.
- **MCP treats a blank lane as no lane** (`optionalText`); a long or
  non-string lane is still an error at `steps[i].lane`.
- **Lane names in `uk`, `ru` and `zh-Hans`.** "Lane" is translated as
  частина / часть / 分工 ("part" / "division of work"), and the chip label
  "I'm on" as "Моя частина" / "Моя часть" / "我负责".
- **The library agent sees lanes**, since `parseSteps` now keeps them; it
  needs no prompt change.

## Context

When two people cook one recipe, some steps can run at the same time (sauce while the pasta boils). Sous has no way to say so: a step is `{ text }`, and cook progress is one `currentStep` index where everything before it is done, so only one step can be "current". This plan adds a per-step **lane** label, groups consecutive laned steps into an "at the same time" block with one current step per lane, records out-of-order progress inside a block, and gives each device an "I'm on: Everyone / Sauce / Pasta" chip that dims the other lanes.

Decisions made with the user:

- **Data**: optional `lane?: string` on `RecipeStep` (named lanes, not a boolean or a recipe-level graph).
- **Progress**: optional `doneSteps?: number[]` on `CookStateRow`, with the cook-log constitution amended in the same PR.
- **Authoring in v1**: the edit form and Ask. Import prompt and schema untouched.
- **Setup**: one phone on the counter is the designed mode, plus the per-device lane chip. Sync has no live updates (polling, listeners and WebSockets are on the do-not-touch list), so two phones on one account would overwrite each other's taps; two accounts on a shared recipe each keep their own row and the chip lets each person follow their lane. This is stated in the plan's Out of scope, not worked around.

Constitutions applied: cook-log (principle 1 amended), client-state (principles 3–4: no new store, `useCookState` still selects one row), i18n (principle 3: no control inside a step row; principle 4: lanes are derived from the stored recipe, not the translation; principle 9/16: all copy in the four catalogs and reviewed in context).

## The UX in one paragraph

Reading: a recipe without lanes renders exactly as today. A block renders as one box headed "At the same time", lanes side by side on wide screens and stacked on a phone, each lane labelled with its name, global step numbers kept. Cooking: the block's active lanes each have one amber "current" step; tapping a lane's current step ticks it, tapping a done lane step un-ticks it and the lane's later steps, tapping the sync step after a block ticks the whole block (today's "tap any step to jump there" rule, applied per lane). Together: above Steps, when the recipe has lanes, a `print:hidden` chip row "I'm on: Everyone · Sauce · Pasta"; a pick dims (never hides) the other lanes' steps and is sent to Ask so the assistant knows which lane the person is on. Authoring: each step card in the edit form gets a small lane select (No lane / existing lanes / New lane…), and Ask's recipe schema learns `lane`, so "split this for two cooks" can be applied in one tap. Print and share-as-text show `[Sauce]` prefixes. Public page ticks lanes in local state.

## Semantics (pure, in `src/lib/stepLanes.ts`)

- **Lane value**: trimmed string, 1–24 chars (`MAX_LANE_CHARS`). Malformed is dropped, not rejected, on every compact path (the `variantOf` / `importCheck` policy). MCP input is the one strict path. Lane names are recipe text: not translated in v1, never passed through `t()`.
- **Blocks**: a maximal run of consecutive steps that have a lane is a block; its lanes are the distinct names in first-appearance order, each an ordered sub-list of global indexes; a run with one lane name is still a block (author mid-way through tagging). An unlaned step is a sync point. A lane name may recur in a later block. Blocks come from the **stored** recipe's steps, never the display translation.
- **Progress**: `currentStep` keeps its meaning (done prefix). `doneSteps` holds only indexes `>= currentStep` done out of order. `normalizeStepProgress` drops non-integers, negatives, `>= steps.length`, duplicates; sorts; folds the prefix into `currentStep`; caps at 200. The key is omitted when empty, so a row with no block progress is byte-for-byte what today's client writes, and old clients ignore it.
- **Tap** `tapStep(steps, progress, i)` on the done set `D = [0, currentStep) ∪ doneSteps`:
  - sync step `i`: first undone → `D ∪ {i}`; otherwise `D' = [0, i)` (jump there).
  - lane step `i` in block `[s, e)`, lane `L`: done → `(D ∩ [0, e)) \ { j ∈ L : j ≥ i }`; not done → `D ∪ [0, s) ∪ { j ∈ L : j ≤ i }`.
  - then `currentStep` = smallest index not in `D'`, `doneSteps` = sorted `D' ∩ [currentStep, ∞)`. With no lanes this is exactly today's `onStep(i === currentStep ? i + 1 : i)`.
- **Active set** `activeSteps`: for the block containing the first undone step, each lane's first undone step; for a sync step, that step; empty when done. "Done — enjoy!" still keys off `currentStep >= steps.length`.
- **Lane carry** `carryStepLanes(stored, proposed)`: if any proposed step has a lane, trust the proposal; otherwise copy `stored[i].lane` onto `proposed[i]` when the text matches at the same index. Ask can move or remove lanes on request, and a model that forgot them while editing something else does not wipe them.

## Built to extend: multi-device coop later

Multi-device coop (two phones seeing each other's progress live) is not in this plan, but this plan must not need re-engineering to get there. The rules below are what make that true; the implementation keeps them.

- **Progress is a set, never a pointer.** The only progress type the UI and the tap logic see is `StepProgress { currentStep, doneSteps }`, which denotes the done set `[0, currentStep) ∪ doneSteps`. `currentStep` is a compaction of the prefix, not extra information. Two devices' progress can be combined by union of done sets and refolded, and partitioned by lane through `stepBlocks`. `stepLanes.test.ts` includes a test that proves the union property with the existing functions (no merge code ships now).
- **The cook row is one adapter, not the model.** `useCookState` turns the per-user cook row into a `StepProgress` and an `onTap`; `StepsSection` and `LaneChips` take only props. A future coop session store (a new top-level entity keyed by recipe, the cook-log precedent, never a `Recipe` or `CookStateRow` field) plugs in at `RecipeView` by supplying a different `StepProgress` and `onTap`, with no change to `RecipeBody` or `stepLanes`.
- **Tap logic is pure and lane-local.** `tapStep(steps, progress, index)` touches only the tapped lane and what follows the block, so taps from people on different lanes commute. Keep it free of store or device knowledge.
- **Lanes are the unit of assignment.** A lane name recurring across blocks means the same person; a future "who is on which lane" is a map from lane name to participant inside the session, bound to a recipe revision the way `recipeUpdatedAt` already binds progress. No step ids are needed for that; do not add them.
- **The lane pick stays out of the cook row.** It is per device now and becomes a session assignment later; persisting it in `CookStateRow` would be the wrong home and is not done.
- **What coop will still need, deliberately deferred:** a shared progress entity, a per-lane merge rule finer than whole-row LWW, and a bounded live-update channel while a session is active. The last one amends the do-not-touch list (no polling, listeners or WebSockets) and is a sync-architecture decision of its own.

## Files to change

| File | Change |
| --- | --- |
| `docs/constitutions/cook-log.md` | Principle 1 retitled to ban **log data** on `Recipe`/`ChatMessage`/`CookStateRow`; amendment-log entry for `doneSteps`. |
| `AGENTS.md` | "Do not add fields" paragraph: fourth deliberate exception (`RecipeStep.lane`, `CookStateRow.doneSteps`); Plans table row. |
| `src/lib/types.ts` | `RecipeStep.lane?`, `CookStateRow.doneSteps?`, doc comments. |
| `server/recipeSteps.ts` (new) + `src/lib/recipeSteps.ts` (re-export) | `MAX_LANE_CHARS`, `compactLane`, `compactSteps`. Dependency-free, the `server/recipeVariant.ts` pattern. |
| `src/lib/stepLanes.ts` (new) + test | Blocks, lanes, progress normalization, tap, active set, lane carry. Imports only types and `recipeSteps`. |
| `src/lib/compactRecipe.ts`, `server/store.ts` `compactRecipeFields` | `steps: compactSteps(recipe.steps)` (today both pass steps by reference, so junk step keys survive). |
| `server/store.ts` `validateCookStatePut` (~1786) | Accept optional `doneSteps`: array ≤ 200 of non-negative integers. |
| `src/lib/recipeShape.ts` `normalizeSteps` | Carry `lane` via `compactLane`. `isValidStep` unchanged. |
| `src/lib/remote.ts` `normalizeCookChange` | Keep a normalized non-empty `doneSteps`. |
| `src/lib/useCookState.ts` | `doneSteps` in `CookState`; `progressFor` resets it with `currentStep`; write path normalizes against `recipe.steps.length` and omits the key when empty; `setCurrentStep` becomes `tapStep(index)` (`RecipeView` is the only caller). |
| `src/lib/translationStore.ts` `toDisplayRecipe` | Copy each stored step's lane onto the translated step by index. |
| `src/lib/recipeText.ts` | Block heading line and `{n}. [{lane}] {text}`. |
| `src/lib/recipeStore.ts` `applyDraft`, `createFromAsk` | `steps: carryStepLanes(existing.steps, draft.steps)`. |
| `src/components/ChatPanel.tsx` `recipeLines` | `[lane] text` so a lane-only change shows in the diff. |
| `src/lib/chatApi.ts`, `api/chat.ts` | `CookingState.doneSteps?` (1-based) and `lane?`; `RECIPE_SCHEMA` `steps[].lane`; one prompt paragraph; the sync NOTE records that this copy carries `lane` and the import copy carries `lang`. The route passes `cookingState` through unvalidated, so no server validation change. |
| `server/mcp/recipeInput.ts`, `server/mcp/tools.ts`, `server/mcp/recipeView.ts` | `STEP_FIELDS` + `validateSteps` + `RECIPE_LIMITS.lane`; `stepsSchema` gains `lane` (`additionalProperties: false` stays); types. |
| `server/agent/sous/library.ts` `parseSteps` | Carry `lane` (MCP `get_recipes` reads through `loadAgentLibrary`, so without this Claude cannot preserve lanes on `update_recipe`). |
| `src/components/RecipeBody.tsx` | `StepsSection` renders blocks; `StepButton` extracted; new `LaneChips`. No store imports (public-screen fence in `scripts/invariants.test.ts:75`). |
| `src/screens/RecipeView.tsx`, `src/screens/PublicRecipe.tsx` | Wire `doneSteps`, `tapStep`, lane chip state, Ask cooking state. |
| `src/components/RecipeForm.tsx` | `steps: string[]` → `StepFields { key, text, lane }`; lane select per card; `fromDraft`/`toDraft`. |
| `src/i18n/{en,ru,uk,zh-Hans}.ts` | New keys. |
| `testing/fixtures.ts`, `testing/personas.ts`, `testing/README.md`, `docs/plans/test-mode.md` | Member recipe 108 with lanes, filed in Weeknights (public + shared); cook row with `doneSteps`; counts. |
| `docs/i18n-review/screens.json`, `testing/i18n-review/states.ts` | Four new states. |
| Lock tests (changed on purpose) | `src/lib/remote.test.ts:501`, `src/lib/syncEngine.test.ts:409` and `:1153` gain `doneSteps`. `src/lib/recipeStore.test.ts` Recipe key lock untouched. |

Confirmed not to need changes: `server/store.ts validateRecipePut` (only checks `Array.isArray(steps)`; malformed lanes are dropped by compaction), `src/lib/backup.ts` (recipes go through `compactRecipe`, cook rows are spread; version stays 4), `server/recipeTranslation.ts` (returns text only; the client puts lanes back), `server/recipeImport.ts` (import untouched), `server/importWarnings.ts contentKey` (a lane edit counts as a content edit; accepted).

## Steps

### 0. [core] Constitution amendment and schema-lock notes

- `docs/constitutions/cook-log.md` principle 1: retitle "The cook log is its own entity. Cook-log data never adds fields to `Recipe`, `ChatMessage`, or `CookStateRow`." Keep the Why; add that other features extend `CookStateRow` only through the `AGENTS.md` schema-lock process. Amendment-log entry: what (`CookStateRow.doneSteps`, cook progress from this plan, not log data), why (lanes need out-of-order progress; a sibling entity would split one row's LWW), guard (resets with `recipeUpdatedAt` like `currentStep`, normalized on every write, omitted when empty, lock tests changed on purpose, old clients ignore it). Status stays `ratified`; the index line is unchanged so `scripts/constitutions.test.ts` passes.
- `AGENTS.md` paragraph after `variantOf`: the fourth exception; `compactSteps` is the only step compaction on both ends; `doneSteps` normalized by `normalizeStepProgress`. Plans table row.
- PR description: a "Constitution amendment" heading naming the file.

### 1. [core] Types and shared step compaction

- `types.ts`: `RecipeStep { text: string; lane?: string }`, `CookStateRow.doneSteps?: number[]`, each with a doc comment saying missing is normal.
- `server/recipeSteps.ts`: `MAX_LANE_CHARS = 24`; `compactLane(value: unknown): string | undefined`; `compactSteps(value: unknown): RecipeStep[]` (non-array → `[]`; entry must be a plain object with string `text`; output `{ text }` plus `lane` only when `compactLane` returns one; unknown keys never survive). `src/lib/recipeSteps.ts` re-exports.
- `compactRecipe` and `compactRecipeFields` use it. Everything else on the server (`recipeDocBody`, `sharedPull`, `publicRecipeBody`, `mergeRecipeChanges`) already goes through `compactRecipeFields`.
- Tests: `server/recipeSteps.test.ts` (trim, 24 kept, 25 dropped, non-string dropped, junk key dropped, non-object entry dropped); `recipeStore.test.ts` and `server/store.test.ts` each get a "lane kept, `foo` dropped" case next to the existing key lock.

### 2. [core] `stepLanes.ts`

```ts
export const MAX_DONE_STEPS = 200;
export interface StepProgress { currentStep: number; doneSteps: readonly number[] }
export interface LaneRun { lane: string; steps: number[] }
export type StepBlock =
  | { kind: 'sync'; index: number }
  | { kind: 'parallel'; start: number; end: number; lanes: LaneRun[] };
export function stepBlocks(steps: readonly RecipeStep[]): StepBlock[];
export function recipeLanes(steps: readonly RecipeStep[]): string[];
export function normalizeStepProgress(p: { currentStep: number; doneSteps?: readonly unknown[] }, stepCount?: number): { currentStep: number; doneSteps: number[] };
export function isStepDone(p: StepProgress, i: number): boolean;
export function activeSteps(steps: readonly RecipeStep[], p: StepProgress): ReadonlySet<number>;
export function tapStep(steps: readonly RecipeStep[], p: StepProgress, i: number): { currentStep: number; doneSteps: number[] };
export function carryStepLanes(stored: readonly RecipeStep[], proposed: readonly RecipeStep[]): RecipeStep[];
```

`stepLanes.test.ts`: block derivation (none, a run, single-lane run, recurring lane, block at the end), `recipeLanes` order, normalization (fold, dedupe, range, non-integers, cap), `activeSteps` cases, every `tapStep` case above including the lane-free reduction to today's rule, `carryStepLanes` (carries only when the proposal is lane-less; text mismatch or index shift carries nothing), and one "two devices" case: device A ticks Sauce steps, device B ticks Pasta steps from the same start, the union of their done sets (via `isStepDone`) normalized with `normalizeStepProgress` equals the progress of one device doing both; this pins the mergeable shape for the coop phase (Built to extend).

### 3. [core] Cook progress write, read, pull

- `useCookState.ts`: `CookState.doneSteps: readonly number[]`; `CookStateApi.tapStep(index)` replaces `setCurrentStep`; `progressFor` returns a shared empty constant on reset and `row.doneSteps ?? NO_DONE` otherwise; `cookStateStore.update` runs `normalizeStepProgress(..., recipe.steps.length)` after `change(prev)` and includes `doneSteps` only when non-empty. `upsertCook` stays the only writer (failed-cook-tap plan).
- `remote.ts normalizeCookChange`: normalize `raw.doneSteps` when it is an array; set the key only when non-empty.
- `server/store.ts validateCookStatePut`: optional `doneSteps`, array, length ≤ 200, integers ≥ 0. Tests: absent and `[3, 5]` accepted; non-array, 201 entries, `-1`, `1.5`, `'3'` rejected. (The seed pushes fixture cook rows through this validator.)
- Lock tests, with a comment pointing at this plan: `remote.test.ts` expected keys become `['checkedKeys','currentStep','doneSteps','recipeId','recipeUpdatedAt','servings','updatedAt']`, plus cases for `[]`, a foldable `[1]` with `currentStep: 1`, and `['x', -1, 2.5]` all yielding no key; `syncEngine.test.ts` `:409` and `:1153` inputs gain `doneSteps` and expected key lists gain it.
- New `useCookState.test.ts` (mock `./remote` as `optimisticWrite.test.ts` does): a write folds and omits; a row with a stale `recipeUpdatedAt` reads as `0, []`; `tapStep` on a lane step pushes the expected `cookState.put`.

### 4. [core] Shape, translation display, share text, Ask carry

- `recipeShape.ts normalizeSteps` adds `lane` from `compactLane`. Tests: kept and trimmed; blank and 25 chars dropped.
- `translationStore.ts toDisplayRecipe`: `steps: translated.steps.map((step, i) => source.steps[i]?.lane === undefined ? step : { ...step, lane: source.steps[i].lane })`. Extend the existing translate test with a laned source.
- `recipeText.ts recipeToText`: walk `stepBlocks`; a parallel block emits `t('recipe.atTheSameTime')` then `{n}. [{lane}] {text}` in index order. Test.
- `recipeStore.ts`: `applyDraft` and `createFromAsk` use `carryStepLanes`. Test beside the existing `applyDraft` coverage.
- `ChatPanel.tsx recipeLines`: `s.lane ? `[${s.lane}] ${s.text}` : s.text`.

### 5. [core] Ask schema, prompt, cooking state

- `api/chat.ts RECIPE_SCHEMA` steps item gains `lane: { type: Type.STRING, description: 'Only for steps two cooks do at the same time: a short label for who does it, e.g. "Sauce" or "Pasta" (24 characters max). Consecutive steps with lanes run together; a step without a lane is done by everyone, in order. Keep the lanes the recipe already has.' }`. Update the sync NOTE at the top of the schema.
- `systemPrompt`: one paragraph after the modify paragraph explaining lanes, "keep existing lanes unless asked", and that when asked to split for two cooks it should lane consecutive steps and leave shared steps unlaned; mention `doneSteps` (1-based) and `lane` in the cooking state.
- `chatApi.ts CookingState`: `doneSteps?: number[]`, `lane?: string`. `RecipeView` sends `doneSteps.map(i => i + 1)` when non-empty and `lane` when picked.

### 6. [core] MCP and agent

- `recipeInput.ts`: `RECIPE_LIMITS.lane = MAX_LANE_CHARS`; `RecipeStepInput = { text; lane? }`; `STEP_FIELDS = new Set(['text', 'lane'])`; `validateSteps` runs `optionalText(step.lane, `${path}.lane`, RECIPE_LIMITS.lane, errors)`. Tests: kept and trimmed; 25 chars rejected at `steps[0].lane`; `steps[0].foo` still rejected; `mergeRecipeChanges` keeps lanes.
- `tools.ts stepsSchema`: `lane: { type: 'string', minLength: 1, maxLength: 24, description }`.
- `recipeView.ts McpRecipe.steps`, `agent/sous/library.ts AgentRecipe.steps` types; `parseSteps` carries `lane` via `compactLane`.
- `testing/mcpSmoke.ts`: `get_recipes` on fixture 108 shows `steps[1].lane === 'Sauce'`; `update_recipe` with laned steps rereads with lanes.

### 7. [ui] i18n keys (all four catalogs)

`recipe.atTheSameTime` "At the same time"; `recipe.laneChips` "I'm on"; `recipe.laneEveryone` "Everyone"; `form.stepLane` "Lane for step {n}" (select aria-label); `form.noLane` "No lane"; `form.newLane` "New lane…"; `form.laneName` "Lane name"; `form.lanePlaceholder` "e.g. Sauce"; `form.lanesHint` "Give each cook's steps a lane, like Sauce and Pasta, when two people cook at once."

### 8. [ui] `StepsSection` blocks and `LaneChips` (`RecipeBody.tsx`)

- Props: `{ recipe, displayRecipe, currentStep, doneSteps, onTap, activeLane?, afterDone? }`. `blocks = useMemo(stepBlocks(recipe.steps))`, `active = activeSteps(...)`.
- Extract today's button into `StepButton({ index, text, isCurrent, isDone, dimmed, onTap })` with the same classes plus `dimmed ? 'opacity-50 print:opacity-100' : ''`. Still a full-width button with no inner control.
- `<ol>` of blocks. Sync block: one `StepButton`. Parallel block: `<div role="group" aria-labelledby>` box (`rounded-xl border border-line p-2 print:border-0 print:p-0`), heading `t('recipe.atTheSameTime')`, lanes container `grid gap-2 sm:grid-flow-col sm:auto-cols-fr`, each lane an `<h3>` with the lane name and an `<ol>` of `StepButton`s with global numbers. `dimmed = activeLane !== undefined && lane !== activeLane`; sync steps never dim.
- `LaneChips({ lanes, active, onChange })`: rendered by the parent above `StepsSection` only when `lanes.length > 0`; `print:hidden`; label + "Everyone" + one button per lane with `aria-pressed`, pressed look like the translate chip.

### 9. [ui] `RecipeView` and `PublicRecipe`

- `RecipeView`: `doneSteps`, `tapStep` from `useCookState`; `lanes = useMemo(recipeLanes(recipe.steps))`; `const [lane, setLane] = useState<string>()` reset when `recipe.id` changes (plain component state: a sessionStorage read in render would need a `useSyncExternalStore` store per client-state principle 3, the pick is one tap, and an edit resets progress anyway); `<LaneChips>` above `<StepsSection activeLane={lane}>`; cooking state per step 5.
- `PublicRecipeBody`: `useState<{ currentStep; doneSteps }>` with `onTap={(i) => setProgress(p => tapStep(recipe.steps, p, i))}` and its own `lane` state; `key={recipe.id}` already resets per recipe.

### 10. [ui] Form lane picker (`RecipeForm.tsx`)

- `StepFields { key: string; text: string; lane: string }` (`lane: ''` = none; `key` from a module counter so a card keeps its "typing a new lane" mode across moves; dropped by `toDraft`). `fromDraft` maps `{ key, text, lane: step.lane ?? '' }`; `toDraft` filters on trimmed text and emits `{ text, ...(compactLane(lane) ? { lane } : {}) }`; `patchSteps`, `moved`, add and remove work on the objects; `<li key={step.key}>`. `dirty` compares `JSON.stringify(form)` and keys are stable per mount, so an untouched form stays clean.
- Muted hint `t('form.lanesHint')` under the Steps heading.
- `<StepLaneField>` (local component) in each card's header row between the number and the move buttons: a `<select aria-label={t('form.stepLane', { n })}>` with No lane (`''`), each distinct lane already in the form (order of appearance), and New lane… (a sentinel like `CUSTOM_UNIT`); picking New lane reveals `<input maxLength={MAX_LANE_CHARS} aria-label={t('form.laneName')} placeholder={t('form.lanePlaceholder')}>`; the field starts in typing mode when its lane is used by no other step so a lone lane stays editable.

### 11. [core] Fixture, personas, docs

- `testing/fixtures.ts`: `FIXTURE_IDS.member.pestoPasta: uuid(108)`; "Pesto pasta for two cooks", `lang: 'en'`, servings 2, six steps: 0 sync (water on), 1–2 `lane: 'Sauce'`, 3–4 `lane: 'Pasta'`, 5 sync (toss). Add it to the Weeknights collection (public link and the viewer's share are on Weeknights, so the public page and the viewer persona both show a block). Second cook row: `{ recipeId, servings: 2, currentStep: 1, doneSteps: [3], checkedKeys: [], recipeUpdatedAt, updatedAt: now − 30 min }` (two amber steps, one done in Pasta).
- `testing/personas.ts` "8 recipes (one a variant, one with lanes)"; `testing/README.md` and `docs/plans/test-mode.md` counts (8 recipes, Weeknights 4, cook state on two recipes). `testing/smoke.ts` derives expectations from the fixtures; `testing/library-click-through.ts` assumes only two collections and an unfiled recipe.

### 12. [ui] i18n review states (`screens.json` + `states.ts`)

- `recipe-view-lanes`: member, `/recipe/${ids.member.pestoPasta}`, no taps.
- `recipe-view-lane-picked`: same route; `reach` clicks the "Pasta" chip by role and name (lane names are recipe text).
- `recipe-edit-lanes`: `/recipe/${pestoPasta}/edit`; `reach` picks New lane… on one step. Do not save.
- `public-recipe-lanes`: `signedOut`, `/p/${ctx.publicToken}/r/${pestoPasta}`.

Share text is not a screen; it is covered by `recipeText.test.ts` and the manual check.

## Verification

- `npm test` and `npm run build` (the only type gate on `server/`; `erasableSyntaxOnly`, so no enums).
- Lock-test diff reviewed by hand: only the three cook key lists and the new `doneSteps` cases change; the Recipe key lock is untouched.
- Test mode (`gcloud emulators firestore start --host-port=127.0.0.1:8085`, `npm run dev:test`, `npm run dev`, `/__test/` → member) on Pesto pasta:
  - block renders with Sauce and Pasta side by side on a wide window and stacked under `sm`; two amber steps; one Pasta step already ticked;
  - tap through Sauce, then Pasta; step 6 goes amber only when both lanes are done; tap step 6 early and the whole block ticks; tap a done lane step and the lane tail plus step 6 un-tick;
  - Settings → Refresh keeps the progress (pull round trip keeps `doneSteps`);
  - pick "Pasta": Sauce dims; print preview shows every step undimmed with lane labels; Share copies text with the "At the same time" line and `[Sauce]` prefixes;
  - edit form: lane selects present, add "Garnish" via New lane…, save, the recipe shows three lanes, progress reset as on any edit;
  - Ask "split this for two cooks" on Quick tomato pasta → Apply (needs `GEMINI_API_KEY` in `.env.local`) → lanes appear; Ask "halve the servings" on Pesto pasta → Apply keeps lanes;
  - translate chip on Pesto pasta keeps the block;
  - signed out, `/p/<token>/r/<108>` ticks lanes locally; viewer persona sees the block on the shared recipe;
  - `node testing/mcpSmoke.ts` shows `lane` in `get_recipes` and after `update_recipe`.
- `npm run test:i18n -- --states recipe-view-lanes,recipe-view-lane-picked,recipe-edit-lanes,public-recipe-lanes` before the PR; fix blockers; attach the report.
- Recipes without lanes: open Roast chicken and confirm nothing changed (no box, no chips, same tap behaviour).

## Out of scope

Lanes from import or the extension (phase 2 once Ask's splits have been seen; it touches `evals/` process); translating lane names; per-lane timers; a per-cook device handoff or any live sync between phones; a lane on cook-log entries; `RecipeStep` keys beyond `lane`; backup version bump; a persisted (sessionStorage) lane pick.
