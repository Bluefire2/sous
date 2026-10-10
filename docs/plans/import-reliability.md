# Recipe import reliability

**Status:** Approved 2026-09-30. Phase 2 built 2026-10-01 on
`claude/import-reliability-plan-170fa6`, not deployed; see
[Phase 2 implementation notes](#phase-2-implementation-notes). Import
logging, its privacy and terms copy, `scripts/import-audit.ts`, and the
sanitized rethrow (`sanitizedImportError`) are #102, merged 2026-10-01, not
deployed. Phase 1 is still waiting on the reporter's failing URLs. Phase 3
waits on a deploy and log data. The spec is
[`import-reliability-spec.md`](import-reliability-spec.md).

**Branch:** `claude/import-reliability-plan-170fa6`, with `main` merged in
after #102. Open its PR against `main`.

## Context

A ~50-recipe bulk import surfaced two problems. Some URL imports fail outright.
Others "succeed" with whole sections missing, most often ingredients with no
steps.

How the pipeline behaves today (`server/recipeImport.ts`):
- It makes one Gemini call.
- When that call throws on the URL or paste path, the error reaches the
  dispatcher as a text 500.
- `parse_error` and `unusable` become 502s.
- A recipe with zero steps comes back as `ok`.
- The import preview shows a generic `import.fixBeforeSaving` banner, and bulk
  import shows nothing at all.

The goal is to check every import deterministically, record **specific** typed
warnings on the saved recipe, and retry only where a retry can help.

**What the reporter's library shows** (`scripts/import-audit.ts`, 2026-09-30):
- The session ran from 2026-09-20 03:44 to 04:12 UTC: 36 URL imports, mixed in
  with 10 recipes that have no `sourceUrl`, plus 2 deletions.
- None of the 10 has a photo. They are very likely recipes pasted as text after
  the URL import failed, which makes them the hard failures.
- No surviving URL import has zero steps or zero ingredients. The partial
  failures were fixed or deleted by hand.
- The failing URLs were never stored, so they have to come from the reporter.

**Decisions from the owner**
- Warnings persist as an **optional `Recipe.importCheck` field**. This is a
  deliberate break of the AGENTS.md schema lock, the second after `lang`, and
  it amends that rule in the same PR.
- The owner supplies the failing URLs. Phase 1 turns them into cached fixtures
  and calibrates the thresholds against them.
- JSON-LD is used **as a reference only**. Gemini still runs on every page. The
  deterministic fast path (spec §4.1) gets a later plan, once the logs show how
  much it would save.

**Other decisions (locked unless the owner objects)**
- **Photo import is out of scope.** Constitution `image-import.md` P1 says one
  call, and the photo retry was measured and reverted (`evals/EXPERIMENTS.md`,
  2026-09-27). `importFromImages`, its schema, and its prompt stay unchanged.
  Paste, URL, and extension imports all go through `importFromSource`, so all
  three get the checks.
- **Retries are a code constant (`MAX_IMPORT_RETRIES`), not an env var.**
  Phase 2 ships it at `0` and phase 3 sets it to `2`. This avoids a deploy-time
  flag that `--env-vars-file` could silently revert.
- **Self-report fields** are `instructionsOnPage` and `ingredientsOnPage`, in
  camelCase like the rest of the schema. They go on a page/paste-only schema;
  the photo schema and the `api/chat.ts` copy do not change. `extraction_notes`
  is dropped: nothing would read it, and logging model text could echo page
  content.
- **Warnings are computed on the original extraction**, before translation.
  `UNGROUNDED_INGREDIENT` stores the ingredient's position, not its name, so
  the banner shows the current name, translated or edited. This works because
  i18n P4 says translation never changes structure.
- **No `ImportOutcome` kind is added for warnings.** `ok` gains
  `warnings: ImportWarning[]`, which may be empty. The one new kind is
  `model_error`, for a Gemini call that throws.

Constitutions that apply: **i18n** (P9, P10, P16: codes from the server, words
in the catalogs, in-context review), **client-state** (RecipeView reads and
the new sheet), and **image-import** (checked, and untouched).

---

## Phase 1: Fixtures and hand classification (spec §10.1; no product code)

1. **[core]** Cache each failing URL the reporter supplies as
   `evals/import-sites/<name>/page.html` plus `sourceUrl.txt`. Fetch them with
   the **same UA and headers as `fetchPageHtml`**, because a source failure
   depends on what the server sees, not what a browser renders. Add each one to
   `EXPECTED` in `evals/pageFixtures.test.ts`. The 10 pasted titles (run
   `scripts/import-audit.ts`) help the reporter remember which links failed.
2. **[core]** Add `evals/import-sites/<name>/class.json`:
   `{ "class": "source" | "extraction" | "ok", "why": "…" }`, classified by
   hand. Record the source/extraction split here. If source failures dominate,
   tell the owner before phase 3, because the spec says page fetching is the
   better investment in that case.
3. **[core]** If the import log lines from #102 have been live for a while by
   then, add their outcome counts (`fetch_failed` by site status, `threw` by
   `errorStatus`, `ok` with `steps: 0`) next to the hand classification.

## Phase 2: Checks, warnings, UI (spec §10.2; retries off)

### 2a. Pure checks: `server/importChecks.ts` (new) **[core]**

Nothing in this module calls Gemini or does I/O. Exports:

- `ImportWarningCode`: the ten codes from spec §6.1–6.2, plus `BLOCKING`, the
  set from §6.3.
- `ImportWarning = { code; at?: [section: number, item: number] }`.
- `readRecipeJsonLd(html)`: refactor the JSON-LD scan out of
  `extractRecipeSource` (now parse5-based) so both callers share one parser.
  It returns the Recipe node, plus the ingredient and step counts with
  `HowToSection` flattened.
- `hasInstructionLikeContent(html | text)`: true when any of these holds:
  - an `<ol>` with at least 2 `<li>` in the primary region;
  - a heading or line that matches a small multilingual word list
    ("instructions", "directions", "method", "preparation", "steps",
    "how to make", plus the uk/ru/zh/es/fr/it/de equivalents);
  - `Step 1` or numbered-line patterns;
  - a non-empty JSON-LD `recipeInstructions`.

  **Conservative by design:** when unsure it returns true, so the
  source-failure banner (which needs this to be false) stays rare.
- `groundingCorpus(html)`: the full untruncated page text plus the JSON-LD
  text. `stripToText` drops `<script>`, so the JSON-LD has to be added back. For
  paste, the corpus is the pasted text.
- `checkImport({ recipe, selfReport, jsonLd?, sourceHasInstructions, corpus })
  → { warnings, failureClass: 'none' | 'extraction' | 'source' }`:
  - Structural checks (§6.1). `TOO_FEW_STEPS` uses `MIN_STEPS = 2`; phase 1
    calibrates it.
  - `INSTRUCTIONS_NOT_ON_PAGE` fires only when steps are empty **and**
    `!sourceHasInstructions` **and** `selfReport.instructionsOnPage === false`.
    It classifies as **source**.
  - `INSTRUCTIONS_DROPPED` fires when steps are empty and
    `sourceHasInstructions`. It classifies as **extraction**. If steps are
    empty and the signals disagree, only `MISSING_INSTRUCTIONS` fires, classed
    as extraction, so a retry is allowed.
  - `MISSING_INGREDIENTS` is classed as extraction unless the JSON-LD has no
    ingredients and `ingredientsOnPage === false`.
  - The count checks run only when the JSON-LD has the list, and they flag only
    the *fewer* direction:
    - ingredients flag when `extracted < jsonLd − max(2, 20%)`;
    - steps flag when `extracted < 50% of jsonLd`, because the prompt tells
      Gemini to "trim fluff" and it legitimately merges steps.

    Phase 1 calibrates both thresholds.
  - The grounding check:
    - normalizes each item: NFKD, strip diacritics, lowercase, drop numbers,
      units (`src/lib/units.ts` vocabulary) and stopwords, then strip a
      trailing `s`/`es`;
    - counts an item as grounded if any token of 3+ characters appears in the
      normalized corpus; CJK uses a substring match;
    - reports at most 3 items;
    - skips entirely when more than half the items look ungrounded, because
      that means the corpus is wrong, not the model.
- `pickBestAttempt(attempts)`: the fewest blocking warnings, then the most
  steps, then the earliest attempt.

`server/importChecks.test.ts` covers each code, each failure class, the
precedence rules, and the CJK and diacritic grounding cases.

### 2b. Pipeline: `server/recipeImport.ts` **[core]**

- Add `PAGE_RECIPE_SCHEMA`, which is `RECIPE_SCHEMA` plus `instructionsOnPage`
  and `ingredientsOnPage` (BOOLEAN). `importFromSource` uses it.
  `outcomeFromModelText` reads the self-report next to
  `normalizeImportedRecipe`, which still strips unknown keys.
- `importFromHtml` builds its check context from the HTML through 2a, and
  reports whether it read JSON-LD or page text. `importFromSource` called
  directly (the paste path) builds a text-only context.
- Add an attempt loop inside `importFromSource`, before translation, with up
  to `1 + MAX_IMPORT_RETRIES` calls:
  - A thrown `generateContent`, `parse_error`, or `unusable` is a hard failure:
    retry.
  - `ok` with a blocking warning and `failureClass === 'extraction'`: retry.
  - `source`, `not_a_recipe`, `empty_source`: never retry.
  - Stop starting new attempts after `IMPORT_RETRY_DEADLINE_MS` (≈40 s), so a
    bulk row cannot stall. Retries are immediate; the backoff question in spec
    §9.4 waits until the logs' `errorStatus` counts show whether failures are
    rate limits (429) or overload (503).
  - When every attempt has warnings, return `pickBestAttempt`. When none is
    usable, return the last failure kind. A final throw becomes
    `{ kind: 'model_error' }` instead of escaping. The thrown error's numeric
    status is kept on the outcome for the log line.
- `ImportOutcome.ok` gains `warnings` and `attempts`. `attempts` is a list of
  `{ result: 'ok' | 'warn' | 'parse_error' | 'unusable' | 'threw', codes }`
  and is used only for logging. `finishImport` passes both through unchanged.
- `export const MAX_IMPORT_RETRIES = 0` in this phase.

Extend `server/recipeImport.test.ts` with fake `generateContent` sequences:
- throw, then ok;
- empty steps on an instruction page, then a retry;
- a source failure, with no retry;
- the deadline;
- best-attempt selection;
- the photo path still making exactly one call.

While retries are 0, the fakes override the constant through a
`deps.maxRetries?` test seam.

### 2c. Routes **[core]**

- `server/importRoute.ts`:
  - `outcomeResponse` adds `warnings` to the JSON when there are any. The
    server sends codes and the client owns the words (i18n P10).
  - It maps `model_error` to a 502 with the new code `import-model-failed`.
  - The URL and paste paths no longer reach the dispatcher's 500 on a Gemini
    throw.
- `server/extensionImport.ts`: map `model_error` the same way.
  `recipePutFromExtraction` gains an optional `importCheck` and writes it when
  there are warnings.
- Extend the existing log line (`server/importLog.ts`, `noteImportOutcome`)
  with `source` (`jsonld` | `text`), `attempts` (results only), `codes`, and
  the `model_error` outcome with its `errorStatus`. Per AGENTS.md, update the
  list in `/privacy`'s Server logs section in the same PR, so it names how the
  page was read and the warning codes. The line still never holds recipe text.

### 2d. `Recipe.importCheck`: schema amendment **[core]**

```ts
importCheck?: {
  at: number;                 // import time
  warnings: ImportWarning[];  // non-empty when present
  dismissedAt?: number;
  editedAt?: number;          // first content change after import
}
```

- Add the field to `src/lib/types.ts`. Update `compactRecipe` and the server's
  `compactRecipeFields` / `validateRecipePut` in `server/store.ts`:
  - codes must be in the known set;
  - at most 10 warnings;
  - integer `at` positions and finite timestamps.

  An invalid value is dropped, not rejected, so old clients never break.
- Update the key-set lock in `src/lib/recipeStore.test.ts`, the AGENTS.md
  schema-lock paragraph (`importCheck` becomes the second deliberate exception,
  and code must work when it is missing), and any `scripts/invariants.test.ts`
  rule that names the key set.
- Add a pure `reconcileImportCheck(prev, next)`, applied in the `recipeStore`
  update path. It covers Edit, Ask Apply, and the editor role. It:
  - sets `editedAt` on the first content change;
  - drops a structural or source warning once its condition no longer holds
    (for example, steps were added);
  - drops position-addressed warnings when `ingredientSections` changes;
  - keeps `dismissedAt`.
- Backup round-trips through `compactRecipe`, so no further change is needed
  there. Add a `backup.test.ts` case for it.

### 2e. UI **[ui]**

All copy goes in `en`, `uk`, `ru`, and `zh-Hans`. That means one key per
warning code, the action and summary keys, and `error.importModelFailed`,
mapped from `import-model-failed` in `src/lib/errorText.ts`. New states go in
`docs/i18n-review/screens.json`.

- **Import preview** (`ImportScreen.tsx`):
  - Remove the `import.fixBeforeSaving` banner and its catalog keys
    (spec §7.3).
  - When the result has warnings, show a specific warning list in its place.
  - Saving puts `importCheck` on the draft (`ImportPreview` →
    `recipeStore.create`).
  - `importApi.ts` parses `warnings` defensively and ignores unknown codes.
- **Recipe view banner** (new `components/ImportWarningBanner.tsx`):
  - Shown when `importCheck` has warnings, there is no `dismissedAt`, and the
    viewer can edit (the owner, or a shared-collection editor; viewers never
    see it).
  - It uses the spec §7.2 copy for each code, and renders
    `UNGROUNDED_INGREDIENT` with the current ingredient name at `at`.
  - Actions:
    - **View original** links to `sourceUrl`, with the same http/https guard
      RecipeView already uses.
    - **Dismiss** calls `recipeStore.update` with `dismissedAt`.
    - **Retry import**, shown only with a `sourceUrl`, calls `importRecipe({
      url, translateTo: recipe.lang if it is a supported locale })`. It then
      opens a confirm sheet: "Replace the ingredients and steps with the new
      import?" Confirming replaces title, description, servings, times,
      sections, steps, notes, `lang`, and `importCheck`. It keeps id,
      createdAt, tags, photos, `sourceUrl`, collections, and cook logs. The
      sheet follows client-state P6.
- **Bulk summary**:
  - The heading becomes "{imported} imported · {attention} need attention ·
    {failed} failed".
  - The last two counts are buttons that filter the list, and a third button
    clears the filter.
  - Each row gets a warning or error indicator plus the first warning's short
    copy.
  - A failed row shows "Couldn't import this recipe." with the reason, and gets
    its own **Retry** button. It re-runs that URL with a fresh fetch into the
    same batch destination.
  - **Try again** for all failed rows stays.

### Phase 2 implementation notes

Built as planned, with these choices and deviations:

- **Modules.** The parse5 walk, `primaryRegion`, `stripToText` and the
  Recipe JSON-LD finder moved to `server/pageScan.ts`, so `importFromHtml`
  parses once and builds both the Gemini source and the check context. The
  codes, `BLOCKING_IMPORT_WARNINGS`, `MIN_STEPS`, the `ImportCheck` type and
  `compactImportCheck` live in `server/importWarnings.ts`, which is
  dependency-free and re-exported to the client by `src/lib/importCheck.ts`
  (the `pushReasons` pattern), so client and server validate the field the
  same way.
- **Outcome shape.** `ok` has required `warnings`. `attempts`, `source` and
  `errorStatus` sit together on an optional `log` field on every outcome kind,
  read only by `noteImportOutcome`.
- **Photo path.** Still one call, `RECIPE_SCHEMA`, no checks, and a throw
  still propagates to the route's own photo catch (502
  `import-photos-failed`). Its `ok` has `warnings: []`.
