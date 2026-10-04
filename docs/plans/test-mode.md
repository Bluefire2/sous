# Test mode

Status: merged (#123). Steps 1–7 done. The
`test-mode` CI job passed on GitHub on its first run and on every push since.

Constitutions applied: none binds this change. It adds no app UI, no catalog
text, no `Recipe` field, and no client store (`client-state.md`, `i18n.md`,
`cook-log.md`, `image-import.md` checked against their descriptions). The one
page it serves, `/__test/`, is a developer tool that never ships in the image;
see Decisions.

## Goal

Run the whole app, signed in, against seeded data, with no Google sign-in and no
production Firestore. One command starts it. A browser, a Playwright script, or
a person picks a persona ("member with a full library", "empty account", "owner",
"viewer of a shared collection") and is signed in as that persona in one request.

Today every end-to-end check needs a real Google account, and local dev talks to
production Firestore under that account's `sub` (see Cloud and deploy in
`AGENTS.md`). That makes most states in `docs/i18n-review/screens.json`
unreachable without writing to production (69 of 90 are `needsData`), and makes
any browser test a manual job. This plan fixes that once, for every later
end-to-end test. The scheduled i18n review (a later plan,
`docs/plans/i18n-review-ci.md`) is the first user.

## Out of scope

- Playwright, screenshots, and the i18n judge. Those belong to the i18n review
  plan, which builds on this one.
- Photos. Google Cloud Storage has no official emulator. Test mode runs with
  `PHOTO_BUCKET` unset, so photo upload answers the existing "storage
  unavailable" response and seeded recipes have no photos.
- Faking Gemini. Model-backed routes (import, chat, translate, STT, the agent)
  use a real `GEMINI_API_KEY`: the owner provides a key for tests, and test
  mode passes it through. Without one they fail as they do today. A test that
  needs a fixed model answer mocks the route in the browser (Playwright
  `page.route`), not in the server. The `test-mode` CI job on PRs uses no key
  (fork PRs get no secrets, and the job checks sign-in and seed, not models);
  scheduled workflows such as the i18n review read it from the
  `GEMINI_API_KEY` Actions secret.
- Email. `RESEND_API_KEY` is cleared, so the approval email is skipped, as it is
  today without a key.
- Google sign-in. The "Sign in with Google" link fails in test mode
  (`AUTH_GOOGLE_*` are cleared). Personas sign in through `/__test/`.

## Decisions

- **No auth bypass. A real session for a fake account.** Test mode does not
  change `readSession`, `requireMember`, `requireOwner`, `api/chat.ts`, or any
  route. `/__test/sign-in` signs an ordinary `sous_session` cookie with the
  existing `signSession`, and every later request goes through the same
  verification and admission as production. A persona is admitted the normal
  way: the owner through `ALLOWED_EMAILS`, members through an active
  `members/{sub}` document.
- **Test mode is a different entrypoint, not a flag.** It is
  `testing/test-server.ts`, which wraps `createRequestListener` from
  `scripts/server.ts` and answers `/__test/*` before handing everything else
  to it. `scripts/server.ts`, `scripts/dev-api-server.ts`, `server/`, `api/`,
  and `src/` gain no test code and no new env var.
  - **Why not an env var or a startup flag on the real server.**
    `scripts/deploy.sh` writes the whole env map from a file, so one stray
    variable would turn the bypass on in production with no error. A code path
    that exists in the image is one bug away from being reachable. Code that is
    not in the image cannot be.
  - **Not in the image.** The runtime stage copies only `api/`, `server/`,
    `scripts/`, `dist/`, and `node_modules/`, so `testing/` never reaches it.
    `.dockerignore` also lists `testing`, so the build stage never sees it.
    `scripts/invariants.test.ts` checks both.
