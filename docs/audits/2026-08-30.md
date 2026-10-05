# Audit — cook

2026-08-30. Scope: everything under `api/`, `src/`, `scripts/`, the configs
(`vite.config.ts`, `vercel.json`, `tsconfig.*`, `.github/workflows/ci.yml`,
`.gitignore`, `.env.example`), `index.html`, the README, and the two plan docs
in `docs/plans/`. The working tree includes uncommitted UI-polish changes
(eight modified files plus the new `src/lib/uiClasses.ts` and `docs/plans/`);
the audit covers the tree as it stands, not just HEAD.

What ran: `npm test` — 39 tests in 5 files, all pass. `npm run build` —
`tsc -b` clean, Vite build clean (note: build writes `dist/` and
`*.tsbuildinfo`, both gitignored). CI (`ci.yml`) runs `tsc -b` + `npm test`
on Node 22.18, matching what I ran. Not run: the dev API server or any real
Anthropic call (no API key in this environment), and nothing against the live
Vercel deployment.

## Overall assessment

This is a small, carefully built local-first PWA, and it is in better shape
than most personal projects: the README is accurate against the code (I
verified the schema-duplication claim, the `0x1E` stream protocol, the env-var
table, and the backup merge semantics — all true), the code comments
consistently explain *why* rather than *what*, the store layer discipline the
README demands is actually followed (no screen touches `db` directly), and the
photo-lifecycle handling in `recipeStore`/`RecipeForm`/`ChatPanel` shows real
thought about failure ordering. Tests exist where parsing is fiddly
(quantities, JSON-LD extraction, seeding) and they pass.

The problems cluster in two places. First, **trust in model output**: a recipe
proposed by the `update_recipe` tool is parsed with a type cast and persisted
into chat history with no shape validation, and a malformed one becomes a
message that crashes the chat panel every time it renders, with no error
boundary and no clear-chat UI to recover with. Second, **empty-string env
values**: the documented setup path (`cp .env.example .env.local`) leaves
`CHAT_MODEL=` as an empty string, which defeats the `??` fallback and breaks
both AI endpoints; the same empty-string logic quietly disables auth if
`APP_PASSWORD` is ever set but blank. Both are cheap to fix. Nothing here
argues for structural change — the architecture fits the app.

## High

### 1. The shipped `.env.example` breaks chat and import: `CHAT_MODEL=` resolves to `''`, not the default

[.env.example:11](.env.example) → [api/chat.ts:78](api/chat.ts:78),
[api/import.ts:64](api/import.ts:64) — CONFIRMED

`.env.example` ends with a bare `CHAT_MODEL=`, and the README's setup is
`cp .env.example .env.local` then "add your Anthropic key". Node's
`--env-file` (used by `npm run dev:api`) sets an empty assignment to the empty
string — verified by running
`node --env-file=... -e "console.log(process.env.CHAT_MODEL ?? 'fallback')"`,
which prints `''`. Since `''` is not nullish,
`process.env.CHAT_MODEL ?? 'claude-sonnet-4-5'` resolves to `''`, and every
request calls the Anthropic API with `model: ''`, which is rejected. The user
sees "Assistant request failed" / "Import failed (500)" on a setup that
followed the README exactly — and the README's troubleshooting note points
them at the *other* known cause (dev API server not running), so they will
chase the wrong thing.

Fix (minutes): use `process.env.CHAT_MODEL || 'claude-sonnet-4-5'` in both
handlers (the schema-duplication rule applies here too — change both copies),
and/or comment the line out in `.env.example`
(`# CHAT_MODEL=claude-sonnet-4-5`).

### 2. An `update_recipe` proposal is persisted unvalidated; a malformed one permanently crashes the chat panel

[src/lib/chatApi.ts:70](src/lib/chatApi.ts:70),
[src/components/ChatPanel.tsx:27](src/components/ChatPanel.tsx:27),
[src/components/ChatPanel.tsx:304](src/components/ChatPanel.tsx:304) — PLAUSIBLE

`streamChatReply` parses the JSON after the `0x1E` separator with
`JSON.parse(...) as RecipeDraft` — a cast, not a check — and `ChatPanel.send`
persists it into `chatMessages` as `proposedRecipe`. When the thread renders,
`ProposalCard` calls `recipeLines`, which does
`r.ingredientSections.flatMap(...)` and `r.steps.map(...)`. If a proposal
arrives without those arrays (the Anthropic API constrains tool input to the
schema but does not hard-guarantee `required` fields, and `max_tokens: 4096`
is tight for "the COMPLETE updated recipe" on a long recipe), the render
throws. There is no error boundary anywhere ([src/App.tsx](src/App.tsx),
[src/main.tsx](src/main.tsx)), so the throw white-screens the app — and
because the message is *persisted*, reopening the chat crashes it again,
forever. `chatStore.clearForRecipe`
([src/lib/chatStore.ts:25](src/lib/chatStore.ts:25)) is the escape hatch, but
nothing in the UI calls it; recovery means devtools or deleting the recipe.

