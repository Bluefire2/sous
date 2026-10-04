# AGENTS.md

Guidance for agents working in this repo. The product is **Sous**, and so are
the npm package and the GitHub repo (`Bluefire2/sous`); the backup marker and
local directories are still named `cook`.

## What this is

A personal, allowlisted recipe PWA: readable recipes, a Gemini cooking
assistant per recipe, URL/paste import. Live at https://sous.kyrylo.lol.

There is also `extension/`: an unpacked MV3 Chrome extension (plain JS, no
build step) that imports the page you are reading. It is excluded from the
image and from `tsc`; nothing else depends on it.

It is a **Vite SPA + a hand-written Node server**, not Next.js, not Auth.js.
New HTTP routes go in `server/`, not `api/`. `api/chat.ts` exists because
Vercel still hosts a copy of that handler; it **cannot import siblings**, so
session verification is duplicated inline there. Keep that copy in sync with
`server/session.ts` and `server/allowlist.ts`. `api/import.ts` is a Vercel-only
stub that always returns 401; Cloud Run serves `/api/import` from
`server/importRoute.ts`.

Recipe import (web URL/paste, extension, evals) is one pipeline in
`server/recipeImport.ts`: `importFromHtml` / `importFromSource` /
`importFromImages` take the Gemini client and model as arguments and return an
`ImportOutcome`; routes map outcomes to HTTP. `normalizeImportedRecipe` is the
only cleanup of model output for import. Page and paste imports are checked by
`server/importChecks.ts` (pure, no I/O) against the page (`server/pageScan.ts`,
one parse5 pass shared with `extractRecipeSource`); `ok` carries typed
`warnings` (codes only; the words are in the catalogs), and a thrown Gemini
call is `model_error` (502 `import-model-failed`), not a 500. Retries are the
code constant `MAX_IMPORT_RETRIES` (0 until phase 3 of
`docs/plans/import-reliability.md`), never an env var. Photo import runs no
checks and makes exactly one call.