- **The test server builds its own environment and fails closed.** It loads
  `.env.local` if present (`--env-file-if-exists`), then sets, clears, or passes
  through every variable the server reads (table below), so a developer's
  production values cannot leak in. It refuses to start, with one line per
  reason, unless:
  - `FIRESTORE_EMULATOR_HOST`, when set, has the host `localhost`,
    `127.0.0.1`, or `[::1]`. Unset means `127.0.0.1:8085`, so `npm run
    dev:test` needs no env syntax in any shell (PowerShell has no
    `VAR=value command`). The default is loopback, so it can only reach a
    local emulator;
  - the emulator at that host answers `GET /` with `Ok` within 5 seconds;
  - `K_SERVICE` is unset (Cloud Run always sets it);
  - `NODE_ENV` is not `production`.

  The checks are a pure function, `testModeRefusals(env)`, unit-tested in
  `testing/guard.test.ts`. Only the emulator probe does I/O.
- **Environment classification** (`testing/env.ts`, one table, the only place
  test mode names a variable):

  | Variable | Test mode | Why |
  | --- | --- | --- |
  | `SESSION_SECRET` | set to a fixed public constant, `TEST_SESSION_SECRET` | A cookie minted in test mode never verifies against production's secret, even when `.env.local` holds the real one. |
  | `ALLOWED_EMAILS` | set to the owner persona's email | The owner tier is the persona, never a real address. |
  | `GOOGLE_CLOUD_PROJECT` | set to `demo-sous` | The emulator's `demo-` convention: a `demo-` project reaches no real resource. |
  | `FIRESTORE_DATABASE_ID` | cleared | The emulator's `(default)` database. |
  | `PUBLIC_ORIGIN` | set to `http://localhost:5173` (API mode) or `http://localhost:<port>` (static mode) | `Secure` stays off on http, so the cookie is sent. |
  | `PHOTO_BUCKET` | cleared | Never the production bucket. |
  | `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_NOTIFY_EMAIL` | cleared | No email leaves test mode. |
  | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | cleared | No real Google sign-in in test mode. |
  | `PORT` | set from `--port` | |
  | `GEMINI_API_KEY`, `CHAT_MODEL`, `TRANSLATE_MODEL`, `TRANSLATE_PROVIDER` | passed through | Model routes work when the developer supplies a key. |
  | `FIRESTORE_EMULATOR_HOST` | defaults to `127.0.0.1:8085`; a value set must be loopback | See the refusals above. |

  `scripts/invariants.test.ts` greps every `process.env.NAME` read under
  `server/`, `api/`, and `scripts/server.ts` and fails if a name is missing from
  this table, so a new variable cannot silently fall through to its
  `.env.local` value.
- **The env is set before the server is loaded.** ESM hoists static imports, so
  `test-server.ts` imports nothing from the app statically. It runs the guard,
  writes `process.env`, then `await import('../scripts/server.ts')`. Every
  getter in `server/env.ts` reads `process.env` per call, so this is enough.
- **Personas are fixed ids that no real Google account can have.** Google
  `sub`s are numeric strings; persona `sub`s start with `test-`. Emails use the
  reserved `.invalid` domain. Both pass the existing validators
  (`isValidSubParam`, `normalizeShareEmail`).
- **Seeding goes through the app's own HTTP routes.** After the server listens,
  the seed signs each persona in through `/__test/sign-in` and writes its data
  with the same requests the client makes (`POST /api/sync/push`, the grant and
  public-link routes, `POST /api/admin/decision`, `POST /api/admin/invites`).
  Validation, `compactRecipe`, LWW, and the grant transactions all run, so
  seeded data cannot drift from what the app writes. Access requests also go
  through their route, `POST /api/access-request`, with the form's `t` token
  signed by the server's own `signAccessRequestTx`, as the invitation-only
  page does. The MCP grant has no HTTP path short of the consent page, which
  fetches a public client-metadata document, so the seed writes it with
  `createGrantWithCode` and then redeems the code through `POST /oauth/token`.
  The grant stays "connected 4 days ago"; the code uses a separate clock so
  its 60 s lifetime is still open, and `lastUsedAt` is put back to 2 hours
  ago after the redeem stamps it. The raw tokens are remembered for
  `/__test/personas` and are not logged.
- **Each start is a clean slate.** By default the test server clears the
  emulator (`DELETE /emulator/v1/projects/demo-sous/databases/(default)/documents`)
  and seeds before printing "ready". `--keep` skips both, for a developer who
  wants their clicks to survive a restart.