Marked PLAUSIBLE because I could not produce a malformed proposal without a
live API key; the crash-on-render path from a malformed persisted proposal is
traced end-to-end and certain.

The same missing validation lets a proposal with `servings: 0` through
`applyDraft`, after which `RecipeView`'s
`scale = servings / recipe.servings`
([src/screens/RecipeView.tsx:67](src/screens/RecipeView.tsx:67)) renders every
quantity as `NaN` — the form path clamps servings to ≥ 1
([src/components/RecipeForm.tsx:142](src/components/RecipeForm.tsx:142)), but
the apply path bypasses the form.

Fix (hours): validate/normalize the parsed proposal before persisting, the way
`importApi` already defaults `tags`/`ingredientSections`/`steps`
([src/lib/importApi.ts:29](src/lib/importApi.ts:29)) — drop the proposal (keep
the text) if `title`/`servings ≥ 1` are unusable. An error boundary around the
routes is a worthwhile second line of defense.

## Medium

### 3. `api/chat.ts` has no `maxDuration`, and a stream killed by the platform is indistinguishable from a clean ending

[api/chat.ts:125](api/chat.ts:125) vs [api/import.ts:70](api/import.ts:70) — PLAUSIBLE

`api/import.ts` exports `maxDuration = 60` with a comment saying extraction
"regularly outlasts Vercel's 10s default" — the project's own measurement of
its deployment. `api/chat.ts` exports nothing, yet a chat turn that triggers
`update_recipe` streams a text reply *and then* the complete recipe JSON,
which is the slowest response the app produces and can plausibly exceed the
same default. When the platform kills the function, the client's read loop
just sees `done` ([src/lib/chatApi.ts:59](src/lib/chatApi.ts:59)): the
truncated text is saved as a normal assistant message and any pending proposal
vanishes — no error, no hint. The protocol has no end-marker, so the client
*cannot* detect truncation.

Fix: export `maxDuration = 60` from `api/chat.ts` (minutes). For robustness,
append a terminator (e.g. a final `0x1E` even when there is no proposal) and
have the client flag replies that end without it (an hour or two).

### 4. Chat photos are stored at original camera size, defeating the app's own storage-encoding design

[src/components/ChatPanel.tsx:237](src/components/ChatPanel.tsx:237) — CONFIRMED

`attachPhoto` does `photoStore.add(file)` — the raw `File`. The recipe-photo
path deliberately downscales first via `encodeImageForStorage`
([src/components/RecipeForm.tsx:322](src/components/RecipeForm.tsx:322)),
whose doc comment says exactly why: "The originals are several megabytes each
and the IndexedDB quota is finite"
([src/lib/image.ts:46](src/lib/image.ts:46)). Chat photos — the ones snapped
mid-cook with the camera — skip this and sit in IndexedDB at full size
forever, and `exportLibrary` re-encodes them as base64 (~1.33×) into the
backup file, so a chatty library produces backups tens of megabytes larger
than they need to be. On iOS, where the README itself worries about storage
eviction, this is the quota pressure that matters. (The bytes *sent to the
model* are fine — `encodeImageForChat` downscales separately at send time.)

Fix (minutes): `photoStore.add(await encodeImageForStorage(file))` in
`attachPhoto`, keeping the downscaled blob for the pending preview and chat
encode. Existing oversized rows would need a one-off migration if you care.

### 5. An empty-string `APP_PASSWORD` on the server silently disables auth

[api/chat.ts:126](api/chat.ts:126), [api/import.ts:107](api/import.ts:107) — CONFIRMED

The README correctly says an *unset* `APP_PASSWORD` makes every request 401
(header `null !== undefined`). But `APP_PASSWORD=''` — set-but-blank, e.g. an
edited `.env.local` or a blank Vercel env entry — passes the check for any
client that never saved a password, because `settings.getPassword()` defaults
to `''` ([src/lib/settings.ts:9](src/lib/settings.ts:9)) and `'' === ''`. The
failure mode is the bad one: everything works in testing, and the deployed
endpoint is an open proxy to your Anthropic key.

Fix (minutes): guard both handlers with
`if (!process.env.APP_PASSWORD || header !== process.env.APP_PASSWORD)` —
falsy server password always 401s. Same two-copies rule as finding 1.

## Low

### 6. `/api/import` fetches any URL the client sends (SSRF)

[api/import.ts:117](api/import.ts:117) — CONFIRMED