Both import routes write one `event: 'import'` JSON log line per request
(`server/importLog.ts`, `withImportLog`): the session `sub`, how the import
arrived, the URL as `origin + pathname`, for page and paste imports `source`
(`jsonld` | `text`) and `attempts` (each call's result), warning `codes`, the
outcome, counts, a thrown error's numeric `status`, and timing. Never the
email, recipe or pasted text, HTML, photo bytes, a query string, or an error
message. A Gemini throw on a page or paste import is a logged `model_error`,
not a throw. Any other throw from either
route is rethrown as `sanitizedImportError` (class name and status only),
because the dispatcher in `scripts/server.ts` `console.error`s whatever
escapes and an SDK message can quote the request; never let the original
error escape an import route. `/privacy` (Server logs) and `/terms` describe
that line and its 30-day retention (the `_Default` log bucket); change them
with it. Photo import's share of the line is bound by
`docs/constitutions/image-import.md` principle 3.

Import feedback (`docs/plans/import-feedback.md`): after a failed or flagged
import, or a 👎 on a clean preview, the person can send a report
(`POST /api/import-feedback`, `server/importFeedback.ts`, `withMembership`). Reports
live in top-level Firestore `importFeedback/{id}` (client-generated UUID
written with `create()`; ALREADY_EXISTS, gRPC code 6, is success), never under
`users/{uid}`, never synced or backed up. A report may hold the full link,
pasted text, and the extracted recipe as capped JSON, but never photos, the
notes typed with photos, or an email. `expireAt` drives a 180-day Firestore
TTL policy (owner step in the plan). A 👍 stores nothing and only writes the
`import_feedback` log line (`sub`, trigger, via, host, warning codes,
`hasComment`, status; never a path, text, or comment). The handler never lets
an error escape: a store failure is 503, anything else is rethrown as
`sanitizedImportError`. `/privacy` and `/terms` describe reports and that
line; change them with it. `scripts/import-feedback.ts` reads reports,
read-only. Storage location and the full field-by-field schema are in
`docs/plans/import-feedback.md` (Where reports are stored, Report schema);
change that section with `ImportFeedbackDoc`.

Feature requests (`docs/plans/feature-requests.md`): a member sends a
suggestion from `/suggest` (`POST /api/feature-request`,
`server/featureRequest.ts`, `withMembership`), opened from a muted line under
the library list or the Feedback section in Settings; there is no header
control. Suggestions live in top-level Firestore `featureRequests/{id}`
(client UUID, `create()`, gRPC 6 is success), never under `users/{uid}`,
never synced or backed up, with a one-year TTL on `expireAt`. A suggestion
holds the text, `contactOk`, and three context fields, never the email; the
read-only `scripts/feature-requests.ts` looks the email up from `sub` only
when `contactOk` is true. The `feature_request` log line never holds the
text. `/privacy` describes both; change it with them, and change the schema
section in the plan with `FeatureRequestDoc`. Suggestions and import reports
sit outside `users/{uid}`; `scripts/delete-account-data.ts` removes them with
the rest of an account (see Account deletion).

**Account deletion.** A deletion request is the manual procedure in
README.md: deny access, then `scripts/delete-account-data.ts <sub>` (dry run,
then `--apply`), then the GCS photo prefix. `server/accountDeletion.ts`
classifies every Firestore collection in `FIRESTORE_COLLECTIONS` and has one
step per top-level collection that holds a member's data, run in
`ACCOUNT_DELETION_ORDER`. A new collection must be classified there (and get
a step if it is personal and top-level); `scripts/invariants.test.ts` fails on
an unclassified `.collection(...)` name, and TypeScript on a missing step.
`/privacy` promises what a deletion request covers; change it with the steps.

No server log line may contain an email address or a link token. Invite
(`/invite/<token>`), collection-link (`/c/<token>`), and public-collection
(`/p/<token>`, `/api/public/<token>`) pages send
`Referrer-Policy: no-referrer` so the token never rides a `Referer`, and the
`link-token-requests` exclusion on the `_Default` sink
(`scripts/logExclusions.ts`, applied with `node
scripts/apply-log-exclusions.ts --apply`, dry run without) keeps Cloud Run's
request lines for those URLs out of Cloud Logging. `/privacy` promises both;
a new token-in-path route must be added to that filter. To see one account's imports, filter Logs
Explorer on `jsonPayload.event="import"` and `jsonPayload.sub`;
`scripts/import-audit.ts <email>` prints the `sub` and the account's imported
recipes, read-only.

## How to run it

Node **≥ 22.18** (native TypeScript stripping). Both processes:

```
npm run dev       # Vite, http://localhost:5173
npm run dev:api   # node --env-file=.env.local scripts/dev-api-server.ts, port 3001
```

Vite proxies `/api` to 3001. **Vite alone looks fine and then chat/import/sync
fail.** After any change under `server/` or `scripts/server.ts`, restart
`dev:api` — it does not watch those files.

To run several checkouts side by side, choose the ports on the command line;
nothing is edited, and with no arguments they stay 5173 and 3001:

```
npm run dev:api -- --port 3101               # or npm run dev:test -- --port 3101
npm run dev -- --port 5273 --api-port 3101   # --api-port is where Vite proxies
```

`SOUS_API_PORT` and `SOUS_WEB_PORT` work as fallbacks when the flag is absent
(`scripts/devPorts.ts`). `npm run dev` is the thin wrapper `scripts/dev-web.ts`
around Vite, because Vite's CLI rejects `--api-port`; other flags pass through.

Google sign-in only works on 5173: the registered redirect URI is
`http://localhost:5173/api/auth/callback/google`. On another web port, use
test mode's `/__test/` sign-in instead.

`.env.local` is gitignored and required for `dev:api`. Never print its values.
Never add a `VITE_` prefix to a secret; Vite would inline it into the client.

On this machine Vite has bound **IPv6 `[::1]` only**; `http://127.0.0.1:5173`
may fail. Use `http://localhost:5173`.

```
npm test          # Vitest over src/ and server/
npm run test:import  # live Gemini paste-to-recipe evals; needs GEMINI_API_KEY
npm run build     # tsc -b && vite build — the only type gate on server/
```

`erasableSyntaxOnly` is on for Node/API tsconfigs: **no enums, no constructor
parameter properties**. Dev servers run TS unchecked; a `server/` type error
can sit until `npm run build` or a container start.

### Test mode

To run the app signed in without Google and without production Firestore, use
test mode. How to run it, the personas, and scripting it are in
`testing/README.md`; the design is `docs/plans/test-mode.md`. Start the
Firestore emulator, then the test server in place of `dev:api`:

```
gcloud emulators firestore start --host-port=127.0.0.1:8085   # needs Java
npm run dev:test                                               # port 3001; Vite unchanged
```

`dev:test` looks for the emulator at `127.0.0.1:8085`. To use another port,
set `FIRESTORE_EMULATOR_HOST` to a loopback `host:port`; any other host is
refused.

Open `http://localhost:5173/__test/` and pick a persona (`owner`, `member`,
`empty`, `viewer`, `outsider`, `declined`). Each start clears the emulator and
reseeds it; `npm run dev:test -- --keep` keeps the data. `--static --port 4173`
serves `dist/` as well, for CI and browser automation without Vite;
`GET /__test/personas` answers 503 until the seed is done and then lists the
personas, fixture ids, and, after a fresh seed, the member's MCP tokens.
Google sign-in, photos, and email are off in test
mode; model routes work when `GEMINI_API_KEY` is set.

`/__test/sign-in` is not an auth bypass: it signs an ordinary session for a
fake account with a test-only secret, and every route still runs
`requireMember`. Test mode lives only in `testing/`, which the image never
contains. No non-test file under `server/`, `api/`, `scripts/`, `src/`, or
`evals/` may import from `testing/`, none under the first four may mention
`__test`, and every env var the server reads must be classified in
`testing/env.ts`; `scripts/invariants.test.ts` checks all three. The allowed
`__test` traces outside those directories are the dev proxy and the PWA
`navigateFallbackDenylist` entry in `vite.config.ts` (the denylist ships in
the production service worker and is inert there), the image check in
`.github/scripts/smoke-server.sh`, and the CI job comment. Never add a flag
or env var that turns test mode on in the real server.

Test mode is the default for end-to-end checks; Tests and verification says
when a real sign-in is needed instead.

## Architecture

```
UI (screens, components)
 → stores (recipeStore / collectionStore / chatStore / photoStore / useCookState)
 → in-memory library + syncEngine/remote (the only modules that fetch)
```

`syncEngine` and `remote` are the only client modules allowed to `fetch` for
library data. Screens must not `fetch`. Do not add fields to `Recipe`,
`ChatMessage`, or `CookStateRow` — `compactRecipe` strips unknown keys, and
`src/lib/recipeStore.test.ts` asserts the exact key set. That test is a
schema lock; do not "fix" it by expanding the allow-list. Sharing avoided a
`Recipe` field (`docs/plans/shared-recipes.md`, D3); optional `Recipe.lang`
is the first deliberate exception since `galleryPhotoIds`
(`docs/constitutions/i18n.md`), and code must work when `lang` is missing.
Optional `Recipe.importCheck` (typed import warnings, `server/importWarnings.ts`)
is the second (`docs/plans/import-reliability.md`); code must work when it is
missing, and both `compactRecipe` and `compactRecipeFields` drop a malformed
one rather than reject the recipe. `recipeStore.save` carries it from the
stored recipe and reconciles it with the edit; only `replaceFromImport`
replaces it.
Collections are a separate store kind. Grants live under
`collections/{id}/grants/{viewerSub}` plus a reverse
`incomingShares/{viewerSub}` index; they are REST, not LWW push. Shared
rows stay in the owner's tree and carry origin metadata beside `Recipe`.

The recipe library is **not** stored in IndexedDB. On boot, `discardLegacyCookDb`
deletes the old Dexie database named `cook` if it is still present. Backups
still use `app: 'cook'` and `cook-backup-` filenames.

## Auth

Google identity only. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.
No refresh tokens, no extra Google APIs, no Auth.js.

- Cookie `sous_session`: `base64url(JSON).HMAC`, payload `{v,sub,email,iat,exp}`.
  HttpOnly, SameSite=Lax, Path=/, Secure on https, 90 days.
  `readSession` is cryptographic only. Protected routes call **`requireMember`**
  (or **`requireOwner`** for `/api/admin/*`).
- **Two-tier admission:** `ALLOWED_EMAILS` is the fail-closed **owner/admin**
  set (blank = nobody), re-parsed from env on **every** protected request with
  **no cache**. Firestore **`members/{sub}`** with `status: 'active'` is the
  member tier, keyed by Google **`sub`**. Owners short-circuit before any
  member read. Approve ordinary people from **`/admin`**, not by editing
  `ALLOWED_EMAILS` (every address there is an admin). Owners mint single-use
  7-day bearer invite URLs on `/admin` and can revoke any unused one. An
  admitted member who is not an owner can mint one such link from Settings
  (`POST /api/invites`) and can admit up to 5 people that way; creating
  another replaces their previous unused link, and they do not see `/admin`.
  A signed-in person can also mint from the library header: an owner uses
  the admin mint (`POST /api/admin/invites`), and a member confirms in a
  sheet before minting (`POST /api/invites`).
  Removing a member revokes their unused links, and redeem refuses a link
  whose minter is no longer admitted. The invite landing page runs that
  same check before the join page; redeem still decides inside its
  transaction. The first verified Google account that
  finishes consent from a link is written as an active member and listed
  under Approved. `approvedBy` is the minter's `sub`.
- **401 = denied** (client may invalidate the session). **503 = unknown**
  (Firestore blip — do not sign the user out). Membership **denied** must never
  map to 503; membership **unknown** must never map to 401.
- **Revocation bound:** only **active** members are cached, for **60 seconds**
  per container instance. Removing someone from `members/{sub}` takes effect
  within that bound; removing an owner from `ALLOWED_EMAILS` takes effect on
  the very next request.
- **`api/chat.ts`:** on Cloud Run, `withMembership` passes an
  in-process **`authorizedSub`** argument after `requireMember` passed. The
  inline **`sessionSub`** copy remains the **Vercel** gate and must stay in sync
  with `server/session.ts` + `server/allowlist.ts`.
- **One exception to cookie-only auth:** `POST /api/extension/import` reads the
  same token from an `X-Sous-Session` header and **never** from the cookie
  (`readHeaderSession`, no fallback), then applies the same membership decision
  as `requireMember` (`requireHeaderMember`). The Chrome extension reads the
  cookie with `chrome.cookies.get` and forwards it, because a `SameSite=Lax`
  cookie is not dependably attached to an extension-initiated request. Do not
  extend header auth to any other route, and do not add
  `Access-Control-Allow-Credentials` to this one.
- **MCP bearer tokens are a separate family**, not the session token: `/mcp`
  reads only `Authorization: Bearer sous_at_…` and `/oauth/token` only its
  form body; neither reads a cookie, and no cookie route reads a bearer. See
  Public MCP.
- **Other cookies**, all HttpOnly, SameSite=Lax, HMAC-signed with
  `SESSION_SECRET`, 10 minutes, each its own `v` family so one never verifies
  as another: `sous_oauth` (oauth transaction), `sous_invite` (app invite
  hop), `sous_collection_link` (collection link hop, `v: 'clink'`,
  **`Path=/c`**, carries the link's sha256 id, never the token),
  `sous_mcp_authz` (MCP authorization request hop, `v: 'mcpauthz'`,
  **`Path=/oauth`**). A new flow gets a new cookie name and family; do not
  reuse one.
- OAuth callback **must not** use `Response.redirect()` (immutable Headers;
  `Set-Cookie` would be dropped). Build a `Response` with a `Location` header
  and always clear `sous_oauth`.
- Sign-in control is `<a href={signInHref(...)}>`, never `fetch` from a button.
- Do not rotate `SESSION_SECRET` casually; it signs every device out.

Local redirect URI is `http://localhost:5173/api/auth/callback/google` (Vite,
not 3001). Production: `https://sous.kyrylo.lol/api/auth/callback/google`.

## Sync

Server is source of truth (Firestore `users/{uid}/…`). The client holds the
library **in memory** after a pull. LWW on `updatedAt`; **tombstones**, never
hard-deletes (a missing doc is invisible to another device's cursor). `uid`
comes only from the session — ignore `uid`/`sub` in bodies.

Pull runs on sign-in, `online`, tab-visible (≥30s debounce), and Refresh in
Settings. Writes go through `POST /api/sync/push` immediately. **No polling
timer. No outbox. No AccountGate.**

`photoStore.add(blob)` keeps the bytes in memory until the parent recipe/chat
write POSTs `/api/photos/:id`. `usePhotoUrl` fetches the blob for the session
(not IndexedDB).

Toasts (`SyncToast`): refresh errors show "Couldn't refresh". No-op app-open
pulls stay silent. `sync()` returns a Promise so Settings can await Refresh.
Clear `inFlight` in `.then`/`.catch` on that Promise, not with `finally`
inside the IIFE — that wedges sync after a signed-out run.

## Sharing

Named collections can be shared with existing admitted members as viewer or
editor; the default collection remains private. Shared refresh is a **full positional
reread** of live incoming grants and current collection contents, not an
`updatedAt` delta. The continuation cursor is HMAC-signed with a domain
separate from the session cookie. If grants or collection membership change
between pages, the server returns `409 shared-snapshot-changed` and the
client discards that attempt and rereads from the start, up to three times,
then publishes owned-only state and the existing refresh error. A successful
refresh publishes owned and shared rows atomically, so an open shared recipe
never disappears mid-refresh; the cost is that the viewer's own updates wait
for the shared pull (about 0.7 s for 900 shared recipes over 6 shares on the
emulator). Keep that trade unless shared pulls get much slower. After owned pull
completes, a non-auth shared failure publishes the completed owned-only
snapshot and returns the existing error outcome; a shared 401/403 still
clears the session and library.

Each grant has `role: 'viewer' | 'editor'`, copied onto its
`incomingShares` row; a missing or unknown role reads as viewer (no
backfill). The owner changes it with `POST /api/collections/:id/grants/role`
`{ sub, role }` (404 for anyone else, 400 for a bad role); the 20-grant cap
counts both roles. Add by email to someone already granted applies the
chosen role (`orchestrateGrantAdd` `onExisting: 'applyRole'`); a grant path
that must not change an existing role passes `'keepRole'`. An editor saves with `recipe.put` plus op-level
`shared: true`. The server resolves owner and role from the session's shares
inside the writing transaction (share → collection → listed live recipe,
stronger role wins), writes the owner's row with the owner's `id`,
`createdAt`, and photo ids, clamps `updatedAt` to server time before the LWW
compare (and stores the clamped value), and rejects (`invalid`) a viewer, an unadmitted
owner, or any photo-id change. The flag only narrows: without it a put is an
ordinary own-tree write. Only the owner deletes; `recipe.delete` from a
session with no own row that reaches the id through a share is `invalid`.
Client role is in-memory `access` on the shared origin, never a `Recipe`
field. Editors get Edit and Ask Apply (photos always kept), no photo, delete,
move, or cook-log controls.

**Collection links** (`server/collectionLinks.ts`, `collectionLinksHttp.ts`)
attach an already admitted member to one collection; they never create a
member (that is `/invite`). The owner mints, lists, and revokes under
`/api/collections/:id/links` (`GET`, `POST { role? }`, `POST …/revoke
{ id }`), cookie session, collection owner only, 404 for anyone else. Firestore
`collectionLinks/{sha256(token)}` holds owner, collection, role, and expiry;
the raw token is only in the mint response. Multi-use until revoked or 7 days,
at most 20 live per collection. `/c/<token>` is server HTML (Vite proxies
`^/c/`, PWA denylist): it swaps the token for the `sous_collection_link` hop
cookie and 303s to `/c/join`, so the token never reaches a rendered page,
Referer, or the OAuth round trip. `GET /c/join` only renders: signed out ⇒ sign
in with `returnTo=/c/join`; signed-in non-member ⇒ the invitation-only 403;
member ⇒ a confirm form. Only the same-origin `POST /c/join` redeems
(`Origin` must be exactly ours, never `null`, so `/c/join` pages send
`Referrer-Policy: same-origin`, not `no-referrer`; the posted id must match
the hop cookie), through `orchestrateGrantAdd`,
the same code path as add-by-email but with `onExisting: 'keepRole'`:
unlike add-by-email, already granted keeps its role (a link never upgrades
or downgrades anyone; the owner's row switch does), the
20-grant cap shows a "full" page and leaves the link valid, the owner's own
link writes nothing. Unknown, revoked, expired, deleted collection, and
unadmitted owner are one generic 404 page. The OAuth callback is unchanged.

**Public collections** (`docs/plans/public-collections.md`,
`server/publicLinks.ts`, `publicLinksHttp.ts`, `publicJoin.ts`) are the one
place data is served without a session. The owner turns a named collection's
unlisted link on or off under `/api/collections/:id/public` (owner only, 404
for anyone else); top-level `publicLinks/{sha256(token)}` keeps the token so
the owner can copy it again. `GET /api/public/<token>` and
`…/recipes/<id>/photos/<id>` recheck live link → admitted owner → live
collection → listed live recipe (→ listed photo) on every request, cache
nothing, and answer one generic 404. They return recipe fields only, never an
email, `sub`, chat, cook row, or cook log, and never reach a model. The client
side is separate screens (`/p/:token`, `/p/:token/r/:recipeId`, `/p`) that
keep the snapshot in component state, never `libraryMemory`; AI controls
there are locked (`src/components/LockedAi.tsx`), and
`scripts/invariants.test.ts` keeps AI and library-writing imports out of
them. Sign-in from `/p` returns to `/p` with the token in sessionStorage, so
it never rides the OAuth round trip. A signed-in member can `POST
/api/public/join { token }` to become a viewer through the collection-link
redeem path (`keepRole`, same cap); AI then runs through that grant. A new
feature on a recipe page decides separately whether it belongs on
`PublicRecipe`; shared display pieces live in `src/components/RecipeBody.tsx`.
Collection delete revokes the public link in the grant-cascade transaction.

Collection delete tombstones live grants in the same transaction. Forward
grants carry an internal `active` flag, and the cascade time is
`grantCascadeAt`, not the client `updatedAt`. Grants written before `active`
are not backfilled; re-share them. Undelete does not restore old viewers.

Viewer chat and cook rows store `sharedParentOwnerSub` beside the document.
The client keeps that in `chatParentOrigins` and `cookParentOrigins`, not on
`ChatMessage` or `CookStateRow`. Backup export treats either the live recipe
origin or that sidecar as shared.

A chat/cook write on a shared parent uses that stored marker (the row's own,
or for a new chat message the viewer's cook row for the recipe) only as a
lookup hint: it narrows the in-transaction incoming-share query to one owner,
and the full share → collection → listed recipe → live recipe chain is still
checked. A stale or missing hint falls back to the full scan. Never take the
hint from the request body.

Grants are inert while their owner is not admitted (not in `ALLOWED_EMAILS`
and no active `members/{sub}`). Shared pull skips them, and that omission is
part of the authorization-scope digest, so a removal between pages restarts
the shared refresh. Shared photo reads 404. Unknown owner membership is 503.
Grant documents are kept, so re-admitting the owner restores their shares.
A shared page reads its recipes in one batch and their photos in one batch.
Backup clone ids are derived from the importing `sub`, the entity namespace,
and the original id, so re-importing a file overwrites the earlier clone.

Profile upsert writes display `email` plus normalized `emailLower`. Add-by-email
queries `emailLower` first and falls back only to exact normalized `email` for
legacy profiles that already stored lowercase email. Profiles written before
`emailLower` existed are repaired once with
`scripts/backfill-email-lower.ts` (dry run, then `--apply`); do not widen the
lookup into a case-insensitive scan instead. The success-vs-generic
failure account-existence signal is a conscious invitation-only product
choice; do not make failure responses more revealing.

For a shared photo, metadata only indexes its parent recipe. Authorization
still freshly reads the incoming share and live collection, then requires
`canViewRecipe` and `recipeListsPhoto`; metadata alone never authorizes. Ask
text works on shared recipes, but Ask photo attachments are intentionally
unavailable.

A grantee — viewer or editor, same endpoint, there is no separate "viewer
leave" — can leave a shared collection with `POST /api/shared/leave`
(`{ ownerSub, collectionId }`, grantee is the session sub only); it
tombstones the same forward-grant + `incomingShares` pair as owner revoke,
reusing that code path (so the tombstone omits `role` the same way a revoke
does). A second leave, or a leave after the owner already revoked, 404s;
the client treats that 404 as success. Viewer-owned shared-parent chat can
remain orphaned server-side after revoke or leave; do not invent cleanup as
part of sharing.

## Cloud and deploy

| | |
| --- | --- |
| GCP project | `cooking-assistant-508423` (number `62867274312`) |
| Region / Firestore | `europe-west1`, Native `(default)` — no `FIRESTORE_DATABASE_ID` |
| Cloud Run | `sous`, port 8080 |
| Photo bucket (planned) | `gs://sous-photos-cooking-assistant-508423` |
| Runtime SA | confirm `serviceAccountName`; empty ⇒ `62867274312-compute@developer.gserviceaccount.com` |
| `gcloud` | `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd` — **not on PATH** |
| Default gcloud project on this machine | `match-cal-507107` — always pass `--project=cooking-assistant-508423` |

Local ADC: `gcloud auth application-default login` and
`set-quota-project cooking-assistant-508423`. Dev talks to **real** Firestore
(and, once set, the real bucket). Opt-outs: `FIRESTORE_EMULATOR_HOST`, unset
`PHOTO_BUCKET`. Same Google account ⇒ same `sub` ⇒ local experiments mutate
the production library. Test mode (How to run it) avoids that: fake
personas against a seeded emulator.

`scripts/deploy.sh` uses `--env-vars-file` (replaces the **whole** env map).
Never `--set-env-vars` (`ALLOWED_EMAILS` is comma-separated). Never put a
secret on a `gcloud` command line. `SESSION_SECRET` may be generated only if
`services describe` **succeeded** and the var was absent; a failed describe
must die, not mint a new secret. Production env also includes **`MAIL_FROM`**,
**`OWNER_NOTIFY_EMAIL`**, and optional **`RESEND_API_KEY`** (omit with
`SOUS_DISABLE_RESEND=1` to remove an existing key from the service).

This deploys **straight to production**. There is no staging. Record the
current revision before `bash scripts/deploy.sh`. `.github/workflows/deploy.yml`
is **`workflow_dispatch` only** (never on push). It authenticates with Workload
Identity Federation as
`sous-github-deploy@cooking-assistant-508423.iam.gserviceaccount.com`, prints
the live revision, builds the image with Docker on the runner, pushes it to
Artifact Registry, then runs `SKIP_BUILD=1 bash scripts/deploy.sh`. Do not
call `gcloud builds submit` from Actions — the default
`gs://PROJECT_cloudbuild` bucket rejects the WIF identity. One-time pool /
SA / IAM setup is in `docs/github-actions-deploy.md`. Do not add a `push`
trigger.

Docker is not installed locally; local `bash scripts/deploy.sh` still uses
Cloud Build.

As of 2026-09-27, production was `sous-00013-ccs`, deployed from `main` at
`cdf6d07` (includes #35, #36 cook log, and #37). Commits after `cdf6d07` were
not in that deploy. This file does not record later revisions.

The `emailLower` backfill (`node --env-file=.env.local
scripts/backfill-email-lower.ts`, ADC for `cooking-assistant-508423`, dry run
before `--apply`, idempotent) ran 2026-09-27: dry run found 0 pending of 4
profiles, so nothing was applied. Still to run: delete a real recipe that is
listed in a collection and confirm the `array-contains` query on `recipeIds`
succeeds. Native Firestore creates that single-field array index
automatically; the check is for an index exemption or misconfiguration, and
it exercises the real delete path.

## Do not touch

- `app: 'cook'` backups, `cook-backup-` filenames
- `vercel.json`, Vercel env, or `https://cook-seven-mu.vercel.app` (chat/import
  401 there is intended)
- Dockerfile Node pin, multi-stage shape, or `CMD` (only `COPY server` was
  the Phase 2 image change)
- Region, domain mapping, certificate
- `0x1E` chat framing / Gemini request shape / `maxDuration = 60`
- Adding Google scopes, refresh tokens, or Auth.js
- Polling sync, Firestore listeners, WebSockets
- Conflict-merge UI (LWW is the product)

## Public MCP

A remote MCP server lets a member's AI app (claude.ai, Claude Code, any MCP
client) read and edit their own recipes (`docs/plans/mcp-server.md`). The code
is `server/mcp/`; `scripts/server.ts` imports only `server/mcp/index.ts`.

- **Routes.** `POST /mcp` (Streamable HTTP, stateless, JSON responses; `GET`
  and `DELETE` are 405), `GET /.well-known/oauth-protected-resource[/mcp]`,
  `GET /.well-known/oauth-authorization-server`, `GET /oauth/authorize`,
  `GET|POST /oauth/consent`, `POST /oauth/token`, `POST /oauth/revoke`, and
  for Settings `GET /api/mcp/grants` and `POST /api/mcp/grants/revoke`
  (cookie session). The dispatcher matches the non-`/api/` ones
  (`matchMcpRoute`) before the static and SPA fallback, also with
  `staticRoot: null`. Vite proxies `^/mcp$`, `^/oauth/` and
  `^/\.well-known/oauth-` to 3001, and the PWA denylist covers them.
- **Its own OAuth 2.1 server.** Clients identify with Client ID Metadata
  Documents (CIMD); there is no dynamic client registration and no client
  database. The authorization server metadata must keep
  `client_id_metadata_document_supported: true` and `"none"` in
  `token_endpoint_auth_methods_supported`, or Claude falls back to DCR, which
  Sous does not offer. PKCE S256 only. The consent step is server HTML
  (English, i18n principle 9) following the `/c/join` pattern: the
  `sous_mcp_authz` hop cookie, a nonce, `sameOriginPost`, `Referrer-Policy:
  same-origin`, `frame-ancestors 'none'`. Sous fetches a client's metadata
  document only once a member session exists, through the SSRF-safe pinned
  fetch in `oauth/clientMetadata.ts`.
- **Tokens.** Opaque `sous_at_` (1 h) and `sous_rt_` (30 days, rotated on
  every use) tokens, stored only as sha256 hashes; they are not HMAC-signed
  and do not depend on `SESSION_SECRET`. `/mcp` reads the bearer from
  `Authorization` only and `/oauth/token` reads only its form body; neither
  reads a cookie. The `X-Sous-Session` header exception stays
  extension-only. Every `/mcp` call re-reads the token and its grant (no
  cache, so a revoke works on the next call), then runs `memberFromIdentity`
  on the grant's `{ sub, email }`: denied is 401 with `WWW-Authenticate:
  Bearer … resource_metadata=…`, unknown is 503, never 401. A write tool on a
  read-only grant is 403 `insufficient_scope` (step-up). The gate runs before
  the MCP SDK, so a refusal is never a 200 tool error.
- **Tools.** `search_recipes`, `get_recipes`, `list_collections`
  (`recipes:read`), `create_recipe`, `update_recipe`, `move_recipes`
  (`recipes:write`), own tree only, via the agent's `loadAgentLibrary`. No
  delete, no collection create, rename or delete, no photos, sharing, cook
  log, chat, translation, or import. `create_recipe` takes an optional
  `collectionId`; it and `move_recipes` file recipes with the app's
  membership rule in one transaction (`server/mcp/collectionMove.ts`,
  `docs/plans/mcp-collection-writes.md`) and refuse a collection with a live
  public link (`not_allowed`); member-shared collections are allowed. Results
  say who can see the destination and every collection the recipes left
  (`sharedWithMembers`, `joinLinkOpen`, `public`), and `list_collections`
  shows the same per collection, so the model can tell the user who gained
  or lost recipes.
  `update_recipe` needs the stored `updatedAt` as `version` (else
  `conflict`), patches fields, and writes through `updateOwnRecipe`; the
  server stamps every time (`nextRecipeUpdatedAt`). Input is validated
  strictly (`server/mcp/recipeInput.ts`), never repaired.
- **SDK.** `@modelcontextprotocol/sdk`, low-level `Server` plus
  `WebStandardStreamableHTTPServerTransport`, built per request. Its
  transitive dependencies (express, hono, …) ship in the image unused.
- **Logs.** One `event: 'mcp'` line per `/mcp` request and one `event:
  'mcp_oauth'` line per authorize, consent, token or revoke step
  (`server/mcp/log.ts`). Never arguments, recipe text, tokens, codes,
  `state`, the email, or a full `redirect_uri`. `/privacy` and `/terms`
  describe them, and connected apps; change them with it.
- **Storage.** Top-level `mcpAuthCodes/{sha256(code)}` and
  `mcpTokens/{sha256(token)}`, each with `expireAt` for a TTL policy (owner
  step, after deploy), and `users/{sub}/mcpGrants/{grantId}`. Because codes
  and tokens sit outside `users/{uid}`, the account deletion script has a
  step for each (see Account deletion); a new MCP collection needs one too.
- **Rate limits.** Per instance, per `sub` and grant: 300 reads and 60 writes
  an hour (`admitTranslateCall`'s window, own buckets); uncached client
  metadata fetches at 10 a minute per member and 60 per instance; store
  lookups by `/oauth/token` and `/oauth/revoke` at 120 a minute per instance
  (503 with `Retry-After`).

## Agent module

The library assistant (`POST /api/agent`, screen `/assistant`) is a module.
Public entry points are `agentPost` from `server/agent/index.ts` and
`AssistantScreen` / `AssistantEntryLink` from `src/agent/index.ts`.
`server/agent/index.ts` also exports the agent's read surface over a member's
own library, which the MCP tools reuse: `loadAgentLibrary`,
`narrowAgentRecipe`, `winningMembership`, `searchRecipesPage` (the agent's
`searchRecipes` is its first page), and the `AgentLibrary`, `AgentRecipe`,
`AgentCollection`, `SearchRecipesArgs` and `SearchRecipeHit` types. Nothing
outside those directories imports agent internals. Wiring outside the module
is one route line in `scripts/server.ts`, one route in `src/App.tsx`,
`<AssistantEntryLink />` in `src/screens/Library.tsx`, `listLiveDocs` in
`server/store.ts`, and `onSessionReset` in `src/lib/session.ts`. The harness
under `server/agent/harness/` knows nothing about recipes; only
`server/agent/harness/google.ts` imports `@google/genai`. Domain tools live in
`server/agent/sous/`. See `docs/plans/library-agent.md`.

## Feature constitutions

A constitution records a feature's principles and why each exists. The index
below lists every constitution by name and description only. Before planning
or editing, check your change against these descriptions. If one plausibly
applies, read that constitution in full before you write code; when unsure,
read it. Its frontmatter `scope` lists the exact files and concepts it covers.
You may break a principle only by amending the constitution in the same PR:
rewrite the principle, add an amendment-log entry saying why the break is
worth it, and flag it in the PR description. An unacknowledged break is a
defect. Plans, audits, and verifications name the constitutions they applied.

A new constitution goes in `docs/constitutions/<slug>.md` with `name`,
`description`, `status` (`draft` or `ratified`), and `scope` frontmatter,
plus a matching index line here. `scripts/constitutions.test.ts` checks that
this index matches each file's frontmatter.

- **Client state** (`docs/constitutions/client-state.md`): How React reads client state: the one library snapshot and its copy-only-what-changes writes, useSyncExternalStore with stable getters and narrow selectors, subscriptions for everything a render reads, and reducer-driven screen dialogs. Read before changing a libraryMemory write, any store hook, a module-level store that React reads, a store read inside a component's render, or Library's dialogs.
- **Cook log** (`docs/constitutions/cook-log.md`): Dated records of cooking a recipe (rating, servings, notes, lessons, photos), the /cooks journal, and promoting a lesson into recipe notes. Read before changing CookLog data, its sync ops or cascade, its photos, its backup handling, or those screens.
- **i18n** (`docs/constitutions/i18n.md`): UI language (the src/i18n catalogs, t(), plurals, cook.locale), the Recipe.lang label and normalizeLang, recipe translation at import and on the recipe screen, dictation language, and the in-context translation review. Read before adding or changing any user-facing text, touching Recipe.lang or a language tag, sending recipe text to a translation provider, or changing the language passed to /api/stt.
- **Image import** (`docs/constitutions/image-import.md`): Importing one recipe from 1–4 photos of notes. Gemini reads the photos and they are not stored. Read before changing importFromImages, the images field, the photo picker, handwritten evals, or the photo sentences in privacy and terms.

## Plans (source of truth for unfinished work)

Non-trivial features go through `docs/plans/<slug>.md` with steps tagged
`[core]` or `[ui]`. Do not implement 18–22 off memory; read the slice plan.

| Plan | Status |
| --- | --- |
| `docs/plans/sous-oauth-db.md` | Parent. Identity + sync (1–17) done. |
| `docs/plans/sync-toast.md` | Done (`b4b43b6`). |
| `docs/plans/photos-and-deploy-docs.md` | Done (GCS photos, deploy.sh, README, legal rewrite). |
| `docs/plans/invitation-flow.md` | Done (#8). Request access → `/admin` → Firestore membership. |
| `docs/plans/invite-links.md` | Done (#12). Single-use 7-day bearer invite links that admit on Google consent. Owners mint from `/admin`. |
| `docs/plans/member-invite-links.md` | Merged (#48; library-header copy in #49). A non-owner member mints one link from Settings (`POST /api/invites`). Not deployed. |
| `docs/plans/server-backed-library.md` | Done: drop IndexedDB; in-memory library over pull/push. |
| `docs/plans/ask-voice-stt.md` | Done (#7). Ask composer dictation via `POST /api/stt` (Gemini); output remains text. |
| `docs/plans/sync-engine-hardening.md` | Findings only, not an approved plan. Dexie-lease items no longer apply. |
| `docs/plans/recipe-gallery.md` | Done (#10, simplified in #18). Main photo + end-of-recipe gallery. |
| `docs/plans/shared-recipes.md` | Done. PR 2 view-only collection grants (#23) deployed as `sous-00011-td2`; production is now `sous-00013-ccs`. `emailLower` backfill ran 2026-09-27 (0 pending); real-delete `array-contains` check still to run (see Cloud and deploy). Editor role (#45) and grantee leave (#43) are merged, not deployed. |
| `docs/plans/shared-collections-review-fixes.md`, `shared-access-hardening.md`, `shared-sharing-final-hardening.md`, `pr23-review-fixes-round-2.md` | Done. Review rounds for PR 2; history only, `shared-recipes.md` and the Sharing section here are current. |
| `docs/plans/bulk-import.md` | Done (#15). Opt-in bulk URL import on `/import`. |
| `docs/plans/chrome-extension-import.md` | Built: `extension/` + `POST /api/extension/import`. Not deployed. |
| `docs/plans/recipe-import-module.md` | Built on `recipe-import-module`: import is `server/recipeImport.ts`; one pipeline for web, extension, evals (`evals/recipeImport.eval.ts`). `api/import.ts` is a 401 stub. Not deployed. |
| `docs/plans/import-blocked-fetch.md` | Extension POSTs the tab HTML; empty html is 422, never `fetchPageHtml`. Website URL import stays paste-fallback. No proxy. |
| `docs/plans/image-import.md` | Built on `cursor/image-import-38e9`, not deployed. Import one recipe from 1–4 photos (handwritten notes) via `images` on `POST /api/import`; Gemini reads them; never stored. Bound by `docs/constitutions/image-import.md`. |
| `docs/plans/image-import-evals-and-retry.md` | Built, not deployed. Handwritten evals split into dev/holdout with `evals/AGENTS.md` rules and `ocrCompare --thinking`. The photo retry and runaway-unit check were measured and reverted (dev approach A 14/15 → 12/15; holdout stayed 15/15). |
| `docs/plans/cook-log.md` | Done (#36; constitution `docs/constitutions/cook-log.md`). Included in `sous-00013-ccs`. |
| `docs/plans/i18n.md` | Merged (#42; constitution `docs/constitutions/i18n.md`). Not deployed. UI language with `src/i18n/` catalogs, `Recipe.lang`, translation at import and on the recipe screen, dictation language. |
| `docs/plans/i18n-follow-ups.md` | Open. Post-deploy owner steps (Cloud Run translate p95, dictation clips, `lang` backfill `--write`), unrun checks, and review nits left after PR #42. |
| `docs/plans/collection-path.md` | Built on `cursor/collection-path-2d3d`. Named collections open at `/collections/<id>`. Legacy `?c=` redirects removed. Not deployed. |
| `docs/plans/library-collections-region.md` | Built. Collection switcher on the page background, sideways scroll, and a `/collections` index. No card around it. Not deployed. |
| `docs/plans/approval-email.md` | Built on `cursor/approval-email-420a`. Email the requester after an admin approves an access request. Not deployed; before deploying, set `MAIL_FROM` to a sender on a Resend-verified domain (the sandbox sender skips the send). |
| `docs/plans/library-agent.md` | Merged (#34), not deployed. App-level assistant: read-only tools over the user's own library, modular cards (shopping list first), ephemeral threads. |
| `docs/plans/import-reliability.md` | Phase 2 built on `claude/import-reliability-plan-170fa6`, not deployed. Typed import warnings stored as optional `Recipe.importCheck`, deterministic checks, retries (constant at 0 until phase 3), warning UI. Import logging is #102 (merged, not deployed). Phase 1 still waits on the reporter's failing URLs; phase 3 waits on a deploy and data. |
| `docs/plans/import-feedback.md` | Merged (#107), not deployed. Optional import reports after a failed or flagged import, 👍/👎 on clean previews, stored in Firestore `importFeedback` for 180 days. TTL policy on `expireAt` applied 2026-10-01. |
| `docs/plans/feature-requests.md` | Built on `claude/feature-requests`, not deployed. `/suggest` page, stored in Firestore `featureRequests` for one year; TTL policy on `expireAt` is an owner step. |
| `docs/plans/agent-collection-moves.md` | Built, not deployed. `propose_collection_move` / `collection_move` v1 proposal card; client apply via `collectionStore.moveRecipes`. |
| `docs/plans/agent-create-collection.md` | Built, not deployed. `propose_create_collection` / `collection_create` v1 proposal card; client apply via `collectionStore.createWithRecipes` in one push. |
| `docs/plans/html-parser-recipe-import.md` | Built on `cursor/html-parser-recipe-import-11d4`. Not deployed. Replace the hand-rolled HTML scanner in `server/recipeImport.ts` with parse5 (issue #91). |
| `docs/plans/public-collections.md` | Built on `claude/read-only-unauthenticated-mode-204be2`, not deployed. Unlisted public link per named collection, readable signed out; AI locked; members can add it as viewers. Apply the widened log exclusion before deploying. |
| `docs/plans/sheet-dialog.md` | Merged (#95). Headless dialog for Sheet and Ask: focus trap, initial focus, restore on close, dialog semantics. Not deployed. |
| `docs/plans/mcp-collection-writes.md` | Built on `claude/mcp-collection-writes`, not deployed. `create_recipe` into a collection and `move_recipes`; collections with a public link are refused. |
| `docs/plans/mcp-server.md` | Built on `claude/llm-api-vs-mcp-04b215`, not deployed. Remote MCP server at `/mcp` with its own OAuth 2.1 authorization server (CIMD clients, no DCR): search, get, list collections, create and edit (with a version check) over the member's own recipes. No delete. |
| `docs/plans/new-member-intro.md` | Built on `claude/new-member-intro-plan`, not deployed. Three-step welcome sheet on Library for a member with no recipes of their own; closing it sets `users/{sub}.introSeenAt` (`GET /api/intro`, `POST /api/intro/seen`), so it shows once per account. Reopened from Settings. |
| `docs/plans/test-mode.md` | Merged (#123). `testing/test-server.ts` runs the app against a seeded Firestore emulator; `/__test/sign-in?as=<persona>` signs in a fake account with a real session cookie. Not in the image. The emulator runs in CI only in the `test-mode` job (owner-approved exception, Tests and verification). |
| `docs/plans/i18n-review-ci.md` | PR 1 built on `claude/i18n-review-ci`: `npm run test:i18n`, the in-context translation review as a Playwright + Gemini-judge suite in `testing/i18n-review/`, run against test mode with model routes mocked, all 91 states (steps 1–5 and its docs). Amends i18n principle 16. PR 2 on `claude/i18n-review-workflow`: the daily workflow on `main` that keeps one `i18n-review` issue of open findings (step 6); its live check waits for the merge. |

If iOS standalone PWA sign-in jumps to Safari and the app stays signed out,
stop and plan the GIS `id_token` fallback from the parent Decisions. Do not
invent other OAuth workarounds.

## Tests and verification

Unit tests cover **pure** logic only. There is no fake-indexeddb, no GCS mock,
no DOM testing library, and no Firestore emulator in unit tests — do not add
them for one feature. The one exception is test mode (below): the Firestore
emulator runs in CI only in the `test-mode` job, which boots the app against
seeded data, and in the scheduled `i18n-review` workflow, which reviews the
app in test mode. That exception was approved on 2026-10-02 because test mode
is shared infrastructure for every end-to-end test, and an unexercised test
path rots silently (`docs/plans/test-mode.md`); the review's use of it is in
`docs/plans/i18n-review-ci.md`. Do not add the emulator to another job or to
`npm test`. `.github/workflows/ci.yml` runs on PRs and pushes to
`main`: `npm run build` + `npm test`, a Docker image build booted with no
cloud credentials and checked by `.github/scripts/smoke-server.sh`, the
`test-mode` job checked by `testing/smoke.ts`, and
dependency review. None of it needs secrets, ADC, or production.
`scripts/invariants.test.ts` turns rules in this file into failing tests; follow
the rule rather than loosening the check. `evals/pageFixtures.test.ts` runs the
offline extraction step over every cached page and needs an entry for each new
page fixture.

Live paste-to-recipe evals are `npm run test:import` (`evals/**/*.eval.ts`,
`vitest.eval.config.ts`). They call Gemini against fixtures in `evals/import/`
and need `GEMINI_API_KEY` from `.env.local` (same as `dev:api`). Website
fixtures use cached `page.html` (never fetch at eval time). Do not fold them
into `npm test` or CI.

The in-context translation review is `npm run test:i18n`
(`testing/i18n-review/`, `docs/i18n-review/README.md`): Playwright captures
each manifest state in test mode, with the app's model routes mocked, and a
Gemini judge (`GEMINI_API_KEY` from `.env.local`) reviews them. Like the
import evals it is a live tool, not a unit test, and not part of `npm test`
or CI. It uses `playwright` with its own Chromium (`npx playwright install
chromium` once), not the installed Chrome that `click:library` drives,
because screenshots must not change with the browser on the machine; it
also needs the emulator and `testing/test-server.ts --static`. Before
changing the judge's prompt or model, run `testing/i18n-review/calibration.ts`
and record the result in `docs/plans/i18n-review-ci.md`.

`.github/workflows/i18n-review.yml` runs the full review on `main` daily at
06:00 UTC (and on dispatch, optionally for some states or languages) and
keeps the open findings in one issue labelled `i18n-review`
(`testing/i18n-review/issue.ts`). A scheduled run on a `main` it already
reviewed in full stops early. Only the review step gets `GEMINI_API_KEY`
(an Actions secret) and only the issue steps get the token. To decline a
finding, add its fingerprint to `docs/i18n-review/accepted.json` with a
reason; never edit the issue body by hand, since the next run rewrites it
from the state hidden in it.

Before changing an import prompt, model setting, output check, retry, or eval
golden, read `evals/AGENTS.md` (dev/holdout split, no tuning on holdout,
experiments logged in `evals/EXPERIMENTS.md`).

UI and layout changes: exercise the flow in the browser (not a screenshot).
Check other routes that share the state you touched.

**End-to-end checks run in test mode by default** (`npm run dev:test` + Vite,
a persona from `/__test/`; see `testing/README.md`). It needs no Google
account, writes only to the emulator, and has personas for states a real
account rarely has (empty library, shared viewer and editor, pending and
declined requests). Pick the persona that shows the state; do not create
data in a real account to reach it.

Use `dev:api` with a real Google sign-in only when the check needs what test
mode turns off:

- the Google sign-in flow itself (`server/auth.ts`: sign-in, the OAuth
  callback, sign-out), or a flow that goes through Google consent, such as
  redeeming an `/invite/<token>` link or signing in from `/c/join` or `/p`;
- photos, which need the real bucket (there is no Cloud Storage emulator);
- something only production data or configuration shows, such as an index
  or a TTL policy.

Then remember that `dev:api` reads and writes the production library (Cloud
and deploy), and say in the PR which check needed it. The in-context
translation review runs in test mode too (`npm run test:i18n`).

`npm run click:library` (`testing/library-click-through.ts`, #57) is a local
Playwright click-through of Library search persistence and collection
switching, in test mode; run it after changing `Library`, `CollectionSection`,
`librarySearchMemory`, or sign-out. Start the emulator, `npm run dev:test`,
and `npm run dev`; it signs in as the `member` persona. It aborts every
non-GET `/api` request except its final sign-out, which is how it shows a
flow submitted nothing. For a Vite on another port, pass `-- --port 5273` (or
set `SOUS_WEB_PORT`). It uses `playwright-core` (a devDependency, no browser
download) with the installed Chrome. Not part of `npm test` or CI.

Chat streaming must not grow `Content-Length` or `Content-Encoding` on
`/api/chat`. The framing/streaming oracle in `docs/plans/sous-subdomain.md`
step 2, with a `sous_session` cookie instead of `x-app-password`, is the
guard — run it against Cloud Run after a production deploy, not only locally.

## UI text and languages

Any change touching UI copy, `Recipe.lang`, translation, import translation,
or dictation language must follow `docs/constitutions/i18n.md`.

**UI text rule.** Any change that adds or changes user-facing text must put
it in the `src/i18n/` catalogs for every supported language (`en`, `uk`,
`ru`, `zh-Hans`), with no hardcoded strings in screens, components, or
client `lib/` messages. `src/i18n/en.ts` defines the key set; the other
catalogs are typed `Messages`, so a missing key fails `tsc`, and the parity
test in `src/i18n/messages.test.ts` checks plural forms and placeholders.
Sentences are single catalog strings with named `{params}`, never joined
fragments; relative times go through `src/lib/relativeTime.ts`.

Any UI change that adds or changes user-facing text must add it to
every catalog in `src/i18n/` (see `docs/constitutions/i18n.md`), in
the same change. New screens or states are added to
`docs/i18n-review/screens.json` in the same change, with the steps
that reach them in `testing/i18n-review/states.ts`. Once a task's
implementation is complete and you think its PR may be ready to
merge, and before opening the PR, run the in-context translation
review (`npm run test:i18n -- --states <ids>`, see
`docs/i18n-review/README.md`) for every screen that shows text the
task added or changed, in every non-English language. Fix
the blockers, re-review those screens, and attach the report to the
PR. Do not run the review after each individual change; it is a
pre-PR check, not part of the iteration loop. Cursor agents can use
the `.cursor/skills/i18n-visual-review` skill.

## Product copy

`/about` is a short public page that says what the app is for. `/privacy`
and `/terms` describe Firestore + GCS and that there is no on-device recipe
database. Theme preference, the UI language (`cook.locale`), and
`cook.session` stay in localStorage. Do not
describe IndexedDB, offline edits, or a local library. The Chrome extension
sends rendered page HTML, possibly from a page behind a login, to the server
and on to Gemini; `/privacy` and `/terms` must describe that before the
extension is offered beyond the owner. Photos sent for import go to Gemini and
are not stored; `/privacy` and `/terms` say so.
