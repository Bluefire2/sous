# Library assistant: create a collection

**Status:** built, not deployed. The library assistant proposes a new owned collection; the person applies it on the card.

**Constitutions applied:** client state (`docs/constitutions/client-state.md`: the new collection and the stripped source lists publish together through `writeCollections`) and i18n (`docs/constitutions/i18n.md`: every new string is in all four catalogs and `screens.json`).

**Trust boundary:** `propose_create_collection` emits a `collection_create` proposal card only. The person taps Create; `collectionStore.createWithRecipes` creates the collection and files the given recipes through one `pushOps`. The server applies those ops one by one, not in a transaction, so the new collection's put goes first: a cap rejection then lands before any source collection is stripped. The agent loop never writes. A name that already exists among owned collections (ignoring case) is refused, here and in `collectionStore.create` and `rename`, and the model is told to call `propose_collection_move` with that collection's id.

`recipeIds` is optional, at most 100. Omitting it, or passing `[]` or `null`, proposes an empty collection. Ids come from the library index or from `search_recipes` (at most 20 hits, no offset). The card does not run a second search.

## Steps

1. [core] Card spec, `revalidate`, prompt rule, and the move-card rule that points a missing name here. Fixtures and `replayCards`.
2. [core] `writeCollections` publishes the new collection and the stripped source lists together. `collectionStore.createWithRecipes` rechecks the name, the 50-collection cap, and the 500-recipe cap, then pushes once and rolls the snapshot back on failure.
3. [ui] Client parse, registry, confirm card, replay strip, catalogs, `screens.json`.
4. [core] `evals/agent.eval.ts`: one prompt that should call `propose_create_collection`. The eval stays on `npm run test:import`, not CI.
