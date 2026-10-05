# MCP: file recipes into collections

**Status:** built on `claude/mcp-collection-writes`, not deployed. Extends
`docs/plans/mcp-server.md`, which shipped `create_recipe` as Unfiled only and
no collection writes.

Constitutions applied: `docs/constitutions/i18n.md` (the Settings intro
changes in all four catalogs and is reviewed in context; the consent page
stays English under principle 9). Client state does not apply: the client
picks up the new membership on its next pull, as from another device.

## Goal

A connected AI app can save a new recipe straight into one of the member's
own collections, and move existing recipes between collections or back to
Unfiled.

## Decisions

- **Two changes, both `recipes:write`.**
  - `create_recipe` takes an optional `collectionId` (an id from
    `list_collections`, or `"unfiled"`, the default).
  - A new tool, `move_recipes`: `{ ids, collectionId }`, 1 to 20 own recipe
    ids, and a collection id or `"unfiled"` to take them out of every
    collection.
  No new scope: filing is part of editing your library. The consent page's
  write line says so, including that a collection may be shared and that a
  public collection never receives recipes (editing a recipe that is already
  in one, or moving it out, is still allowed, so the copy never says public
  collections are untouched).
- **Same membership rule as the app.** A recipe belongs to at most one
  collection (the smallest id wins if two lists hold it). A move appends to
  the destination, keeping ids it already lists in place, and removes the
  ids from every other live collection: `moveRecipes` in
  `src/lib/collectionMembership.ts`, ported to `server/mcp/collectionMove.ts`
  because the server does not import `src/`.
- **All or nothing, in one transaction.** Every id must be a live recipe in
  the member's own tree (else `not_found` with `missingIds`, nothing
  written). The destination must be a live collection of theirs (else
  `not_found`; a value that is neither "unfiled" nor a UUID is `invalid`,
  added in #150), with room under the 500-recipe cap (else `invalid` on
  `collectionId`). A create into a collection writes the recipe and the
  collection together, so a refusal leaves no Unfiled stray.
- **Public collections are refused (owner's decision, 2026-10-02).** A
  destination with a live public link (`publicLinks`) is `not_allowed`, and
  the message tells the model to ask the user to do it in the app. Anyone on
  the web can read a public collection, and recipe text the model reads may
  come from any imported page. The check reads the live links inside the
  write transaction, so it cannot race the owner turning a link on (that
  transaction reads the collection doc this one writes). Collections shared
  with members or by a join link are allowed, and so is moving out of a
  public or shared collection.
- **The model is told who is affected on both sides.** The result carries
  `sharedWithMembers` (live member grants) and `joinLinkOpen` (an unexpired
  join link is out, even with 0 members) for the destination, and
  `removedFrom` lists every collection the recipes left, with the same
  fields and `public`. These are reads in the write transaction; a join-link
  or public row that cannot be parsed counts.
- **`list_collections` shows each collection's sharing** (`public: true`,
  `sharedWithMembers`, `joinLinkOpen: true`) from two owner-wide queries
  (public links, join links) and one grants read per collection, so the
  model can avoid public ones and check with the user before emptying a
  shared one. (Added after review: a move out of a shared collection, or
  into one with an open link and no members yet, used to look like any
  other success.)
- **Server-stamped times.** Each changed collection gets `updatedAt =
  max(now, stored + 1)` (`nextRecipeUpdatedAt`) and `serverUpdatedAt = now`,
  and keeps its other stored fields. `now` is read inside each transaction
  attempt: a retried attempt must not stamp a `serverUpdatedAt` older than
  writes that committed meanwhile, or a device whose pull cursor already
  passed it would never see the move. Recipe documents and their versions are
  untouched by a move. Like an edit from a second device, a phone that edits
  the same collection before it pulls can overwrite the list (LWW is the
  product).
- **Logs.** New outcome `not_allowed`; the line stays tool name, outcome and
  counts, never ids or names.

## Steps

1. [core] `collectionsColRef` in `server/store.ts`; `server/mcp/collectionMove.ts`
   (pure `planCollectionMove`, then `moveOwnRecipes` and
   `createOwnRecipeInCollection` transactions, both through
   `runCollectionWrite` over a `CollectionTxPort`); `listLivePublicCollectionIds`
   in `server/publicLinks.ts`. Tests for the planner, and for
   `runCollectionWrite` over a fake port that refuses a read after a write.
2. [core] Tools: `move_recipes`, `collectionId` on `create_recipe`, `public`
   on `list_collections`, the `not_allowed` code, scopes, server
   instructions, tool tests.
3. [core] Consent page write line; `/privacy` and `/terms`; AGENTS.md Public
   MCP; `docs/plans/mcp-server.md` pointer.
4. [ui] Settings intro sentence in all four catalogs; in-context review of
   the Connected apps states.

## Verification

- `npm test`, `npm run build`.
- Against production through the connected app, with the owner's go-ahead:
  create a throwaway recipe into a private collection, move it to Unfiled
  and back, try a public collection (expect `not_allowed`), then delete the
  recipe in the app.
