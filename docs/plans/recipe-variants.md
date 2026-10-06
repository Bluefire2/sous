# Recipe variants

Status: merged (#148), not deployed. The MCP section is #149, built on
`claude/mcp-create-variant`.

Constitutions applied: client-state (a new list hook, written to principles 4
and 5 as they stand; only `scope` changed), i18n (new copy in every catalog,
two glossary rows, a review state; the MCP path writes `Recipe.lang` under
principle 6).

## Goal

Ask's "Save as variant" (`ChatPanel` → `recipeStore.createFromAsk`) made a new
recipe with no link back to the recipe it came from, so variants scattered
across the library. A variant now records which group it belongs to, and the
recipe screen shows the group.

## Decisions

- **One flat group per original, not a tree.** A new variant stores
  `variantOf = parent.variantOf ?? parent.id`. A variant of a variant joins the
  same group, and every member is shown as an equal. The original is labelled
  while it exists.
- **Nothing is written to the parent.** It works when the parent is a shared
  recipe that the person can only view (the viewer's "Save as new recipe").
  It also needs no second write that could fail halfway.
- **No cascade on delete.** If the original is deleted or a share is revoked,
  the rest keep the same key and stay grouped. The group just has no
  original to label.
- **UI on the recipe screen only.** The Variants row sits under the title. The
  library list, search, collections and selection are unchanged.

## Field contract

`Recipe.variantOf?: string` is the recipe id (a UUID) of the group's original.
It is the third deliberate exception to the `Recipe` schema lock, after `lang`
and `importCheck`.

- **Missing is normal.** Code must work without it.
- **Malformed values are dropped, not rejected.** A value that is not a UUID,
  or that equals the recipe's own id, is dropped by `compactVariantOf` in
  `server/recipeVariant.ts`. Both `compactRecipe` and `compactRecipeFields`
  use it. `validateRecipePut` does not check it.
- **It is set only at creation**, by two paths with one rule: Ask's
  `createFromAsk` on the client, and MCP `create_recipe` with `variantOf` on
  the server (see MCP below). `recipeStore.create` keeps whatever it is
  given, and no other caller can supply it. `saveRecipe` forces the
  stored value on every later save, so no edit path (the edit form, Ask Apply,
  replace from import, dismissing warnings, promoting a lesson) can set or
  clear it.
- **A shared editor cannot change it.** `planSharedRecipePut` pins the owner's
  stored value.
- **Shared pull carries it to viewers and editors.** That is what lets a
  viewer's "Save as new recipe" on a shared recipe join the owner's group
  (while the viewer can see the owner's original; see Client), and a shared
  variant group with its shared original. The id is an opaque
  recipe id. Every read still rechecks share, collection and listing, so it
  grants no access, though a member can learn the id of an original they
  cannot see.
- **It never reaches a visitor or the model.** `publicRecipeBody` strips it,
  because a visitor has no library to group variants in.
  `recipeForChat` strips it as well, so the `/api/chat` request keeps its
  shape.
- **MCP takes a parent, never the key.** `create_recipe` accepts the id of a
  parent recipe and the server derives the key (see MCP below).
  `toMcpRecipe` does not show the field, and `update_recipe` keeps it,
  because `mergeRecipeChanges` starts from the compacted stored recipe.
- **Backup import remaps it** through the recipe id map when the id is in the
  map, and keeps it raw otherwise. It is not part of the backup graph,
  because an original that is a shared recipe is never exported. Every
  variant of one original maps the same way, so the group survives.
- **An older client that edits a variant drops the field.** This is the same
  trade as `lang` and is accepted.

## Client

- `src/lib/variantGroup.ts`: `variantGroup(recipes, origins, id)` returns every recipe
  whose `variantOf ?? id` matches. The original comes first, then the rest
  ordered by `createdAt` and then `id`. A group of one is a shared `EMPTY`
  constant. Owned and shared recipes group together, with one limit (added
  after #149 from review): a recipe someone else owns joins only when it is
  the group's original, has the same owner as the recipe on screen, or has
  the same owner as the group's original.
  Without it, a member who shares a collection with you could set their
  recipe's `variantOf` to one of yours. Their recipe, titled however they
  liked, would then appear in the Variants row on your own recipe's page.
  The legitimate cases still group:
  - your copy of a shared recipe sits with that original;
  - your copy of a shared variant sits with that variant and the owner's
    other variants, while you can see the owner's original;
  - an owner's shared variants sit together.

  Two limits are accepted rather than closed with a field that records who
  owns the original (owner's decision on #150):
  - **A hidden original.** Your copy of someone's shared variant keys on
    their original. If they did not share that original with you, nothing
    says who owns the group, so the copy has no Variants row.
  - **A forged original.** Ids are unique only within one person's tree. Once
    a group's original is gone from your library (deleted, or its share
    revoked), someone who shares with you and knows its id can push a recipe
    with that id. It would show as "(original)". They can learn the id from
    shared pull. The cost is a chip on your page, and only after the real
    original is gone.

  `src/lib/variantGroup.test.ts` pins both limits.
- `useRecipeVariants(id)` in `recipeStore.ts` subscribes to the recipes and
  recipe-origin maps and derives the group with `useMemo`. Only `VariantLinks` calls it, so a
  change to another recipe re-renders that row and not all of RecipeView.
- `src/components/VariantLinks.tsx` is a `nav` with one chip per member:
  - The open recipe's chip is highlighted and is not a link.
  - The other chips are links that keep the router state, so Back still
    returns to the list the person came from.
  - Chips show stored titles, which are not translated.
- Copy: `recipe.variants` and `recipe.variantOriginal`, in all four catalogs.

## MCP

A member's AI app can save a variant, for prompts like "make a variant of my
carrot stew with potatoes instead of carrots". The extension is optional
`variantOf` on `create_recipe`, not a new tool. The model already finds the
recipe with `search_recipes` and reads it with `get_recipes`. Then it writes
the whole changed recipe, as it would for any new recipe.

- **Input.** `variantOf` is the id of one of the caller's own recipes.
  - The server reads that recipe from `users/{sub}` (`readOwnRecipeDoc`).
  - A missing, deleted or foreign id is `not_found`, and nothing is written.
    MCP sees the caller's own tree only, so a shared recipe cannot be a
    parent.
  - A value that is not a recipe id (not a UUID; the schema caps it at 36
    characters) is `invalid` before anything is read. `collectionId` gets the
    same shape check on `create_recipe` and `move_recipes`: anything other
    than "unfiled" or a UUID is `invalid`. That decision depends
    on the input's shape alone, so it reveals nothing about what is stored,
    and `not_found` only ever repeats a recipe id back.
- **Rule.** `variantFromParent` (`server/mcp/recipeInput.ts`) stores the
  parent's own `variantOf`, else its id, through `compactVariantOf`, so a
  variant of a variant joins the same flat group. The model never supplies
  the stored key. That is the same group-key rule as `createFromAsk`. The
  language differs from Ask: the new recipe takes the parent's `lang` unless
  the call gives one, and an explicit `lang` wins (Ask always copies the
  parent's). The tool description asks the model to pass `lang` when it
  writes in another language. A wrong label is tolerated, because
  `Recipe.lang` is best-effort metadata (i18n principle 6).
- **Deleted parents.** A tombstoned parent is `not_found`. The tool checks
  liveness (`isLiveDoc`) itself, so the rule is tested with the tool, as
  `update_recipe`'s is. `readOwnRecipeDoc` returns the stored document as it
  is.
- **No photos.** MCP has no photos, so a variant made here has none. This
  differs from Ask, which copies the parent's photos.
- **Placement.** The variant lands Unfiled unless `collectionId` is given, the
  same as Ask's variant.
- **Result.** The response includes `variantOf: { id, title }` for the
  recipe it was made from, so the model can tell the person what it saved.
- **Tool description.** It tells the model how to make a variant: read the
  original, write the whole new recipe, pass the original's id, and leave
  the original unchanged.
- **Logging.** The `mcp` log line holds no arguments, so nothing changes
  there.
- **Tests.** `server/mcp/tools.test.ts` and `server/mcp/recipeInput.test.ts`
  hold the unit tests. In `testing/mcpSmoke.ts`, the test-mode job checks,
  against the real store, that a variant of the Herb roast chicken fixture
  is stored in Lemon garlic roast chicken's group with the parent's `lang`,
  that the parent's version is unchanged, and that another account's recipe
  is `not_found`.

## Test mode

The member persona has "Herb roast chicken" (`FIXTURE_IDS.member.herbRoastChicken`),
an unfiled variant of "Lemon garlic roast chicken". The review state
`recipe-view-variants` opens it. The original, which `recipe-view-cook` and
`recipe-view-your-cooks` show, now has the row too. The viewer sees that
original through Weeknights without a row, because the variant is not shared.
