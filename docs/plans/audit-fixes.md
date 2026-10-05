# Audit fixes

Implement every finding in [`AUDIT.md`](../audits/2026-08-30.md) — High 1–2, Medium 3–5,
Low 6–11 — and nothing else. No new product features, no new screens, no new
npm dependencies, no theme or layout redesign. The working tree already carries
the uncommitted UI-polish work (`src/lib/uiClasses.ts` plus eight modified
files); this plan builds on it and must not revert any of it.

## Goal

- The documented setup path (`cp .env.example .env.local`) produces a working
  chat and import instead of `model: ''` (finding 1).
- Model-authored recipe proposals can no longer poison the app: they are
  normalized before they are persisted, re-checked before they are rendered,
  recoverable with a clear-chat control, and contained by an error boundary
  (finding 2).
- A chat stream killed by the platform is detectable by the client, and
  `api/chat.ts` gets the same 60s budget `api/import.ts` already has
  (finding 3).
- Chat photos go through the same downscale as recipe photos, pending photos
  stay in memory until send, and orphaned blobs get swept at startup
  (findings 4, 7).
- A blank `APP_PASSWORD` 401s instead of opening the endpoint, and `/api/import`
  refuses non-`http(s)` URLs (findings 5, 6).
- The test file leaves `api/` (finding 8), a corrupt backup can no longer insert
  a recipe that crashes the Library (finding 9), the `0x1E` protocol gets tests
  (finding 10), and the photo-history decision is documented (finding 11).

## Assumptions

- Implementers can run `npm test`, `npm run build`, `npm run dev`, and
  `npm run dev:api` (Node ≥ 22.18, `.env.local` present). Real Anthropic calls
  are only needed for the manual chat checks in steps 4, 7, 9, 10, 12; every
  step also has a build/test-level verification that works without a key.
- Baseline before step 1: `npm test` → 39 tests in 5 files, all pass;
  `npm run build` → `tsc -b` and Vite clean. Every step must keep both green.
- No new dependencies. Vitest stays `environment: 'node'`
  ([`vitest.config.ts`](../../vitest.config.ts)) — do **not** switch to jsdom;
  the two new test files stub what little they need, the way
  [`src/lib/settings.test.ts`](../../src/lib/settings.test.ts) already stubs
  `globalThis.localStorage`.
- The schema-duplication rule from the README holds: any env/auth edit lands in
  **both** `api/chat.ts` and `api/import.ts`, and `RECIPE_SCHEMA` stays
  byte-identical between them (no step below changes the schema).
- New or changed controls follow the UI-polish decisions already in the tree:
  every `hover:` fill has the same `active:` twin, shared class strings come
  from `src/lib/uiClasses.ts`, and two utilities never set the same CSS
  property. Settings' `statusKind` state (ui-polish step 7) stays.
- Anthropic SDK behavior is unchanged: `stream.on('end')` fires and
  `stream.finalMessage()` resolves afterwards, as the current code assumes.
- Verification commands must run on this Windows / PowerShell checkout. Do not
  use `/dev/null`, `xxd`, `tail`, or bash-only redirects. Prefer `node -e`
  scripts that print a status code or trailing bytes.

## Decisions (not blocking)

- **Where proposal validation lives.** A new module
  `src/lib/recipeShape.ts` exporting `normalizeRecipeDraft(value: unknown)` and
  `isUsableRecipe(value: unknown): value is Recipe`. Findings 2 and 9 both need
  shape checking on data that has no compile-time relationship to `Recipe`, so
  they share one module and one test file rather than duplicating guards.
  `src/lib/recipeDraft.ts` keeps only `blankDraft()`.
- **Normalize at the boundary, not in the component.** `streamChatReply`
  ([`src/lib/chatApi.ts`](../../src/lib/chatApi.ts)) replaces its
  `JSON.parse(...) as RecipeDraft` cast with `normalizeRecipeDraft`, so a bad
  proposal never reaches `chatStore.append`. `MessageBubble` re-checks
  `message.proposedRecipe` at render because rows persisted **before** this fix
  are already in users' IndexedDB.
- **`servings < 1` is rejected, not clamped.** AUDIT's gate is
  "drop the proposal if `title` / `servings ≥ 1` are unusable".
  `normalizeRecipeDraft` returns `undefined` when `servings` is missing, not a
  finite number, or `< 1`. Do **not** `Math.max(1, servings)`: that would
  silently rewrite a model-authored `0` (or a negative) into a valid recipe
  instead of dropping the proposal. The form still clamps user input in
  [`RecipeForm.toDraft`](../../src/components/RecipeForm.tsx); this path is
  untrusted tool output, not a form submit.
- **Title-only / empty-body proposals are kept.** The editor already accepts
  recipes whose `ingredientSections` and `steps` are empty arrays
  (`blankDraft` seeds empty rows the user can leave blank). Do **not** add an
  extra drop rule for "both arrays empty after normalization" — that contradicts
  existing editor validity and is beyond AUDIT's `title` / `servings ≥ 1` gate.
  Empty arrays still default in when those keys are missing, same as
  `importApi`.
- **Never copy `photoId` or `sourceUrl` off a proposal.**
  [`recipeStore.applyDraft`](../../src/lib/recipeStore.ts) uses
  `draft.photoId ?? existing.photoId` and
  `draft.sourceUrl ?? existing.sourceUrl`. The tool schema cannot express those
  fields, but a hallucinated `photoId` would replace the recipe photo and
  `deleteReplacedPhoto` the real blob; a hallucinated `sourceUrl` would overwrite
  provenance. `normalizeRecipeDraft` **omits both keys always**, even if the
  parsed object has them. `applyDraft` then keeps the existing values.