- **`EMPTY_ITEMS`** is counted on the raw model output, since
  `normalizeImportedRecipe` drops blank items before the checks see the
  recipe. **`MISSING_TITLE`** can only fire if normalization ever stops
  requiring a title; a blank title is `unusable` today.
- **Resolved records stay.** When an edit resolves every warning,
  `reconcileImportCheck` keeps `{ at, warnings: [], editedAt }` instead of
  deleting the field, so `scripts/import-check-report.ts` can count fixes.
  The banner shows only while warnings remain. The count warnings, which
  cannot be re-checked without the page, drop once the edit adds to that
  list; `EMPTY_ITEMS` drops once the ingredients or steps change.
- **Store API.** There is no `recipeStore.update`. `save` carries the stored
  `importCheck` when the caller omits it and reconciles it (Edit, Ask Apply,
  cook-log lesson promotion, editor saves). Dismiss is
  `recipeStore.dismissImportWarnings`; Retry import's confirm calls
  `recipeStore.replaceFromImport`, the one path that replaces the record.
  The banner's retry workflow is a reducer (`src/lib/importRetryFlow.ts`).
- **Bulk copy.** The summary is three controls, not one sentence: an
  "imported" heading, then "need attention" and "failed" filter buttons, each
  its own plural key (uk/ru use a colon form so the verb never has to agree
  with the number). One catalog key per warning code serves the banner, the
  preview, and the bulk row.
