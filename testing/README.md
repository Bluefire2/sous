# Test mode

Test mode runs Sous signed in, without a Google account and without
production Firestore. The app talks to a local Firestore emulator, which test
mode wipes and fills with fixture data each time it starts. You sign in as a
fake persona from a page at `/__test/`.

Use it for clicking through flows by hand, for browser automation, and for
anything that would otherwise write to the real library. The design and the
safety rules are in [docs/plans/test-mode.md](../docs/plans/test-mode.md).

## One-time setup

1. **Java 25 or later.** The Firestore emulator is a Java program. Java 21
   still runs, with a warning that newer gcloud releases drop it.
2. **The Google Cloud CLI and its Firestore emulator component.**

   ```bash
   gcloud components install cloud-firestore-emulator
   ```

   The first `gcloud emulators firestore start` also offers to install it. On
   the owner's machine `gcloud` is not on `PATH`; run it by its full path
   (`AGENTS.md`, Cloud and deploy).
3. **`npm ci`**, as for normal development.

No `.env.local` is needed. If you have one, test mode reads only
`GEMINI_API_KEY` and the model settings from it and ignores everything else
(see [What test mode changes](#what-test-mode-changes)).

## Run it

Three terminals:

```bash
gcloud emulators firestore start --host-port=127.0.0.1:8085
```

```bash
npm run dev:test
```

```bash
npm run dev
```

`npm run dev:test` replaces `npm run dev:api` on port 3001; Vite on 5173 is
unchanged. Wait for `Test mode ready`, then open
<http://localhost:5173/__test/> and pick a persona.

To switch persona, open `/__test/` again and pick another; the new session
replaces the old one. Sign out from Settings as usual.

### Options

| Command | What it does |
| --- | --- |
| `npm run dev:test` | Wipes the emulator, seeds it, serves the API on 3001. |
| `npm run dev:test -- --keep` | Keeps whatever is in the emulator; no wipe, no seed. Use it to keep your own clicks across restarts. |
| `npm run dev:test -- --static` | Also serves the built `dist/` on 4173, with no Vite. Run `npm run build` first. Open <http://localhost:4173/__test/>. |
| `npm run dev:test -- --port 4000` | Another port. In API mode, start Vite with `npm run dev -- --api-port 4000` so it proxies there. |

The emulator is expected at `127.0.0.1:8085`. To use another port, start the
emulator there and set `FIRESTORE_EMULATOR_HOST` to the same address. In
PowerShell:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:9000'; npm run dev:test
```

In bash, `FIRESTORE_EMULATOR_HOST=127.0.0.1:9000 npm run dev:test`. The value
must be `localhost`, `127.0.0.1`, or `[::1]` with a port; anything else is
refused.

## Personas

| Persona | Who | What they have |
| --- | --- | --- |
| `owner` | `owner@sous.invalid`, the owner (`ALLOWED_EMAILS`) | `/admin` with pending, approved, and declined requests and one unused invite link; 2 recipes; "Owner's picks", shared with `viewer` as editor |
| `member` | `member@sous.invalid`, an approved member | 8 recipes (English, Ukrainian, Chinese, one with no language, one with import warnings, one a variant of another, one with steps in two lanes); "Weeknights" (shared with `viewer`, public link on) and "Baking" (not shared); two unfiled recipes; cook progress, two cook-log entries, a chat thread; one connected AI app |
| `empty` | `empty@sous.invalid`, an approved member | Nothing: the empty library and the first-collection prompt |
| `capped` | `capped@sous.invalid`, an approved member | No recipes, and today's AI budget used up: Ask, the assistant, import, translation, and dictation all answer the daily limit (until UTC midnight) |
| `viewer` | `viewer@sous.invalid`, an approved member | 1 recipe; views `member`'s "Weeknights"; edits `owner`'s "Owner's picks"; an Ask thread ending in a proposal on one recipe from each |
| `outsider` | `outsider@sous.invalid`, not admitted | A pending access request. Sign-in lands signed out, as for a real non-member. |
| `declined` | `declined@sous.invalid`, not admitted | A declined access request. Same as `outsider`. |

Recipe ids are fixed; `GET /__test/personas` lists them under `fixtures`, and
`testing/fixtures.ts` defines them. The seed writes no photos.

Dates are relative to when the seed ran ("cooked 3 days ago"), so they read
the same every run.

## What works and what doesn't

| Works | Off in test mode |
| --- | --- |
| Library, collections, sharing, public links, cook mode, cook log, chat history, `/admin`, invites, Settings, connected apps | **Google sign-in.** The normal sign-in button fails; use `/__test/`. |
| Writes of every kind; they go to the emulator | **Photos.** There is no Cloud Storage emulator, so uploading answers "storage unavailable". |
| Import, Ask, translation, dictation, and the assistant, **if** `GEMINI_API_KEY` is set | **Email.** Approval and access-request emails are skipped. |

With `GEMINI_API_KEY` in `.env.local`, or in the shell, model calls are real
and cost what they normally cost. Without it they fail the way they do in dev
without a key.

## From scripts and browser tests

- **Sign in** by navigating to
  `/__test/sign-in?as=<persona>&returnTo=<path>`. It answers `303` with a
  `sous_session` cookie and redirects to `returnTo` (a same-origin path;
  default `/`). An unknown persona is `404`.
- **Wait for the seed** by polling `GET /__test/personas`: it answers `503`
  until the seed is done, then `200` with the personas, fixture ids, and
  (after a fresh seed, not `--keep`) the member's MCP access and refresh
  tokens.
- **Without Vite**, run `node testing/test-server.ts --static --port 4173`
  after `npm run build`; the app and `/__test/` are on one origin.
- `testing/library-click-through.ts` (`npm run click:library`) drives the
  library in Chrome with Playwright as `member`; see its header.
- `testing/smoke.ts` is a working example: it signs every persona in with
  `fetch` and reads back what each one should see, with the expected values
  taken from the fixtures. It also calls the MCP server: discovery, authorize
  and token errors, `/mcp` with the seeded member tokens (search, get, list
  collections, create, edit, conflict, move into a collection), refresh narrowed to read-only, and
  disconnect. The `test-mode` CI job runs it; run it yourself with
  `node testing/smoke.ts http://localhost:3001`. Those MCP checks create a
  recipe and disconnect the seeded app, and they need the tokens from this
  process's seed, so run the script once after a fresh start. It fails
  against `--keep`, and a second run against the same server fails too.
  Last, it runs the write checks in `testing/writeSmoke.ts`: last-write-wins
  and tombstones, the recipe delete cascade, editor and viewer rules, the
  collection-link hop, public join, and admin approve and revoke. They add
  rows and change roles and put them back.
- `node testing/deletionCheck.ts http://localhost:3001` runs the real
  `scripts/delete-account-data.ts` on the `viewer` persona against the
  emulator and checks that only the viewer's data went. It removes the
  viewer, so run it after `smoke.ts` and restart before anything else.
- `node testing/logSweep.ts <log>` checks the server's output for persona
  emails, MCP tokens, session cookies, link tokens, and query strings in a
  logged URL. Redirect the server's output to a file to use it.

## Reviewing translations

The in-context translation review, `npm run test:i18n`, runs against
`node testing/test-server.ts --static --port 4173`: see
`docs/i18n-review/README.md` for how to run it and what it reports, and its
"Without the suite" section for reviewing a screen by hand here. Start the
server fresh first; the smoke script above changes the seed.

It needs Playwright's Chromium, installed once with
`npx playwright install chromium`. If that download stalls while `curl`
fetches the same URL fine, download the archives the install names with
`curl`, serve them from a local directory with the same paths, and point
the install at it with `PLAYWRIGHT_DOWNLOAD_HOST=http://localhost:<port>`.

## What test mode changes

Test mode is `testing/test-server.ts`, a separate entrypoint around the same
server as `dev:api`. It changes no app code. It:

- signs sessions with a test-only secret, so its cookies never work against
  production;
- sets the owner to `owner@sous.invalid`, the project to `demo-sous`, and
  clears the photo bucket, email, and Google sign-in settings, whatever
  `.env.local` says (the full table is `ENV_TREATMENT` in `testing/env.ts`);
- listens on `127.0.0.1` and `::1` only, never on your network.

It refuses to start when the emulator address is not local, when no emulator
answers, on Cloud Run, or with `NODE_ENV=production`. None of `testing/` is in
the production image.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `No Firestore emulator answered at http://127.0.0.1:8085/` | Start the emulator (the command is in the message), or set `FIRESTORE_EMULATOR_HOST` to where it runs. |
| `FIRESTORE_EMULATOR_HOST must be localhost, 127.0.0.1, or [::1]` | You set a non-local address. Test mode only runs against a local emulator. |
| `--static serves dist/, which has no index.html` | Run `npm run build`. |
| `EADDRINUSE` | Something already uses the port, often `npm run dev:api`. Stop it; test mode replaces it. |
| `/__test/` answers `Not found` | `dev:api` is running instead of `dev:test`. Stop it and run `npm run dev:test`. |
| Every persona lands signed out | Either you signed in before the seed finished (the picker waits for it, but a saved `/__test/sign-in` link does not; wait for `Test mode ready`), or you ran `--keep` against a restarted emulator, which keeps nothing, so no persona is admitted. Restart `dev:test` without `--keep`. (`outsider` and `declined` always land signed out.) |
| Java warning about JRE 21 | Install Java 25 or later. |
