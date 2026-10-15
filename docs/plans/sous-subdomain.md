# sous.kyrylo.lol (Cloud Run)

> **Superseded region (2026-10).** Sous moved to `us-central1`; see
> [`us-region-move.md`](us-region-move.md). The `europe-west1` references
> below are history. The rule behind "`europe-west1` is mandatory" still
> holds: the region must support Cloud Run domain mappings.

Move the app off Vercel and serve it at `https://sous.kyrylo.lol` as a public
Cloud Run service, renamed **Sous** everywhere a user can see the name. No
auth change, no per-user storage, no data-model change — those are Phase 2.

This is a **workback**: the end state comes first, then every prerequisite that
must already be true before it. Supersedes `docs/plans/cook-kyrylo-subdomain.md`
(wrong names, open decisions since settled).

## Goal

- `https://sous.kyrylo.lol` serves the PWA over a Google-issued certificate.
- Deep links (`/recipe/:id`, `/settings`, …) hit the SPA; real assets do not.
- `POST /api/chat` and `POST /api/import` run the **existing** handlers in
  `api/`, unchanged, with the same `GEMINI_API_KEY` / `APP_PASSWORD` /
  `CHAT_MODEL` contract and the same `0x1E` streaming protocol.
- `/api/chat` still streams incrementally end to end — no buffering anywhere
  between the Gemini SDK and the browser.
- The installed PWA is called **Sous**, installs from the new origin, and the
  Dexie database it opens is still named `cook`.
- The Vercel deployment keeps running, untouched.

## Why this is not "just DNS"

The deployment recipe below (proven on another `*.kyrylo.lol` app) starts at
`gcloud run deploy --image=…`. That image does not exist. There is no
`Dockerfile` in this repo and no server that serves `dist/` — on Vercel the
static build and the two `api/` functions are hosted by the platform, wired
together only by the SPA rewrite in [`vercel.json`](../../vercel.json).

The substance of this plan is the container: a production Node server that
does what Vercel does today, in one process, without breaking the stream.

## Assumptions

- Verified by reading the tree: `api/chat.ts` and `api/import.ts` each export
  `POST(req: Request): Promise<Response>` plus `maxDuration = 60`;
  [`scripts/dev-api-server.ts`](../../scripts/dev-api-server.ts) already
  imports both as `.ts` and adapts `node:http` to them; clients fetch
  **relative** URLs (`fetch('/api/chat')` in
  [`src/lib/chatApi.ts`](../../src/lib/chatApi.ts), `fetch('/api/import')` in
  [`src/lib/importApi.ts`](../../src/lib/importApi.ts)). There is no configured
  base URL anywhere, so Phase 1 needs none.
- Node **22.18+** is the runtime everywhere (native TypeScript type stripping —
  the same thing `npm run dev:api` and `.github/workflows/ci.yml` already rely
  on). The container pins it.
- `kyrylo.lol` is already verified in Google Search Console as a **Domain**
  property under `chernyshov.k@gmail.com`, which covers every subdomain and
  works even though the Cloud Run project is a different GCP project. All
  `gcloud` commands run as that account (`gcloud config get account`).
- Cloudflare hosts the `kyrylo.lol` zone and its SSL mode is Full (strict), as
  on the other `*.kyrylo.lol` apps.
- The GCP project `cooking-assistant-508423` exists. Billing is *believed*
  attached — step 1 verifies rather than assumes.
- Docker Desktop **may or may not** be installed on this machine. The image is
  built with Cloud Build so the plan does not depend on it; the local
  `docker run` check is optional and has a Docker-free substitute.
- No live Gemini key is needed for `npm run build` / `npm test`. Steps that
  exercise `/api/chat` need a working `.env.local`.
- Historical plan files (`docs/plans/*`) and `AUDIT.md` are snapshots and are
  not rewritten for the rename.

## Names

| Placeholder | Value |
|---|---|
| domain | `sous.kyrylo.lol` |
| Cloud Run service | `sous` |
| GCP project | `cooking-assistant-508423` |
| region | `europe-west1` |
| Artifact Registry repo | `sous` |
| image | `europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous:v1` |
| gcloud account | `chernyshov.k@gmail.com` |

**`europe-west1` is mandatory, not a preference.** `europe-west2` does not
support Cloud Run domain mappings. A service deployed there cannot be mapped
and would have to be redeployed. Do not "fix" the region to something closer.

## Decisions (settled — do not re-open)

- **The rename is user-facing only.** Sous is what the user sees: the Cloud Run
  service, the domain, the PWA manifest `name`/`short_name`, the `<title>` and
  Apple web-app title, the Library `<h1>`, the backup-file error copy, and the
  README. Everything internal stays `cook`: the `package.json` `name`, the
  `api/` and `src/` paths, every identifier (`CookDB`, `useCookState`,
  `CookingState`), the `localStorage` keys (`cook.appPassword`, `cook.theme`,
  `cook.hasSeeded`), the backup marker `app: 'cook'` and the `cook-backup-…json`
  download filename that agrees with it, and — **critically** — the Dexie /
  IndexedDB database name `cook` in [`src/lib/db.ts`](../../src/lib/db.ts).
  Renaming the database would open a second, empty database and orphan every
  recipe already on the user's phone. There is no migration and none is in
  scope. The download filename stays `cook-backup-` because it must match the
  `app: 'cook'` marker inside the file, which `importLibrary` checks.
- **One server module, two entrypoints.** `scripts/server.ts` is new and owns
  everything: route table, static serving, SPA fallback, streaming. It exports
  a request-listener factory and, when run directly, listens on
  `process.env.PORT || 8080` serving `dist/`.
  [`scripts/dev-api-server.ts`](../../scripts/dev-api-server.ts) shrinks to a
  few lines that call the same factory with static serving **off** and listen on
  3001. `npm run dev:api` keeps its exact command string and its current
  behavior (API on 3001, 404 for everything else, Vite serves the UI). A
  separate copy of the adapter would drift; a dev server that also served a
  stale `dist/` would be worse than the proxy we have.
- **Do not touch `api/chat.ts` / `api/import.ts`.** The container imports them
  the same way the dev server does. The `maxDuration = 60` exports stay even
  though Cloud Run ignores them — they are the Vercel contract and Vercel stays
  up. Cloud Run's own request timeout (default 300s) is what governs there.
- **Run the TypeScript directly; no compile step.** `npm run build` is
  `tsc -b && vite build`, and all three tsconfigs are `noEmit`. Adding emit for
  `api/` + `scripts/` means a fourth tsconfig, an output tree, and rewriting the
  `.ts` import specifiers the dev server depends on — real churn for no gain,
  because Node 22.18+ strips types natively and already does exactly this in dev
  and in CI. The Dockerfile pins `node:22`-bookworm-slim and `CMD` runs
  `scripts/server.ts`. Guard-rail: turn on `erasableSyntaxOnly` in the tsconfigs
  covering `api/` and `scripts/` so a non-strippable construct (enum, namespace,
  constructor parameter property) fails `npm run build` instead of the
  container.
- **Type-check the server.** `scripts/` is currently in **no** tsconfig —
  `tsconfig.node.json` includes only `vite.config.ts` — so today's dev server is
  unchecked. The new server is production code; add `scripts` to a tsconfig so
  `tsc -b` covers it.
- **Build with Cloud Build, not local Docker.** `gcloud builds submit` needs no
  Docker Desktop and no local registry auth, and it is the same command whether
  or not this machine has Docker. A local `docker build` + `docker push` is an
  acceptable substitute when Docker is present.
- **Secrets are runtime env, never image layers.** No `ARG`/`ENV` for
  `GEMINI_API_KEY` or `APP_PASSWORD`; `.dockerignore` and `.gcloudignore`
  exclude `.env*`. Phase 1 sets them with `--set-env-vars` on the service
  (matching the proven recipe). Secret Manager is the later upgrade, not a
  Phase 1 blocker.
- **The SPA fallback is stricter than `vercel.json`.** `vercel.json` rewrites
  every non-`/api/` path to `index.html`, so a missing `/assets/index-abc.js`
  returns HTML with a 200 and the browser reports a MIME/`Unexpected token '<'`
  error instead of a 404. The new server serves `index.html` only for GET/HEAD
  paths that do **not** start with `/api/` and do **not** look like a file
  (no extension). Client routes are unaffected — none of `/`, `/settings`,
  `/import`, `/recipe/:id` has a dot in the last segment.
- **Leave Vercel alone.** No redirect, no teardown, no `vercel.json` change, no
  Vercel env change. `https://cook-seven-mu.vercel.app` keeps working as a
  second origin with its own IndexedDB. Deciding its fate is deferred.

## Files to change

**New**