- **`isUsableRecipe` validates every `Recipe` field the UI might render.** A
  backup row with `description: {}` or `ingredientSections[0].name: {}` still
  crashes React (`Library` / `RecipeView` render those values). Required fields
  as listed in step 6, **plus** every optional field: if present, it must be the
  correct type (and nested optionals on sections/items too). A row either
  passes through untouched or is skipped — no repair.
- **Stream terminator shape.** `api/chat.ts` always ends the response with
  `\x1E` + (proposal JSON or empty) + `\x1E`. A complete reply therefore splits
  into at least three parts on `\x1E`; fewer means the stream was cut off. This
  is backward compatible with the currently deployed client (it destructures
  the first two parts and ignores the rest), so the server step ships before the
  client step.
- **Truncation is reported inline, not as an error banner.** The client appends
  `⚠️ The reply was cut off before it finished.` to the persisted assistant
  message, matching the existing `⚠️ ${message}` convention in `ChatPanel.send`.
  No `setError` call, so a partial reply is not double-reported.
- **Clear-chat control.** A `Clear` ghost pill in the `ChatPanel` header, armed
  by a first tap (label becomes `Clear all?`, styled with the existing
  `addBtnDanger`) and committed by a second. Hidden or disabled while `busy`
  so a late `streamChatReply` resolve cannot append into a just-cleared thread.
  Await `clearForRecipe`; do not `void` it. Guard against a second commit click
  while the delete is in flight, and `setError` if it fails. No new `Sheet`, no
  `window.confirm`, no new export in `uiClasses.ts`. `chatStore.clearForRecipe`
  also deletes the photos those messages referenced, mirroring `recipeStore.remove`.
- **Finding 4 migration of existing oversized rows: out of scope.** A one-off
  re-encode is not cheap here — it needs canvas at startup, rewrites the only
  copy of user data with no undo, and needs its own version flag and
  verification. Referenced full-size rows stay until the user re-picks them.
- **Finding 7: store-on-send, plus a sweep for leftovers.** Pending chat photos
  stay in memory (downscaled) and are written to IndexedDB only when `send`
  persists the user message — the same store-on-submit pattern
  [`RecipeForm`](../../src/components/RecipeForm.tsx) already uses with
  `useObjectUrl(picked)`. The pending preview therefore uses `useObjectUrl(blob)`
  rather than `usePhotoUrl(photoId)`. A killed compose no longer orphans a row.
  The startup sweep remains for (a) orphans an older build already left behind
  and (b) a crash between `photoStore.add` and `chatStore.append` during send.
  The 5-minute age window on the sweep is only for (b): another tab mid-send.
- **Finding 8: move the test to `src/`,** as
  `src/lib/extractRecipeSource.test.ts`, importing `../../api/import`. The
  current file has **10** `it` blocks (not 11); move them verbatim. Fallback
  if `tsc -b` objects to `api/import.ts` entering the app project: put the file
  at `tests/extractRecipeSource.test.ts` and change
  [`tsconfig.api.json`](../../tsconfig.api.json) `include` to
  `["api", "tests"]`. Do not add a `vercel.json` exclusion — the file simply
  should not sit in the functions directory.
- **Finding 9 reports both counts and colors a partial import as a failure.**
  `importLibrary` returns `{ imported, skipped }`; Settings shows
  `Imported 4 recipes ✓ — skipped 2 unreadable entries` with `statusKind: 'err'`
  whenever `skipped > 0`, so a silent partial restore cannot pass for a clean
  one. Backup validation is `[core]`; the Settings status string is a separate
  `[ui]` step.
- **Finding 11: keep the behavior, add the comment.** No existing comment
  documents it and re-encoding earlier photos is the "hours" option AUDIT lists
  second; a one-line comment above the history map in `ChatPanel.send` is the fix.

## Files to change

**Server / config**

- `.env.example` — comment out the `CHAT_MODEL` line
- `api/chat.ts` — `||` model fallback, strict password check, `maxDuration`,
  stream terminator
- `api/import.ts` — `||` model fallback, strict password check, URL scheme guard

**Core**

- `src/lib/recipeShape.ts` — **new**: `normalizeRecipeDraft`, `isUsableRecipe`
- `src/lib/recipeShape.test.ts` — **new**
- `src/lib/chatApi.ts` — terminator-aware parsing, `truncated`, normalization
- `src/lib/chatApi.test.ts` — **new**
- `src/lib/chatStore.ts` — `clearForRecipe` also deletes referenced photos
- `src/lib/photoStore.ts` — `sweepUnreferenced`
- `src/lib/backup.ts` — per-recipe guard, `{ imported, skipped }` return
- `src/main.tsx` — run the sweep after seeding
- `src/lib/extractRecipeSource.test.ts` — **moved** from `api/import.test.ts`
  (delete the old path)
- `src/components/ChatPanel.tsx` — store-on-send + downscale, truncation notice,
  history-photo comment (Clear control and proposal guard are the UI step)

**UI**

- `src/components/ErrorBoundary.tsx` — **new**
- `src/App.tsx` — wrap `<Routes>` in the boundary
- `src/components/ChatPanel.tsx` — Clear control, proposal render guard,
  pending thumbs via `useObjectUrl`
- `src/screens/Settings.tsx` — import status string / `statusKind` only

**Docs**

- `README.md` — `0x1E` protocol, env table, `npm test` scope, photo sweep

Do not change: `RECIPE_SCHEMA` in either handler, `src/lib/uiClasses.ts`,
`src/index.css`, `src/lib/types.ts`, `src/lib/db.ts` (no schema version bump),
`vitest.config.ts`, `vercel.json`, `vite.config.ts`, `.github/workflows/ci.yml`,
`docs/plans/ui-polish.md`, `docs/plans/dark-mode-default.md`, or `AUDIT.md`.

