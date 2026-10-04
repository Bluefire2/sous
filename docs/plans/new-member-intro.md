# New-member intro

Status: built on `claude/new-member-intro-plan`, not deployed.

## Goal

The first time a new member reaches their library, a short intro (three steps
in a sheet) says what Sous can do, then gets out of the way:

1. **Bring your recipes in.** Paste a link or recipe text, or take up to four
   photos of handwritten notes; Sous turns it into a clean recipe.
2. **Cook with help.** Ask on any recipe answers questions, scales, swaps
   ingredients and suggests edits; you can dictate instead of typing. The
   assistant works across your whole library, for example to make a shopping
   list. Cooks keeps a log of what you made and how it went.
3. **Organise and share.** Put recipes in collections, share a collection with
   people who use Sous, and invite friends.

The last step ends with **Import a recipe** (primary) and **Look around**
(secondary). Every step has **Skip**. Once closed, the intro doesn't open again
on any device for that account. It can be reopened from Settings.

Why: today a new member lands on "No recipes yet. Import your first one!" and
an add button. Ask, the assistant, collections, sharing and the cook log aren't
visible until there is a recipe, so new members don't find them.

## Out of scope

- A guided tour that highlights real controls (coach marks, spotlights).
- Sample or seeded recipes in a new library.
- Changing the empty-library sentence, the add sheet, or `/about`.
- Mentioning the Chrome extension (not offered beyond the owner) or connected
  AI apps (a niche Settings feature with its own explanation there).
- Signed-out, public (`/p/...`), and non-member screens.
- A "what's new" intro for existing members (a different trigger; its own plan).

## Constitutions applied

- **Client state** (`docs/constitutions/client-state.md`): principle 6 (the
  intro is a Library sheet in the `libraryFlow` reducer) and principles 3 and 5
  (whether the intro was seen is fetched in an effect, never read during
  render).
- **i18n** (`docs/constitutions/i18n.md`): all copy goes in every catalog, and
  the new screens are added to `docs/i18n-review/screens.json`.

No principle is broken, so no amendment is needed.

## Decisions

**D1. Who sees it.** The intro opens on Library when all of these are true:

- the session is `signedIn`;
- the owned pull has finished without an error;
- the member has **no live recipes of their own** (shared rows don't count);
- the account's profile has no `introSeenAt` (D2);
- no other Library sheet is open.

This covers every way a person becomes a member: an invite link, an approved
access request, and owners. It also covers someone who joined only to view a
shared collection (`/c/join`, or joining from `/p`): they have shared recipes
but none of their own, so they see it (owner's call, 2026-10-04).

The no-own-recipes condition is checked on the client first, so existing
members (who have recipes) never cause a request, and no backfill is needed.
An existing member whose library is still empty sees the intro once, which is
what we want.

**D2. "Seen" is stored per account, on the profile.** The new optional field
is `users/{sub}.introSeenAt` (ms since epoch). Closing the intro on any device
sets it, so the intro doesn't open again on another browser or after clearing
site data. (Owner's call, 2026-10-04, over a per-browser localStorage flag.)

- It is a field on the existing profile document, not a new collection, so
  account deletion already removes it (`usersStep` in
  `server/accountDeletion.ts` deletes `users/{sub}`), and
  `FIRESTORE_COLLECTIONS` doesn't change.
- `upsertUser` writes with `merge: true` and never names the field, so signing
  in doesn't clear it.
- It is never synced, pulled, or put in a backup, and it is not a `Recipe`
  field.

**D3. Two small routes** in `server/intro.ts`. Each calls `requireMember`
itself (injected, like `server/grantsHttp.ts`) rather than going through
`withMembership`, whose `authorizedSub` is limited to a fixed list of files by
`server/membership.test.ts`. The `sub` comes from the session only:

| Route | Does | Answers |
| --- | --- | --- |
| `GET /api/intro` | Reads `users/{sub}` | `200 { seen: boolean }`, `Cache-Control: no-store`. A missing profile or field means `seen: false`. Firestore failure: `503`. |
| `POST /api/intro/seen` | In a transaction, sets `introSeenAt` if the profile exists and the field is absent | `204`. A missing profile writes nothing (so it can't create a profile without an email); it is still `204`. Firestore failure: `503`. No body. |

We don't put this in `/api/auth/session`, because that would add a Firestore
read to every session check for every member. The `GET` happens only for
members with no recipes of their own, once per page load.

Neither route writes a log line beyond what the dispatcher already does, and
neither holds a token in the path, so the log exclusion filter doesn't change.
The helpers that read and write the field go next to `upsertUser` in
`server/store.ts`; a pure `introSeenFromProfile(raw)` parses the field and
treats any non-finite or non-positive value as not seen.

**D4. Client calls live in `src/lib/introApi.ts`**, like
`featureRequestApi.ts`; screens don't `fetch`.

- `fetchIntroSeen(): Promise<boolean | null>`: `null` means unknown (network
  error, `503`). Unknown never opens the intro and shows no toast. A `401`
  calls `invalidateSession()`, like the other client APIs.
- `markIntroSeen(): void` sends the `POST` and ignores failures. It also
  records the `sub` in a module-level "closed this page load" set, so a failed
  `POST` can't reopen the intro until the next load. The worst case of a lost
  write is that the intro shows once more on a later visit.
- The "asked this page load" state is kept by `sub` in the same module, so the
  `GET` runs at most once per page load per account, and a sign-out followed by
  a different account's sign-in asks again.

**D5. A Library sheet, not a route.** The intro is
`{ kind: 'intro'; step: 0 | 1 | 2 }` in `LibrarySheet`
(`src/lib/libraryFlow.ts`), drawn with the existing `Sheet` (`DialogShell`
already handles the focus trap, initial focus, restoring focus on close, and
Escape). A `/welcome` route was rejected: the OAuth `returnTo` flows
(`/c/join`, `/p`) would each need to know about it, and the back button would
return to the intro.

**D6. Opening is an effect; the reducer stays pure.** When the D1 client
conditions hold, a Library effect calls `fetchIntroSeen()`. On `false` it
dispatches `openIntro`, but only if Library is still mounted and the session's
`sub` is still the one it asked about. The reducer ignores `openIntro` unless
the sheet is `closed`, so a late answer never replaces a sheet the person
opened while waiting. The fetch is a side effect in an effect, not in the
reducer or render (client-state principles 5 and 6).

**D7. Every close marks it as seen.** Skip, the backdrop, Escape, Look around,
and Import a recipe all call `markIntroSeen()`, then close. Import a recipe
then goes to `importHref(currentCollectionId)`, the same destination as the add
sheet's first button. Reloading in the middle of the intro shows it again;
that's fine.

**D8. Reopening.** Settings gets a **Show the intro** link in the Feedback
section, above About. It goes to `/` with router state `{ intro: true }`.
Library opens the intro when it sees that state, without asking the server and
whatever the library holds. It then clears the state with
`navigate(location.pathname, { replace: true, state: null })` so a reload
doesn't reopen it. Closing it sends the `POST` again, which is a no-op.

**D9. Copy describes only what production has.** Several features the steps
mention are merged but not deployed (photo import, the library assistant,
member invite links). Before the deploy that ships the intro, check each
sentence against what that deploy includes, and remove any clause it doesn't.
Keep each step to a heading and at most two sentences.

**D10. Steps are text, with one icon from `src/lib/icons.tsx`** (`CameraIcon`,
`ChatBubbleIcon`, `FolderIcon`). No images or illustrations, so nothing needs
translating per locale and nothing grows the bundle.

## English copy (draft)

The draft for `src/i18n/en.ts`. Button and screen names match the existing
labels: **Ask** (`recipe.ask`; the chat-bubble icon at the top of the
library is `assistant.ask`), **Log a cook** (`recipe.logACook`), **Invite**
(`library.inviteLink`), and the import wording of `library.importFromLink` and
`import.photoHint`. Quotes use the curly `“ ”` the catalog already uses.

| Key | Text |
| --- | --- |
| `intro.welcome` | Welcome to Sous |
| `intro.stepOf` | Step {n} of {total} |
| `intro.importTitle` | Bring your recipes in |
| `intro.importBody` | Paste a link or a recipe's text, or add up to 4 photos of handwritten notes. Sous turns it into a clean recipe you can edit. |
| `intro.cookTitle` | Cook with help |
| `intro.cookBody` | On any recipe, tap Ask for substitutions, timing, or a second opinion on how it's going. Type or dictate, and when you're done, Log a cook to keep notes for next time. |
| `intro.shareTitle` | Plan and share |
| `intro.shareBody` | The chat bubble at the top of your library looks across all your own recipes: try “What can I make tonight?” or ask for a shopping list. Put recipes in a collection to share them, or tap Invite to bring a friend to Sous. |
| `intro.back` | Back |
| `intro.next` | Next |
| `intro.skip` | Skip |
| `intro.importCta` | Import a recipe |
| `intro.lookAround` | Look around |
| `settings.showIntro` | Show the intro again |

`intro.welcome` sits above each step's title as a small label. Clauses to cut
if their feature isn't in the deploy that ships the intro (D9): "or add up to 4
photos of handwritten notes" (photo import), the whole first sentence of
`intro.shareBody` (the library assistant), and "or tap Invite to bring a
friend to Sous" (member invite links). An owner always has Invite, but most
people who see the intro are members.

## Steps

1. **[core]** `server/store.ts`: `readIntroSeen(sub)` and
   `markIntroSeen(sub, now)` (transaction; no write when the profile is
   missing or the field is already set), plus the pure `introSeenFromProfile`.
   Unit tests for the pure parts.
2. **[core]** `server/intro.ts`: `introGet` and `introSeenPost` (D3), and two
   lines in the route table in `scripts/server.ts`. Neither lets the original
   error escape: a Firestore failure is `503`, and only its gRPC code is
   logged. Unit tests for the response mapping, with the store
   functions passed in so no emulator is needed.
3. **[core]** `src/lib/introApi.ts` (D4) with tests for the status mapping
   (`200`, `401`, `503`, network error) and the per-`sub` page-load state.
4. **[core]** `src/lib/libraryFlow.ts`: add the `intro` sheet kind, plus
   `openIntro` (only from `closed`) and `introStep { step }` (clamped to 0–2).
   Opening it bumps `token` like any other sheet. Add reducer tests in
   `libraryFlow.test.ts`, including `openIntro` while `add` is open (no
   change).
5. **[core]** A selector in `src/lib/librarySelectors.ts` that says whether
   the member has any live recipe of their own (no shared origin), and a pure
   `shouldAskAboutIntro({ sessionStatus, sync, hasOwnRecipe,
   sheetClosed })` in `src/lib/intro.ts`. Unit tests cover "only shared
   recipes" (ask) and "one own recipe" (don't ask).
6. **[ui]** `src/components/IntroSheet.tsx`: one step at a time (icon, heading,
   body), "Step {n} of {total}", Back / Next, and Skip; the last step shows
   Import a recipe and Look around instead of Next. On a step change, focus
   moves to the step heading (`tabIndex={-1}`) so screen readers read it. No
   animation.
7. **[ui]** `src/screens/Library.tsx`: the effect from D6, the router-state
   handling from D8, render `IntroSheet` for `sheet.kind === 'intro'`, and a
   close handler that calls `markIntroSeen()` then dispatches `close`.
8. **[ui]** `src/screens/Settings.tsx`: the Show the intro link (D8), shown
   only when signed in.
9. **[ui]** `intro.*` keys and `settings.showIntro` in `src/i18n/en.ts`, `uk.ts`,
   `ru.ts` and `zh-Hans.ts`. Each sentence is one catalog string; "Step {n} of
   {total}" is one string with params. Add `intro-step-1`, `intro-step-2` and
   `intro-step-3` to `docs/i18n-review/screens.json`, with setup notes
   ("Settings → Show the intro"; that works on any account, so these screens
   don't need an empty library).
10. **[ui]** `public/privacy.html`: where it says sign-in associates your
    `sub`, email address and display name with your library, add that the
    profile also records when you closed the welcome intro. `/terms` lists no
    profile fields and doesn't change.
11. **[ui]** Add a row to the Plans table in `AGENTS.md`.

## Verification

- `npm test` and `npm run build`.
- In test mode (`npm run dev:test` + `npm run dev`; test sign-in writes the
  persona's profile, so `introSeenAt` round-trips through the emulator):
  - `empty`: the intro opens once the library loads. Step through it, check
    Back, Next and focus, and use Import a recipe to land on `/import`.
    Reload: it doesn't reopen.
  - Per account: as `empty`, close the intro, then sign in as `empty` again in
    a second browser profile (or after clearing site data). It doesn't open.
    Restart `dev:test` (which reseeds) and it opens again.
  - Skip, Escape and the backdrop each set `introSeenAt` (check by reloading).
  - `member`, `owner`, `viewer` (each has recipes of their own): it never
    opens, and the network panel shows no `GET /api/intro`. Settings → Show
    the intro opens it on `/`, and reloading doesn't reopen it.
  - Viewer-only member: as `empty`, before closing the intro anywhere, join
    `member`'s public "Weeknights" link from `/p`. The library shows the shared
    recipes, and the intro opens.
  - Unknown: stop the emulator after the library loads and reload. The intro
    doesn't open and no error toast appears.
  - With the add sheet already open when `GET /api/intro` answers, the intro
    doesn't open over it.
- `npm run click:library` still passes (it signs in as `member`).
- Narrow phone width and dark mode: the sheet fits without horizontal scroll,
  and the buttons don't wrap awkwardly in `uk`/`ru` (the longest strings).
- Before the PR: the in-context translation review
  (`docs/i18n-review/README.md`) for the three intro screens and Settings in
  `uk`, `ru` and `zh-Hans`.

The translation review runs as `npm run test:i18n` (`testing/i18n-review/`).
The three intro steps are scripted there from Settings as `member`, and the
two empty-library states use the `introSeen` mock, so they still show the
empty library and nothing closes the intro. Task run on 2026-10-04 over
`intro-step-1..3`, `settings`, `library-empty` and
`library-collections-empty`: 18 judged, 0 blockers, 0 nits; `--repeat 2`
found every capture deterministic.

No check here needs `dev:api` or a real Google sign-in.

## Rollout

No owner step. Existing members with recipes never see the intro; existing
members with an empty library see it once after the deploy.