- **`/__test/` is plain English server HTML.** It is a developer tool that
  never ships, not app UI, so it is outside the catalogs and the in-context
  review, and no i18n amendment is needed. It lists each persona as a link.
- **CI boots test mode on every PR.** This breaks the rule in
  `AGENTS.md` Tests and verification, "no Firestore emulator in CI ... do not
  add them for one feature". The break is deliberate: test mode is shared
  infrastructure for every end-to-end test, not one feature, and a test path
  nothing runs rots silently. The owner approved the break on 2026-10-02. The
  PR rewrites that sentence (step 7) and says so in its description. Unit tests stay pure; the emulator runs only in the
  new `test-mode` job.

## Personas and seed data

All timestamps are relative to the seed run (for example "cooked 3 days ago"),
so relative-time labels look the same on every run.

| Persona (`as=`) | `sub` | Email | Admission | Data |
| --- | --- | --- | --- | --- |
| `owner` | `test-owner` | `owner@sous.invalid` | `ALLOWED_EMAILS` | 2 recipes; a named collection "Owner's picks" with `viewer` as editor; one unused invite |
| `member` | `test-member` | `member@sous.invalid` | active member, approved by `test-owner` | the full library below |
| `empty` | `test-empty` | `empty@sous.invalid` | active member | none: no recipes, no collections, no shares |
| `viewer` | `test-viewer` | `viewer@sous.invalid` | active member | 1 own recipe; viewer grant on `member`'s "Weeknights", editor grant on `owner`'s "Owner's picks" |
| `outsider` | `test-outsider` | `outsider@sous.invalid` | not admitted; a pending access request | none |
| `declined` | `test-declined` | `declined@sous.invalid` | declined access request | none; fills the Declined list on `/admin` |

The `member` library, enough to reach the `needsData` states in
`docs/i18n-review/screens.json` that need no photos:

- 6 recipes written for this file (no copied recipe text): English with prep
  and cook times; English with no times; Ukrainian (`lang: 'uk'`); one with no
  `lang`; one Chinese (`lang: 'zh-Hans'`); one with `importCheck` warnings.
- 2 named collections: "Weeknights" (3 recipes, shared with `viewer`, public
  link on) and "Baking" (2 recipes, no grantees, so the share sheet shows
  "Nobody else can see this yet."). One recipe is in no collection.
- Cook state on one recipe (two ingredients checked, step 2), 2 cook-log
  entries with rating, notes, and a lesson, and a short chat thread on one
  recipe.
- One connected MCP app (`clientHost: claude.ai`, read and write).

Fixture recipes and ids live in `testing/fixtures.ts` with fixed UUIDs, so a
test can open `/recipe/<id>` by a constant.

## Routes (test server only)

| Route | Answer |
| --- | --- |
| `GET /__test/` | HTML list of personas, each linking to `/__test/sign-in?as=<persona>`. |
| `GET /__test/sign-in?as=<persona>&returnTo=<path>` | Upserts the persona's profile with the server's `upsertUser`, as the OAuth callback does (add-by-email finds people by `emailLower` there), then `303` with `Set-Cookie: sous_session=…` from `signSession` and `sessionCookie`, and `Location` from `safeReturnTo` (default `/`). Built as a `Response` with a `Location` header, never `Response.redirect` (immutable headers drop `Set-Cookie`, as in the OAuth callback). Unknown persona: `404`. |
| `GET /__test/personas` | JSON of the personas (`as`, `sub`, `email`, `admitted`) plus the fixture ids, and after a fresh seed the member's MCP tokens (`mcp`). `--keep` omits `mcp`. |

Sign-out is the app's normal route. Signing in as `outsider` gives a valid
cookie that `/api/auth/session` then clears as denied, which is the real
behavior for a signed-in non-member.

Two modes:

- **API mode (default, port 3001).** Replaces `npm run dev:api`; Vite on 5173
  is unchanged. `vite.config.ts` proxies `^/__test/` to 3001, like `/api`.