The handler passes `body.url` to `fetch` with no scheme or destination check.
It is behind the app password and single-user, so the practical risk is an
attacker who already has the password using the deployment as a request proxy
(internal probing from Vercel's egress, hitting metadata endpoints, laundering
requests). For this threat model it is low — but a scheme check is nearly
free. Fix (minutes): parse with `new URL(...)` and reject anything that is not
`http:`/`https:` — the client already does exactly this for display in
`sourceLink` ([src/screens/RecipeView.tsx:16](src/screens/RecipeView.tsx:16)).

### 7. Pending chat photos leak if the PWA is killed before unmount cleanup runs

[src/components/ChatPanel.tsx:212](src/components/ChatPanel.tsx:212) — PLAUSIBLE

A photo blob is written to the `photos` table on attach, and only the unmount
effect deletes ones still pending. If iOS kills the installed app (which the
README notes it does aggressively) while a photo is attached but unsent, the
blob is orphaned: no message references it, and nothing ever sweeps
unreferenced photos. Combined with finding 4 these orphans are full-size.
Fix (hours): a startup sweep that deletes photo rows referenced by no
`recipe.photoId` and no `chatMessage.photoIds` — or write pending photos only
at send time, mirroring `RecipeForm`'s store-on-submit approach.

### 8. `api/import.test.ts` sits in the directory Vercel deploys as serverless functions

[api/import.test.ts](api/import.test.ts) — PLAUSIBLE

Vercel treats files under `api/` as function entrypoints and has no built-in
test-file exclusion, so the test file is likely built and exposed as a dead
`/api/import.test` endpoint (or, worse, breaks a future build when bundling
`vitest` fails). The live deployment apparently survives it today, and I
cannot verify Vercel's behavior from here — hence PLAUSIBLE. Fix (minutes):
move the test to `src/` (Vitest already scans both, per
[vitest.config.ts](vitest.config.ts)) or exclude it via `vercel.json`.

### 9. `importLibrary` trusts the backup file's shape beyond the two checked fields

[src/lib/backup.ts:65](src/lib/backup.ts:65) — PLAUSIBLE

After checking `app === 'cook'` and `Array.isArray(recipes)`, every row is
`bulkPut` as-is. A corrupted or hand-edited backup can insert a recipe without
`tags`, which crashes the Library on render (`recipe.tags.length` at
[src/screens/Library.tsx:146](src/screens/Library.tsx:146)) — and unlike
finding 2 the user *chose* this file, so it is their own foot. Worth a cheap
per-recipe guard (`title`/`tags`/`ingredientSections`/`steps` present) that
skips or rejects bad rows with a count in the status message. Minutes to an
hour.

### 10. The `0x1E` stream protocol — the riskiest parsing in the client — has no tests

[src/lib/chatApi.ts:56](src/lib/chatApi.ts:56) — CONFIRMED (absence verified)

The five test files cover quantity formatting, JSON-LD extraction, seeding,
settings, and `compactRecipe`, but nothing exercises `streamChatReply`:
separator splitting across chunk boundaries, a truncated proposal, a reply
with no separator, an empty stream. That is exactly where findings 2 and 3
live, and it is testable with a mocked `ReadableStream` and no network.
Hours. (Related hygiene: `chatStore.clearForRecipe` is exported but never
called — either wire it to a "clear chat" control, which finding 2 wants
anyway, or drop it.)

### 11. Earlier photos are silently dropped from the history sent to the model

[src/components/ChatPanel.tsx:295](src/components/ChatPanel.tsx:295) — CONFIRMED

`send` maps history to `{role, content}` — text only; images ride along only
on the newest message. So "does it look better than my last photo?" fails in a
way the UI hides, because the thread *displays* the old photos it is not
sending. This reads like a deliberate token-cost decision, but nothing says
so. Fix: a one-line comment if intentional (minutes), or re-encode the last
N message photos into the outgoing history (hours).

## Not checked

- **The live Vercel deployment.** Function runtime behavior (default
  `maxDuration`, whether `api/import.test.ts` becomes an endpoint, the SPA
  rewrite) is reasoned from config and the project's own comments, not
  observed. Findings 3 and 8 are PLAUSIBLE for exactly this reason.
- **Real Anthropic calls.** No API key here, so `api/chat.ts` /
  `api/import.ts` were never executed end-to-end; `npm run dev:api` was not
  started. Model-behavior claims (schema adherence, truncation) are argued,
  not reproduced.
- **PWA/service-worker behavior** (`vite-plugin-pwa` output, offline caching,
  iOS install flow, wake lock on a real device) — nothing verified beyond the
  build emitting `sw.js` and the manifest.
- **Browser rendering** of the uncommitted UI-polish changes. `tsc` and the
  build pass over them, and they match the intent in
  `docs/plans/ui-polish.md`, but I did not click through the app.
- **`dist/` contents and `package-lock.json`** beyond confirming `dist` is
  gitignored; no dependency vulnerability scan was run (no network audit
  tooling invoked).