- `scripts/server.ts` — production HTTP server (API routes + static + SPA)
- `Dockerfile`
- `.dockerignore`
- `.gcloudignore`

**Changed**

- `scripts/dev-api-server.ts` — becomes a thin dev entrypoint on the shared factory
- `tsconfig.node.json` — type-check `scripts/`. **Or**, if widening that
  project does not work (see step 2), instead add a new `tsconfig.server.json`
  and a reference to it in `tsconfig.json` — in which case those two files are
  the ones that change and `tsconfig.node.json` is left alone. Exactly one of
  the two shapes lands; decide it in step 2 and record which.
- `tsconfig.api.json` — `erasableSyntaxOnly`
- `package.json` — `engines.node >= 22.18` (no script-name changes)
- `package-lock.json` — regenerated so its root package entry records `engines`
- `.env.example` — the header comment names Cloud Run as the production home
- `vite.config.ts` — PWA manifest `name` / `short_name` → `Sous`
- `index.html` — `<title>` and `apple-mobile-web-app-title` → `Sous`
- `src/screens/Library.tsx` — header `<h1>` → `Sous`
- `src/lib/backup.ts` — the *message* "…doesn't look like a Cook backup." → Sous
- `README.md` — live URL, install steps, Deployment section, Node/runtime notes

**Do not change:** `api/chat.ts`, `api/import.ts`, `vercel.json`,
`src/lib/db.ts`, `src/lib/settings.ts`, `src/lib/seed.ts`,
`src/screens/Settings.tsx`, the `app: 'cook'` literal or `BackupFile['app']`
type in `src/lib/backup.ts`, `package.json`'s `name`, `vitest.config.ts`,
`.github/workflows/ci.yml`, or any file in `docs/`.

## Workback

Read bottom-to-top to execute. Each line is blocked by everything under it.

```
12. Users open https://sous.kyrylo.lol, install "Sous", chat + import work
    └─ 11. CertificateProvisioned = True
        └─ 10. Cloudflare CNAME  sous → ghs.googlehosted.com  (DNS only, grey)
            └─ 9. gcloud beta run domain-mappings create
                └─ 8. *.run.app verified: root, deep link, both APIs, streaming
                    └─ 7. Cloud Run service `sous` live in europe-west1, env set
                        └─ 6. Image in Artifact Registry (Cloud Build)
                            ├─ 5. README + .env.example for Cloud Run     [repo]
                            ├─ 4. User-facing strings say Sous            [repo]
                            ├─ 3. Dockerfile + .dockerignore/.gcloudignore [repo]
                            │    └─ 2. scripts/server.ts (API+static+SPA)  [repo]
                            └─ 1. Project billing + APIs + AR repo + account
```

Steps 1–5 are independent of each other except 3 needing 2; do 1 early because
it is the only one that can reveal a hard blocker (no billing) hours before it
matters.

Each step below is labelled **Repo** (an implementer subagent can do it here)
or **Operational** (a human, in a browser or with authenticated `gcloud`;
no subagent can do it).

## Steps

### 1. [core] Verify the GCP project, enable APIs, create the registry

**Operational.** Run as `chernyshov.k@gmail.com`.

```powershell
gcloud config get account
gcloud projects describe cooking-assistant-508423
gcloud beta billing projects describe cooking-assistant-508423
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com --project=cooking-assistant-508423
gcloud artifacts repositories create sous --repository-format=docker --location=europe-west1 --project=cooking-assistant-508423
```

**Read the result of every command; do not assume a scrolled-past sequence
succeeded.** `gcloud` is a native executable, so a non-zero exit does not stop
a PowerShell session the way a failing cmdlet does — `$ErrorActionPreference`
has no effect on it. Run these one at a time and check `$LASTEXITCODE` (`0`)
before moving to the next. Silently skipping the `services enable` line is how
step 6 fails with a confusing permissions error.

Failure handling:

- **`billingEnabled: false`** → stop and attach a billing account in the
  console. Nothing downstream can run, and the failure will otherwise surface
  as an opaque API-enablement or Cloud Build error rather than a billing one.
- **`services enable` fails** → check, in this order: billing is actually on
  (above); the active account has `roles/serviceusage.serviceUsageAdmin` or
  Owner on the project; and the project id is right (`cooking-assistant-508423`,
  not a similarly named one). Re-run `gcloud services list --enabled` to see
  what actually landed rather than trusting the command's own output.
- **API enablement propagates asynchronously.** A `create` or `builds submit`
  issued seconds after `services enable` can still fail as if the API were
  off. Wait a minute or two and retry once before treating it as a
  permissions problem.
- **`artifacts repositories create` fails with "already exists"** → fine,
  continue; confirm with the `describe` below that its location really is
  `europe-west1`. Any other error → resolve it here, because step 6 has
  nowhere to push.

If the account is not the Search Console verifier,
`gcloud auth login chernyshov.k@gmail.com` before step 9 (the domain mapping
is the only step that actually depends on it, but switching accounts mid-run
is how projects get created in the wrong place).

**Verify:** `gcloud beta billing projects describe cooking-assistant-508423`
prints `billingEnabled: true`;
`gcloud services list --enabled --project=cooking-assistant-508423` lists all
three APIs; `gcloud artifacts repositories describe sous --location=europe-west1 --project=cooking-assistant-508423`
succeeds.

### 2. [core] `scripts/server.ts` — one process serving the API and `dist/`

**Repo.** Files: `scripts/server.ts` (new), `scripts/dev-api-server.ts`,
`tsconfig.node.json` (or a new `tsconfig.server.json` + a reference in
`tsconfig.json`), `tsconfig.api.json`, `package.json`, `package-lock.json`
(re-run `npm install` after adding `engines` so the lockfile's root package
entry matches; commit the result).

Export a factory, e.g.
`createRequestListener(options: { staticRoot: string | null })`, and keep the
`node:http` ↔ `Request`/`Response` adapter that
[`scripts/dev-api-server.ts`](../../scripts/dev-api-server.ts) already has
(including the `Readable.toWeb` body and the `duplex: 'half'`
`@ts-expect-error`). Behavior:

**Routing**

- `POST /api/chat` → `POST` from `../api/chat.ts`; `POST /api/import` → `POST`
  from `../api/import.ts`. Match on pathname only (strip `?query`), as today.
- Any other `/api/*` path → 404. A non-`POST` method on a known API path → 405
  (today's dev server returns 404; 405 is more honest and nothing depends on
  it).
- Reconstruct the `Request` URL from the `Host` header when present so
  `new URL(req.url)` inside a handler sees the real origin; fall back to
  `http://localhost:${port}`. Neither handler reads the URL today; this is so a
  future one is not wrong.

**Streaming (the part that breaks the app if it is wrong)**

- Copy the handler `Response` status and headers onto the `node:http` response,
  then `flushHeaders()` **before** any body byte, then stream.
- Pipe with `pipeline(Readable.fromWeb(response.body), nodeRes)` from
  `node:stream/promises` — it propagates backpressure and, on client
  disconnect, destroys the source, which cancels the web stream and fires the
  `cancel()` in `api/chat.ts` that aborts the Gemini request. Do **not**
  `await response.arrayBuffer()`, do not accumulate chunks, do not set
  `Content-Length` on a streamed response, and do not add gzip/brotli
  compression anywhere (it would coalesce the `0x1E` framing into one flush and
  the chat UI would jump from empty to complete).
- A `pipeline` rejection after headers are sent cannot become a 500; log it and
  `destroy()` the response so the client sees a truncated stream — which is
  exactly the case `chatApi` already detects via the missing terminator.
- Keep the existing catch-all → 500 `Internal error` for failures *before* the
  response starts.

**Static files (only when `staticRoot` is non-null)**

- GET/HEAD only. Decode the pathname, resolve against `staticRoot`, and reject
  anything whose resolved path is not inside `staticRoot` (`..`, encoded
  traversal) with 400/404 — this server is public and `dist/` sits next to the
  source in the image.
- Serve the file with an explicit `Content-Type` map: `.html`, `.js`, `.css`,
  `.json`, `.webmanifest` (`application/manifest+json`), `.png`, `.svg`,
  `.ico`, `.txt`, `.woff2`, `.map`. Unknown extension →
  `application/octet-stream`. Do not guess from content.
- Cache-Control: `/assets/*` (content-hashed by Vite) gets
  `public, max-age=31536000, immutable`. `index.html`, `sw.js`,
  `registerSW.js`, `manifest.webmanifest`, and `workbox-*.js` get
  `no-cache` — the service worker is `registerType: 'autoUpdate'`, and a cached
  `sw.js` or `index.html` is how an origin gets stuck on an old build. `/icons/*`
  can take a short `max-age` (e.g. 1 day).
