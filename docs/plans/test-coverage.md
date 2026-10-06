# Test coverage for CI

Status: PR 1 (steps 1 to 4), PR 2 (steps 5 to 7), and PR 3 (steps 8 to 11)
built 2026-10-05; step 12 is the owner's call. Written from a survey of the suite
(149 test files, 2593 cases, about 13 s under `npm test`) and of
`.github/workflows/ci.yml`. Every feature PR in the last eight commits shipped
with tests; the gaps below are structural, not per-feature.

Constitutions applied: `i18n.md` binds step 4f, which turns principle 9 (UI
copy lives only in the catalogs) into a failing test; the plan adds no UI
text, so principle 16's in-context review does not apply. `client-state.md`
lists `scripts/invariants.test.ts` for its client-state checks; this plan
adds other `describe` blocks to that file and changes none of those.
`cook-log.md` and `image-import.md` were checked against their descriptions
and do not bind. No step amends a constitution.

## Goal

Make `npm test` and the `test-mode` CI job catch the regressions that today
only a manual check, the Docker smoke, or production would show:

- the Google sign-in callback (`server/auth.ts`, 308 lines, imported by no
  test) and the HTTP dispatcher (`scripts/server.ts`, 617 lines, tested only
  for body piping);
- rules that `AGENTS.md` states in prose but nothing checks: the session-gate
  copy in `api/chat.ts` "must stay in sync" with `server/session.ts`, every
  server-rendered route must be in the Vite proxy and the PWA denylist, a new
  token-in-path route must be in the log-exclusion filter, UI text lives only
  in the catalogs, and more (step 4);
- the write paths a unit test cannot reach because they are Firestore
  transactions: last-write-wins and tombstones on push, the editor and viewer
  rules on shared recipes, the collection-link and public-link joins, the
  revoke and leave pairs, and the account deletion script. The `test-mode`
  job already seeds all of these through the app's routes and then asserts
  only reads (`testing/smoke.ts`).

## Out of scope

- A DOM testing library, component tests, or Playwright in CI. Unit tests
  stay pure (Tests and verification in `AGENTS.md`); `npm run click:library`
  stays a local tool by the same decision.
- The Firestore emulator anywhere but the existing `test-mode` job.
- Live model evals (`npm run test:import`, `npm run test:i18n`) in CI.
- Coverage thresholds. Step 12 adds a report only, and only if the owner
  wants one.
- The Google consent flow and `/invite/<token>` redeem (they need Google),
  the MCP consent page (it fetches a public client-metadata document), and
  photos (no Cloud Storage emulator). Their pure parts are already tested.
- Production code changes beyond the seams the steps name: an `export` on
  the dispatcher's route table (step 2), and a `main(argv, deps)` split in
  two operator scripts (step 7). Nothing in `server/auth.ts`, the sync
  routes, or the sharing code changes.

## Decisions

- **Existing patterns, no new test infrastructure.** Module seams use
  `vi.mock` with `importOriginal`, as `server/admin.test.ts` does for
  `./membership.ts`, `./invites.ts`, and `./members.ts`. Handlers that already
  take a `deps` argument (`featureRequestPost`, the public-link and
  collection-link handlers) are driven through it. Fake timers where a
  timeout matters; never a real wait.
- **The dispatcher is tested in-process on a real socket.** `scripts/server.ts`
  exports `createRequestListener` and its `isDirectRun()` guard keeps the
  import side-effect free, so a test binds `http.createServer(listener)` to
  `127.0.0.1:0` with `staticRoot` pointing at a temp directory and uses
  `fetch` (and `http.request` for raw paths a URL parser would normalize).
  The test never calls a route that reaches Firestore or Gemini: the public
  collection GET, the `/invite/<token>` and `/c/<token>` landings, the OAuth
  token and authorize endpoints, and photo reads stay with the Docker smoke,
  which keeps proving boot and runtime dependencies.
