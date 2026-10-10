# Recipe links

Status: built on `claude/recipe-level-sharing-d8ffdf`.

Constitutions applied: `docs/constitutions/i18n.md` (new copy in all four
catalogs as whole sentences with named params; `public.missing` and
`public.loadFailed` reworded to cover both kinds of link; the shared copy keeps
the recipe's `lang`; `recipeForChat` strips `savedFrom`) and
`docs/constitutions/client-state.md` (public screens keep the snapshot in
component state; saving goes through `usePublicSave`, which only pulls after
the server wrote; `saveRecipe` carries `savedFrom` from the stored recipe like
`variantOf`). No principle is broken.

## Goal

Share one recipe without sharing a collection. The owner turns on an unlisted
link per recipe. Anyone with it reads the live recipe, signed in or not, and
sees the sharer's Google display name. A signed-in member can save a copy into
their own library; that copy is theirs.

## Decisions

- **Copy, not a grant.** Recipe-level grants would add a second authorization
  path ("share → recipe") beside "share → collection → listed recipe" in shared
  pull and its scope digest, shared photos, viewer chat and cook rows, the
  editor put, leave and revoke, and account deletion. A copy gives the
  recipient Ask, chat, the cook log, photos, variants, and MCP with none of
  that. What is lost is live updates; a collection share keeps those.
- **Same URL space as public collections.** `/p/<token>` and
  `/api/public/<token>[/recipes/<id>/photos/<id>]` serve both kinds; the
  server tries `publicLinks` first, then `recipeLinks`. The no-referrer pages,
  the `link-token-requests` log exclusion, the PWA denylist, the Vite
  middleware, `TOKEN_PAGES`, and `testing/logSweep.ts` cover recipe links
  unchanged. The visitor body says which kind it is: `{ kind: 'collection', … }`
  or `{ kind: 'recipe', recipe, sharedBy? }`.
- **Storage.** Top-level `recipeLinks/{sha256(token)}`: `ownerSub`,
  `ownerEmail` (never sent to a visitor), `ownerName?` (the profile's Google
  display name, refreshed when the owner turns the link on), `recipeId`,
  `token`, `status`, `createdAt`, `revokedAt?`. At most one live link per
  recipe; on is idempotent, off revokes, on again mints a new token. Deleting
  the recipe revokes its links in the delete transaction
  (`cascadeRecipeDelete`), so an undelete never reopens one. Personal
  top-level: `scripts/delete-account-data.ts` removes them.
- **Recheck on every read.** Live link → admitted owner → live recipe (→ photo
  listed on it). Nothing is cached; one generic 404.
- **Owner routes.** `GET|POST /api/recipes/:id/public`, `POST
  /api/recipes/:id/public/revoke`, cookie session, own live recipe only (404
  for anyone else, including a member who reaches it through a share).
- **Saving a copy.** `POST /api/public/save { token }`, admitted member. The
  copy's id is `uuid(sha256(saver, sha256(token)))`, so one copy per member per
  link: a live copy answers `already` and opens it; a copy the saver deleted
  is written again past its tombstone. The owner's own link answers `own`.
  The copy is Unfiled, has the visitor fields (`publicRecipeBody`: no
  `importCheck`, `variantOf`, or `savedFrom`), and `savedFrom = { name?,
  savedAt }`. Photos are copied server-side (`copyPhotoBetweenOwners`: upload
  intent, GCS copy, confirm) onto new ids; one that fails is left off the copy.
  Per-member, per-instance limit of 30 saves an hour (429
  `recipe-save-rate-limited`). One `event: 'recipe_link_save'` log line: `sub`,
  result, status, photo counts, timing; never the token, recipe, or a name.
- **`Recipe.savedFrom`** is the fourth deliberate schema addition (after
  `lang`, `importCheck`, `variantOf`). Only the server sets it; `saveRecipe`
  keeps the stored value; an editor's put keeps the owner's; Ask variants do
  not carry it. It is stripped from public bodies, shared pull, and chat, so
  only the saver sees it.

## Steps

1. [core] `server/recipeSavedFrom.ts` (+ `src/lib` re-export), `Recipe.savedFrom`,
   both compactors, strip and pin points, schema-lock tests.
2. [core] `server/recipeLinks.ts`, `recipeLinksHttp.ts`, `recipeLinkSave.ts`,
   `copyPhotoBetweenOwners` in `server/photos.ts`, visitor GET in
   `publicLinksHttp.ts`, revoke in `cascadeRecipeDelete`, routes in
   `scripts/server.ts`, account deletion registry.
3. [ui] Share on an own recipe opens `ShareRecipeSheet` (as text, or as a
   link through the generalized `PublicLinkPane`); `/p/:token` dispatches to
   `PublicSharedRecipe`; `AiLockedSheet` takes a member action; the "Shared by
   … · saved …" line on the copy.
4. [core] Test mode: the seed turns on a link for Overnight oats; read checks in
   `testing/smoke.ts`, save/revoke checks in `testing/writeSmoke.ts`.
5. [ui] i18n review states; `/privacy`, `/terms`, AGENTS.md.

## Verification

Unit tests for the chain, the save planner, the HTTP handlers, and the field.
Test mode (`--static`): smoke, log sweep, deletion check, and a browser pass
(owner share sheet, signed-out preview, member save, locked sheet, the copy's
line, the collection pane after the refactor). The photo copy needs the real
bucket, which test mode does not have.