## Steps

### 1. [core] `CHAT_MODEL=''` no longer defeats the default (finding 1)

Files: `api/chat.ts`, `api/import.ts`, `.env.example`

- In both handlers change `const MODEL = process.env.CHAT_MODEL ?? 'claude-sonnet-4-5';`
  to use `||`. Both copies, identical text — this is the schema-duplication rule
  applied to env reads. Add a short comment on one line explaining why `??` is
  wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is
  not nullish.
- In `.env.example`, replace the bare `CHAT_MODEL=` with
  `# CHAT_MODEL=claude-sonnet-4-5` and keep the existing
  `# Optional. Defaults to claude-sonnet-4-5 when unset.` line above it.

Do not touch `ANTHROPIC_API_KEY=` or `APP_PASSWORD=change-me` in
`.env.example`; a blank key must stay blank so the SDK reports it.

**Verify:** `npm run build`. Then
`node --env-file=.env.example -e "console.log(JSON.stringify(process.env.CHAT_MODEL))"`
prints `undefined`. With a real key present, `npm run dev:api` + `npm run dev`
and one chat turn succeeds using a `.env.local` that has no `CHAT_MODEL` line.

### 2. [core] A blank server `APP_PASSWORD` 401s (finding 5)

Files: `api/chat.ts`, `api/import.ts`

In both `POST` handlers replace the single header comparison with a check that
also rejects a falsy server value:

```
if (!process.env.APP_PASSWORD || req.headers.get('x-app-password') !== process.env.APP_PASSWORD)
```

Keep the `new Response('Unauthorized', { status: 401 })` body and status
unchanged. Add a one-line comment: a set-but-blank server password would match
the `''` that `settings.getPassword()` returns for a client that never saved
one, turning the deployment into an open proxy.

**Verify:** `npm run build`. With `APP_PASSWORD=` (blank) in `.env.local` and
`npm run dev:api` running, this must print `401` twice:

```
node -e "fetch('http://127.0.0.1:3001/api/import',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"
node -e "fetch('http://127.0.0.1:3001/api/import',{method:'POST',headers:{'content-type':'application/json','x-app-password':''},body:'{}'}).then(r=>console.log(r.status))"
```

Restore a real password and confirm a correct `x-app-password` header returns
non-401.

### 3. [core] `/api/import` rejects non-`http(s)` URLs (finding 6)

File: `api/import.ts`

In `POST`, before the `fetch` inside `if (body.url) { … }`, parse and validate:

- `new URL(body.url)` inside a `try`; on throw, return
  `Response.json({ error: 'That does not look like a web address.' }, { status: 422 })`.
- If `parsed.protocol` is neither `http:` nor `https:`, return the same shape
  with a message naming the restriction.
- Pass the validated URL to the existing `fetch` (use `parsed.href` so the
  fetched target is provably the parsed one).

Mirror the intent of `sourceLink` in
[`src/screens/RecipeView.tsx`](../../src/screens/RecipeView.tsx) — the same
two-protocol allowlist — but write it inline: `api/` entrypoints cannot import
from `src/`. Note in the comment that this is a scheme check only, matching
AUDIT's scope; it does not block private or link-local destinations.

Leave the existing `catch` around `fetch` (unreachable-host → 422) and the
`!page.ok` branch as they are. 422 keeps the client's
`data?.error ?? 'Import failed (…)'` path in
[`src/lib/importApi.ts`](../../src/lib/importApi.ts) showing the message.

**Verify:** `npm run build`. Against `npm run dev:api` (with a real password
header), POSTs whose JSON body is `{"url":"file:///etc/passwd"}`,
`{"url":"javascript:alert(1)"}`, and `{"url":"not a url"}` each return 422
with the error message and no outbound request. Drive them with `node -e`
`fetch` the same way as step 2 and print `status` plus the parsed `error`
field. A normal `https://` recipe URL still extracts.

### 4. [core] `maxDuration` and a stream terminator on `/api/chat` (finding 3, server half)

File: `api/chat.ts`

- Export `export const maxDuration = 60;` at module scope near `MODEL`, with a
  comment in the style of `api/import.ts`'s: a turn that triggers
  `update_recipe` streams a text reply and then the complete recipe JSON, the
  slowest response the app produces, so Vercel's 10s default can kill it.
- In the `stream.on('end')` handler, replace the conditional
  `controller.enqueue(encoder.encode('\x1E' + JSON.stringify(toolUse.input)))`
  with an unconditional single enqueue of
  `` `\x1E${proposal}\x1E` `` where `proposal` is `JSON.stringify(toolUse.input)`
  when the `update_recipe` tool block is present and `''` otherwise. Keep the
  `controller.close()` after it and the `catch { controller.error(err) }` around
  it — a failed `finalMessage()` must still leave the stream terminator-less so
  the client can tell.
- Update the existing protocol comment above the `ReadableStream` to describe
  all three parts: text, then `\x1E`, then any proposal, then a final `\x1E`
  that marks a clean end.

Do not change `stream.on('text')`, `cancel()`, the response headers, or
`max_tokens`.

**Verify:** `npm run build`. With a key, `npm run dev:api`, and a real
password, POST a plain "hi" chat body and print the last four bytes as hex
via `node -e` (read the response as an `ArrayBuffer`, take `Buffer.from(buf).subarray(-4)`,
print each byte as two hex digits). A text-only complete reply ends `1e 1e`.
A prompt that triggers `update_recipe` ends `1e` after the JSON (`…7d 1e` if
the JSON object is the last payload). The currently deployed client still
works against this (it ignores the trailing part).

### 5. [core] Move the import test out of the Vercel functions directory (finding 8)

Files: `api/import.test.ts` (delete), `src/lib/extractRecipeSource.test.ts` (new)