- **Rule tests live in `scripts/invariants.test.ts`**, one `describe` per
  rule, each comment quoting the `AGENTS.md` sentence, built on the file's
  `filesUnder` and `matchingLines` helpers. The UI-text guard (step 4f) uses
  the TypeScript compiler API (`typescript` is already a devDependency) to
  walk `JsxText` nodes and string-literal `aria-label`, `title`,
  `placeholder`, and `alt` attributes, not a regex, so generics and comments
  cannot false-positive. A scan on 2026-10-05 found only the brand name
  `Sous`, which is the allowlist.
- **The session-gate parity test lives under `test/`.** `tsconfig.api.json`
  has no `allowImportingTsExtensions`, so a test under `api/` cannot import
  `../server/session.ts`; `tsconfig.node.json` includes `test/` and can
  import both sides. The invariant "api/*.ts handlers import no sibling or
  parent modules" exempts test files already.
- **Write checks run last in the test-mode job**, in a new
  `testing/writeSmoke.ts` called from `testing/smoke.ts` after the MCP
  checks, because `testing/mcpSmoke.ts` asserts the member's exact recipe
  total and collection count and the write checks add rows. The write checks
  use fresh UUIDs, prefer the `empty` persona, and read every result back
  through the routes the app uses, as `smoke.ts` does.
- **The deletion script is exercised as the CLI it is**, from a separate
  process (`spawnSync`, as `scripts/invariants.test.ts` already spawns
  `node --check`), so its exit codes and its own "none remains" read-back are
  the assertions. It runs after every other check because it removes the
  viewer persona.
- **The log sweep is pattern-only.** It needs no runtime values: every MCP
  token starts with `sous_at_` or `sous_rt_`, every persona email ends in
  `@sous.invalid`, token-in-path URLs have fixed prefixes, and a logged query
  string shows as `?` inside a `url` field. A hit prints the line number and
  the pattern name, never the line.

## Steps

All steps are `[core]`; nothing touches a screen or catalog.

1. **[core] `server/auth.test.ts`.** Mock `google-auth-library` with a class
   whose `generateAuthUrl`, `getToken`, and `verifyIdToken` read a mutable
   fake the test sets per case, plus `CodeChallengeMethod.S256`; partial-mock
   `./membership.ts` (`accessAllows`, `requireMember`,
   `clearMembershipCache`), `./invites.ts` (`redeemInvite`), `./members.ts`
   (`touchRequestIdentity`), and `./store.ts` (`upsertUser`). Set
   `PUBLIC_ORIGIN`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
   `SESSION_SECRET` in `beforeEach`; sign the transaction cookie with
   `signAuthTx` from `./session.ts`. Cases:
   - `authStart`: 302 to the generated URL; the `sous_oauth` cookie
     round-trips through `verifyAuthTx` with `returnTo` from `safeReturnTo`
     (an open redirect falls back to `/`), and with the invite id only when a
     valid `sous_invite` cookie was presented; `sous_invite` is cleared;
     `generateAuthUrl` gets the three scopes, S256, and
     `include_granted_scopes: false`.
   - Callback refusals, each 400 "Sign-in failed" with both hop cookies
     cleared: no `sous_oauth` cookie; expired or tampered transaction; state
     mismatch, including a different length; missing code (`getToken` never
     called); no `id_token`; nonce mismatch; `email_verified` false; empty
     `sub`; missing email.
   - `error=access_denied` → 302 to `${origin}/settings?signin=cancelled`,
     cookies cleared, no session cookie.
   - `accessAllows` unknown → 503 HTML, no session. Denied without an invite
     → 403 invitation-only HTML naming the email, `touchRequestIdentity`
     called, no session cookie. Denied with an invite: `redeemInvite` ok →
     `clearMembershipCache(sub)` then 302 with a `sous_session` cookie that
     `verifySession` accepts for that sub and email; a dead invite → 403; a
     throwing redeem → 503 and no session.
   - Member → 302 to `${origin}${returnTo}` with the session cookie,
     `upsertUser` and `touchRequestIdentity` called; owner → the same without
     `touchRequestIdentity`. `getToken` receives the transaction's PKCE
     verifier; `verifyIdToken` the client id as audience.
   - On every path, `Set-Cookie` holds a `Max-Age=0` `sous_oauth` and
     `sous_invite`, with `Secure` present exactly when the origin is https.
   - `authSession`: absent → 200 `{user:null}` and no `Set-Cookie`; unusable
     → 200 null plus a cleared session cookie; valid but denied → the same;
     unknown → 503 JSON; ok → the user with `isOwner`, `Cache-Control:
     no-store`, and a fresh cookie only when `shouldRefresh` says so.
   - `authSignout`: 204 and a cleared cookie.
   Check: the file fails if a `respond` path forgets a cleared cookie, which
   is the bug the "never `Response.redirect`" rule exists for.