- **Static mode (`--static`, port 4173).** Serves the built `dist/` through the
  same listener, as production does, for CI and Playwright with no Vite. The
  PWA `navigateFallbackDenylist` gains `/^\/__test\//`, so an installed service
  worker never answers a `/__test/` navigation with the app shell. That regex
  is the only test-mode trace in the production bundle and is inert there.

## Files

| File | What |
| --- | --- |
| `testing/env.ts` | The classification table, `TEST_SESSION_SECRET`, `testModeRefusals(env)`, `testModeEnv(env, mode)`. Pure. |
| `testing/guard.test.ts` | Unit tests for the two pure functions. |
| `testing/personas.ts` | The persona table. |
| `testing/fixtures.ts` | Recipes, collections, cook rows, cook logs, chat, fixed ids. |
| `testing/seed.ts` | `seed(baseUrl)`: clears the emulator, signs personas in, writes the fixtures over HTTP; `createGrantWithCode` for the MCP grant, then `POST /oauth/token` to redeem it. |
| `testing/mcpSmoke.ts` | The MCP half of the smoke check: discovery, OAuth, and `/mcp`. |
| `testing/test-server.ts` | Entrypoint: guard, env, dynamic import, `/__test/*`, seed, listen. Flags `--port`, `--static`, `--keep`. |
| `testing/smoke.ts` | Reads the seed back through the app's routes on a running test server (step 6). |
| `package.json` | `"dev:test": "node --env-file-if-exists=.env.local testing/test-server.ts"`. |
| `tsconfig.node.json` | Add `testing` to `include`, so `npm run build` type-checks it. |
| `vite.config.ts` | `^/__test/` proxy; `/^\/__test\//` in the PWA denylist. |
| `.dockerignore` | `testing`. |
| `scripts/invariants.test.ts` | The checks in step 5. |
| `.github/workflows/ci.yml` | The `test-mode` job. |
| `.github/scripts/smoke-server.sh` | The image refuses `/__test/sign-in` (step 6). |
| `AGENTS.md`, `README.md` | Step 7. |

## Steps

1. **[core] Emulator spike.** Confirm both ways of running the emulator before
   building on them, and record the commands in this plan:
   - local: `gcloud emulators firestore start --host-port=127.0.0.1:8085`
     (on this machine `gcloud` is not on `PATH`; the full path is in
     `AGENTS.md`, and Java 21 and the `cloud-firestore-emulator` component are
     already installed);
   - CI: `docker run -d -p 8085:8085
     gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators gcloud
     emulators firestore start --host-port=0.0.0.0:8085`, timing the pull on
     `ubuntu-latest`. If the pull costs more than about 90 seconds, try the
     runner's preinstalled `gcloud` with the apt emulator package and record
     which one won.
   - Check that `GET /` answers `Ok`, that the clear endpoint works for
     `demo-sous`, and that `@google-cloud/firestore` with
     `FIRESTORE_EMULATOR_HOST` and `GOOGLE_CLOUD_PROJECT=demo-sous` reads and
     writes without credentials.
   Port 8085, not 8080, so it never collides with `node scripts/server.ts`.

   **Result (2026-10-02).** Local: the gcloud command works on this machine
   (Java 21, component installed); `GET /` answers `Ok`, the clear endpoint
   answers 200 and empties the database, and the SDK reads and writes
   `demo-sous` with no credentials. CI: the image is pinned to
   `gcr.io/google.com/cloudsdktool/google-cloud-cli:587.0.0-emulators` (the
   tag exists in the registry). On `ubuntu-latest` the whole `test-mode` job,
   pull included, took 48 s on its first run.
2. **[core] `testing/env.ts` and `testing/guard.test.ts`.** Tests: each refusal
   alone (unset host, `example.com:8085`, `K_SERVICE` set, `NODE_ENV=production`);
   all clear gives no refusals; `testModeEnv` overrides `SESSION_SECRET`,
   `ALLOWED_EMAILS`, and `GOOGLE_CLOUD_PROJECT` even when the input holds
   other values, clears every "cleared" variable, and keeps `GEMINI_API_KEY`.
