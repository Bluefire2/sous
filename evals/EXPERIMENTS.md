# Experiments

Append-only log of changes to import prompts, model settings, output checks,
retry policy, and goldens. `evals/AGENTS.md` defines when an entry is
required. Newest first.

Record aggregate numbers only: dev per fixture, holdout as a pass count.
Never record transcriptions or judge reasons. The notes are personal data,
and holdout must stay unseen. The `passes` numbers come from the `ocrCompare`
summary, approach A.

## Entry template

```
## <YYYY-MM-DD> — <short name>
- Change: <what changed; commit(s)>
- Reason (not fixture-specific): <…>
- Command: npm run eval:ocr-compare -- --split=all --runs=<n> [--thinking=…]
- Before (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <e.g. MAX_TOKENS 1, calls>1 in 2 runs>
- After (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <…>
- Decision: kept | reverted | pending owner run — <why, per the acceptance rule>
- Run by: <owner | agent>, model <CHAT_MODEL or default>
```

## 2026-10-09 — Import default `gemini-3.7-flash` → `gemini-3.8-flash` (3.7 now redirects)

- Change: `DEFAULT_MODEL` in `server/recipeImport.ts` becomes
  `gemini-3.8-flash`, undoing the import revert in the entry below. Every
  `CHAT_MODEL` default is now 3.8.
- Reason (not fixture-specific): Google deprecated `gemini-3.7-flash`, and
  the API now serves it with 3.8. On 2026-10-09 a `generateContent` call
  naming `gemini-3.7-flash` returned `modelVersion: gemini-3.8-flash`,
  while `models.get` still lists 3.7 (`3.7-flash-08-2026`). Requests that
  name 3.7 already get 3.8, so this change does not alter what import
  runs, and the evals were not run for it.
- What it means for the entry below: `ocrCompare` does not record
  `modelVersion`, so it is unknown whether the redirect was already active
  for the 2026-10-08 runs. If it was, the "3.7" Before run and the isolated
  run's 3.7 judge were 3.8 too, and the differences there (dev 12, 10 and
  8 of 15; holdout 15, 15 and 14) are run-to-run variance on one model,
  not a model regression. The two `MAX_TOKENS` runaways happened on 3.8
  either way.
- Decision: kept, since there is no other model behind the 3.7 id to
  choose.
- Run by: agent, model `gemini-3.8-flash` (`modelVersion` checked).

## 2026-10-08 — Default model `gemini-3.7-flash` → `gemini-3.8-flash`

- Change: `DEFAULT_MODEL` in `server/recipeImport.ts` and every other
  `CHAT_MODEL` default (chat, dictation, the assistant, `evals/judge.ts`)
  becomes `gemini-3.8-flash` (`b6b2409`, PR #173; import reverted to 3.7 in
  `35780b7`, see Decision). Prompts, schemas,
  checks, retries, thinking and goldens are unchanged.
- Reason (not fixture-specific): move to the newer Flash model.
- Command: `npm run eval:ocr-compare -- --split=all --runs=3`, once per
  side, both at `b6b2409`. `.env.local` sets no `CHAT_MODEL`.
- Before (`CHAT_MODEL=gemini-3.7-flash`, the same requests as the parent
  `e687da4`, since the change only moves defaults): dev 12/15
  (blueberry-muffins 1/3, choc-pie-tea-towel 3/3, hundred-good-cookies
  3/3, lemon-tea-bread 3/3, sweet-sour-pork 2/3), holdout 15/15; every A
  run `ok`, `STOP`, calls 1. Approach B: dev 9/15, holdout 9/15.
- After (default, `gemini-3.8-flash`): dev 10/15 (blueberry-muffins 1/3,
  choc-pie-tea-towel 3/3, hundred-good-cookies 3/3, lemon-tea-bread 2/3,
  sweet-sour-pork 1/3), holdout 15/15; every A run `ok`, `STOP`, calls 1.
  Approach B: dev 8/15, holdout 9/15. Median A time: dev 12.6 s → 12.2 s,
  holdout 10.2 s → 9.6 s. The cost column still uses the 3.7 estimates.
- Caveat: `evals/judge.ts` also defaults to `CHAT_MODEL`, so the judge
  moved with the importer and the difference mixes the two.