2. **[core] `scripts/server.dispatch.test.ts`.** Export `apiRoutes` from
   `scripts/server.ts` (no other change). Start one listener with a temp
   `staticRoot` holding `index.html`, `privacy.html`, `sw.js`,
   `assets/app-abc.js`, and `icons/icon.png`, and one with
   `staticRoot: null`; `SESSION_SECRET` set, `PUBLIC_ORIGIN` set, no
   Firestore. Cases:
   - For every row of `apiRoutes`: the wrong method is 405; the right method
     without a cookie is never 404, 500, or 503, and is 401 for every
     `withMembership`-wrapped and `requireMember`-gated route (a table in the
     test lists the expected status per path, so a new route must be added
     deliberately).
   - Prefix routes: `/api/photos/<id>` DELETE 405 and `/api/photos/<id>/x`
     404; the grants, role, revoke, public, and links collection routes 405
     on the wrong method; `/api/public/<token>` POST 405 (GET is excluded, it
     reads Firestore); `/api/nope` 404.
   - MCP: `GET /mcp` and `DELETE /mcp` 405, `POST /mcp` without a bearer 401
     with `WWW-Authenticate`, `/oauth/nope` 404, the two discovery documents
     200 JSON; `/invite/x` POST 405; `/c/join` PUT and `/c/x` POST 405.
   - Static: `/` and `/settings` serve `index.html` as `text/html` with
     `no-cache`; `/privacy` serves `privacy.html`; `/assets/app-abc.js` is
     `text/javascript` and `immutable`; `/missing.css` 404; `POST /` 405;
     `/p` and `/p/abc` carry `Referrer-Policy: no-referrer` and
     `X-Robots-Tag: noindex`; HEAD `/` has the headers and an empty body.
   - Raw paths through `http.request` (a URL parser would normalize them):
     `/../package.json` 400, `/%00` 400, `/%zz` 400.
   - `staticRoot: null`: `/`, `/privacy`, and `/p/x` are 404; API matching is
     unchanged.
   - The catch-all: `vi.mock('../server/sync.ts')` so `syncPull` throws;
     `GET /api/sync/pull` is 500 "Internal error" and `console.error` was
     called; HEAD gives 500 with no body.
   Check: the Docker smoke keeps its fifteen URLs; this test runs the same
   dispatcher in milliseconds on every `npm test`.

3. **[core] `test/sessionGateParity.test.ts`.** Import `sessionSub` from
   `../api/chat.ts`, `signSession`, `signInviteTx`, `signAuthTx`, and
   `signAccessRequestTx` from `../server/session.ts`, and `isAllowed` from
   `../server/allowlist.ts`. One table of cases, and both sides must agree on
   every row: a `signSession` token with an allowed email gives the sub and
   `isAllowed` is true; the same token with the address absent from
   `ALLOWED_EMAILS` gives null and false; allowlists with spaces, trailing
   commas, mixed case, and an empty string; `exp <= now`; `v: 2`; tokens of
   the invite, oauth, and access-request families; a tampered payload; two
   dots; a blank `SESSION_SECRET`. Keep the existing `api/sessionGate.test.ts`
   as it is. Check: changing either copy alone fails the table.

   **Found while building.** The copies differed in one place:
   `server/session.ts` required a numeric `iat` and `api/chat.ts` never read
   it. Not reachable (only a holder of `SESSION_SECRET` can mint such a
   token), but a drift. The owner chose to align them: `api/chat.ts` now
   requires a numeric `iat` too, and the table has rows for a missing and a
   string `iat`.

