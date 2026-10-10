# Library assistant: collection moves

**Status:** built, not deployed. The library assistant proposes a collection move; the user applies it on the card.

Review fixes on the same branch: explicit `recipeIds` are deduped; an unknown `fromCollectionId` is an unknown source, and an owned collection named Recipes beats the unfiled alias; `sources` freezes each recipe's proposal-time collection so the card does not relabel rows from live membership after Move; replay drops `recipeIds` and `sources` and `revalidate` accepts that summary; a destination keeps ids it already lists in place.

**Trust boundary:** `propose_collection_move` emits a `collection_move` proposal card only. The user taps Move on the client; `collectionStore.moveRecipes` applies the change through the existing sync path. The agent loop never writes membership. There is no `create` argument on this tool. Creating a collection is a separate card, `propose_create_collection` (`docs/plans/agent-create-collection.md`).

## Steps

1. [core] `moveRecipes` in `collectionMembership.ts`, and `collectionStore.moveRecipes` (owned collections only, union cap before compact, rollback, `reread: 'always'` on a non-ok push, sign-out `reread: 'no'`).
2. [core] `AgentLibrary.loadTruncated`. Card spec, `revalidate`, prompt rule, fixtures. `replayCards` uses `revalidate` when the spec has one.
3. [ui] Client parse, registry props, expandable card, `AgentState.applies`, chip label, catalogs, `screens.json`.
4. [core] `evals/agent.eval.ts`: one prompt that should call `propose_collection_move` for an existing collection. The contract-test library gains an owned collection too. The eval stays on `npm run test:import`, not CI.