- Stream files with `createReadStream` + `pipeline`; do not `readFileSync`.

**SPA fallback**

- Only for GET/HEAD, only when the path does not start with `/api/`, and only
  when the last path segment has **no** `.` in it → serve `dist/index.html`
  with 200 and `no-cache`. A missing path that looks like a file → 404 (see
  Decisions).
- List what `npm run build` actually produces before writing the matcher —
  expect `index.html`, `assets/*`, `icons/*`, `sw.js`, `workbox-*.js`,
  `registerSW.js`, `manifest.webmanifest` — and confirm each is served as
  itself, not as HTML.

**Dev entrypoint**

`scripts/dev-api-server.ts` keeps its doc comment (updated to say it shares
`server.ts`) and becomes: build the listener with `staticRoot: null`, listen on
3001, log the same line. `package.json`'s `dev:api` string does not change.

**Type-checking**

Add `scripts` to the include of `tsconfig.node.json` (it already sets
`allowImportingTsExtensions`, which the `../api/chat.ts` import needs). If that
project's `lib: ["ES2023"]` without `types: ["node"]` fails to resolve `Request`
/ `Response` / `ReadableStream` globals, add a `tsconfig.server.json` modeled on
`tsconfig.api.json` (`types: ["node"]`, `allowImportingTsExtensions: true`,
`include: ["scripts"]`) and reference it from `tsconfig.json` instead of
widening `tsconfig.node.json`. Add `"erasableSyntaxOnly": true` to
`tsconfig.api.json` and to whichever project covers `scripts/`. Add
`"engines": { "node": ">=22.18" }` to `package.json`.

**Verify:** `npm run build` and `npm test` are clean (`tsc -b` now covers
`scripts/`). Then, in PowerShell with a real `.env.local`:

```powershell
npm run build
$env:PORT='8080'; node --env-file=.env.local scripts/server.ts
```