3. **[core] `testing/test-server.ts`, `testing/personas.ts`, the routes.**
   Add the `vite.config.ts` proxy and denylist entry, `.dockerignore`, the
   `tsconfig.node.json` include, and the `dev:test` script. Check: with the
   emulator up, `npm run dev:test -- --keep` plus `npm run dev`, open
   `http://localhost:5173/__test/`, pick `member`, land on `/` signed in with
   an empty library; pick `outsider` and land signed out. With the emulator
   down, the server refuses and exits non-zero with the reason.
4. **[core] `testing/fixtures.ts` and `testing/seed.ts`.** Wire the default
   clean-slate seed. Check in the browser as each persona: `member` sees 6
   recipes and both collection chips; Weeknights' share sheet lists `viewer`;
   Baking's says nobody else can see it; `viewer` sees the shared-with-you
   banner and can edit in "Owner's picks"; `empty` sees the empty library;
   `owner` sees Pending, Approved, Declined, and one invite on `/admin`;
   `member`'s Settings shows one connected app. A second start with no
   `--keep` gives the same state.
5. **[core] Invariants** in `scripts/invariants.test.ts`, in a new
   `describe('test mode (docs/plans/test-mode.md)')`:
   - no file under `server/`, `api/`, `scripts/`, `src/`, or `evals/` imports
     from `testing/`;
   - no file under `server/`, `api/`, `scripts/`, or `src/` contains `__test`;
   - `.dockerignore` lists `testing`, and the Dockerfile's runtime stage has no
     `COPY` of `testing` or of `.`;
   - every `process.env.NAME` read under `server/`, `api/`, and
     `scripts/server.ts` is in the `testing/env.ts` table.
6. **[core] CI.**
   - New `test-mode` job in `ci.yml`, no secrets: `npm ci`, `npm run build`,
     start the emulator (the step 1 command), start `node
     testing/test-server.ts --static --port 4173` in the background, then
     `node testing/smoke.ts http://localhost:4173`. The script waits for
     `/__test/personas`, signs every persona in, and reads the seed back
     through the routes the app uses (see Deviations: it replaced a bash
     script). The job prints the server log on failure.
   - `smoke-server.sh` gains one check against the production image:
     `GET /__test/sign-in?as=member` is not a 303 and sets no `sous_session`
     cookie. (The SPA fallback answers it 200 with the app shell, so the check
     is on the cookie and status, not on 404.)
7. **[core] Docs.**
   - `AGENTS.md`: a "Test mode" paragraph under How to run it (one command,
     personas, emulator command, Google sign-in off, no photos); the Cloud
     and deploy note that dev talks to real Firestore names test mode as the
     way not to; Tests and verification replaces "no Firestore emulator in
     CI" with "the emulator runs only in the `test-mode` CI job, for test mode;
     unit tests stay pure"; the plan table row for this plan.
   - `README.md`: the same run instructions in the local development section.
   - `docs/plans/i18n-follow-ups.md` section 6: point the test-data question
     at this plan.

## Risks

- **A future route reads a new env var.** The step 5 invariant forces it into
  the table before it can fall through from `.env.local`.
- **A future change moves `testing/` into the image.** For example, the
  runtime stage switches to `COPY . .`. The step 5 invariant fails, and the
  image smoke check catches a working `/__test/sign-in`.
- **`TEST_SESSION_SECRET` is public.** Anyone can mint a cookie that the test
  server accepts. That is the point, and it is harmless because no other
  server uses that secret, and test mode refuses to run outside a loopback
  emulator.
- **Fixtures drift from the client's push shapes.** The seed goes through
  `/api/sync/push`, so a shape the server rejects fails the seed and the CI
  job, not a later test.
- **Emulator behavior differs from production Firestore** (indexes, TTL,
  some transaction contention). Test mode is for rendering and flows, not for
  proving index or TTL configuration; those checks stay against production as
  `AGENTS.md` describes.

## Owner steps

None for production. Locally: start the emulator with the step 1 command
before `npm run dev:test`.

## Verification

- `npm run build` and `npm test` pass, including the new guard tests and
  invariants.