Move the file verbatim — all **10** `it` blocks, unchanged — and change only
its import to `import { extractRecipeSource } from '../../api/import';`. No
test bodies change. Confirm nothing else references `api/import.test.ts`.

If `tsc -b` reports a problem pulling `api/import.ts` into the app project
(`tsconfig.app.json` includes only `src`), use the fallback from Decisions:
`tests/extractRecipeSource.test.ts` with `include: ["api", "tests"]` in
`tsconfig.api.json`. Do not add a `vercel.json` exclusion, and do not extract
`extractRecipeSource` into a shared module — the handlers cannot import
siblings.

**Verify:** `npm test` still reports 39 tests in 5 files, all passing, and lists
the new path instead of `api/import.test.ts`. `npm run build` is clean.
`api/` now contains exactly `chat.ts` and `import.ts`.

### 6. [core] `src/lib/recipeShape.ts` and its tests (findings 2 and 9 foundation)

Files: `src/lib/recipeShape.ts` (new), `src/lib/recipeShape.test.ts` (new)

Pure functions, no imports beyond `type { Recipe, RecipeDraft, Ingredient, IngredientSection, RecipeStep } from './types'`.
A file-level doc comment states the point: this guards data that entered from
outside the app (the `update_recipe` tool, a backup file) and therefore has no
compile-time relationship to `Recipe`.

`normalizeRecipeDraft(value: unknown): RecipeDraft | undefined`

- `undefined` unless `value` is a non-null, non-array object.
- `title`: must be a string whose trim is non-empty; store the trimmed value.
  Otherwise `undefined`.
- `servings`: must be a finite number **≥ 1**; otherwise `undefined`. Do not
  clamp. `0`, negatives, `NaN`, `Infinity`, strings, and missing all drop the
  proposal.
- `ingredientSections`: non-arrays become `[]` (the default
  [`importApi`](../../src/lib/importApi.ts) already applies). Keep entries that
  are objects with an array `items`; within a section keep items whose `item` is
  a string with a non-empty trim, carrying `quantity` only when it is a finite
  number and `unit`/`note` only when they are non-empty strings (trimmed); drop
  sections left with zero items; carry `name` only when it is a non-empty
  string.
- `steps`: non-arrays become `[]`; keep entries that are objects with a
  non-empty trimmed string `text`.
- `tags`: non-arrays become `[]`; keep non-empty trimmed strings, deduped. Do
  not change case (`RecipeForm.toTags` lowercases user input; a model-authored
  tag is displayed as written).
- `description`, `notes`: included only when a non-empty string.
  `prepMinutes`, `cookMinutes`: included only when a finite number ≥ 0.
- **Always omit `photoId` and `sourceUrl`**, even when the input has them
  (see Decisions). Do not pass them through.
- A title + valid servings with empty `ingredientSections` and empty `steps`
  is a usable draft. Do not drop it.
- Build the result with conditional spreads so absent optional keys are
  *omitted*, matching `compactRecipe` and `RecipeForm.toDraft`; Dexie `put`
  replaces whole records and an explicit `undefined` would be stored as a key.

`isUsableRecipe(value: unknown): value is Recipe`

A strict predicate, not a repair function — a row either passes through
untouched or is skipped, which is what finding 9 asks for. Require: non-null
non-array object; `id` a non-empty string; `createdAt` and `updatedAt` finite
numbers; `title` a non-empty string; `servings` a finite number ≥ 1; `tags` an
array of strings; `ingredientSections` an array in which every entry is an
object with an `items` array whose every entry is an object with a string
`item`; `steps` an array in which every entry is an object with a string
`text`.

Also require that **if present**, each optional is the right type (wrong type
→ `false`, not "ignore"):

- `description`, `notes`, `sourceUrl`, `photoId`: string
- `prepMinutes`, `cookMinutes`: finite number ≥ 0
- section `name`: string
- item `quantity`: finite number; item `unit` / `note`: string

Those are the fields the UI dereferences or renders without a guard
(`recipe.tags.length` in `Library`, `ingredientSections.map` / `steps.map` /
`servings` in `RecipeView`, plus optional text nodes that crash if they are
objects).

Share small private helpers between the two (object / non-empty-string /
finite-number checks). Keep `noUnusedLocals` clean.

`src/lib/recipeShape.test.ts` follows the existing style (a `required` fixture
like [`recipeStore.test.ts`](../../src/lib/recipeStore.test.ts)) and covers:
a well-formed proposal round-tripping; `null`, an array, a string, and a number
all dropped; missing and whitespace-only `title` dropped; string, missing,
`0`, and negative `servings` dropped; missing `ingredientSections` and `steps`
defaulting to `[]` and **kept** when title + servings are valid; malformed
ingredient items and empty sections filtered; malformed steps filtered; tags
deduped and non-strings dropped; `photoId` / `sourceUrl` omitted even when
present; optional keys omitted rather than set to `undefined` (assert with
`Object.keys`); `isUsableRecipe` returning `true` for a valid row and `false`
for rows missing each of `title`, `tags`, `ingredientSections`, `steps`,
`servings`, and `id`; and `isUsableRecipe` returning `false` when
`description` is an object, when a section `name` is an object, and when an
item `quantity` is a string.

**Verify:** `npm test` — 6 files, the new suite passing, existing 39 unchanged.
`npm run build` clean.

### 7. [core] Terminator-aware parsing and proposal normalization in the client (findings 2 and 3, client half)

File: `src/lib/chatApi.ts`

Depends on step 4 being deployed/running first (see Decisions).

- Add to `ChatReply`: `truncated: boolean`, documented as "the stream ended
  without its terminator, so the reply is cut off".
- Leave the read loop and `params.onDelta(raw.split('\x1E')[0])` exactly as
  they are — the pre-separator slice is still the text.