In a second terminal (`node -e` rather than `Invoke-WebRequest` for the 404
checks — Windows PowerShell 5.1's `Invoke-WebRequest` throws on 4xx):

```powershell
node -e "for (const p of ['/','/settings','/recipe/nope','/manifest.webmanifest','/sw.js','/registerSW.js','/icons/icon-192.png','/icons/icon-180.png','/favicon.ico','/assets/nope.js','/api/nope','/index.html/settings','/sw.js/foo','/index.html/nope.js']) fetch('http://127.0.0.1:8080'+p).then(r=>console.log(p, r.status, r.headers.get('content-type'), r.headers.get('cache-control')))"
```

Expect: `/`, `/settings`, `/recipe/nope` → 200 `text/html` `no-cache`;
`/manifest.webmanifest` → 200 `application/manifest+json`; `/sw.js` and
`/registerSW.js` → 200 `text/javascript` `no-cache`; `/icons/icon-192.png` →
200 `image/png`; `/icons/icon-180.png` → 200 `image/png` (it exists in
`public/icons/` and [`index.html`](../../index.html) references it as the
`apple-touch-icon` — if it 404s the installed iOS icon is broken);
`/favicon.ico` → **404** (no such file in `public/`; it must 404 rather than
return the SPA shell, which is the file-like-path rule doing its job);
`/assets/nope.js` → **404** (not HTML); `/api/nope` → 404. Also confirm a real
hashed file from `dist/assets/` returns 200 with `immutable`. Nested-under-file
paths must not 500 (`stat()` is `ENOTDIR` on Linux, often `ENOENT` on Windows):
`/index.html/settings` and `/sw.js/foo` → **200 `text/html`**;
`/index.html/nope.js` → **404** (file-like last segment); a real
`/assets/index-<hash>.js/x` → **200 `text/html`**.

**Path-traversal probes.** This server is public and the image ships `api/`,
`scripts/`, and `package.json` next to `dist/`, so the containment check needs
its own test. `fetch` normalizes away `..` before the request is sent and
cannot exercise it — use raw `node:http`, which writes the request target
verbatim:

```powershell
node -e "const http=require('node:http');for(const p of ['/%2e%2e%2fpackage.json','/%2e%2e%2f%2e%2e%2fpackage.json','/assets/%2e%2e%2f%2e%2e%2fpackage.json','/..%2fpackage.json','/%2e%2e%5cpackage.json','/%ZZ','/sw.js%00.png'])http.request({host:'127.0.0.1',port:8080,path:p},r=>{let n=0,s='';r.on('data',c=>{n+=c.length;if(s.length<80)s+=c.toString('utf8',0,80)});r.on('end',()=>console.log(JSON.stringify(p),r.statusCode,r.headers['content-type'],n,JSON.stringify(s.slice(0,40))))}).end()"
```

The encoded forms are the point: `%2e%2e%2f` and `%2e%2e%5c` are opaque
characters to the HTTP layer, so they travel to the server intact and only
become `../` and `..\` when the handler decodes them. That is exactly the
window a naive decode-then-join has. (`%5c` matters because this server is
developed on Windows, where `path.resolve` treats a backslash as a separator.)

Every one must return **400 or 404**. None may return 200, and none may return
500 — a 500 means the path reached the filesystem layer and threw, which is a
containment bug even when nothing leaked. The malformed escape `/%ZZ` must be
rejected cleanly (a bare `decodeURIComponent` throws `URIError`; catch it and
answer 400). Check the printed body prefix: it must never begin with `{` from
`package.json` or contain source. Serving the SPA `index.html` for these is
also wrong — they are file-like paths and must 404, not fall through.

Finally, confirm HEAD behaves: `HEAD /` and `HEAD /icons/icon-192.png` must
return the same status and headers as GET with **no body bytes** (the Node
response must not write a body for HEAD, or the client sees a protocol
error), and `HEAD` on an API path must not invoke the handler.

Auth and framing. **The probe terminal must load `.env.local` itself** — the
server process loads it via `node --env-file`, but a second PowerShell window
inherits nothing from that, so `process.env.APP_PASSWORD` would be `undefined`
there and the "authenticated" call would silently test the 401 path instead.
Run the probes with `node --env-file=.env.local -e` (or set
`$env:APP_PASSWORD` explicitly in that window first):

```powershell
node -e "fetch('http://127.0.0.1:8080/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-pw',r.status))"
node --env-file=.env.local -e "if(!process.env.APP_PASSWORD)throw new Error('APP_PASSWORD not loaded - probe would test the wrong path');const b=JSON.stringify({messages:[{role:'user',content:'Count slowly from one to twenty, one number per line, and add a short cooking tip after each number.'}],recipe:{title:'t',servings:2,ingredientSections:[],steps:[],tags:[]}});const t=Date.now();fetch('http://127.0.0.1:8080/api/chat',{method:'POST',headers:{'content-type':'application/json','x-app-password':process.env.APP_PASSWORD},body:b}).then(async r=>{const rd=r.body.getReader();const parts=[];let chunks=0,firstTextMs=-1,seenRS=false,lastMs=0;for(;;){const{done,value}=await rd.read();if(done)break;chunks++;lastMs=Date.now()-t;if(!seenRS){const i=value.indexOf(0x1e);const pre=i===-1?value:value.subarray(0,i);if(firstTextMs<0&&pre.length>0)firstTextMs=Date.now()-t;if(i!==-1)seenRS=true}parts.push(Buffer.from(value))}const body=Buffer.concat(parts);const first=body.indexOf(0x1e);const textBytes=first===-1?0:first;const rs=body.filter(x=>x===0x1e).length;const gap=firstTextMs<0?-1:lastMs-firstTextMs;const framing=r.status===200&&rs===2&&body[body.length-1]===0x1e&&textBytes>0&&firstTextMs>=0;console.log('status',r.status,'textBytes',textBytes,'rsCount',rs,'endsWithRS',body[body.length-1]===0x1e,'firstTextMs',firstTextMs,'lastByteMs',lastMs,'gapMs',gap,'chunks',chunks);console.log('FRAMING',framing?'PASS':'FAIL');console.log('STREAMING',!framing?'n/a':gap>=500?'PASS':'INCONCLUSIVE - reply too fast, retry with a longer prompt');console.log('reply:',JSON.stringify(body.subarray(0,textBytes).toString('utf8').slice(0,300)))})"
```

`no-pw` must print 401 (a blank or unset `APP_PASSWORD` must also 401, never
open the endpoint).

**Reading the streaming result.** Chunk boundaries on the wire are arbitrary —
the two terminators can land in one chunk, split across two, or ride along with
the last text — so `chunks` is a **diagnostic only** and no pass/fail may
depend on it. There are two separate judgements, and the probe prints them
separately because they fail for different reasons:

**`FRAMING` must print `PASS`.** That means all of:

- `rsCount` is exactly **2** and `endsWithRS` is true. That is the whole
  `0x1E` contract in [`api/chat.ts`](../../api/chat.ts): text, separator,
  proposal (empty string for a question turn), separator. It holds whether or
  not the model proposed a recipe, unlike a literal `1e 1e` tail check, which
  only holds when the proposal is empty.
- `textBytes` > 0 — there is real reply text *before* the first separator.
  Counting "any byte that is not `0x1E`" would also count proposal JSON, which
  arrives in one burst at the very end and proves nothing about streaming.
- The printed `reply:` reads as the counting text, not an error string. A
  handler that 200s and streams an apology is a fail, and only reading the
  text catches it.

**`STREAMING` must print `PASS`**, meaning at least **500 ms** elapsed between
the first text byte (`firstTextMs`) and the last byte of the response
(`lastByteMs`). A real incremental stream of a twenty-item list takes seconds;
a buffered one collapses that gap to near zero. The 500 ms floor is a
deliberate threshold rather than a vague "well below": with no floor, a fast
reply where `firstTextMs` is 0 and `totalMs` is 40 looks like a huge relative
gap while actually proving nothing.

If it prints `INCONCLUSIVE`, do **not** read that as a pass and do not read it
as a failure. The reply finished too quickly to distinguish the two cases —
re-run with a longer prompt (ask for forty items, or a paragraph per step)
until the gap clears 500 ms. Only a `FRAMING PASS` plus a `STREAMING PASS`
clears this step.

Finally, `npm run dev` + `npm run dev:api` in two terminals: the UI loads on
5173, one chat turn streams, one import works, and `http://localhost:3001/`
still returns 404.

### 3. [core] `Dockerfile`, `.dockerignore`, `.gcloudignore`

**Repo.** Depends on step 2.

Multi-stage, pinned to a Node 22 tag that includes type stripping (e.g.
`node:22.20-bookworm-slim`; `node:22-bookworm-slim` is acceptable, `node:22`
without a distro suffix is not — keep the image small):

1. **build stage** — `COPY package*.json ./`, `npm ci` (dev deps needed for
   `tsc`/Vite), `COPY . .`, `npm run build` → `dist/`.
2. **deps stage** (or reuse the build stage) — `npm ci --omit=dev` into a clean
   `node_modules`.
3. **runtime stage** — copy `node_modules` (prod), `dist/`, `api/`, `scripts/`,
   `package.json`. `ENV NODE_ENV=production`, `EXPOSE 8080`, `USER node`,
   `CMD ["node", "scripts/server.ts"]`.

No `ARG`/`ENV` for secrets. No `.env*` in any layer. `WORKDIR /app`.

`.dockerignore`: `node_modules`, `dist`, `dev-dist`, `.git`, `.github`,
`.vercel`, `docs`, `*.tsbuildinfo`, `.env*`, `*.local`, `.DS_Store`.
`.gcloudignore`: the same list — write it explicitly rather than letting
`gcloud builds submit` auto-generate one from `.gitignore`, so the upload
contents are reviewable and `.env.local` is provably excluded.

**Verify:** `npm run build` still clean. Then, **if Docker is available**:

```powershell
docker build -t sous:local .
docker run --rm -p 8080:8080 -e PORT=8080 -e GEMINI_API_KEY=$env:GEMINI_API_KEY -e APP_PASSWORD=$env:APP_PASSWORD sous:local
```

and re-run every `node -e` probe from step 2 against `http://127.0.0.1:8080`,
including the traversal probes — the container is the artifact that goes
public, and its working directory holds `api/`, `scripts/`, and
`package.json`.

Also `docker run --rm sous:local node -e "console.log(process.version)"` prints
`v22.18` or newer.

**Secrets must be absent from the image**, checked with no env passed in, so
anything that prints is baked into a layer:

```powershell
docker run --rm sous:local node -e "const fs=require('node:fs');console.log('GEMINI',!!process.env.GEMINI_API_KEY,'APP_PW',!!process.env.APP_PASSWORD,'envfiles',fs.readdirSync('/app').filter(f=>f.startsWith('.env')))"
docker history --no-trunc sous:local | Select-String -Pattern 'GEMINI_API_KEY|APP_PASSWORD'
```

The first must print `GEMINI false APP_PW false envfiles []` — check **both**
secrets, not just the Gemini key, and list the directory rather than testing
one filename, so a `.env` or `.env.production` that slipped past
`.dockerignore` is caught too. The second must print nothing: a match means a
secret was passed as `ARG`/`ENV` and is recoverable from image metadata even
if the final layer looks clean.

**If Docker is not installed**, do not install it for this: the step-2 probes
already cover the server behavior, and step 6 builds the image in Cloud Build.
Re-run the step-2 probes once more with `NODE_ENV=production` set
(`$env:NODE_ENV='production'`) to catch anything that only differs by
environment, and move on.

**The secret check is not optional, though** — it just moves. Cloud Build's
log does not prove an image is free of baked-in secrets. When Docker is
missing here, step 6 runs the same two inspections against the pushed image
by digest in Cloud Shell, before the service is deployed. Do not treat this
step's `docker` block as the only place it happens.

### 4. [ui] User-facing strings become "Sous"

**Repo.** Files: `vite.config.ts`, `index.html`, `src/screens/Library.tsx`,
`src/lib/backup.ts`.

- `vite.config.ts` PWA manifest: `name: 'Sous'`, `short_name: 'Sous'`. Leave
  `description`, `display`, `start_url`, `theme_color`, `background_color`, and
  the icon list exactly as they are.
- `index.html`: `<title>Sous</title>` and
  `<meta name="apple-mobile-web-app-title" content="Sous" />`. Do not touch the
  inline theme script — it reads the `cook.theme` localStorage key, which stays.
- `src/screens/Library.tsx`: the header `<h1 className="text-2xl font-bold">`
  reads `Sous`. No class or layout change.
- `src/lib/backup.ts`: the thrown message becomes
  `"That file doesn't look like a Sous backup."`. The `app: 'cook'` literal,
  the `BackupFile['app']` type, and the `backup.app !== 'cook'` check **stay**
  — they are the on-disk format marker, and changing them would reject every
  backup a user already exported.

Do not rename anything else. Grep for the remaining `Cook`/`cook` hits and
confirm each survivor is intentional: `CookDB`/`super('cook')` in `db.ts`,
`useCookState`/`CookState*`, `CookingState`, `cookMinutes`, the `Cook N min`
label and `Cook min` form label in `RecipeView`/`RecipeForm` (those are the
cooking *time*, not the app name — leave them), `cook.*` localStorage keys,
`cook-backup-` in `Settings.tsx`, `app: 'cook'`, and `"name": "cook"` in
`package.json`.

**Verify:** `npm run build` and `npm test` clean. `npm run dev`: the Library
header reads **Sous** and the browser tab title is **Sous**. After
`npm run build`, `node -e "const m=JSON.parse(require('fs').readFileSync('dist/manifest.webmanifest','utf8'));console.log(m.name,m.short_name,m.start_url,m.icons.length)"`
prints `Sous Sous / 2` (read the file — `require` cannot load a
`.webmanifest`). In DevTools → Application → IndexedDB the database is
still named `cook` and the existing recipes are still listed. Importing a
backup file exported before this change still succeeds.

### 5. [core] README and `.env.example`: Cloud Run, not Vercel

**Repo.** Files: `README.md`, `.env.example`.

[`.env.example`](../../.env.example) currently opens with "Copy to `.env.local`
for local dev; set the same values in the Vercel project settings for
production." That sentence is now wrong in the one place a person looks when
wiring up secrets, and following it would leave the Cloud Run service without
`GEMINI_API_KEY` and `APP_PASSWORD` — which 401s every chat and import call.
Rewrite the header comment to name the Cloud Run service as production (set
via `gcloud run services update --update-env-vars`, never baked into the
image), while noting the Vercel deployment still exists and keeps its own
copy. Leave the three variables, their names, the `APP_PASSWORD=change-me`
placeholder, and the `VITE_` warning exactly as they are.

- Title/intro and the two "Live at"/install links → `https://sous.kyrylo.lol`.
  The app is called Sous; the repo, database, and directories are still `cook`
  — say that once, plainly, so the mismatch does not read as a bug.
- Install section: Safari → Add to Home Screen from the new URL, then Settings →
  app password, unchanged. Add the migration note: IndexedDB is per-origin, so a
  home-screen install from the old Vercel origin keeps its own library —
  **Export library** on the old origin, **Import backup** on the new one.
- Stack bullet: the two handlers in `api/` are no longer described as "Vercel
  serverless functions" only — they are web-standard `POST(req: Request)`
  handlers run by `scripts/server.ts` in the container (and still by Vercel).
- Deployment section, rewritten: Cloud Run in `europe-west1` (say why:
  `europe-west2` has no domain mappings), project `cooking-assistant-508423`,
  Artifact Registry repo `sous`, the `gcloud builds submit` + `gcloud run deploy`
  pair, `GEMINI_API_KEY`/`APP_PASSWORD` set on the service (never in the image),
  the domain mapping + Cloudflare grey-cloud CNAME, and the certificate wait.
  Keep a short paragraph saying the Vercel deployment still exists and is
  untouched, and that `vercel.json`'s rewrite is mirrored — more strictly — by
  the server.
- Commands table: add nothing new (no script names changed); note that
  `node scripts/server.ts` after `npm run build` serves the built app plus the
  API on `PORT` (8080 by default), which is what the container runs.
- Environment variables: same three vars, same rules; "in the Vercel project's
  environment settings" becomes "on the Cloud Run service (and still in Vercel
  while that deployment exists)". The `VITE_` warning stays verbatim.
- Layout tree: add `scripts/server.ts`, `Dockerfile`; keep the
  `scripts/dev-api-server.ts` line with its new description.
- "Your data": the database name is still `cook` and the export/import file
  format is unchanged.

Do not restructure the README or rewrite sections the move does not touch.

**Verify:** `npm run build`. Re-read every changed claim against the tree —
each must be checkable. No remaining `cook-seven-mu.vercel.app` reference
outside the paragraph that deliberately mentions the old deployment, and no
remaining sentence in either file that calls Vercel the production host:

```powershell
Select-String -Path README.md,.env.example -Pattern 'Vercel project'
```

Every surviving hit must be one that deliberately describes the still-running
old deployment. `cp .env.example .env.local` must still produce a working
local setup.

### 6. [core] Build and push the image

**Operational.** Depends on steps 2–5 (build from the final tree).

**Check what will be uploaded before uploading it.** `gcloud builds submit`
tars the working directory and sends it to Google; once `.env.local` is in
that tarball it has left the machine and the secret must be rotated. Do not
try to audit this after the fact from the build log — the log does not give a
reliable file listing. Ask gcloud directly what it intends to send:

```powershell
gcloud meta list-files-for-upload
```

This honours `.gcloudignore` from the same directory. Assert the list contains
**no** `.env`, `.env.local`, or any other `.env*` file, and no `node_modules`
or `dist`:

```powershell
gcloud meta list-files-for-upload | Select-String -Pattern '(^|[\\/])\.env'
```

Must print nothing. If it prints anything, fix `.gcloudignore` and re-check —
do not submit.

```powershell
gcloud builds submit --tag europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous:v1 --project=cooking-assistant-508423
```

Watch the log for `npm run build` succeeding inside the build stage. If Docker
is present locally, `docker build` + `gcloud auth configure-docker europe-west1-docker.pkg.dev`
+ `docker push` is equivalent.

**If the build fails to start** (rather than failing to compile): check
`$LASTEXITCODE`, confirm billing is still enabled, and confirm
`cloudbuild.googleapis.com` is in `gcloud services list --enabled`. A freshly
enabled API can take a few minutes to propagate — if step 1 enabled it moments
ago, wait and retry once before assuming a permissions problem.

**There are two different principals here, and granting the wrong one fixes
nothing.** Diagnose by where the failure happens:

- **The submit is rejected** → the *caller* (`gcloud config get account`) lacks
  permission to create builds. It needs `cloudbuild.builds.create`, i.e.
  `roles/cloudbuild.builds.editor` (Owner also covers it).
- **The build runs but fails at the push step** → the *build-executing service
  account* lacks write access to Artifact Registry. That is a different
  identity from you. Which one it is depends on the project's age: newer
  projects run builds as the default compute service account
  `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`, older ones as the
  legacy `<PROJECT_NUMBER>@cloudbuild.gserviceaccount.com`. Do not guess —
  read it off the build itself:

  ```powershell
  gcloud builds get-default-service-account --project=cooking-assistant-508423
  gcloud projects describe cooking-assistant-508423 --format="value(projectNumber)"
  gcloud builds list --project=cooking-assistant-508423 --limit=1 --format="value(serviceAccount)"
  ```

  `get-default-service-account` is the authoritative answer; the `builds list`
  line is a cross-check and can come back empty on some builds, so do not rely
  on it alone.

  Then check that account's roles and grant `roles/artifactregistry.writer`
  (and `roles/logging.logWriter` if the build cannot write logs) to **it**,
  not to your user:

  ```powershell
  gcloud projects get-iam-policy cooking-assistant-508423 --flatten="bindings[].members" --filter="bindings.members:<the-service-account>" --format="table(bindings.role)"
  ```

**Verify:**
`gcloud artifacts docker images list europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous --project=cooking-assistant-508423 --include-tags`
lists the `v1` tag (without `--include-tags` the tag column is omitted and it
looks as though the push did not tag anything), and the pre-submit
`Select-String` above printed nothing.
Record the image **digest** from that listing alongside the tag: `v1` is
reusable and will be overwritten on the next build, so the digest is what
identifies the revision you actually deployed when diagnosing or rolling back.

Capture the digest into a variable now — every later step refers to `$D`, and
"record it" in prose does not create one:

```powershell
$D = gcloud artifacts docker images describe europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous:v1 --project=cooking-assistant-508423 --format="value(image_summary.digest)"
if (-not ($D -match '^sha256:[0-9a-f]{64}$')) { throw "digest not resolved, got: '$D'" }
$D
```

The `throw` matters: if the `describe` fails, `$D` is empty or holds an error
string, and `…/sous@` with nothing after it would either fail confusingly or —
worse — be silently replaced by a tag reference. Write the printed value down
somewhere outside the shell too; the Cloud Shell block below runs in a
different session and cannot see this variable.

**Inspect the pushed image for secrets — this is mandatory, not the optional
local check.** Step 3's `docker` inspection only runs if Docker happens to be
installed on this machine, and the Cloud Build log does *not* prove the image
is clean. The artifact that goes public must be checked directly, **before**
step 7 deploys it. If Docker is not available locally, open
[Cloud Shell](https://shell.cloud.google.com) (Docker is preinstalled, no
setup) and run:

```bash
# Cloud Shell is a fresh bash session and knows nothing about the PowerShell
# $D above. Paste the digest you just printed, literally:
D='sha256:PASTE_THE_DIGEST_FROM_STEP_6'
[[ $D =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "bad or unreplaced digest: $D"; return 1 2>/dev/null || exit 1; }

IMG=europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous@$D
gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
docker pull "$IMG"
docker run --rm "$IMG" node -e 'const fs=require("node:fs");console.log("GEMINI",Boolean(process.env.GEMINI_API_KEY),"APP_PW",Boolean(process.env.APP_PASSWORD),"envfiles",fs.readdirSync("/app").filter(f=>f.startsWith(".env")))'
docker history --no-trunc "$IMG" | grep -E 'GEMINI_API_KEY|APP_PASSWORD' || echo "CLEAN - no secrets in image history"
```

(Cloud Shell is bash, so `grep` and `$VAR` are correct there — unlike every
other command block in this plan, which is PowerShell.)

**Do not write `!!process.env.X` in the bash block.** Interactive bash runs
history expansion before anything else, and `!!` expands to the previous
command — it will splice `docker pull …` into the middle of the JavaScript and
fail with a `SyntaxError`. Double quotes do not suppress it; only single quotes
do. Hence `Boolean(...)` inside a single-quoted script above. (The PowerShell
`docker` block in step 3 can keep `!!`, which is not special there.)

Address the image **by digest, not by the `v1` tag**. The tag is mutable and
can be repointed by a later build, so a tag-based check can inspect something
other than what you are about to deploy. The first command must print
`GEMINI false APP_PW false envfiles []`; the second must find nothing. A hit
in either means a secret is baked into a layer: fix the Dockerfile, rebuild,
**and rotate that secret**, because the image has already been pushed to the
registry.

### 7. [core] Deploy the Cloud Run service

**Operational.**

```powershell
# Same session as step 6, or re-set it here from the value you wrote down.
if (-not ($D -match '^sha256:[0-9a-f]{64}$')) { throw "set `$D to the digest from step 6 first" }

gcloud run deploy sous `
  --image=europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous@$D `
  --region=europe-west1 `
  --project=cooking-assistant-508423 `
  --allow-unauthenticated `
  --port=8080
```

Deploy the **digest** (`$D`, recorded and secret-scanned in step 6), not the
`v1` tag, so the running revision is provably the image that was inspected.

Then the environment. Read the values in rather than typing them on the
command line — PowerShell writes every command line to
`ConsoleHost_history.txt`, and a pasted API key stays on disk in plaintext:

```powershell
$k = Read-Host 'GEMINI_API_KEY'
gcloud run services update sous --region=europe-west1 --project=cooking-assistant-508423 --update-env-vars="GEMINI_API_KEY=$k"
$p = Read-Host 'APP_PASSWORD'
gcloud run services update sous --region=europe-west1 --project=cooking-assistant-508423 --update-env-vars="APP_PASSWORD=$p"
Remove-Variable k,p
```

Three things bite here:

- **`--set-env-vars` replaces the whole env map.** A later redeploy using it
  with one variable silently drops the other, and the app 401s on every
  request. Use `--update-env-vars`.
- **Quote the argument.** Passing it bare lets PowerShell reinterpret `$`,
  backticks, `|`, `&`, `;`, `(`, `)` and spaces inside the value. The
  double-quoted `"NAME=$k"` form expands the variable and hands gcloud one
  intact argument. A password containing `$` set unquoted arrives truncated or
  mangled, and the failure looks like a wrong password, not a quoting bug.
- **gcloud splits the value on commas.** If a key or password contains a
  comma, switch gcloud's delimiter with its `^DELIM^` prefix — but on Windows
  each caret must be **quadrupled**, because both `cmd` and gcloud's own
  parser consume a layer. The working form is:

  ```powershell
  gcloud run services update sous --region=europe-west1 --project=cooking-assistant-508423 --update-env-vars="^^^^@^^^^APP_PASSWORD=$p"
  ```

  Pick a delimiter (`@` above) that does not occur in the value. Simpler
  still: choose an `APP_PASSWORD` with no comma and avoid the whole problem.

`CHAT_MODEL` is left unset — both handlers default to `gemini-3.7-flash`.
Leave the default 300s timeout, default concurrency, and `min-instances=0`.

**Verify:**

```powershell
gcloud run services describe sous --region=europe-west1 --project=cooking-assistant-508423 --format="value(status.url)"
gcloud run services describe sous --region=europe-west1 --project=cooking-assistant-508423 --format="value(spec.template.spec.containers[0].env[].name)"
gcloud run services describe sous --region=europe-west1 --project=cooking-assistant-508423 --format="value(status.conditions)"
```

The first prints the service URL — a `https://…run.app` address. Take it from
this command rather than pattern-matching it: Cloud Run has more than one URL
format (the older `sous-<hash>-<region>.a.run.app` and the newer deterministic
`sous-<project-number>.<region>.run.app`), and both are valid. The second must project
**`env[].name` only** — do not describe the whole `env` object, which prints
every `value` too and writes both secrets to the terminal, the scrollback, and
any transcript of this session. It should list `GEMINI_API_KEY` and
`APP_PASSWORD` and nothing unexpected. The third must show `Ready` `True`.

**If the revision never becomes Ready, stop here — do not continue to step 8
or 9.** A Cloud Run deploy that cannot start still leaves a service resource
behind, and mapping a domain onto it wastes the certificate wait on an app
that was never up. Diagnose in this order:

```powershell
gcloud run revisions list --service=sous --region=europe-west1 --project=cooking-assistant-508423
gcloud run services logs read sous --region=europe-west1 --project=cooking-assistant-508423 --limit=100
```

The usual causes, in likelihood order: the container listened on a hard-coded
port instead of `process.env.PORT`; a non-erasable TypeScript construct threw
at startup (step 2's `erasableSyntaxOnly` guard should have caught it at build
time, but the container is where it surfaces); a missing production dependency
pruned by `npm ci --omit=dev`; or the runtime stage missing `dist/`, `api/`, or
`scripts/`. Fix the cause in the repo, rebuild the image (step 6), and
redeploy. Do not paper over a startup failure by raising the startup timeout.

Note that a failed native `gcloud` command does **not** stop a PowerShell
script — `$ErrorActionPreference` governs cmdlets, not external executables.
Check `$LASTEXITCODE` after each command, or run them one at a time and read
the output, rather than assuming a sequence that scrolled past all succeeded.

### 8. [core] Verify the `*.run.app` URL before mapping anything

**Operational.** Do not skip this — debugging a broken app and a pending
certificate at the same time is how a 10-minute wait turns into an afternoon.
With `$U` set to the `run.app` URL:

- `$U/` returns 200 HTML and the app renders with the header **Sous**.
- A deep link (`$U/settings` and `$U/recipe/anything`) returns 200 HTML and the
  client router renders it — not a 404, not a JSON blob.
- Assets resolve: DevTools → Network shows `assets/*.js` and `*.css` with 200
  and the right MIME types, `manifest.webmanifest` parses, and
  Application → Service Workers shows `sw.js` registered.
- **Both APIs, authenticated.** The password must be the one set on the
  *service* in step 7, which may differ from a stale `.env.local` — so supply
  it explicitly rather than reusing step 2's `--env-file` form:

  ```powershell
  $U = gcloud run services describe sous --region=europe-west1 --project=cooking-assistant-508423 --format="value(status.url)"
  $env:PROBE_PW = Read-Host 'APP_PASSWORD as set on the service'
  node -e "fetch(process.argv[1]+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-pw',r.status))" $U
  ```

  `no-pw` must print 401.

- **Streaming, re-checked against the public host.** This is the check most
  likely to differ from local, because Cloud Run's front end sits between the
  container and the client and can buffer or re-frame independently. Run the
  same oracle as step 2, parameterized on `$U`:

  ```powershell
  node -e "const U=process.argv[1];const b=JSON.stringify({messages:[{role:'user',content:'Count slowly from one to twenty, one number per line, and add a short cooking tip after each number.'}],recipe:{title:'t',servings:2,ingredientSections:[],steps:[],tags:[]}});const t=Date.now();fetch(U+'/api/chat',{method:'POST',headers:{'content-type':'application/json','x-app-password':process.env.PROBE_PW},body:b}).then(async r=>{const rd=r.body.getReader();const parts=[];let chunks=0,firstTextMs=-1,seenRS=false,lastMs=0;for(;;){const{done,value}=await rd.read();if(done)break;chunks++;lastMs=Date.now()-t;if(!seenRS){const i=value.indexOf(0x1e);const pre=i===-1?value:value.subarray(0,i);if(firstTextMs<0&&pre.length>0)firstTextMs=Date.now()-t;if(i!==-1)seenRS=true}parts.push(Buffer.from(value))}const body=Buffer.concat(parts);const first=body.indexOf(0x1e);const textBytes=first===-1?0:first;const rs=body.filter(x=>x===0x1e).length;const gap=firstTextMs<0?-1:lastMs-firstTextMs;const framing=r.status===200&&rs===2&&body[body.length-1]===0x1e&&textBytes>0&&firstTextMs>=0;console.log('status',r.status,'textBytes',textBytes,'rsCount',rs,'endsWithRS',body[body.length-1]===0x1e,'firstTextMs',firstTextMs,'lastByteMs',lastMs,'gapMs',gap,'chunks',chunks,'encoding',r.headers.get('content-encoding'),'len',r.headers.get('content-length'));console.log('FRAMING',framing?'PASS':'FAIL');console.log('STREAMING',!framing?'n/a':gap>=500?'PASS':'INCONCLUSIVE - reply too fast, retry with a longer prompt');console.log('reply:',JSON.stringify(body.subarray(0,textBytes).toString('utf8').slice(0,300)))})" $U
  Remove-Item Env:PROBE_PW
  ```

  Same pass condition as step 2: `FRAMING PASS` **and** `STREAMING PASS`, with
  `gapMs` at or above 500. `INCONCLUSIVE` means retry with a longer prompt, not
  proceed. Ignore `chunks` — the proxy may legitimately re-frame the same bytes.
  This version also prints `content-encoding` and `content-length`: either one
  being set on the chat response is the likely culprit if it streamed locally
  but not here. If streaming fails on `run.app`, stop and fix it before
  mapping the domain — debugging it behind a pending certificate is far worse.

- `/api/import` extracts a known recipe URL.
- `$U/assets/nope.js` returns 404, not HTML.
- **Re-run the traversal probes against the public host.** The step-2 script
  hardcodes `node:http`, `127.0.0.1` and port 8080, so it cannot be pointed at
  `$U` as-is. Use this `node:https` variant, passing the **bare hostname**
  (no scheme, no trailing slash) as an argument — with `node -e`,
  `process.argv[1]` is the first user argument:

  ```powershell
  $H = ([uri]$U).Host
  node -e "const https=require('node:https');const h=process.argv[1];for(const p of ['/%2e%2e%2fpackage.json','/%2e%2e%2f%2e%2e%2fpackage.json','/assets/%2e%2e%2f%2e%2e%2fpackage.json','/..%2fpackage.json','/%2e%2e%5cpackage.json','/%ZZ','/sw.js%00.png'])https.request({host:h,port:443,path:p},r=>{let n=0,s='';r.on('data',c=>{n+=c.length;if(s.length<80)s+=c.toString('utf8',0,80)});r.on('end',()=>console.log(JSON.stringify(p),r.statusCode,r.headers['content-type'],n,JSON.stringify(s.slice(0,40))))}).end()" $H
  ```

  Each encoded string is handed to `options.path` verbatim. Do **not** rebuild
  these through `fetch()` or `new URL(base + path)` — both normalize the path
  before it reaches the wire, so the probe would silently test nothing. Same
  pass condition as step 2: 400 or 404, never 200, never 500, never the SPA
  shell, and no source in the body. Google's front end may reject some of
  these itself with its own 400 before the container sees them; that is an
  acceptable pass, but confirm the container also rejects them (step 2
  already did that locally).

**Verify:** all of the above pass. Record the `run.app` URL in the deploy notes;
it stays valid after the mapping and is the fastest way to tell an app problem
from a DNS/cert problem later.

### 9. [core] Create the domain mapping

**Operational.** Must run as `chernyshov.k@gmail.com` (the Search Console
verifier of the `kyrylo.lol` Domain property). This works even though
`cooking-assistant-508423` is not the project that verified the domain.

```powershell
gcloud beta run domain-mappings create --service=sous --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423
```

It prints the DNS record to create — so far always a `CNAME` to
`ghs.googlehosted.com`. Use whatever it prints, not what this document
predicts.

**If it fails, read the actual error before changing anything.** Step 7 already
verified the service is in `europe-west1`, so "wrong region" is not the
default explanation here and redeploying the service is the wrong reflex.
Work through the causes this command actually has:

- **Domain ownership.** This is the most likely failure, because it is the one
  step that depends on *which Google account* is running it. Check
  `gcloud config get account` is `chernyshov.k@gmail.com` and that
  `gcloud domains list-user-verified` lists `kyrylo.lol`. If it does not, the
  active account is not the Search Console verifier — re-auth as that account,
  or add the current one as an owner of the Domain property in Search Console.
  The verification lives on the *account*, not the project, which is why a
  different GCP project is fine but a different login is not.
- **Permissions.** The account needs `roles/run.admin` on
  `cooking-assistant-508423` to create a mapping.
- **The mapping already exists** (a retry after a partial failure) → `describe`
  it instead of creating it again.
- **Region genuinely unsupported.** Only conclude this if the error names the
  region or domain-mapping availability. Confirm against
  `gcloud beta run domain-mappings list --region=europe-west1` and current
  Google documentation; Cloud Run's domain-mapping region list changes over
  time. Only then redeploy elsewhere.

Do not build a load-balancer workaround, and do not delete and recreate the
service to "reset" a mapping error.

**Verify:** `gcloud beta run domain-mappings describe --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423`
succeeds and shows the resource record set it wants.

### 10. [core] Cloudflare DNS record

**Operational.** Cloudflare → zone `kyrylo.lol` → DNS → Add record:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `sous` |
| Target | `ghs.googlehosted.com` (or exactly what step 9 printed) |
| Proxy status | **DNS only — grey cloud** |

Grey is mandatory. Proxied, Google's validation sees Cloudflare's IPs and the
certificate is never issued. It can be switched to proxied *after* the cert
exists, as long as zone SSL mode is Full (strict) — not part of this phase.

**Verify:** `Resolve-DnsName sous.kyrylo.lol -Type CNAME -Server 1.1.1.1`
returns `ghs.googlehosted.com` (a proxied record would return Cloudflare A
records instead — if you see those, the cloud is orange).

### 11. [core] Wait for the certificate

**Operational.** No code, no repo change.

```powershell
gcloud beta run domain-mappings describe --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423 --format="value(status.conditions)"
```

Done when `CertificateProvisioned` is `True`. A prior app on this domain took
about 10 minutes; Google allows up to 24 hours. **For the entire pending window
the status says "You must configure your DNS records" even when DNS is already
correct** — that is not a fault and not a reason to change the record. HTTPS
fails and the site looks broken until the cert lands.

**While waiting, change nothing.** Repeatedly editing the DNS record or
deleting and recreating the mapping restarts the clock and is the most common
way this turns into a multi-day problem. The only thing worth checking early
is that the record you created in step 10 matches what step 9 printed.

**If it is still pending after ~24 hours**, diagnose in this order and only
then act:

```powershell
gcloud beta run domain-mappings describe --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423 --format="yaml(status)"

# Public resolvers
Resolve-DnsName sous.kyrylo.lol -Type CNAME -Server 1.1.1.1
Resolve-DnsName sous.kyrylo.lol -Type A -Server 8.8.8.8

# Authoritative nameservers for the zone, then ask one of them directly
Resolve-DnsName kyrylo.lol -Type NS -Server 1.1.1.1
$ns = (Resolve-DnsName kyrylo.lol -Type NS -Server 1.1.1.1 | Where-Object { $_.NameHost } | Select-Object -First 1).NameHost
Resolve-DnsName sous.kyrylo.lol -Type CNAME -Server $ns
Resolve-DnsName sous.kyrylo.lol -Type A -Server $ns

# CAA via DNS-over-HTTPS (see note below). Check the apex and the subdomain:
# a CAA record on either one governs issuance for sous.kyrylo.lol.
foreach ($n in 'kyrylo.lol','sous.kyrylo.lol') {
  $r = Invoke-RestMethod -Uri "https://cloudflare-dns.com/dns-query?name=$n&type=CAA" -Headers @{ accept = 'application/dns-json' }
  if ($r.PSObject.Properties.Name -contains 'Answer') { "$n CAA:"; $r.Answer } else { "$n CAA: none" }
}
```

Two notes on these commands. **`Resolve-DnsName` cannot query CAA** — Windows
PowerShell's `-Type` enum has no CAA member, and passing the numeric type
returns an unparsed blob, so the DNS-over-HTTPS call above is the way to read
it. (If `Answer` is absent from the response, there are no CAA records, which
is the good case.) And **querying an authoritative nameserver matters**: a
public resolver can serve a cached answer for minutes to hours, so a record
you already corrected may still look wrong — or a record you think you fixed
may never have been saved. The authoritative answer is the zone's actual
state.

1. **Read the condition `reason` and `message` fields**, not just the boolean.
   The full `status` yaml distinguishes a DNS problem from a certificate
   authority problem, which the summary line does not.
2. **Resolve from a public resolver *and* from the zone's authoritative
   nameserver**, not from the local cache. If the two disagree, the change
   simply has not propagated yet and the answer is to wait, not to edit. If
   the A lookup returns Cloudflare addresses, the record is **proxied**: set
   it back to grey cloud. That alone blocks issuance indefinitely, and the
   pending message looks identical to every other cause.
3. **Look for a conflicting record.** An existing `A`, `AAAA`, or second
   `CNAME` on the `sous` name, or a wildcard `*.kyrylo.lol` record that shadows
   it, will defeat the CNAME. Remove the conflict rather than adding more
   records.
4. **Check CAA** with the DNS-over-HTTPS query above. If `kyrylo.lol`
   publishes CAA records, they must authorize `pki.goog`; otherwise Google
   cannot issue no matter how correct the DNS is. An empty answer — no CAA
   records at all — is fine and means any CA may issue.

If all four check out, **escalate rather than iterate**: this is a Google-side
issuance delay, and the app is not down — the `run.app` URL from step 7 and the
untouched Vercel deployment both still serve users. Keep both as the fallback,
leave the mapping and the DNS record exactly as they are, and open a support
case or wait. Do not start recreating the mapping on a timer.

**Verify:** the command prints `CertificateProvisioned` … `True`, and
`node -e "fetch('https://sous.kyrylo.lol/').then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.message))"`
prints 200.

### 12. [core] End-state check on the real domain

**Operational.** On desktop and on the phone:

- `https://sous.kyrylo.lol/` loads with a valid certificate (no warning),
  header reads **Sous**.
- `/settings` and a real `/recipe/<id>` deep link load directly (typed into the
  address bar, not navigated to) — this is the SPA fallback in production.
- Settings → app password saved; one chat turn **streams** (text appears
  progressively, not all at once); a recipe proposal applies; one URL import
  works.
- Safari → Share → Add to Home Screen: the suggested name is **Sous**, the icon
  is right, and the installed app opens standalone at the new origin.
- Data migration for anyone with an existing install: on the old Vercel origin,
  Settings → **Export library**; on the new install, Settings → **Import
  backup**. IndexedDB does not follow a hostname change, so the new origin
  starts empty (and will seed the sample recipe — delete it after importing).
- `https://cook-seven-mu.vercel.app` still works and is deliberately left alone.

**Verify:** every bullet above, done once by hand. Then tick the Status list.

## Out of scope

Phase 2, and anything that is not needed to serve the app at the new hostname:

- **Google OAuth / sign-in / consent screen / privacy + terms pages.** No
  redirect URI work, because there is no OAuth client in Phase 1.
- **Per-user recipe storage.** Worth stating plainly for whoever plans Phase 2:
  this app has **no shared server database at all** today. Recipes, chat, and
  photos live in per-origin IndexedDB on one device
  ([`src/lib/db.ts`](../../src/lib/db.ts)), and the only server code is two
  stateless Gemini proxies. "Each user gets their own recipe repository" is
  therefore a brand-new storage design — a database, a sync protocol, conflict
  handling, and a migration out of IndexedDB — not a partition of something
  that exists. Do not design it here.
- **Replacing `APP_PASSWORD`**, and any change to the `x-app-password` contract.
- **Anything on Vercel**: redirects, teardown, `vercel.json` edits, env changes.
  The deployment stays up and untouched; its fate is a later decision.
- **Renaming internals** — `package.json` `name`, `api/`/`src/` paths,
  identifiers, `localStorage` keys, the `app: 'cook'` backup marker, and above
  all the Dexie database name.
- **Cloudflare proxying (orange cloud)**, WAF, caching rules, or page rules.
- **Secret Manager, custom service accounts, min-instances, CPU/memory tuning,
  Cloud Armor**, and multi-region.
- **CI changes** — `.github/workflows/ci.yml` keeps running `tsc -b` + `npm test`
  only. Automating the image build and deploy is deferred.
- **Any change to `api/chat.ts` / `api/import.ts`**, the `0x1E` protocol, the
  client fetch layer, Dexie schema, or the UI beyond the four rename strings.

## Risks

- **PWA origin split / data does not move.** IndexedDB is per-origin. Every
  recipe on a phone today belongs to `cook-seven-mu.vercel.app` and will not
  appear at `sous.kyrylo.lol`. The *only* migration path is Settings →
  Export library → Import backup, and it must happen before the old install is
  deleted. Both origins stay live, so a missed export is recoverable — until
  someone removes the Vercel project (explicitly not in this plan).
- **Renaming the Dexie database would orphan every recipe**, silently, with the
  old data still on disk under the old name. This is why `super('cook')` is on
  the do-not-touch list; an implementer "finishing the rename" is the single
  most likely way to lose user data here.
- **Service-worker staleness on a brand-new origin.** `registerType: 'autoUpdate'`
  means the SW updates itself once a new `sw.js` is fetched — which only works
  if `sw.js`, `registerSW.js`, and `index.html` are served `no-cache`. Get the
  cache headers wrong on the first deploy and the first visitors can pin
  themselves to that build; the fix is then a hard reload / "Unregister" in
  DevTools, per device. The old origin's service worker keeps serving the old
  app independently — that is expected, not a bug.
- **Buffered streaming.** Anything that reads the whole `Response` body, sets
  `Content-Length`, or compresses `/api/chat` turns the assistant into a long
  blank pause followed by a wall of text. The guard is the step-2 and step-8
  probe pair — the gap between the first text byte and the last byte, with a
  500 ms floor — **not** the chunk count, which is diagnostic only because the
  wire is free to re-frame the same bytes. Run it on Cloud Run, not just
  locally: the front end sits in the path and can buffer independently.
- **`europe-west2` has no Cloud Run domain mappings.** Deploying there out of
  habit makes step 9 fail with a confusing error.
- **Proxied (orange) CNAME blocks certificate issuance** indefinitely, and the
  status message during the wait ("You must configure your DNS records") reads
  like a DNS error the whole time, which tempts exactly the wrong fix.
- **CAA records.** If the `kyrylo.lol` zone has CAA records, they must permit
  `pki.goog`, or Google cannot issue. Check with the DNS-over-HTTPS query in
  step 11 if the cert is still pending after a few hours — **not** with
  `Resolve-DnsName -Type CAA`, which Windows PowerShell does not support.
- **Type stripping limits.** Node strips types; it does not compile. An `enum`,
  `namespace`, or constructor parameter property anywhere in `api/` or
  `scripts/` fails at container start, not at build time. `erasableSyntaxOnly`
  moves that failure into `npm run build`, which is why it is in step 2.
- **`scripts/` was never type-checked before.** Pulling it into `tsc -b` may
  surface errors in the existing dev-server code (the `duplex: 'half'`
  `@ts-expect-error` in particular can flip to "unused" depending on the
  project's lib/types). Fix them in place; do not delete the directive without
  checking that the assignment really type-checks.
- **`maxDuration = 60` is inert on Cloud Run.** It is a Vercel hint. Cloud Run
  uses its own request timeout (300s default), so a chat turn that would have
  been killed at 60s on Vercel can now run longer. Acceptable; noted so nobody
  is surprised by a 90-second reply.
- **`--set-env-vars` replaces the whole map and splits on commas.** A redeploy
  with `--set-env-vars` listing one variable silently drops the other, and the
  app 401s on every request. Use `--update-env-vars`.
- **Cold starts** at `min-instances=0`: the first request after idle pays ~1–3s.
  Fine for a personal app; do not "fix" it with a paid warm instance in Phase 1.
- **Two live origins.** Until Vercel is retired there are two copies of the app
  with two separate libraries and two separate service workers. That is the
  accepted cost of the "leave Vercel untouched" decision.

## Open Questions

**None blocking.** The project id, region, service name, domain, rename scope,
and Vercel disposition are all settled above. Deferred, decide later, none of
which blocks any step:

1. After the certificate is issued, switch the Cloudflare record to proxied
   (orange) for the WAF and analytics? Requires zone SSL Full (strict); the cert
   must exist first.
2. Move `GEMINI_API_KEY` / `APP_PASSWORD` to Secret Manager with
   `--set-secrets`? Better hygiene than plain env vars on the service.
3. Retire, redirect, or keep `cook-seven-mu.vercel.app`? Revisit once every
   installed device has migrated its library.
4. Automate build + deploy in GitHub Actions, or keep it a manual two-command
   release?

## Deploy record

Filled in as the operational steps run, so a later diagnosis can tell which
image a revision came from.

| What | Value |
|---|---|
| Project number | `62867274312` |
| Billing account | `01313D-F10695-715C9B` (enabled) |
| Account running gcloud | `chernyshov.k@gmail.com`, `kyrylo.lol` confirmed in `gcloud domains list-user-verified` |
| Artifact Registry | `europe-west1` repo `sous`, DOCKER, STANDARD |
| First build | `0c7a9722-e800-44b1-9889-7ea5d980dc46`, SUCCESS in 1m36s |
| Image digest (`v1`) | `sha256:b2796c7f23f8e6bdaa69be503178bc5c79d3654952a04fa6ea181db48a1c9ec6` |
| Image secret scan | PASS in Cloud Shell \u2014 `GEMINI false APP_PW false envfiles []`, no layer-history hits |
| Container Node | v22.20.0 (satisfies the 22.18+ type-stripping requirement) |
| Live URL | `https://sous.kyrylo.lol` (mapping Ready, CertificateProvisioned) |
| First revision | `sous-00001-zj7` |
| Current revision | `sous-00002-vjq` (`GEMINI_API_KEY` replaced from `.env.local` after Git Bash paste corrupted the first value) |

Note: `gcloud` is not on PATH on the dev machine. It lives at
`C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`
(a second copy is under `C:\Program Files (x86)\…`), and the machine's default
project is `match-cal-507107` \u2014 so **every** command must pass
`--project=cooking-assistant-508423` explicitly. Docker is not installed
locally at all, which is why the image scan runs in Cloud Shell.

## Status

- [x] 1. [core] Verify GCP project billing, enable APIs, create the AR repo *(operational)*
- [x] 2. [core] `scripts/server.ts` — API routes, static `dist/`, SPA fallback, streaming *(repo)*
- [x] 3. [core] `Dockerfile`, `.dockerignore`, `.gcloudignore` *(repo)*
- [x] 4. [ui] User-facing strings become "Sous" *(repo)*
- [x] 5. [core] README and `.env.example`: Cloud Run, not Vercel *(repo)*
- [x] 6. [core] Build and push the image *(operational)*
- [x] 7. [core] Deploy the Cloud Run service *(operational)*
- [x] 8. [core] Verify the `*.run.app` URL before mapping *(operational)*
- [x] 9. [core] Create the domain mapping *(operational)*
- [x] 10. [core] Cloudflare CNAME, grey cloud *(operational)*
- [x] 11. [core] Wait for `CertificateProvisioned=True` *(operational)*
- [x] 12. [core] End-state check on https://sous.kyrylo.lol *(operational)*