- Steps 3 and 4 checked in the browser at `localhost:5173`, as each persona.
- The `test-mode` CI job and the image smoke check pass on the PR.
- Production behavior is untouched: the PR changes no file under `server/`
  or `api/`, `scripts/` only in `invariants.test.ts`, and `src/` only to move
  the `CookStateRow` interface into `src/lib/types.ts` (type-only; see
  Deviations).

## Deviations found while building

- **Loopback only.** The test server listens on `127.0.0.1` and `::1`
  (two listeners, IPv6 optional), never on all interfaces, so a server that
  signs anyone in does not answer the LAN. `dev:api` still listens on all
  interfaces; that is unchanged.
- **Readiness probe.** The server listens before it seeds, because the seed
  goes through its HTTP routes. `GET /__test/personas` answers 503 until the
  seed (or `--keep`) is done, and the CI smoke script waits on it.
- **`GOOGLE_APPLICATION_CREDENTIALS` is cleared** as well. App code does not
  read it, but no Google client library in test mode should find a real key.
- **`declined` can sign in.** It is an ordinary persona whose session is
  denied, like `outsider`; there was no reason to forbid it.
- **`CookStateRow` moved to `src/lib/types.ts`.** It lived in
  `src/lib/useCookState.ts`, which pulls browser modules into the Node type
  check, so the fixtures first carried a copy. The interface moved, unchanged,
  next to `CookLog` and `ChatMessage`; its importers now take it from
  `./types`. `testing/fixtures.ts` imports it, so the build checks every
  fixture type against the app's.
- **Shared pull pages one share at a time.** The viewer's second share is on
  the second page of `/api/sync/shared`. That is existing behavior, noted
  because it looks like a missing grant when you read only the first page.
- **The emulator host defaults to `127.0.0.1:8085`.** The plan required
  `FIRESTORE_EMULATOR_HOST`, but `VAR=value npm run …` is bash syntax and
  fails in PowerShell. A loopback default keeps the guarantee (only a local
  emulator is reachable) and makes `npm run dev:test` work in any shell. A
  value that is set must still be loopback.
- **The CI smoke check reads the whole seed back.** The first version,
  `.github/scripts/smoke-test-mode.sh`, checked sign-in, admission, and the 6
  member recipe ids. `testing/smoke.ts` replaced it so CI also catches data
  that is written but no longer read back correctly. It is Node rather than
  bash because it follows the shared-pull cursor and parses JSON, and it
  imports its expected values from the fixtures instead of copying ids. It
  checks, per persona: every persona signs in, admitted ones get their own
  session (owner as owner), and `outsider` and `declined` are denied;
  `member`'s pull holds exactly the fixture recipes, collections, cook-log
  entries, chat messages, and cook progress; Weeknights' public link reads
  signed out and lists its recipes; `member` has one connected app,
  `claude.ai` with read and write; `viewer`'s own recipe, and across every
  shared-pull page exactly two shares, Weeknights as viewer and Owner's picks
  as editor, with their recipes; `owner`'s recipes and collection, the
  pending, approved, and declined lists on `/admin`, and one unused invite;
  `empty` has no recipes or collections. An unknown persona is 404 and a pull
  with no cookie is 401. It also drives the MCP endpoints (`testing/mcpSmoke.ts`):
  both discovery documents, method and authorize/token refusals, a session
  cookie and a bearer staying on their own routes, `/mcp` search/get/list/
  create/update/move against the member library (including a stale-version conflict,
  filing a recipe into a collection, and another account's recipe coming back missing), refresh narrowed to
  `recipes:read`, and disconnect from Settings then revoke.
- **The picker waits for the seed.** Review found that `/__test/` offered
  personas while the seed was still running; a sign-in then lands signed out,
  because the persona is not admitted yet. Until the seed is done the picker
  answers 503 with a page that reloads itself and offers no links.
  `/__test/sign-in` stays open, because the seed signs in through it.
- **The image check fails when nothing answers.** The `/__test/sign-in`
  check in `smoke-server.sh` first passed on an empty `curl` result; it now
  fails without a status line.
- **The `__test` rule names its scope.** `AGENTS.md` first said nothing
  outside `testing/` may mention `__test`, which `vite.config.ts` and
  `.github/` contradict. It now names the directories the invariant scans and
  lists the allowed traces outside them.
