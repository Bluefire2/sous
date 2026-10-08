# Sous

A personal, allowlisted recipe book that runs as an installed PWA on a phone.
It holds a readable recipe view, a cooking assistant attached to that recipe,
one-tap import of recipes from a URL, pasted text, or photos of handwritten
notes, and a Create mode that writes a recipe from an idea you type.

Live at <https://sous.kyrylo.lol>.

The app is called Sous; the repo, database, and directories are still `cook`.

Sign in with Google. Recipes, chat history, cooking progress, and photos live
in your account (Firestore and Cloud Storage in `europe-west1`). The app loads
them when you are signed in. The server also talks to Gemini on your behalf
when you use chat or import.

## Invitation and access

Sous is **invitation-only**: a Google account must either be in
`ALLOWED_EMAILS` (the owner/admin bootstrap list) or hold an **`active`**
`members/{sub}` record in Firestore. That record is created when the owner
approves a request, **or** when the person redeems a single-use invite link
minted by the owner or by a member who already has access. Everyone else
completes Google consent, lands on a
server-rendered 403 with **Request access**, and gets no session cookie until
admitted.

1. The requester submits **Request access** (signed token, no cookie). Sous
   stores one `accessRequests/{sub}` document and may email the owner via
   Resend (optional — requests still appear in `/admin` without email).
2. The owner opens **Settings → Invitations** (owners only) or `/admin` directly.
   The screen loads invite links and all three request sections on mount, has
   an explicit **Refresh**, and pages requests with **Load more** per section
   (document-id order, not “the most recent 200”).
3. **Create link** mints `{origin}/invite/<token>` — shown once, unused for 7
   days, first verified Google account wins. **Pending** rows can be approved
   or declined; **Approved** rows can have access removed; **Declined** rows
   can be approved again. Approval (and invite redeem) writes `members/{sub}`
   and takes effect on the member’s next sign-in — **no redeploy**.
4. A signed-in member who is not an owner creates one invite link from
   **Settings**. The URL is shown once. Creating another replaces their
   unused link. Each member can admit up to 5 people this way. They cannot
   open Invitations, approve anyone, remove access, or revoke a link. The
   owner still sees every unused link on `/admin`, including who created it,
   and can revoke it. Removing someone’s access also revokes the unused
   links they created.

**Every address in `ALLOWED_EMAILS` is an owner/admin** who can manage
invitations. Add ordinary members through `/admin` or an invite link, not by
editing that variable.

## Installing it on a phone

1. Open <https://sous.kyrylo.lol> in Safari.
2. Share → **Add to Home Screen**.
3. Open the installed app, go to **Settings**, and **Sign in with Google**.

Until you sign in, the library is empty. Chat and import need a session.

The old Vercel origin keeps a separate copy of the app. **Export library**
there, then **Import backup** here. Chat and import on the Vercel origin
return **401** by design — that deployment has no session cookie.

## Stack

- Vite 8 + React 19 + TypeScript 5.9, React Router 7
- Tailwind CSS v4 through `@tailwindcss/vite` — there is no `tailwind.config.js`
- In-memory library after pull; Firestore/GCS via `server/`
- `google-auth-library`, `@google-cloud/firestore`, and `@google-cloud/storage`
  on the Node server; OAuth, sync, photos, and import live in `server/`.
  `api/chat.ts` is the one live `POST(req: Request)` handler in `api/`: it
  calls Gemini via `@google/genai` and cannot import siblings on Vercel, so
  new HTTP routes belong in `server/`. `api/import.ts` is a Vercel-only stub
  that always returns 401; Cloud Run serves `/api/import` from `server/`.
- `scripts/server.ts` mounts `server/` routes plus the `api/` handlers in the
  Cloud Run container; Vercel still runs only the `api/` functions.
- `vite-plugin-pwa` for the service worker and web manifest

## Running it locally

**Prerequisites**