- Replace the tail. Split `raw` on `\x1E`; the reply is complete only when there
  are at least three parts (text, proposal-or-empty, terminator remainder). Text
  is part 0. Parse the proposal only when the reply is complete and part 1 is
  non-empty, keeping the existing `try`/`catch` with its "keep the text reply"
  comment, and pass the parsed value through `normalizeRecipeDraft` from
  `./recipeShape` instead of casting to `RecipeDraft`. An unusable proposal
  yields `undefined` and the text still returns.
- Return `{ text, proposedRecipe, truncated }`.
- Comment why a missing terminator matters: a function killed by the platform
  looks exactly like a clean `done` to the reader.

Do not change the 401 / `!response.ok` branches or the request body.

**Verify:** `npm run build` (the new required `truncated` field must not break
`ChatPanel`; if it does, step 10 covers the consumer — a `tsc` error here means
the field was added as required *and* not yet consumed, which is expected only
if steps are run out of order). Step 8 is the real verification; a manual chat
turn against the step-4 server still renders text and applies a proposal.

### 8. [core] Tests for the `0x1E` stream protocol (finding 10)

File: `src/lib/chatApi.test.ts` (new)

No network, no jsdom. Setup:

- `beforeEach` stubs `globalThis.localStorage` with the in-memory `Map`-backed
  object copied from `src/lib/settings.test.ts` — `streamChatReply` calls
  `settings.getPassword()`, which reads `localStorage` and would throw in the
  node environment.
- A helper builds a `ReadableStream<Uint8Array>` from an array of strings
  (one `TextEncoder().encode` per chunk, then `close()`), and
  `vi.stubGlobal('fetch', …)` returns `new Response(stream, { status: 200 })`.
  `afterEach(() => vi.unstubAllGlobals())`.
- A `RECIPE` fixture for the `recipe` param and a valid proposal JSON string.

Cases:

1. Text-only complete reply (`['Hello ', 'there', '\x1E\x1E']`): `text` is
   `'Hello there'`, `proposedRecipe` is `undefined`, `truncated` is `false`.
2. Separator and proposal split across chunk boundaries (text in one chunk, the
   `\x1E` and the first half of the JSON in the next, the rest in a third, the
   terminator in a fourth): the proposal parses and `text` never contains JSON.
   Assert every `onDelta` argument is a prefix of the final text.
3. Truncated proposal — a complete first separator and half a JSON object, no
   terminator: `text` intact, `proposedRecipe` `undefined`, `truncated` `true`.
4. No separator at all (`['Just text']`): `text` is `'Just text'`,
   `truncated` `true`.
5. Empty stream (no chunks): `text` is `''`, `truncated` `true`, no throw.
6. Complete reply whose proposal is unusable (e.g. `{"steps":[]}` with no
   `title`): `proposedRecipe` `undefined`, `truncated` `false`, text kept —
   this is the finding-2 path.
7. `status: 401` rejects with the "Wrong or missing app password" message, and
   a `500` rejects with `Assistant request failed (500).`

**Verify:** `npm test` — 7 files, all passing. `npm run build` clean.

### 9. [core] Chat photos: downscale in memory, persist on send (findings 4 and 7)

File: `src/components/ChatPanel.tsx`

Pending photos must not hit IndexedDB until the user message is written.

- Import `encodeImageForStorage` alongside the existing `encodeImageForChat`
  from `../lib/image`, and `useObjectUrl` alongside `usePhotoUrl` from
  `../lib/photoStore`.
- Change the pending type to `{ key: string; blob: Blob }` (`key` is a
  `crypto.randomUUID()` used only as a React list key — not a photos-table id).
- `attachPhoto`: `try`/`catch` around `encodeImageForStorage(file)`. On
  success, `setPending([...pendingRef.current, { key, blob: stored }])` — no
  `photoStore.add`. On failure `setError` with the existing send wording
  ("That photo couldn't be read — it may not be a real image.") and add
  nothing. Clear the error at the start of a successful attach. Comment: the
  originals are several megabytes and the IndexedDB quota is finite, and
  `exportLibrary` re-encodes every stored blob as base64 — same intent as
  `RecipeForm`.
- Pending preview: a small thumb that calls `useObjectUrl(blob)` (the same
  hook [`RecipeForm`](../../src/components/RecipeForm.tsx) uses for an unsaved
  pick). Do **not** use `PhotoThumb` / `usePhotoUrl` for pending items — those
  read IndexedDB. Sent-message thumbs stay on `PhotoThumb`.
- `discardPending` / `removePending`: drop from state only. No
  `photoStore.remove`.
- Delete the unmount effect that `photoStore.remove`s pending ids. Pending
  rows no longer exist. Keep the abort-on-unmount effect.
- In `send`, after `encodeImageForChat` succeeds and **before**
  `chatStore.append`, persist the pending blobs with rollback on any failure:
  1. `const storedIds: string[] = []`.
  2. For each pending blob, `photoStore.add` and push the id. If any `add`
     throws, `photoStore.remove` every id already in `storedIds`, then
     `setStreamingText(null)`, `setError` with a short storage-failure
     message, and **return without appending**. Leave `pendingPhotos` in
     place so the user can retry (retry must not see the partial writes).
  3. `chatStore.append` with those `photoIds`. If append throws, the same
     rollback (`photoStore.remove` each stored id), same `setError` /
     `setStreamingText(null)`, and return with pending still in place.
  4. Only after append succeeds, `setPending([])` (and the existing
     `setDraft('')`).
  The encode-failure path still `discardPending`s (memory only now) and
  never writes photos. A crash between add and append is still a sweep
  concern (step 14); this rollback covers the recoverable failure paths.

