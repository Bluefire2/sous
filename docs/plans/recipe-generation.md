# Write a recipe from an idea (Create mode on /import)

**Status:** Built 2026-10-05 on `claude/ai-recipe-generation-0f49e5`, not
deployed.

Constitutions applied: **i18n** (P9 amended for Google's Search Suggestions
chip; P10, P14, P16), **client-state** (plain screen state, no new store),
**image-import** (checked, untouched: photos stay in Import mode and
`importFromImages` is unchanged). `evals/AGENTS.md` is amended to name the
new prompt as outside the dev/holdout rules.

## Context

`/import` only extracted: a link, pasted text, or photos went to Gemini with
a prompt that stays faithful to the source and never invents. Typing an
idea such as "shrimp gumbo in a pressure cooker" gave `NOT_A_RECIPE` or a
thin result with `UNGROUNDED_INGREDIENT` warnings. The owner wants to type
an incomplete idea and have Gemini write a complete recipe from its cooking
knowledge, optionally searching the web, then review and save it through the
normal import preview.

## Decisions (owner, 2026-10-05)

- **UX: a mode switch on the Import screen**, not a new screen and not a
  checkbox on the paste form. The mode is `create` in code and in the review
  state ids; the pill and the button say **Generate**, because "generate" is
  the one verb that reads as "the AI makes it up" and keeps it apart from
  Import and from writing a recipe by hand (owner, 2026-10-05). Import / Generate pills sit under the header.
  Create shows a brief textarea, a Search the web checkbox (off by default)
  and a Generate recipe button; photos and bulk are hidden. The result lands in
  the same preview with the translate checkbox, Save, and the 👍/👎 row.
  `/import?mode=create` opens on Create; the Library add sheet links to it
  ("Generate a recipe from an idea"; the other two read "Import a recipe you already have (link, text, or photos)" and "Start with a blank recipe", so each says what you start with).
- **Web search is opt-in, and it is a research call before the structured
  call.** The plan was one structured call with the Google Search tool
  (Gemini 3 allows the tool with `responseSchema`), but on
  `gemini-3.7-flash` that tool never fired for a dish the model knows,
  however firmly the prompt asked (0 of 17 raw probes), while a call framed
  as research searched every time (`evals/EXPERIMENTS.md`, 2026-10-05). So
  with search on, `generateFromBrief` first asks the model to find and report
  at least three published recipes (free text, the Google Search tool, 2048
  output tokens), then the structured call writes from those notes. The
  grounding comes from the research call. Google's terms require its Search
  Suggestions chip to be shown as provided, so the preview shows the chip (in
  a sandboxed frame) and the pages it used. Searches are billed per query and
  the path is two calls (about 20 s), so searched calls are rate-limited.
- **The UI says Sous, never Gemini** (owner, 2026-10-05): the search hint is
  "Lets Sous run Google searches for your idea" and the sources heading is
  "Pages Sous used", because the model can change. AGENTS.md (Product copy)
  holds the rule for every screen.
- **No provenance marker** on the saved recipe: no tag, no note, no `Recipe`
  field. The schema lock holds. The import log line records
  `via: 'generate'`.

## Server

`generateFromBrief(brief, deps, { search, translateTo? })` in
`server/recipeImport.ts`:

- Blank brief: `empty_source`, no call.
- With `search` on, a research call first: `researchPrompt(brief)` ("Use
  Google Search to find at least three published recipes … report what you
  found, not a recipe of your own"), `tools: [{ googleSearch: {} }]`, no
  schema, `RESEARCH_MAX_OUTPUT_TOKENS` (2048). Its text, cut to
  `MAX_RESEARCH_NOTE_CHARS` (6000), becomes the notes; its
  `groundingMetadata` becomes `grounding`. A blank answer means no notes.
- One structured `generateContent` call: `generatePrompt(withNotes)` +
  `Request:\n<brief>` (+ `Notes from a web search:\n<notes>`),
  `RECIPE_OUTPUT_CONFIG` (the photo schema `RECIPE_SCHEMA`, not the page
  schema; there is no page to self-report on), never a tool. `PAGE_PROMPT`,
  `imageImportPrompt`, both schemas and `normalizeImportedRecipe` are
  unchanged.
- The prompt says the request is an idea, not a finished recipe; fill in
  ingredients with quantities and numbered steps; keep every constraint;
  decimals; realistic times; servings from the request else 4; write in the
  request's language and set `lang`; `NOT_A_RECIPE` for anything that cannot
  be cooked. With notes it must combine them in its own words and prefer
  them over memory where they disagree. `server/recipeImport.test.ts` pins
  the phrases.
- The reply goes through `readModelText`. No `checkImport` (nothing to
  compare against); a recipe with no ingredients or no steps is `unusable`.
  One step is allowed, unlike import's `MIN_STEPS` warning: a drink or a
  dressing is one step, and the model was asked for the method, not quoted.
  `warnings` is always `[]`. A throw is `model_error`
  with the numeric status only (`noteThrow`, shared with `extractOnce`).
- Grounding (`readGrounding`): `groundingChunks[].web` → http(s) only,
  de-duplicated, at most `MAX_GENERATE_SOURCES` (10), an untitled page kept
  with `title: ''` (the client labels it "Untitled page"; the host would only
  ever be Google's redirect host); `searchEntryPoint.renderedContent` as
  `searchSuggestions`. `grounding` is set only with search on and only when a
  page or the chip came back. `webSearchQueries.length` goes on the outcome's
  log as `searchQueries` as soon as the research call answers, so a searched
  run that then fails still logs how many searches ran. The queries themselves are
  never a JSON field and never logged (they paraphrase the brief); the member
  who typed the brief still sees them inside Google's chip, which is shown as
  provided. Sources are de-duplicated by redirect URL and by title (titled
  pages only), because Google issues one redirect URL per chunk.
- `finishImport` runs as for paste, so translation works the same.

`POST /api/import` (`server/importRoute.ts`): body gains `brief` and
`search`. Dispatch is `url` → photos → `brief` → `text`.

| Case | Answer |
| --- | --- |
| `brief` not a string, or `search` present and not a boolean | 400 `bad-request` |
| blank brief | 400 `import-empty` |
| brief over `MAX_GENERATE_BRIEF_CHARS` (2000) | 400 `import-brief-too-long` |
| searched call over `MAX_IMPORT_SEARCHES_PER_HOUR` (20) per member per instance | 429 `import-search-rate-limited` |
| `not_a_recipe` | 422 `import-no-recipe-brief` |
| `parse_error` / `unusable` / `model_error` | 502 `import-generate-failed` ("Couldn't generate that recipe — try again.") |
| `ok` | 200 `{ recipe, translation?, translationFailed?, grounding? }`, no `sourceUrl` |

The rate limit reuses `admitTranslateCall` from `server/recipeTranslation.ts`
with its own bucket map; unsearched briefs are not limited. The log line
(`server/importLog.ts`) gains `via: 'generate'`, `search`, `searchQueries`,
and the outcomes `bad_brief` and `rate_limited`; it never holds the brief.

## Feedback

`IMPORT_FEEDBACK_VIAS` gains `generate`. A report for a generated recipe
carries the brief in `pastedText` (the text the person typed; no new field).
`includedSummary` reports it as `kind: 'brief'`, and the card says "Your idea
for the dish (… characters), starting …". The schema table in
`docs/plans/import-feedback.md` says so.

## Client

- `importRecipe({ brief, search, translateTo })`; `ImportRecipeResult.grounding`
  parsed defensively by `readImportGrounding` (http(s) sources, cap 10,
  non-empty chip). Error codes mapped in `src/lib/errorText.ts`.
- `ImportScreen`: `mode` (from `?mode=create`) and `search` state; the
  pill switch; Create form; `extract()`'s first branch posts the brief with
  `source: { via: 'generate', pastedText: brief }`. Switching to Create drops
  photos and bulk and keeps the typed text.
- `ImportPreview`: a sources block (heading, one link per page labelled with
  Google's title, which is usually the site, because the links themselves
  are redirects on Google's host, or "Untitled page"; and the chip in `<iframe
  sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc>`, no scripts,
  with `<meta name="color-scheme" content="light dark"><base target="_blank">`
  put before Google's unchanged snippet so its links open a new tab, since
  google.com refuses to be framed, and the frame is not a white box on the
  dark theme)
  between the translate-failed notice and the language line. Everything else
  is the paste behaviour.
- `importHref(collectionId, 'create')`; the Library add sheet's third link.
- Catalog keys in all four languages: `import.mode*`, `import.placeholderCreate`,
  `import.createHint`, `import.searchWeb(Hint)`, `import.generateRecipe`,
  `import.generating(Hint)`, `import.sources`, `import.untitledSource`, `import.searchSuggestions`,
  `importFeedback.includedBrief`, `library.generateFromIdea`, and the four
  `error.import*` keys.
- Review states `import-create-idle`, `import-create-preview`,
  `import-create-no-recipe`, `import-create-writing`,
  `import-create-too-long`, `import-create-rate-limited`, and
  `import-create-failed` (`docs/i18n-review/screens.json`,
  `testing/i18n-review/states.ts`, mocks `importGenerated`,
  `importBriefNoRecipe`, `importHangs`, `importBriefTooLong`,
  `importSearchRateLimited`, and `importGenerateFailed`).

## Legal

`/privacy`: the idea goes to Gemini; with search on Gemini may run Google
searches and the pages are shown, not stored; the log line's new fields and
its never-list; import reports may hold the idea. `/terms`: a written recipe
is made up by the model, check it before cooking; search shows the pages and
Google's suggestions.

## Evals

`evals/recipeGenerate.eval.ts` under `npm run test:import`: the gumbo brief
(servings 6, ≥ 6 ingredients, ≥ 4 steps, a step mentions "pressure", `lang`
`en`), a Ukrainian brief (`lang` `uk`, servings 2, Cyrillic steps), a
non-food brief (`not_a_recipe`), and the gumbo brief with search (sources
present; a warning, not a failure, when Google reported no grounding). No
golden, no judge. First run recorded in `evals/EXPERIMENTS.md`.

## Verification

- `npm test`, `npm run build`.
- `npm run test:import` (needs `GEMINI_API_KEY`).
- Browser in test mode (`npm run dev:test` + Vite, persona `member`,
  `GEMINI_API_KEY` set): Import mode unchanged; Create → gumbo brief →
  preview → Save with no `sourceUrl`, tag or note; with search → sources and
  chip; a Ukrainian brief with the UI in English → translate checkbox; a
  non-food brief → the 422 message and a report card whose emulator doc has
  `via: 'generate'` and `pastedText`; `/import?mode=create` from the add
  sheet; the `event: 'import'` line shows `via`, `search`, `searchQueries`
  and no brief.
- `npm run test:i18n -- --states import-create-idle,import-create-preview,import-create-no-recipe,import-create-writing,import-create-too-long,import-create-rate-limited,import-create-failed,library-add-sheet`
  before the PR.