- Isolating the importer (owner's call, a separate measurement, not a
  re-run for a better number), at `61a18e5` (the same code as `b6b2409`): the
  same command with
  `CHAT_MODEL=gemini-3.8-flash` and the eval judge in `evals/judge.ts`
  pinned to `gemini-3.7-flash` (a local edit, not committed), so only the
  importer differs from Before: dev 8/15 (blueberry-muffins 1/3,
  choc-pie-tea-towel 3/3, hundred-good-cookies 3/3, lemon-tea-bread 0/3,
  sweet-sour-pork 1/3), holdout 14/15. Two A runs ran away to `MAX_TOKENS`
  (`parse_error`, one dev and one holdout; the dev one at 3,647 output
  tokens); every other A run `ok`, `STOP`, calls 1. Approach B: dev 8/15,
  holdout 9/15.
- Sums of both 3.8 importer runs: dev 18/30 and holdout 29/30, against
  12/15 and 15/15 on 3.7, with 2 runaways against 0.
- Decision: reverted for import (owner). Both 3.8 runs fail the
  acceptance rule: dev fell in both, and holdout fell in the isolated run.
  `DEFAULT_MODEL` in `server/recipeImport.ts` stays `gemini-3.7-flash`;
  the other `CHAT_MODEL` defaults, including `evals/judge.ts`, move to
  3.8, so later `ocrCompare` runs judge with 3.8 unless `CHAT_MODEL` is
  set.
- Run by: agent, model `gemini-3.7-flash` (before) and `gemini-3.8-flash`
  (after).

## 2026-10-08 — Kitchen profile equipment wording

- Change: the Generate kitchen-profile rule said "use only the equipment the
  profile allows". It now says "Treat the equipment as notes, not a full
  list: never need anything the profile says is missing." PR #172 review.