Do not change the `encodeImageForChat` path otherwise. It now re-encodes an
already-1280px JPEG; the `maxDim` is identical so there is no second downscale.

**Verify:** `npm run build`. In `npm run dev`: attach a multi-megabyte camera
photo and **do not send** — IndexedDB `cook` → `photos` has no new row; the
pending thumb still renders. Send it: one new `photos` row appears, a few
hundred KB, long edge 1280px, `type` `image/jpeg`, and the message references
it. Close the sheet with a pending (unsent) photo: no leftover row. Attach a
renamed non-image file: the error line appears and no row is written. Confirm
the rollback path in code review: a thrown `add` after a successful earlier
`add`, and a thrown `append` after all adds, both `photoStore.remove` every
id in `storedIds` and leave pending intact. A recipe photo added via
`RecipeForm` is unchanged.

### 10. [core] Flag cut-off replies, and document the photo-history decision (findings 3 and 11)

File: `src/components/ChatPanel.tsx`

- In `send`, after `streamChatReply` resolves, append
  `'\n\n⚠️ The reply was cut off before it finished.'` to the content passed to
  `chatStore.append` when `reply.truncated` is true, keeping the existing
  `reply.text.trim() || (reply.proposedRecipe ? 'Here is my proposed change:' : '')`
  expression as the base. A truncated empty reply therefore persists the warning
  instead of an invisible empty bubble. Do not call `setError` (see Decisions).
- Directly above `...history.map((m) => ({ role: m.role, content: m.content }))`,
  add the finding-11 comment: only the newest message carries its photos,
  because re-encoding every earlier photo on every turn would multiply the token
  cost of a long thread — so the assistant cannot compare against a photo from
  an earlier message, even though the thread still displays it. Keep the
  behavior exactly as it is.

Do not change the abort branch or the error branch.

**Verify:** `npm run build`. With `npm run dev:api` running, stop the API
process mid-reply (or temporarily have the dev handler `controller.close()`
before the terminator): the assistant bubble keeps the partial text and gains
the ⚠️ line, and the message survives a reload. A normal complete reply has no
⚠️ line.

### 11. [core] `clearForRecipe` also deletes the photos those messages referenced

File: `src/lib/chatStore.ts`

Wrap `clearForRecipe` in a `db.transaction('rw', [db.chatMessages, db.photos], …)`
that reads the thread first, deletes the messages, then `bulkDelete`s
`messages.flatMap((m) => m.photoIds ?? [])`. Mirror the comment style of
`recipeStore.remove`: nothing else references those blobs, so they go with the
messages or never. Keep the `Promise<void>` signature.

This lands before the UI control in step 12 so the button cannot ship a leak.