- **Calibration.** Offline over the 25 cached pages (no phase 1 pages yet):
  no source warning on any recipe page; the three goldens raise nothing.
  `wikibooks-pancake` is a category overview with no method, now
  `class: source`. The live model answers it with `NOT_A_RECIPE` (issue #106),
  correctly, so it never reaches `checkImport`; the calibration uses an
  empty-steps stand-in. Thresholds are unchanged from this plan.
- **Page schema ordering.** With the two booleans required, the model wrote
  `prepMinutes` last, and a trailing number sometimes ran on until
  `MAX_TOKENS` (a `parse_error`). The parent commit has the same failure,
  less often. `PAGE_RECIPE_SCHEMA.propertyOrdering` ends on the booleans;
  the measurements are in `evals/EXPERIMENTS.md` (2026-10-01).
- **Video-only pages.** On a page that says "watch the video for how to make
  it", the model sometimes turns that sentence into the only step. The import
  then gets `TOO_FEW_STEPS` (advisory) instead of `INSTRUCTIONS_NOT_ON_PAGE`.
  Worth a phase 1 fixture; the checks do not ground steps against the page.
- **Verified 2026-10-01** (dev against production, throwaway recipes): paste
  and URL previews show the specific warning and no generic banner; a clean
  URL shows nothing; Dismiss survives a reload; Retry import → Replace fills
  the steps; an edit that adds a step clears the warning; bulk counts,
  filters, and per-row Retry; Library and `/cooks` render. Log lines carry
  `source`, `attempts`, and `codes`. In-context translation review (task
  scope, uk/ru/zh-Hans): no blockers. A shared viewer's view was not checked
  in the browser (no second account); `showsImportWarnings` covers it in
  unit tests.

## Phase 3: Turn on retries (spec §10.3)

- Once phase 2 has been deployed and has some data, set
  `MAX_IMPORT_RETRIES = 2`.
- Before and after the change, run `npm run test:import`. Also run
  `npm run eval:ocr-compare -- --split=all --runs=3`, which `evals/AGENTS.md`
  requires for any retry-policy change in `recipeImport.ts`, to show the photo
  path is unchanged. Log both in `evals/EXPERIMENTS.md`.

## Measurement (spec §8)

- **Retry efficacy, path, codes, and domain:** the `event: 'import'` log lines,
  once 2c adds `source`, `attempts`, and `codes`. Logs Explorer, project
  `cooking-assistant-508423`, resource `cloud_run_revision`, service `sous`:

  ```
  -- every page or paste import
  jsonPayload.event="import" AND jsonPayload.via=("url" OR "paste" OR "extension")
  -- path taken (summarize by jsonPayload.source)
  jsonPayload.event="import" AND jsonPayload.source:*
  -- imports that raised a warning, by code (summarize by jsonPayload.codes)
  jsonPayload.event="import" AND jsonPayload.codes:*
  -- source vs extraction split for empty steps
  jsonPayload.event="import" AND jsonPayload.codes=("INSTRUCTIONS_NOT_ON_PAGE" OR "INSTRUCTIONS_DROPPED" OR "MISSING_INSTRUCTIONS")
  -- model failures and their provider status (429 rate limit vs 503 overload)
  jsonPayload.event="import" AND jsonPayload.outcome="model_error"
  -- phase 3: attempts after the first, and whether they ended clean
  jsonPayload.event="import" AND jsonPayload.attempts:"threw"
  -- sites that fail repeatedly (summarize by jsonPayload.host)
  jsonPayload.event="import" AND (jsonPayload.outcome!="ok" OR jsonPayload.codes:*)
  ```
- **Dismissals and edits:** `scripts/import-check-report.ts` (new, owner-run,
  ADC, read-only). It prints aggregates only:
  - warnings per code;
  - warnings dismissed with no `editedAt`, as a proxy for false positives;
  - recipes edited after import.

  It never prints recipe text or user ids.

## Out of scope

- The JSON-LD fast path (§4.1)
- Headless or JS rendering, and following "jump to recipe" links (§9.1)
- An LLM judge (§6.4)
- Retrying on advisory warnings (§9.3)
- Photo import
- Extension popup copy (the warning shows on the recipe view instead)
- Any change to `api/import.ts`, `api/chat.ts`, or the Gemini request shape for
  chat

## Critical files

`server/recipeImport.ts`, `server/importChecks.ts` (new),
`server/importRoute.ts`, `server/extensionImport.ts`,
`server/recipeFromExtraction.ts`, `server/importLog.ts`, `server/store.ts`,
`src/lib/types.ts`, `src/lib/compactRecipe.ts`, `src/lib/recipeStore.ts`,
`src/lib/importApi.ts`, `src/lib/errorText.ts`, `src/screens/ImportScreen.tsx`,
`src/components/ImportPreview.tsx`, `src/screens/RecipeView.tsx`,
`src/i18n/*.ts`, `docs/i18n-review/screens.json`, `public/privacy.html`,
`evals/pageFixtures.test.ts`, `AGENTS.md`.

Reuse:
- the parse5 walk, `primaryRegion` and `stripToText` in `recipeImport.ts`
  (export them, or move them where 2a can import them);
- `normalizeImportedRecipe`, `noteImportOutcome`, `serverErrorText`,
  `translatedPreviewDraft`;
- `SaveToCollectionSheet`'s batch destination;
- the unit vocabulary in `src/lib/units.ts`.

## Verification

- `npm test` and `npm run build`. Build is the only type gate on `server/`.
  `erasableSyntaxOnly` applies: no enums, so codes are a string-literal union.
- **Offline calibration test** (new, in `evals/pageFixtures.test.ts` or beside
  it): run `checkImport`'s source-side checks over every cached page.
  - Every `class: ok` page and every existing site fixture must get **no**
    source warning.
  - Every `class: source` page must produce `INSTRUCTIONS_NOT_ON_PAGE` when
    given an empty-steps extraction.
  - The three golden fixtures, checked against their own goldens, must produce
    no warnings at all. This catches a false positive in grounding or the count
    checks.
- **Live**: `npm run test:import`, with the phase 1 fixtures added to the site
  eval as "warnings expected / not expected" assertions.
- **Browser** (Vite + `dev:api`, signed in at `http://localhost:5173`; dev
  writes to the **real** library, so use throwaway recipes):
  - Import a clean URL: no banner, and the generic message is gone.
  - Import a phase-1 source-failure URL: the preview shows the specific
    warning, and after saving, the recipe view shows the banner.
  - Dismiss, then reload: the banner stays hidden.
  - Retry import → confirm → content replaced, photos and tags kept.
  - Bulk-import a mix: the summary counts, the filters, per-row Retry.
  - A shared viewer sees no banner.
  - Check that the Library and the `/cooks` journal still render.
- **Before the PR**: run the in-context translation review
  (`docs/i18n-review/README.md`) for the import preview, the recipe banner, the
  bulk summary, and the new error message in uk, ru, and zh-Hans, and attach
  the report.
- **After a deploy**: confirm the log line carries `source`, `attempts`, and
  `codes`, and that a Gemini failure now shows as `model_error` with a 502, not
  `threw` with a 500.