- Reason (not fixture-specific): members write partial notes ("no oven", "a
  pressure cooker"), not inventories; read strictly, the old wording could
  rule out an ordinary pan or knife. Ask already treats equipment as
  background.
- Command: `npx vitest run --config vitest.eval.config.ts evals/recipeGenerate.eval.ts`
- Before (467e8ba): 3 runs, 18/18 (entry below).
- After: 3 runs, 6/6, 5/6, 6/6 (17/18). The one failure was "grounds on web
  pages when search is on". That case passes no profile, so its prompt is
  unchanged by this edit.
- Decision: kept. Both profile cases passed in every run.
- Run by: agent, model default `CHAT_MODEL`.

## 2026-10-08 — Kitchen profile in generatePrompt

- Change: `generatePrompt` appends the member's kitchen profile block
  (`kitchenProfilePromptBlock`, `server/kitchenProfile.ts`) and one rule:
  never include an allergen or a "never include" food, even if the brief
  names one; substitute and say so in notes; follow the diet and dislikes
  unless the brief explicitly asks otherwise. With no profile the prompt is
  byte-for-byte what it was. The research call is unchanged and never sees
  the profile. Branch `claude/personal-user-settings-explore-5d149e`
  (`docs/plans/kitchen-profile.md`).
- Reason (not fixture-specific): members set allergies and diets once in
  Settings instead of repeating them in every brief.
- Command: `npx vitest run --config vitest.eval.config.ts evals/recipeGenerate.eval.ts`
  (the four existing cases, plus two new ones: "pad thai for two" with a
  peanut allergy must list no peanut ingredient; "lasagne for 4" with a
  vegetarian diet must list no meat ingredient).
- Before: not run. The no-profile prompt is unchanged, so the four existing
  cases measure the old path.
- After: 3 runs, 6/6 each (18/18), model default `CHAT_MODEL`.
- Decision: kept.
- Run by: agent.

## 2026-10-06 — RECIPE_SCHEMA property order (times early), whole-minute rounding

- Change: `RECIPE_SCHEMA` (photo import and `generateFromBrief`) gets a
  `propertyOrdering`: title, description, servings, prepMinutes,
  cookMinutes, ingredientSections, steps, tags, notes, lang.
  `PAGE_RECIPE_SCHEMA` now builds its order from it plus its two booleans;
  the resulting list is the same as before, so the page and paste request
  is unchanged. `normalizeImportedRecipe` rounds `prepMinutes` and
  `cookMinutes` to whole minutes for every import path. Negative values and
  values that round to over 100,000 (about 69 days) are dropped, a positive value that
  would round to 0 (such as 5.000000000000001e-05) is dropped rather than
  shown as "0 min", and 0 is kept. The cap is deliberately above MCP's
  `RECIPE_LIMITS.maxMinutes` (10,000, about 7 days): cures, ferments and
  extracts honestly run to weeks (21 days is 30,240), and the first cap of
  10,000 (`dfa87f4`) dropped them. The cost is that a run-on under 100,000
  (30 becoming 30000) is kept. Prompts, model settings, retries and goldens
  are unchanged. Commits: `21a5a48` (order and rounding, the measured
  version), then review follow-ups `4b6fa54` (drop a value that rounds to
  0), `dfa87f4` (cap at 10,000) and the commit after it (cap raised to
  100,000). The follow-ups were not re-measured. They change only values
  under 0.5 or that round to over 100,000. The judge compares times on the
  photo and page runs (`evals/judge.ts`), and the raw times of those runs
  were not recorded, so whether any fell in either range is unknown; the
  one recorded run-on that size is the 305106198964720960 in the
  2026-10-01 entry.
- Reason (not fixture-specific): the 2026-10-01 rule that no free-form
  number should be the last token of the object, which only the page schema
  followed. Without an order the model writes the required fields, then
  the optional ones alphabetically, so `prepMinutes` comes last. The
  normalizer rules are a backstop for a run-on that still parses: rounding
  catches a fractional one, the 100,000 cap a large whole-number one. Imported
  times are whole minutes; the recipe form, MCP, chat Apply and backup
  import still accept fractions, and nothing depends on whole minutes.
- Reported: a live Generate run ("shrimp gumbo in a pressure cooker for 6",
  search on) showed prepMinutes as 20.000… in the preview and had no
  description.
- Probe: `generateFromBrief` on that brief, 8 runs without search and 8
  with, on the real code path. The structured call was wrapped to record its
  finish reason, key order, and the raw time literals.
  - Before (`33c0c16`): key order always ended `…,tags,cookMinutes,[description,lang,notes,]prepMinutes`.
    2/16 runaways, both with search: one `prepMinutes`
    20.000000000000004 (parsed, shown as a float) and one run of zeros to
    `MAX_TOKENS` (3,241 candidate tokens, not counting thinking tokens;
    `parse_error`). 5/16 had no
    `description`, `notes` or `lang` (2 without search, 3 with), including
    the parsed runaway.
  - After (`21a5a48`): 16/16 `STOP` in the schema order, raw times all integers, and
    `description`, `notes` and `lang` present in 16/16.
- Command: `npm run eval:ocr-compare -- --split=all --runs=3`, once per side
- Before (`33c0c16`): dev 11/15 (blueberry-muffins 3/3, choc-pie-tea-towel
  3/3, hundred-good-cookies 3/3, lemon-tea-bread 2/3, sweet-sour-pork 0/3),
  holdout 15/15; every A run `STOP`, calls 1.
- After (`21a5a48`): dev 14/15 (blueberry-muffins 3/3, choc-pie-tea-towel 3/3,
  hundred-good-cookies 3/3, lemon-tea-bread 3/3, sweet-sour-pork 2/3),
  holdout 15/15; every A run `STOP`, calls 1. Approach B sends the page
  schema, whose request did not change: dev 9/15 → 9/15, holdout
  10/15 → 9/15.
- `npm run test:import` (31 tests, once per side): before 30/31 (failure:
  translate judge, marmiton-boeuf-bourguignon → uk, which does not use the
  import schema); after 30/31 (failure: dev sweet-sour-pork photo,
  ingredient count 1 vs golden 9, `STOP` and not a runaway). `recipeGenerate.eval.ts` was 4/4 on both sides.
  Summed photo runs, ocrCompare A plus test:import: dev 16/20 → 18/20,
  holdout 20/20 → 20/20.
- Decision: kept. Holdout did not drop and dev rose, which passes the
  acceptance rule. The dev gain is mostly sweet-sour-pork, a card that
  varies between runs (2/3 in the 2026-09-27 entry, 0/3 here before the
  change), so the photo result is read as "no regression", not as a fix.
  The generate probe is the evidence for the change.
- Review check, dev split only: does the new order make photo imports
  write a description or times the card does not have? (The photo prompt
  allows them only if written; the order now asks for them before the
  ingredients, and the judge treats them as soft.) A scratch script ran
  `importFromImages` on the dev cards with the `21a5a48` request ("after")
  and with `propertyOrdering` removed, which is byte-for-byte the
  `33c0c16` request ("before"), counting fields present only. Three
  batches, all recorded: every dev card 5× per side; then both
  lemon-tea-bread and sweet-sour-pork 6× each per side; then both 8× each
  per side. The second and third batches were to find out why "after" had
  non-`ok` imports in the first. Sums, 53 imports per side (25 + 12 + 16):
  - `description`, on cards whose golden has none (all five): before 0,
    after 0.
  - A time the golden does not have: before 11 (5 prep on
    choc-pie-tea-towel and lemon-tea-bread; 6 cook, 5 of them on
    hundred-good-cookies, 1 on sweet-sour-pork); after 5 (cook on
    hundred-good-cookies, 5/5 on both sides). blueberry-muffins, whose
    golden has a cook time, returned it in 5/5 on both sides, matching.
  - Not `ok`: before 1 (sweet-sour-pork, `MAX_TOKENS` at 3,543 candidate
    tokens, `parse_error`); after 3 (first batch, 1 lemon-tea-bread and 2
    sweet-sour-pork, kind not recorded because the script did not record
    it yet; the 28 later "after" imports on those cards, 14 per card, were
    all `ok`). Summed with the dev photo runs of ocrCompare (15) and
    test:import (5), where every A run was `ok` on both sides: dev only,
    73 runs per side, 1/73 not `ok` before against 3/73 after. Too few to
    tell apart, and worth watching.
  - Read: the order did not add descriptions and wrote fewer invented
    times, so the photo path keeps it.
- Run by: agent, default model (`gemini-3.7-flash`).

## 2026-10-05 — Recipe from a brief: search as a research call, not on the structured call

- Change: `generateFromBrief` (new, `docs/plans/recipe-generation.md`). With
  search on, a free-text research call with the Google Search tool runs
  first and the structured call writes from its notes. The extraction
  prompts, schemas, checks, retry policy and goldens are unchanged; the
  handwritten evals were not run because nothing they cover changed.
- Reason (not fixture-specific): the Google Search tool on the structured
  call never fired for a dish the model knows. Over 17 raw calls on
  `gemini-3.7-flash` (gumbo and a 2025 trend dish; "you may search",
  "search before writing", and "use the Google Search tool first"; with and
  without the schema) the response had no `groundingMetadata` in every
  case, while a news question with the same tool searched at once (2
  queries, 4 chunks, the Search Suggestions chip). A call framed as
  research ("find at least three published recipes … report what you
  found, not a recipe of your own") searched 3 of 3 times (2–3 queries,
  4–9 chunks, chip 4.7–5.1 KB, 10–12 s).
- Command: `node --env-file=.env.local node_modules/vitest/vitest.mjs run
  --config vitest.eval.config.ts evals/recipeGenerate.eval.ts`
- Before: one structured call with the tool; the eval's search case had no
  grounding to show.
- After: 4/4 (gumbo constraints, Ukrainian brief, non-food refusal, search
  with sources). Structured calls without search parsed 12 of 13 raw
  probes; the one `parse_error` was a searched single call, which no longer
  exists.
- Decision: kept. Searched generation is two calls (about 20 s); the
  checkbox is opt-in and rate-limited for that reason.
- Run by: agent, default model.

## 2026-10-01 — Wikibooks Cookbook:Pancake returns not_a_recipe (issue #106), no change

- Change: none to prompts, schema, checks, or goldens. Only the documented
  expectation for `import-sites/wikibooks-pancake` was corrected
  (`class.json`, `docs/plans/import-reliability.md`).
- Finding: the cached page imported through `importFromHtml` gives
  `not_a_recipe` 3/3 (same as production). The page is a category overview
  (characteristics, varieties, gallery) with no ingredient list or method, so
  the refusal is correct. The earlier note that it yields an ingredients-only
  recipe with `INSTRUCTIONS_NOT_ON_PAGE` came from the empty-steps check
  calibration, not from a model run.
- Rejected: prompting the model to build an ingredients-only recipe from
  prose. It would invent a recipe from one page's shape, and it needs the
  full `--split=all` measurement before it could qualify.
- Run by: agent, default model, 3 runs of the cached page only.

## 2026-10-01 — Page and paste import: self-report fields, import checks, retry loop at 0

- Change: `importFromSource` (page, paste, extension) now asks for
  `PAGE_RECIPE_SCHEMA`, which is `RECIPE_SCHEMA` plus required booleans
  `instructionsOnPage` and `ingredientsOnPage`. The prompt text is unchanged.
  Each extraction runs `checkImport` (`server/importChecks.ts`), and an
  attempt loop retries hard failures and blocking extraction warnings up to
  `MAX_IMPORT_RETRIES`, which ships at 0, so every import still makes one
  call. A thrown call is now `model_error` instead of an escaping throw.
  `importFromImages` keeps `RECIPE_SCHEMA`, its prompt and config, one call,
  and no checks (unit tests pin all of these).
- Reason (not fixture-specific): spec §4.2 and §6. The checks read no
  fixture's content; thresholds are the plan's starting values, to be
  calibrated on the phase 1 fixtures.
- Offline calibration (`evals/pageFixtures.test.ts`): every cached page with
  a recipe raises no source warning for an empty-steps extraction; the three
  page goldens raise no warnings against their own pages.
  `import-sites/wikibooks-pancake` was hand-classified `source` in
  `class.json` (a category overview with no method of its own) and raises
  `INSTRUCTIONS_NOT_ON_PAGE`.
- Command: `npm run test:import` once per side, then `-t "from cached HTML"`
  and `-t "cached HTML|import from text"` repeats, alternating sides. Every
  run is recorded. `eval:ocr-compare` was not run: the photo request is
  byte-for-byte the same (unit-tested). It is required for phase 3.
- Before (`d807bb3`): full run 26/26. Page fixtures, 8 more runs: 24/24.
  Page + text fixtures, 4 runs: 22/24 (beef-noodle-soup `parse_error`;
  gumbo step count 8 vs 5).
- After, first version (`0db5ad9`, page schema with the two required
  booleans, no ordering): full run 24/26 (beef-noodle-soup judge:
  `prepMinutes` 305106198964720960; sweet-sour-pork photo, an unchanged
  request, already 2/3 in the 2026-09-27 entry). Page fixtures, 8 more runs:
  18/24, every failure beef-stew (4 `parse_error`, 1 `prepMinutes` 558, 1
  unrecorded).
- Diagnosis (raw-output probe on beef-stew; finish reason, length, and key
  order only): the model writes required fields first, then the optional
  ones, and with the booleans required `prepMinutes` landed last. A trailing
  number sometimes runs on (`5.000000000000001e-05`, or zeros until
  `MAX_TOKENS`, which is the `parse_error`). The parent commit does the same
  (1 of 3 probes hit `MAX_TOKENS` on a trailing `prepMinutes`); the new
  fields made it more frequent. The model also stopped returning
  `description`, `notes`, and `lang`.
- Fix: `PAGE_RECIPE_SCHEMA.propertyOrdering` puts the times early and ends on
  the two booleans. Reason (not fixture-specific): no free-form number should
  be the last token of the object. Photo schema untouched.
- After, with the ordering: probe 6/6 `STOP`, with `description` and `lang`
  back. Page + text fixtures, 4 runs: 24/24.
- Decision: kept. The first version is the regression the ordering fixes;
  the ordering run beats the parent on the same fixtures (24/24 vs 22/24).
- Grounding now maps ies<->y and ves<->f/fe (review on #103), so a faithful
  extraction of strawberries or bay leaves is no longer flagged against a
  page that says strawberry or bay leaf, and the reverse. Offline calibration
  in `evals/pageFixtures.test.ts` rerun: passes, no new warnings on any cached
  page.
- Run by: agent, model default (`CHAT_MODEL` from `.env.local`)

## 2026-09-27 — Photo import: runaway-unit check (32) and one retry

- Change: `fdefa65` made `importFromImages` treat an ingredient `unit` longer
  than 32 characters as `unusable`, and retry once on `parse_error` or
  `unusable`. Reverted after the measurement below. Principle 1 is one call
  again.
- Reason (not fixture-specific): truncated JSON and reasoning written into a
  field are sampling failures. A second sample of the same call usually
  avoids them. The length check reads no card content.
- Command: npm run eval:ocr-compare -- --split=all --runs=3
- Before (`63e41ba`): dev 14/15, holdout 15/15. Dev per fixture, approach A:
  blueberry-muffins 3/3, choc-pie-tea-towel 3/3, hundred-good-cookies 3/3,
  lemon-tea-bread 3/3, sweet-sour-pork 2/3. Every run finished `STOP` with
  `calls` 1. No `MAX_TOKENS`.
- After (`fdefa65`): dev 12/15, holdout 15/15. Dev per fixture, approach A:
  blueberry-muffins 3/3, choc-pie-tea-towel 3/3, hundred-good-cookies 3/3,
  lemon-tea-bread 2/3, sweet-sour-pork 1/3. No `MAX_TOKENS`. `calls` 2 on
  sweet-sour-pork approach A, runs 1 and 3 (`STOP+STOP`); both failed the
  judge. lemon-tea-bread approach A, run 1, failed with `calls` 1.
- Decision: reverted — dev approach A fell from 14/15 to 12/15. Holdout
  stayed 15/15, which is a tie and would have passed on its own.
- Run by: owner, model default (`CHAT_MODEL` unset in the recorded command)

## 2026-09-27 — Dev/holdout split

- Change: `git mv` of the 10 handwritten fixtures into
  `evals/import-handwritten/dev/` and `holdout/`. No behaviour change.
  dev: `blueberry-muffins`, `choc-pie-tea-towel`, `hundred-good-cookies`,
  `lemon-tea-bread`, `sweet-sour-pork` (already inspected, debugged, or
  golden-adjusted: `803f29c`, `58d193a`). holdout: `broccoli-salad`,
  `peanut-butter-cookies`, `potatoe-pancakes-platter`, `split-pea-soup`,
  `taffy-apple-salad` (not used for debugging or prompt tuning; the taffy
  golden was reconciled in `f6f7b72` against an independent transcription,
  not against model output).
- Reason (not fixture-specific): cards already looked at cannot be treated as
  unseen. The split separates them from cards not used to design a change.
- Command: none. A fixture move; no measurement is needed.
- Before: n/a
- After: n/a
- Decision: kept — fixture move only; no measurement is needed.
- Run by: agent, no model run

## 2026-09-27 — Recipe-card shorthand line in the photo prompt (`58d193a`, reverted `0b7d79e`)

- Change: `58d193a` added a photo-prompt line about recipe-card shorthand
  (`#` after a number means pounds, and tablespoon abbreviations). Reverted
  in `0b7d79e`.
- Reason (not fixture-specific): none. Written from one card. Not a valid
  experiment. See the worked example in `evals/AGENTS.md`.
- Command: measured only on `sweet-sour-pork`, not
  `npm run eval:ocr-compare -- --split=all --runs=3`.
- Before: not recorded across both splits
- After: not recorded across both splits
- Decision: reverted — measured only on `sweet-sour-pork`, so it is not a
  valid experiment. See the worked example in `evals/AGENTS.md`.
- Run by: agent (`58d193a`); owner reverted (`0b7d79e`); model not recorded

## 2026-09-27 — Photos to Gemini vs Vision OCR then Gemini (P2)

- Change: none here. Copy of numbers already recorded in constitution
  principle 2 (`docs/constitutions/image-import.md`). Not a new claim.
- Reason (not fixture-specific): compare photos straight to Gemini with
  Vision OCR then Gemini. Recorded before the split.
- Command: `evals/ocrCompare.ts`, before the split, 3 cards × 3 runs.
- Before (pre-split): approach A 6/9, approach B 3/9; median 3.5 s against
  5.7 s; mean cost about $0.013 against $0.012 per import. These are not
  dev/holdout counts.
- After: n/a — this entry copies the recorded numbers; it is not a new run.
- Decision: kept — copy of the numbers already in constitution P2, not a new
  claim.
- Run by: copied from constitution P2, not a new run