**Verify:** `npm run build` (and step 12's manual check confirms the rows go).

### 12. [ui] ChatPanel: clear-chat control and a guarded proposal card (finding 2, plus finding 10's hygiene note)

File: `src/components/ChatPanel.tsx`

**Proposal render guard.** In `MessageBubble`, run `message.proposedRecipe`
through `normalizeRecipeDraft` (import from `../lib/recipeShape`) and render
`<ProposalCard>` only when the result is defined, passing that normalized value
as `proposal`. Rows persisted before step 7 are already in users' IndexedDB, and
this is what stops `recipeLines`' `flatMap`/`map` from throwing on every render;
a dropped proposal degrades to the plain text bubble, which still shows.
`ProposalCard` and `recipeLines` themselves need no change.

**Clear control.** In the header, keep `<h2>Assistant</h2>` on the left and put
the actions in a `flex items-center gap-1` wrapper on the right:

- A `Clear` button before `Close`, rendered only when
  `(messages ?? []).length > 0`.
- Disabled (or not rendered) while `busy` is true. A stream that resolves
  after a clear would otherwise append a new assistant row into an empty
  thread. Disabling is enough; do not abort the in-flight request from Clear
  (Close / unmount already aborts).
- Local `confirmClear` state. Disarmed: label `Clear`, class `ghostBtn`. First
  click arms it: label `Clear all?`, class `addBtnDanger` — a dedicated string,
  not `ghostBtn` plus `text-danger`, because both set `color` (UI-polish
  composition rule). Second click **awaits**
  `chatStore.clearForRecipe(recipe.id)` (no `void`), then disarms. While that
  promise is in flight, ignore further clicks (a `clearing` flag). On rejection,
  `setError` with a short failure message and leave the thread as-is. Closing
  the sheet unmounts the panel, so no other reset wiring is needed.
- `Close` keeps `ghostBtn` and its current behavior.

Both classes already pair `hover:` with the same `active:`, so nothing new is
needed in `uiClasses.ts` and no token changes are required. Do not add a
confirmation `Sheet`, `window.confirm`, arrow-key handling, or a new dependency.
Do not touch the Escape listener, the composer, the backdrop, or the send/stream
logic except as above.

**Verify:** `npm run build`. In `npm run dev`: with an empty thread no Clear
button appears; with messages, one tap shows `Clear all?` in danger styling and
a second empties the thread, the empty-state hint returns, and the `photos` rows
for cleared messages are gone from IndexedDB. While a reply is streaming, Clear
is disabled / hidden and the thread is unchanged when the reply finishes.
Hover and tap show the same fill on desktop and a narrow viewport; Tab reaches
Clear and Close with the global focus-visible outline. Seed a malformed
proposal by hand (in DevTools, set a `chatMessages` row's `proposedRecipe` to
`{}`): the thread renders the text and no card, with no white screen.

### 13. [ui] Error boundary around the routes (finding 2)

Files: `src/components/ErrorBoundary.tsx` (new), `src/App.tsx`

- New default-exported class component (React only reports render errors to
  class components) with `getDerivedStateFromError` storing a message string and
  `componentDidCatch` logging the error and `ErrorInfo` to `console.error`.
  Props are `{ children: ReactNode }`; use `import type` for `ReactNode` /
  `ErrorInfo` (`verbatimModuleSyntax`).
- Fallback markup in the app's existing idiom: the standard
  `mx-auto max-w-xl px-4` container, a bold heading ("Something went wrong."),
  the message in `text-sm text-ink-muted`, and a `primaryBtn` "Back to library"
  button that calls `window.location.assign('/')`. A full reload is deliberate:
  the crashed subtree cannot be recovered by client routing, and a class
  component has no `useNavigate`.
- In `App.tsx`, wrap `<Routes>` in `<ErrorBoundary>`. No route or path changes.

This is the backstop, not the primary fix — step 12 is what keeps the chat panel
from throwing in the first place, and it must stay, because a boundary that
replaces the whole tree would also hide the Clear control.

**Verify:** `npm run build`. Temporarily `throw new Error('boom')` at the top of
`Library`: the fallback renders instead of a white screen, the console shows the
error and component stack, and "Back to library" reloads. Remove the throw and
confirm every route renders normally.

### 14. [core] Startup sweep for leftover unreferenced photos (finding 7)

Files: `src/lib/photoStore.ts`, `src/main.tsx`

Pending compose photos no longer live in IndexedDB (step 9). This sweep is for
orphans an older build already left, and for a crash between `photoStore.add`
and `chatStore.append` during send.

- Add `photoStore.sweepUnreferenced(olderThanMs = 5 * 60 * 1000): Promise<number>`.
  In one `db.transaction('rw', [db.recipes, db.chatMessages, db.photos], …)`:
  collect referenced ids into a `Set` from every `recipe.photoId` and every
  `chatMessage.photoIds`, then `bulkDelete` the photo rows that are neither
  referenced nor newer than `Date.now() - olderThanMs`, returning how many were
  deleted.
- Doc comment: store-on-send is the primary leak fix; the age window only
  avoids deleting a blob another tab wrote milliseconds ago and has not yet
  referenced from a message.
- In `main.tsx`, chain it after seeding so the two do not interleave:
  `void seedIfEmpty().then(() => photoStore.sweepUnreferenced()).catch((err) => console.error(err))`,
  with a one-line comment pointing at `photoStore`. Nothing renders off the
  result.

This stays inside the store layer (`photoStore` already owns `db.photos`, and
`recipeStore.remove` already reads `db.chatMessages` for the same reason). No
Dexie version bump — no schema change.

**Verify:** `npm run build`. In `npm run dev`, insert an unreferenced `photos`
row by hand in DevTools (or leave one from a pre-step-9 session). Reload after
five minutes (or call `photoStore.sweepUnreferenced(0)` from the console): that
row is gone, while every recipe thumbnail and every sent chat photo still
renders. Attach a photo and do not send: reload immediately — there is no
pending row to lose (step 9), and sent photos are untouched.

### 15. [core] `importLibrary` skips malformed recipe rows and reports the count (finding 9)

File: `src/lib/backup.ts`

- Type `BackupFile.recipes` as `unknown[]` with a comment: the file is whatever
  the user chose, and only rows that pass `isUsableRecipe` reach the db.
  `exportLibrary` needs no change (a `Recipe[]` is assignable).
- In `importLibrary`, after the existing `app === 'cook'` /
  `Array.isArray(recipes)` check, filter with `isUsableRecipe` from
  `./recipeShape`, count the difference as `skipped`, and use the filtered array
  everywhere `backup.recipes` was used — `db.recipes.bulkPut` and the v1
  `db.cookState.bulkDelete(... .map((r) => r.id))`.
- Change the return type to `{ imported: number; skipped: number }` and update
  the JSDoc. Keep the merge semantics (existing ids overwritten) and the
  transaction's table list unchanged.

Do not edit `Settings.tsx` in this step — that is step 16. `tsc -b` will fail
on `Settings.doImport` until step 16 lands; run the two steps back-to-back.
`npm test` after this step still passes because nothing in the current suite
imports `importLibrary`.

Out of scope here (note only): validating `chatMessages` and `photos` entries,
and dropping messages whose `recipeId` was skipped. AUDIT scopes this finding to
recipe rows.

**Verify:** `npm test`. After step 16, `npm run build` is clean.

### 16. [ui] Settings reports skipped backup rows (finding 9)

File: `src/screens/Settings.tsx`

In `doImport`, destructure `{ imported, skipped }` from `importLibrary` and
build the status: `Imported N recipe(s) ✓`, plus
` — skipped M unreadable entr(y|ies)` when `M > 0`, with
`setStatusKind(skipped > 0 ? 'err' : 'ok')` so a partial restore is
danger-colored rather than passing for a clean one. This is the only change in
`Settings.tsx` — no markup, no class changes, and the ui-polish `statusKind`
state stays exactly as it is.

**Verify:** `npm test` and `npm run build`. Export a backup, hand-edit the JSON
to delete `tags` from one recipe, set `servings: "four"` on another, and set
`description` to `{}` on a third, then import it in Settings: the status reads
`Imported N recipes ✓ — skipped 3 unreadable entries` in danger color, the
Library renders without crashing on `recipe.tags.length`, and the good recipes
are all present. Importing an unedited backup reads `Imported N recipes ✓` in
success color.

### 17. [core] README updates for the changed contracts

File: `README.md`

- The `0x1E` bullet under "Two details that are easy to trip over": describe the
  full framing — text, a separator, any proposal, and a final separator that
  marks a clean end — and that the client treats a missing terminator as a
  cut-off reply.
- Environment variables table: `CHAT_MODEL` — the value must be a real model id
  or the line must be commented out, because `--env-file` reads a bare
  assignment as `''`. `APP_PASSWORD` — "unset **or blank** on the server" makes
  every request 401.
- Commands table: `npm test` now says "Vitest once over `src/`" (the extraction
  test moved out of `api/`).
- "Your data": one sentence that unreferenced photo blobs are swept at startup,
  that chat photos are downscaled on attach, and that they are written to
  IndexedDB only when the message is sent.
- Add `ErrorBoundary.tsx` to the `src/components/` line of the layout tree if it
  reads naturally; otherwise leave the tree alone.

Do not restructure the README, change the install/run instructions, or edit
`AUDIT.md`.

**Verify:** `npm run build`. Re-read each edited claim against the code changed
in steps 1–16; every statement must be checkable in the tree.

## Out of scope

- Re-encoding photo rows that already exist at full size (see Decisions).
- Re-encoding earlier chat photos into the outgoing history (finding 11 keeps
  the behavior).
- SSRF protection beyond the scheme check — no private-IP or DNS-rebinding
  defense.
- Validating `chatMessages`, `photos`, or `cookState` rows in a backup file.
- Repairing recipes already stored with `servings: 0` or missing arrays; the
  fixes are write-path (steps 7, 15) plus render-path containment (steps 12, 13).
- Anything from `docs/plans/ui-polish.md` or `docs/plans/dark-mode-default.md`,
  a Dexie schema version bump, jsdom or a component-test harness, Playwright,
  new dependencies, and editing `AUDIT.md` to mark findings resolved.

## Risks

- **Protocol skew (steps 4 and 7).** Server first is safe: today's client
  destructures the first two `\x1E` parts and ignores the trailing one. The
  reverse order would flag every reply as cut off. On Vercel the client bundle
  and the functions deploy together, but `vite-plugin-pwa`'s `autoUpdate`
  service worker can serve a cached client for one page load — a stale *old*
  client against the new server is the harmless direction.
- **`truncated` is a required field on `ChatReply`.** Adding it in step 7 makes
  `tsc` pass only because the consumer reads it optionally; if step 10 is
  skipped the cut-off case silently degrades to today's behavior rather than
  breaking the build. Do not reorder 7 after 10.
- **Interrupted send (step 9).** `photoStore.add` then `chatStore.append` is
  not one transaction. A thrown `add` or `append` rolls back every id written
  in that attempt and leaves pending photos in memory for retry. A *crash*
  between add and append still orphans the new blobs until the next sweep
  past the age window. Accepted; wrapping them would pull `chatStore` into
  `photoStore`'s tables or the reverse.
- **Over-strict normalization (steps 6, 7).** A drop rule that is too eager
  throws away good proposals. Mitigations: only `title` and `servings ≥ 1`
  drop the proposal; everything else is filtered or defaulted (except
  `photoId` / `sourceUrl`, which are always stripped); the text reply always
  survives. The step-6 tests pin each rule.
- **Data loss from `isUsableRecipe` (step 15).** A backup written by a future
  version whose rows legitimately use a new field type would be skipped
  wholesale if that field fails today's predicate. The count in the status
  message is what makes that visible instead of silent, and the predicate only
  checks fields the current UI already renders without a guard.
- **Two-tap clear with no undo (step 12).** `clearForRecipe` deletes messages
  and their photos irreversibly. The armed label (`Clear all?`, danger-styled)
  is the only guard, matching the Library delete sheet's "There is no undo."
- **Error boundary masking real bugs (step 13).** `componentDidCatch` logs the
  error and component stack to the console so a crash is still diagnosable.
- **`api/import.ts` entering the app TypeScript project (step 5).** Watch the
  first `tsc -b` after the move; the fallback location is specified in
  Decisions.
- **Double JPEG encode for chat photos (step 9).** Storage and chat encode both
  run at `maxDim = 1280`, so the second pass re-compresses rather than
  downscales. Quality cost is one generation of JPEG; the gain is a single
  storage path shared with `RecipeForm`.
- **Steps 15 then 16.** The `importLibrary` return-type change fails `tsc`
  until Settings is updated. Implement them sequentially in the same session.

## Open Questions

None blocking. Everything AUDIT left open — reject-vs-clamp for `servings`,
migration of existing oversized photos, sweep vs store-on-send, moving the test
vs excluding it, and whether finding 11 is intentional — is decided above with
the reasoning recorded.

## Status

- [x] 1. [core] `CHAT_MODEL=''` no longer defeats the default (finding 1)
- [x] 2. [core] A blank server `APP_PASSWORD` 401s (finding 5)
- [x] 3. [core] `/api/import` rejects non-`http(s)` URLs (finding 6)
- [x] 4. [core] `maxDuration` and a stream terminator on `/api/chat` (finding 3)
- [x] 5. [core] Move the import test out of the functions directory (finding 8)
- [x] 6. [core] `src/lib/recipeShape.ts` and its tests (findings 2, 9)
- [x] 7. [core] Terminator-aware parsing and proposal normalization (findings 2, 3)
- [x] 8. [core] Tests for the `0x1E` stream protocol (finding 10)
- [x] 9. [core] Chat photos: downscale in memory, persist on send (findings 4, 7)
- [x] 10. [core] Flag cut-off replies; document the photo-history decision (findings 3, 11)
- [x] 11. [core] `clearForRecipe` also deletes referenced photos (finding 2)
- [x] 12. [ui] ChatPanel: clear-chat control and a guarded proposal card (findings 2, 10)
- [x] 13. [ui] Error boundary around the routes (finding 2)
- [x] 14. [core] Startup sweep for leftover unreferenced photos (finding 7)
- [x] 15. [core] `importLibrary` skips malformed rows and reports the count (finding 9)
- [x] 16. [ui] Settings reports skipped backup rows (finding 9)
- [x] 17. [core] README updates for the changed contracts
