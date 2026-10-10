# Public collections

Status: built on `claude/read-only-unauthenticated-mode-204be2`, not deployed. The
log exclusion that covers public links is not applied yet (see Owner steps; it must
be applied before the deploy).

Constitutions applied: `docs/constitutions/client-state.md` (public screens keep
their data in component state, never in `libraryMemory`; RecipeView's access and
shared-by reads are unchanged by the extraction) and `docs/constitutions/i18n.md`
(new copy in all four catalogs; the locked translate chip is the recipe's one
translate control, principle 3). No principle is broken.

## Goal

An owner can make a named collection readable by anyone with a link, signed in or
not. A visitor reads recipes and photos and can use cook mode on the page, but
cannot change anything or use any AI feature. The AI controls are shown grayed out:
hover or keyboard focus explains why, and a tap opens a sheet that offers sign-in
(visitor) or adding the collection (signed-in member).

## Out of scope

- Discoverable or indexed collections. A link is unlisted: a random token, pages
  send `X-Robots-Tag: noindex`, and nothing lists public collections.
- Open sign-up. "Create an account" stays the invitation-only path: sign in with
  Google, then request access on the server's invitation-only page.
- Rate limiting. The routes are unauthenticated; see Risks and
  [Bluefire2/sous#119](https://github.com/Bluefire2/sous/issues/119).
- Public single recipes, the default collection, or editor access by link.

## Decisions

- **Separate surface (option A).** A visitor exists only in two server routes and
  three screens. Library, sync, session, and every existing screen keep their
  meaning: signed out still means an empty library, and 401 still means denied.
- **One live link per collection, stored with its token.** Firestore
  `publicLinks/{sha256(token)}`: `ownerSub`, `ownerEmail` (copied onto grants at
  join, never sent to a visitor), `collectionId`, `token`, `status`
  (`live` | `revoked`), `createdAt`, `revokedAt?`. Unlike a collection link the token
  is stored, so the owner can copy the link again. On is idempotent; off revokes;
  on again mints a new token. No expiry.
- **Every read rechecks the chain.** Live link → owner still admitted
  (`sharingOwnerAdmitted`, unknown is 503) → live collection → recipe listed in it
  and live → (for a photo) photo listed on that recipe. Nothing is cached, so
  turning a link off wins on the next request. Every dead end is one generic 404.
- **Collection delete revokes the link** in the same transaction as the grant
  cascade (`deleteCollectionWithGrants`), so an undeleted collection does not come
  back public.
- **What a visitor gets.** `{ collection: { id, name }, recipes }` with recipes in
  collection order through `compactRecipeFields` minus `importCheck`. Never an
  email, `sub`, chat, cook row, or cook log.
- **Token never leaves the path it lives in.**
  - Page `/p/<token>` and reads under `/api/public/<token>` send
    `Referrer-Policy: no-referrer`; the PWA service worker never serves `/p`.
  - Sign-in from a public page returns to `/p`, and the token waits in that tab's
    sessionStorage; the OAuth start URL and cookie never carry it.
  - Join posts the token in the body (`POST /api/public/join`).
  - The `link-token-requests` log exclusion now also matches `/p/` and
    `/api/public/` (`scripts/logExclusions.ts`).
- **Members join as viewers** through the same code as a viewer collection link
  (`orchestrateCollectionLinkRedeem` via `server/publicJoin.ts`): same grant pair,
  same 20-grant cap, an existing grant keeps its role, the owner writes nothing.
  After joining, the client pulls and opens `/collections/<id>`; Ask and chat then
  run through the ordinary share chain. A public link alone never authorizes AI.
  Like any grant, the join copies the owner's email onto it, so the member then
  sees who shared the collection; `/privacy` says so.
- **Cook mode on a public recipe** (servings, ticks, current step) lives in the
  screen's state only. A visitor has no cook row to save to.

## Routes

| Route | Auth | Handler |
| --- | --- | --- |
| `GET/HEAD /api/public/<token>` | none | `publicGet` (snapshot) |
| `GET/HEAD /api/public/<token>/recipes/<id>/photos/<id>` | none | `publicGet` (photo) |
| `POST /api/public/join` `{ token }` | member | `publicJoinPost` |
| `GET /api/collections/:id/public` | owner | `collectionPublicLinkGet` → `{ url }` |
| `POST /api/collections/:id/public` | owner | `collectionPublicLinkPost` (on) |
| `POST /api/collections/:id/public/revoke` | owner | `collectionPublicLinkRevokePost` (off) |

Client routes: `/p/:token` (`PublicCollection`), `/p/:token/r/:recipeId`
(`PublicRecipe`), `/p` (`PublicReturn`). Owner UI: the Public pane in
`ShareCollectionSheet` (`PublicLinkPane`).

## Files

- Server: `server/publicLinks.ts` (records, read chain, Firestore),
  `server/publicJoin.ts` (join; kept apart so `grants.ts` can import
  `publicLinks.ts`), `server/publicLinksHttp.ts`, `storedPhotoResponse` in
  `server/photos.ts`, the cascade in `server/grants.ts`, routing and `/p` headers in
  `scripts/server.ts`.
- Client: `src/lib/publicApi.ts`, `src/lib/usePublicCollection.ts`,
  `src/lib/usePublicJoin.ts`, `src/components/LockedAi.tsx`,
  `src/components/PublicLinkPane.tsx`, `src/screens/Public*.tsx`, and
  `src/components/RecipeBody.tsx` (display parts extracted from `RecipeView`, shared
  by both recipe screens).
- Guards: `scripts/invariants.test.ts` checks that public screens import no AI or
  library-writing module and that the public server modules import no model code.

## Risks

- **Cost and abuse.** The visitor routes need no session and there is no rate
  limiting. Each snapshot read costs the link, the owner's profile and membership,
  the collection, and one batched read of its recipes; each photo, a handful of
  reads plus GCS egress. The unguessable, unlisted link keeps this low. If a link
  spreads, turn it off; if that becomes routine, add a per-IP limit or Cloud Armor.
  Tracked in [Bluefire2/sous#119](https://github.com/Bluefire2/sous/issues/119).
- **Recipe content.** An owner can publish recipes they copied from elsewhere.
  `/terms` asks them to publish only what they may share.

## Owner steps

1. **Before the deploy**, apply the widened log exclusion (dry run first):

   ```
   node scripts/apply-log-exclusions.ts
   node scripts/apply-log-exclusions.ts --apply
   ```

   `/privacy` (Server logs) promises that public-link requests are left out.

2. **Account deletion request.** `publicLinks` is classified in
   `server/accountDeletion.ts` and deleted by `ownerSub` with the rest of the
   account by `scripts/delete-account-data.ts` (README.md, manual deletion
   procedure). No separate step.

## Verification

- `npm run build`, `npm test` (new: `server/publicLinks.test.ts`,
  `server/publicLinksHttp.test.ts`, `src/lib/publicApi.test.ts`, the collection-delete
  revoke in `server/grants.test.ts` (`deleteRevokingPublicLinks`), the log-exclusion
  cases, and two invariants).
- In the browser, with `dev` and `dev:api`: as the owner, turn a test collection
  public, copy the link, open it in a private window (signed out): recipes and
  photos load; the assistant, Ask, and translate controls are gray, show the hint
  on hover, and open the sign-in sheet on tap; the network panel shows no request to
  `/api/sync`, `/api/chat`, `/api/translate`, `/api/stt`, or `/api/agent`. Turn the
  link off and reload: the generic "link doesn't work" page. As a second member,
  Add to my library opens the collection in the library.
- In-context translation review (`docs/i18n-review/README.md`) for the screens in
  `docs/i18n-review/screens.json` whose ids start with `public-` and
  `share-sheet-public`, before the PR.