4. **[core] Invariants** in `scripts/invariants.test.ts`, new `describe`s:
   - a. **Server-rendered routes.** A table of every prefix the dispatcher
     owns outside the SPA (`/api/`, `/invite`, `/c/`, `/mcp`, `/oauth/`,
     `/.well-known/oauth-`, `/p`, `/privacy`, `/terms`, `/about`, `/__test`)
     with the Vite proxy key or `legal-html` branch that serves it and the
     `navigateFallbackDenylist` source that covers it. The test asserts the
     prefix appears in `scripts/server.ts` (so the table cannot go stale),
     the key in `vite.config.ts`, and the denylist entry. Rule: How to run it
     and Public MCP in `AGENTS.md`.
   - b. **Log exclusions.** Every token-in-path prefix (`/invite/`, `/c/`,
     `/p/`, `/api/public/`) matches `LINK_TOKEN_URL` from
     `scripts/logExclusions.ts` for a 43-character token, and the set of such
     prefixes in the dispatcher is exactly that list. Rule: "a new
     token-in-path route must be added to that filter".
   - c. **Import retries.** `MAX_IMPORT_RETRIES` in `server/recipeImport.ts`
     is an integer literal, and no `process.env` read under `server/` names a
     retry variable. Rule: "never an env var".
   - d. **MCP module boundary.** Outside `server/mcp/`, only
     `server/mcp/index.ts` is imported, and `scripts/server.ts` imports
     nothing else from it; the agent boundary test in `test/` is the
     template. Rule: Public MCP, "scripts/server.ts imports only
     server/mcp/index.ts".
   - e. **Sign-in control and route placement.** No `fetch(` with
     `/api/auth/start` under `src/`; `signInHref` is defined once; `api/`
     holds only `chat.ts`, `import.ts`, and tests. Rules: Auth ("never fetch
     from a button") and What this is ("New HTTP routes go in server/").
   - f. **UI text (i18n principle 9).** With `ts.createSourceFile`, walk
     every `.tsx` under `src/screens`, `src/components`, `src/agent`, plus
     `src/App.tsx` and `src/main.tsx`; report each `JsxText` whose trimmed
     text matches `/\p{L}{2,}/u` and each `aria-label`, `title`,
     `placeholder`, or `alt` attribute whose initializer is a string literal
     with letters, minus the allowlist `['Sous']`. Expect `[]`. Character
     references such as `&larr;` are symbols and are stripped first (ten
     back links use one).
   Check: each new `describe` fails with a message that quotes the rule and
   lists `path:line`.

5. **[core] `server/agent/route.test.ts`.** Partial-mock `../membership.ts`
   and the module that exports `loadAgentLibrary`, and assert the gate order
   of `agentPost`: denied 401 and unknown 503 before the body is read; a body
   over `MAX_AGENT_BODY_BYTES` is 413 (reuse the endless-body helper from
   `server/sync.test.ts`, moved to `test/endlessBody.ts`); invalid JSON and
   an invalid shape are 400; no `GEMINI_API_KEY` is 503 before the library
   loads; a throwing load is 503 `storeUnavailable`; a load slower than
   `LIBRARY_LOAD_TIMEOUT_MS` is 503 under fake timers. Check: "membership
   denied must never map to 503; unknown must never map to 401" holds for
   this route too.

6. **[core] Small pure modules.**
   - `server/mcp/log.test.ts`: `withMcpOAuthLog` writes one line with status
     and duration, defaults `outcome` from the status, logs a throw as
     `error` with its numeric status and rethrows a `sanitizedMcpError`;
     `clientHostOf` gives the host of a URL and undefined otherwise;
     `noteHandledError` records the status and prints only the class name.
     Mirror `server/importLog.test.ts`.
   - `server/mcp/recipeView.test.ts`: the exact key set of `toMcpRecipe`
     with every optional field present, and that `photoId`,
     `galleryPhotoIds`, `importCheck`, `lang`, `variantOf`, and `createdAt`
     never appear. A schema lock in the style of `src/lib/recipeStore.test.ts`.
   - `scripts/devPorts.test.ts`: `--port 3101`, `--port=3101`, the env
     fallback, the default, a bare `--port` throwing, and `0`, `70000`, and
     `abc` throwing with the flag or variable name.
     **Found while building:** a bare `--port` at the end of argv was read as
     no flag and fell back to the default port; it now throws "needs a port
     number", like `--port=`.
   - `src/i18n/unitLabel.test.ts`: every `COMMON_UNITS` token maps to its
     key; a custom unit returns as typed.
   - `src/lib/inviteApi.test.ts`: 401 invalidates the session and throws the
     catalog sentence; 503 throws `adminUnavailable`; another status throws
     the server text; 200 without a usable `url` throws; 200 with one
     returns it. Stub `fetch` as `src/lib/remote.test.ts` does.
   - `src/lib/publicApi.test.ts`, add `joinPublicCollection`: a thrown fetch
     is a generic error; 401 and 403 invalidate the session and are
     `signedOut`; 404 is `missing`; 409 is the join-full sentence; a non-ok
     body's message is shown; a 200 with a bad body is an error; a 200 with
     each of `joined`, `already`, and `own` is `ok` with the collection id.
   - `src/lib/session.test.ts`, add `fetchSession`: 401 and 403 are
     `signedOut` and invalidate; a 503 and a thrown fetch are `offline` with
     the cached user kept; 200 with a null user signs out; 200 with a user is
     `signedIn` and writes the cache; a repeated identical user does not
     notify subscribers; two concurrent calls share one fetch and a call made
     from a continuation after the first settles starts a new one (the
     ordering the code comments describe). The file already stubs
     `localStorage` and mocks `./libraryMemory`.

7. **[core] Operator scripts as testable programs.** Keep both filenames
   and their command lines (README and `scripts/invariants.test.ts` name
   `scripts/delete-account-data.ts`).
   - `scripts/delete-account-data.ts`: move the body into
     `export async function runDeleteAccountData(argv, deps)` returning the
     exit code, with `deps` = `{ readSubject, steps, order, allowedRaw, log,
     error }`, and run it only under an `isDirectRun()` guard like
     `scripts/server.ts`. `scripts/delete-account-data.test.ts` with fake
     steps that count `inventory` and `apply` calls: no sub or a path-like
     sub exits 2 before `readSubject`; a dry run calls `inventory` for every
     step in order, never `apply`, prints the refusal note and `N to change`;
     `--apply` with each refusal exits 1 and calls no `apply`; `--apply`
     runs `apply` in `ACCOUNT_DELETION_ORDER` and re-inventories; a non-zero
     leftover exits 1; `--not-owner` lifts only `no-email`.
   - `scripts/apply-log-exclusions.ts`: the same split,
     `runApplyLogExclusions(argv, client)` with a `client.request` fake;
     the ADC client is created inside the direct-run branch, so importing
     the module performs no I/O. Cases: already in place → no PATCH, exit 0;
     dry run → no PATCH; `--apply` → one PATCH with `updateMask=exclusions`
     and `plan.next`, then the re-read; a sink whose destination, filter, or
     disabled flag changed, or whose exclusions do not verify, exits 1.
   Check: `node scripts/delete-account-data.ts` with no argument still
   prints the usage and exits 2.

8. **[core] Write checks in test mode: `testing/writeSmoke.ts`.** Export
   `checkWrites(baseUrl, cookies, check)` and call it from `smoke.ts` after
   `checkMcpEndpoints`. Helpers: `push(cookie, ops)` returning `results`,
   `pull(cookie)`, `shared(cookie)` (all pages), fresh ids from
   `randomUUID`, and a fixture recipe cloned from `memberLibrary(0)` with a
   new id. In this order:
   - **Last-write-wins and tombstones**, as `empty`: put R1 at `t` applied;
     the same put at `t-1` is `stale` with `current`; at `t+1` applied;
     `recipe.delete` at `t+1` applied (tombstone wins at an equal stamp); a
     put at `t+1` is rejected; a put at `t+2` revives it; a final delete
     shows `deletedAt` in the pull. `uid: 'test-member'` and `sub` in an op
     are ignored: the row is in `empty`'s pull and not in `member`'s. 51 ops
     are 413.
   - **Cascade**, as `empty`: recipe R2 with a chat message, a cook row, a
     cook log, and collection C1 listing it; `recipe.delete R2` tombstones
     the children and removes the id from C1; collection C2 shared with
     `viewer` (`POST /api/collections/C2/grants`) appears in the viewer's
     shared pull, and `collection.delete C2` removes it there and makes the
     grants route 404.
   - **Editor and viewer**, as `viewer`: a `shared: true` put on a Weeknights
     recipe (viewer role) is `invalid` and the member's row is unchanged; a
     `shared: true` put on an Owner's picks recipe with a new title and an
     `updatedAt` a year ahead is applied, and the owner's pull shows the
     title with the owner's `id` and `createdAt` and an `updatedAt` clamped
     to about now; a put that adds a `photoId` is `invalid`; `recipe.delete`
     through the share is `invalid`. The owner switches the role to viewer
     (`POST .../grants/role`), the same put is now `invalid`, and switches it
     back. `POST /api/shared/leave` on Weeknights is 200 then 404, and the
     viewer's shared pull drops it; the member re-adds the grant. The owner
     revokes the picks grant (`POST .../grants/revoke`), the viewer's shared
     pull drops it, and the owner re-grants editor, so the fixture state is
     back for step 9.
   - **Collection link lifecycle**: the member mints a viewer link on Baking;
     `GET /c/<token>` with no cookie is 303 to `/c/join` with a
     `sous_collection_link` cookie scoped to `/c` and no token in `Location`;
     as `empty` with the hop cookie, `GET /c/join` is 200 and its form carries
     the link id (sha256 of the token) in the hidden `link` field; a
     same-origin form `POST /c/join` is a 303 home and `empty`'s shared pull
     lists Baking as viewer; posting again changes nothing; a POST with
     `Origin: https://evil.example` is refused and changes nothing; after
     `POST .../links/revoke { id }`, `GET /c/<token>` is the generic 404.
   - **Public join**, as `empty`: `POST /api/public/join` with the Weeknights
     token is `joined`, then `already`; the member's own join is `own`;
     `POST .../public/revoke` makes `GET /api/public/<token>` and the join
     404; turning it back on mints a new token.
   - **Admin flow**, last because of the cache bound: the owner approves
     `outsider`; its session user is non-null and its pull 200 at once (a
     denial is never cached); the owner revokes; the pull is 401 within 65 s
     (poll every 5 s), which is the documented 60-second revocation bound,
     and `/api/admin/requests` lists the sub under denied.
   Check: `node testing/smoke.ts http://localhost:3001` locally against a
   fresh `npm run dev:test` passes every phase; the CI job passes.

   **Found while building.** A stale put answers `applied: false` with the
   stored row and no `reason` (a last-write-wins loss is not a discarded
   write); the check asserts that. The editor role is enforced twice, in
   `orchestrateSharedRecipePut` and in `planSharedRecipePut`, so removing
   one check still refuses a viewer; removing both fails three write
   checks. Admin revoke takes effect at once in one process (the decision
   clears the membership cache); the 65-second poll only bounds it. Locally
   the smoke with writes takes about 16 s and the deletion check about 5 s.

9. **[core] `testing/deletionCheck.ts` and its CI step.** A separate program,
   `node testing/deletionCheck.ts http://localhost:4173`, run by the job
   after `smoke.ts`:
   - sign in as `owner`, `member`, and `viewer`; snapshot the member's and
     owner's owned pulls, their shared pulls, and the grant lists of
     Weeknights and Owner's picks;
   - the owner revokes `viewer` (`POST /api/admin/decision`); the viewer's
     pull is now 401 (poll to the 60-second bound);
   - spawn `node scripts/delete-account-data.ts test-viewer` with
     `FIRESTORE_EMULATOR_HOST` from `emulatorHost(process.env)`,
     `GOOGLE_CLOUD_PROJECT=TEST_PROJECT_ID`, and
     `ALLOWED_EMAILS=OWNER_EMAIL` (the constants in `testing/env.ts`): the
     dry run exits 0 and prints a positive `to change`; `--apply` exits 0 and
     prints that none remains; a second dry run prints `0 to change`;
   - the member's and owner's owned pulls equal the snapshot; the grant
     lists no longer hold the viewer and nothing else changed; the viewer's
     cookie answers 401.
   The workflow step sets `FIRESTORE_EMULATOR_HOST` like the server step;
   the `Logs` step stays `if: always()`. Check: a deletion step that leaves
   a document behind fails the job through the script's own exit 1.

10. **[core] `testing/logSweep.ts` and its CI step.** `node
    testing/logSweep.ts test-server.log` after the deletion check. Patterns,
    each named: `@sous.invalid`; `sous_at_` and `sous_rt_`; `sous_session=`;
    `/invite/`, `/c/`, `/p/`, and `/api/public/` followed by 20 or more
    token characters; a `?` inside a JSON `url` field. A hit prints the
    pattern name and line number only and exits 1. Rule: "No server log line
    may contain an email address or a link token" and the import-log and MCP
    log paragraphs in `AGENTS.md`. Check: appending a line with a persona
    email to a copy of the log makes the sweep exit 1.

11. **[core] Docs.** `AGENTS.md` Tests and verification: the `test-mode` job
    runs `testing/smoke.ts` (reads, MCP, then writes), then the deletion
    script against the emulator, then the log sweep; the plan table row.
    `testing/README.md`, From scripts and browser tests: the three new
    programs and that the write checks and the deletion check change the
    seed, so run them once per fresh start. README Commands: unchanged (no
    new npm script).

12. **[core, owner's call] Coverage report.** Only if wanted: add
    `@vitest/coverage-v8` at vitest's major, a `test:coverage` script with
    `coverage.include` of `server/**`, `src/lib/**`, and `scripts/**` and the
    `text-summary` reporter, and have the `check` job append the summary to
    `$GITHUB_STEP_SUMMARY`. No threshold: the no-DOM policy makes a global
    floor noisy, and a floor on the server and client lib directories is a
    later decision with data.

## Delivery

Three PRs, each green on its own:

1. Steps 1 to 4 and the `AGENTS.md` row from step 11 (unit: sign-in,
   dispatcher, parity, rules).
2. Steps 5 to 7 (unit: agent route, small modules, operator scripts).
3. Steps 8 to 11 (test mode: writes, deletion, log sweep, docs).

Step 12 is its own PR if the owner wants it.

## Risks

- **The sign-in test mocks a class the real flow instantiates once.**
  `getOauthClient` caches the client in module scope, so the fake must be a
  class whose methods read a shared mutable object the test resets in
  `beforeEach`, never a per-test instance.
- **A dispatcher case reaches Firestore by mistake** and hangs until the
  client times out. The test lists the routes it may call; a new route is
  added to the status table, and the table's comment names the Firestore
  routes that stay excluded.
- **The UI-text guard flags something legitimate** (a product name, a unit
  symbol). The allowlist is in the test with a comment per entry; the
  catalogs remain the place for words.
- **Write checks mutate the seed.** They run last, after the MCP checks that
  assert exact counts; the deletion check snapshots live state rather than
  fixtures; a second `smoke.ts` run against the same server already fails
  today and the README says so.
- **The 60-second membership cache** makes the revoke assertions poll. Both
  pollers cap at 65 s and sit at the end of their phase; the job's
  15-minute budget holds (the job took 48 s on its first run).
- **Emulator transaction behaviour differs from production** for contention
  and indexes. The write checks are sequential and prove authorization and
  cascade logic, not index configuration; the production-only checks in
  Cloud and deploy stay where they are.
- **The operator-script split changes files the README names.** Filenames
  and command lines stay; only the body moves under a function and a
  direct-run guard, and the usage check in step 7 proves the CLI still
  answers.

## Verification

- `npm run build` and `npm test` pass; the new files are type-checked by
  `tsconfig.node.json` (`scripts/`, `server/`, `test/`, `testing/`) and
  `tsconfig.app.json` (`src/`).
- Locally: emulator, `npm run dev:test`, then `node testing/smoke.ts
  http://localhost:3001`, `node testing/deletionCheck.ts
  http://localhost:3001`, and `node testing/logSweep.ts <log>` all pass once
  per fresh start.
- The `test-mode`, `check`, and `image` jobs pass on each PR; the image
  smoke is unchanged.
- Each invariant was seen failing once by breaking the rule locally (remove
  a denylist entry, add a JSX word, change the parity copy) and restored.

## Owner steps

None for production. Decide step 12.