- Node **22.18 or newer**. `npm run dev:api` and `scripts/server.ts` import
  TypeScript handlers directly and rely on Node's native type stripping, which
  lands in 22.18. `package.json` records this as
  `"engines": { "node": ">=22.18" }`; the container pins
  `node:22.20-bookworm-slim`.
- A Gemini API key, for the assistant, dictation, and import features.
- Google OAuth client credentials and the other server variables in
  [Environment variables](#environment-variables).
- Application Default Credentials so the local API can reach Firestore and GCS
  (see [Local development](#local-development)).

**Setup**

```bash
npm install
cp .env.example .env.local   # fill in keys and allowlist; see below
```

`.env.local` is gitignored and is read only by the local API server. See
[Environment variables](#environment-variables).

**Then start both servers**, in two terminals:

```bash
npm run dev      # Vite on http://localhost:5173
npm run dev:api  # API on http://localhost:3001
```

> **`npm run dev` on its own is not enough.** It serves the whole UI, so it
> looks like everything is fine — but chat, import, dictation, sync, and photos need the
> API. Vite proxies `/api` to `localhost:3001` (see [`vite.config.ts`](vite.config.ts)), and with
> nothing listening there the proxy answers 500, which the app surfaces as
> "Assistant request failed (500)." and "Import failed (500).". The Vite log
> shows `http proxy error: /api/chat` with `ECONNREFUSED`. If AI features break
> and nothing else does, this is why.

[`scripts/dev-api-server.ts`](scripts/dev-api-server.ts) is a thin wrapper
around [`scripts/server.ts`](scripts/server.ts) with `staticRoot: null`: it
serves the same routes as production (auth, sync, photos, chat, import, dictation) on port
3001, so you do not need the Vercel CLI. It loads env vars via
`node --env-file=.env.local`, which means **`.env.local` must exist** — without
it the process exits immediately with `node: .env.local: not found`.

Both servers hot-reload their own side of things; the API server does not watch
`server/` or `api/`, so restart `npm run dev:api` after editing those.

A first launch in an empty browser profile shows an empty library until you
sign in.

### Local development

Local `npm run dev:api` talks to **real** Firestore and the photo bucket by
default (same Google account ⇒ same `sub` as production — experiments mutate
live data). Set up ADC once:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project cooking-assistant-508423
```

Opt-outs: set `FIRESTORE_EMULATOR_HOST` to use the emulator instead of
Firestore, or leave `PHOTO_BUCKET` unset in `.env.local` to keep photo upload
off (`/api/photos` returns 503 until the bucket is set).

### Test mode

To work signed in without touching production, run test mode: the app
against a seeded Firestore emulator, with fake personas. The full guide
(setup, personas, options, scripting, troubleshooting) is
[testing/README.md](testing/README.md). It needs Java for the emulator.

```bash
gcloud emulators firestore start --host-port=127.0.0.1:8085
```

```bash
npm run dev:test
```

It looks for the emulator at `127.0.0.1:8085`; set `FIRESTORE_EMULATOR_HOST`
to another loopback `host:port` to change that. Then run `npm run dev` and
open `http://localhost:5173/__test/` to sign in as a persona. Each start
reseeds the emulator; add `-- --keep` to keep its data. Google sign-in,
photos, and email are off; model routes work when `GEMINI_API_KEY` is set.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 5173, proxying `/api` to 3001 |
| `npm run dev:api` | API listener on 3001; needs `.env.local` and Node ≥ 22.18 |
| `npm run dev:test` | Test mode on 3001 instead of `dev:api`: seeded emulator, fake personas at `/__test/` |
| `npm run build` | `tsc -b` over the app/node/api tsconfigs, then `vite build` into `dist/` |
| `npm run preview` | Serves the built `dist/` on 4173, for checking the PWA build |
| `npm test` | Vitest once over `src/` and `server/` |
| `npm run test:watch` | Vitest in watch mode |

`node scripts/server.ts` after `npm run build` serves the built app plus the
API on `PORT` (8080 by default). That is what the container runs.

`npm run build` type-checks everything, including `api/`, `server/`, and
`scripts/`, which the running dev servers do not — run it before deploying.

## The Chrome extension

[`extension/`](extension) is an unpacked MV3 extension that imports the recipe
page you are looking at, straight into your library — one button, no review
step. It is plain JavaScript with no build step, so nothing in `npm run build`
or the container image touches it.

**Load it**

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   pick the `extension/` directory.
2. Sign in to Sous in that browser profile.
3. Open a recipe page, click the toolbar icon, click **Import to Sous**.

It posts to `POST /api/extension/import`, which extracts with Gemini and writes
the recipe to Firestore under your account; your devices pick it up on their
next sync, and the popup links straight to it. **That route has to be deployed
for the production origin to work** — against a local checkout the extension
talks to `http://localhost:5173`, which needs both `npm run dev` and
`npm run dev:api` running.

It tries `localhost` before production and only falls through to the next
origin when the connection is refused, so a local run never posts your test
imports into the real library.

| Permission | Why |
| --- | --- |
| `cookies` | Reads the `sous_session` cookie for the two Sous origins and sends it as `X-Sous-Session`. The cookie is `SameSite=Lax`, so relying on the browser to attach it to an extension request would be relying on a browser implementation detail. |
| `activeTab` + `scripting` | Grabs the rendered HTML of the tab you invoked it on, which is what makes it work on sites the server cannot fetch. No `<all_urls>`: access is granted per invocation. |
| `storage` | Keeps per-tab import state in `chrome.storage.session`, so closing the popup mid-import does not lose the run. |
| `host_permissions` | `https://sous.kyrylo.lol/*` and `http://localhost/*` — the localhost pattern is port-wide because cookies are not port-scoped and `chrome.cookies.get` has to match it. |

The extension sends the page's HTML to the server, which forwards a trimmed
version to Gemini, exactly as pasting the page into the import screen would.
If it cannot read the tab, that is an error — the server never fetches the
URL on its behalf.

## Environment variables

All of these are **server-side only**. They belong in `.env.local` for local dev
and on the Cloud Run service for production (`bash scripts/deploy.sh` writes
the full map).

| Variable | Required | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Passed to `new GoogleGenAI({ apiKey })` in the Gemini handlers (chat, import, and Ask dictation). Use a key from a **paid-tier** AI Studio project: free-tier content may be used to improve Google's products, and import sends photos of personal notes. In `.env.local`, use a separate dev key from its own project so local runs and evals don't use production's quota; production's key lives only on the Cloud Run service. |
| `AUTH_GOOGLE_ID` | yes | OAuth 2.0 Web client id. |
| `AUTH_GOOGLE_SECRET` | yes | OAuth client secret. |
| `SESSION_SECRET` | yes | HMAC key for the `sous_session` cookie. **Do not rotate casually** — every device is signed out if it changes. |
| `ALLOWED_EMAILS` | yes | Comma-separated **owner/admin** list. **Unset or empty ⇒ nobody can sign in** (fail-closed). Every address here can use `/admin`; approve ordinary members there, not by editing this list. |
| `PUBLIC_ORIGIN` | yes | Origin used to build the OAuth redirect URI. Local: `http://localhost:5173`. Production: `https://sous.kyrylo.lol`. |
| `GOOGLE_CLOUD_PROJECT` | yes | `cooking-assistant-508423` for Firestore. |
| `PHOTO_BUCKET` | no | GCS bucket name for recipe and chat photos. Unset ⇒ photo upload returns 503. |
| `MAIL_FROM` | yes (prod) | Resend sender for the owner's access-request notifications and the approval email to requesters. Must be on a domain verified in Resend. The sandbox `onboarding@resend.dev` only reaches the Resend account's own inbox, so approval emails are skipped (and logged) while it is set. |
| `OWNER_NOTIFY_EMAIL` | yes (prod) | Inbox that receives access-request notifications. |
| `RESEND_API_KEY` | no | Resend API key. Unset ⇒ no notification email; requests still land in `/admin`. |
| `CHAT_MODEL` | no | Model id for the Gemini endpoints (chat, import, Ask dictation, and the library assistant). Defaults to `gemini-3.8-flash`, except import, which defaults to `gemini-3.7-flash` (`evals/EXPERIMENTS.md`, 2026-10-08); a set value applies to import too. A blank value uses the default. |
| `TRANSLATE_PROVIDER` | no | Recipe translation provider. Defaults to `gemini`, the only accepted value. Any other value fails closed (`503`, code `translate-provider-unavailable`). A blank value uses the default. |
| `TRANSLATE_MODEL` | no | Gemini model for recipe translation. Defaults to `gemini-3.5-flash-lite`. A blank value uses the default. |

No `VITE_`-prefixed variable exists anywhere in the app, and none should. Vite
inlines `VITE_*` values into the client bundle, so prefixing the Gemini key
would publish it to every browser that loads the app.

## Sync

Firestore is the source of truth. The client pulls into memory on sign-in,
when the tab becomes visible, when the device goes online, and from **Refresh**
in Settings. Writes `POST /api/sync/push` immediately. Changes use
last-write-wins on `updatedAt`. Deletes are **tombstones**, not hard removes.
Photos upload to Cloud Storage; other devices fetch blobs for the current
session when a thumbnail is shown.

## Deployment

Cloud Run in `europe-west1` (not `europe-west2` — that region has no Cloud Run
domain mappings), GCP project `cooking-assistant-508423`, Artifact Registry
repo `sous`. The multi-stage [`Dockerfile`](Dockerfile) pins
`node:22.20-bookworm-slim`, builds `dist/`, and `CMD`s
`["node", "scripts/server.ts"]`. No secrets in any layer: `.dockerignore` and
`.gcloudignore` exclude `.env*`.

Build, push, and deploy with the env map the container needs. The generator
writes **ten** required keys (`GEMINI_API_KEY`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`, `PUBLIC_ORIGIN`,
`GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL`)
and adds **`RESEND_API_KEY`**, **`TRANSLATE_PROVIDER`**, and **`TRANSLATE_MODEL`**
only when they are set — omitting an empty optional key removes it from Cloud
Run because `--env-vars-file` replaces the whole map.

```bash
bash scripts/deploy.sh
```

To turn off notification email on a service that already has a key:

```bash
SOUS_DISABLE_RESEND=1 bash scripts/deploy.sh
```

The same script can run from GitHub Actions. **Actions → Deploy → Run
workflow** — it is `workflow_dispatch` only, never on push. Pick `main` unless
you intend to ship another ref; every run replaces production. Tick **Omit
RESEND_API_KEY** only when you want `SOUS_DISABLE_RESEND=1`. The job prints
the live Cloud Run revision, builds and pushes the image with Docker on the
runner (not `gcloud builds submit`), then `SKIP_BUILD=1 bash scripts/deploy.sh`.
Secrets are reused from the live service; do not put `GEMINI_API_KEY` or
`SESSION_SECRET` in GitHub Secrets.

That job authenticates with Workload Identity Federation as
`sous-github-deploy@cooking-assistant-508423.iam.gserviceaccount.com`. One-time
pool, provider, and service-account setup (PowerShell and Git Bash) is in
[`docs/github-actions-deploy.md`](docs/github-actions-deploy.md). IAM can take
a few minutes to propagate. The GitHub environment is `production`; add a
required reviewer under **Settings → Environments** if you want a second click
before the job starts.

The script resolves secrets from the environment or the live service, never
prints them, and uses `--env-vars-file` so comma-containing values like
`ALLOWED_EMAILS` stay intact. Then map the domain:

```bash
gcloud beta run domain-mappings create --service=sous --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423
```

In Cloudflare, a grey-cloud (DNS only) CNAME `sous` → whatever that command
printed (so far always `ghs.googlehosted.com`). Proxied (orange) blocks
certificate issuance. HTTPS looks broken until `CertificateProvisioned` is
`True`; do not edit the record while waiting.

[`scripts/server.ts`](scripts/server.ts) serves `dist/` and the API in one
process. It mirrors [`vercel.json`](vercel.json)'s SPA rewrite more strictly:
`index.html` only for GET/HEAD paths that do not start with `/api/` and whose
last segment has no `.`. A missing file-like path 404s instead of returning
HTML.

The Vercel deployment at <https://cook-seven-mu.vercel.app> still exists and
is untouched. Chat and import there return 401.

## How it's put together

```
api/chat.ts               streaming Gemini proxy + the update_recipe tool
api/import.ts             Vercel-only stub; always 401
server/recipeImport.ts    import pipeline: page fetch, JSON-LD/region extraction, Gemini, cleanup
server/importRoute.ts     POST /api/import: URL, pasted text, up to 4 photos, or an idea to write from in, recipe draft out
extension/                Chrome extension: import the page you are reading
server/stt.ts             Ask dictation: raw audio in, `{ text }` out via Gemini
server/auth.ts            Google OAuth and session cookie
server/sync.ts            Firestore pull/push
server/photos.ts          GCS staged upload and download
server/store.ts           Firestore paths and mutation helpers
server/extensionImport.ts Chrome extension import: extract a page and save it
scripts/server.ts         production server: server/ + api/ + static dist/
scripts/dev-api-server.ts same listener, static serving off, port 3001
Dockerfile                multi-stage image; CMD node scripts/server.ts
src/App.tsx               flat routes, no layout wrapper
src/screens/              Library, RecipeView, ImportScreen, Settings
src/components/           ChatPanel.tsx, ErrorBoundary.tsx, and subcomponents
src/lib/                  types, stores, in-memory library, small helpers
```

The one rule to keep: **UI code goes through the stores in `src/lib/`
(`recipeStore`, `chatStore`, `photoStore`) and never calls `fetch` for library
data.** [`src/lib/syncEngine.ts`](src/lib/syncEngine.ts) and
[`src/lib/remote.ts`](src/lib/remote.ts) own pull/push/photo HTTP. Admin
HTTP lives in [`src/lib/adminApi.ts`](src/lib/adminApi.ts). Member invite
minting lives in [`src/lib/inviteApi.ts`](src/lib/inviteApi.ts).

Two details that are easy to trip over:

- The recipe JSON schema Gemini fills in is duplicated verbatim between
  [`api/chat.ts`](api/chat.ts) and
  [`server/recipeImport.ts`](server/recipeImport.ts), because Vercel
  transpiles each `api/` entrypoint in isolation and cannot import a sibling
  helper. The two copies must stay in sync. Import's output type,
  `ImportedRecipe`, has a compile-time check against `RecipeDraft` in
  `server/recipeImport.test.ts`; chat's has none.
- `/api/chat` streams **plain text**, then a Record Separator (`0x1E`), then
  any proposal JSON (or empty), then a final `0x1E` that marks a clean end.
  That is why there is no SSE framing: the client splits on `\x1E`, renders the
  text part as it arrives, parses the proposal when present, and treats a
  missing final separator as a cut-off reply.
- `POST /api/stt` takes a raw audio body (`Content-Type` one of webm/mp4/aac/mpeg/ogg/wav)
  and a session cookie, and returns JSON `{ text }`. Vite must proxy `/api` to
  the Node server or dictation fails the same way chat does.
- `POST /api/import` also accepts `images: { mediaType, base64 }[]` (1–4;
  `image/jpeg`, `image/png`, `image/webp`; ≤ 3 MB decoded each; body ≤ 12 MB,
  else 413). `url` wins, and `text` becomes notes. The browser sends 2048 px
  JPEGs. The photos go to Gemini and are not stored. It is bound by
  [`docs/constitutions/image-import.md`](docs/constitutions/image-import.md).

## Your data

Your Google account id, email, and display name are stored server-side so sync
knows who you are. Recipes, chat messages, cooking progress, and attached photos
are stored in Google Cloud (Firestore and Cloud Storage in `europe-west1`).
They are loaded into the browser while you are signed in. There is no app
password and no
Google refresh token. Chat and import send recipe text (and any photos you
attach) to Gemini at request time; Dictate sends a short microphone clip the
same way. Photos you add for import are sent to Gemini to read the recipe and
are not stored. That traffic is not stored as a separate library on the server
beyond what sync already keeps.

Settings has **Export library** / **Import backup**, which write and read a
single JSON file containing every recipe, message, and photo (photos as base64).
Use export as a personal backup or to move recipes between accounts. Importing
merges into the account library, overwriting entries that share an id.

To delete all cloud data for an account, email **chernyshov.k@gmail.com** from
the signed-in address (there is no in-app delete-account button). Revoking
Google access in your Google account settings signs you out of Sous but does
**not** by itself delete stored recipes.

**Manual deletion procedure (operator): revoke access first, then delete data.**
Membership is cached positively for up to **60 seconds** per Cloud Run
instance, so deleting a library while the person is still authorized can let
their client push it back on the next sync.

1. Set `members/{sub}.status = 'revoked'`, or delete `members/{sub}` — either
   denies access immediately.
2. Wait at least 60 seconds and confirm denial: their `/api/auth/session` must
   return `user: null` and sync must **401** before you delete anything else.
3. Find the account's `sub` if you don't have it:
   `node --env-file=.env.local scripts/import-audit.ts <email>` prints it.
4. Delete everything in Firestore with one script. Dry run first; it prints
   what each step would change, as counts only:

   ```bash
   node --env-file=.env.local scripts/delete-account-data.ts <SUB>
   node --env-file=.env.local scripts/delete-account-data.ts <SUB> --apply
   ```

   `--apply` refuses while `members/{sub}` is still active or any email
   stored for them (profile, membership, access request) is in
   `ALLOWED_EMAILS`, read from `.env.local`, which must match the deployed
   allowlist. When no email is stored for the `sub` at all, it refuses until
   you check the deployed allowlist by hand and add `--not-owner`. It runs
   each step in `ACCOUNT_DELETION_ORDER` (`server/accountDeletion.ts`), reads
   each one back, and exits non-zero if anything remains:
   - **Sharing as a viewer:** each forward grant in an owner's tree is
     tombstoned through the same transaction as a revoke or leave (the
     tombstone drops their email), and one that transaction cannot read is
     overwritten with a clean tombstone. Only then is `incomingShares/{sub}`
     deleted. A share row that names no owner or collection, even in its id,
     stops the step before anything changes.
   - **Sharing as an owner:** every viewer's incoming share pointing at them
     is tombstoned without their email. This reads the grants in their own
     tree, which is why `users` runs last.
   - `collectionLinks` and `publicLinks` they own, `importFeedback` and
     `featureRequests` they sent, and MCP `mcpAuthCodes` and `mcpTokens` are
     deleted.
   - **Invites:** ones they minted are deleted; on one they redeemed from
     someone else, `redeemedBy` is removed, and the invite still counts
     toward its minter's limit.
   - `accessRequests/{sub}` and `members/{sub}` are deleted, then the whole
     `users/{sub}` tree with `recursiveDelete`, including `mcpGrants` and
     cached translations.

   Their opaque `sub` stays where it is part of someone else's record:
   `approvedBy` and `decidedBy`, sharing tombstones, and other viewers' own
   chat and cook rows. Their email, name, and content do not. Requires
   Application Default Credentials with quota project
   `cooking-assistant-508423` (see [Local development](#local-development)).
5. Remove photo objects (Firestore does not touch GCS):

   ```bash
   gcloud storage rm --recursive gs://sous-photos-cooking-assistant-508423/users/<SUB>/ --project=cooking-assistant-508423
   ```

   On this machine `gcloud` is often not on PATH; use
   `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`
   instead of `gcloud`.

6. Verify: a dry run of step 4 prints 0 on every line, and the bucket prefix
   under `users/<SUB>/` is empty. Server logs are not deleted; Cloud Logging
   drops them after 30 days, as `/privacy` says.

There is **no automated purge job** for access-request or membership records.
