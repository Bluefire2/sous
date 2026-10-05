# Recipe variants

Status: built on `claude/recipe-variant-parent-tracking-8e1908`, not deployed.

Constitutions applied: client-state (a new list hook, written to principles 4
and 5 as they stand; only `scope` changed), i18n (new copy in every catalog,
two glossary rows, a review state).

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
- **It is set only at creation.** `createFromAsk` is the only caller that
  passes it; `recipeStore.create` keeps whatever it is given, and no other
  caller can supply it. `saveRecipe` forces the
  stored value on every later save, so no edit path (the edit form, Ask Apply,
  replace from import, dismissing warnings, promoting a lesson) can set or
  clear it.
- **A shared editor cannot change it.** `planSharedRecipePut` pins the owner's
  stored value.
- **Shared pull carries it to viewers and editors.** That is what lets a
  viewer's "Save as new recipe" on a shared variant join the owner's group,
  and a shared variant group with its shared original. The id is an opaque
  recipe id. Every read still rechecks share, collection and listing, so it
  grants no access, though a member can learn the id of an original they
  cannot see.
- **It never reaches a visitor or the model.** `publicRecipeBody` strips it,
  because a visitor has no library to group variants in.
  `recipeForChat` strips it as well, so the `/api/chat` request keeps its
  shape.
- **MCP neither shows nor takes it.** `toMcpRecipe` does not show it, and
  `create_recipe` refuses it. `update_recipe` keeps it, because
  `mergeRecipeChanges` starts from the compacted stored recipe.
- **Backup import remaps it** through the recipe id map when the id is in the
  map, and keeps it raw otherwise. It is not part of the backup graph,
  because an original that is a shared recipe is never exported. Every
  variant of one original maps the same way, so the group survives.
- **An older client that edits a variant drops the field.** This is the same
  trade as `lang` and is accepted.

## Client

- `src/lib/variantGroup.ts`: `variantGroup(recipes, id)` returns every recipe
  whose `variantOf ?? id` matches. The original comes first, then the rest
  ordered by `createdAt` and then `id`. A group of one is a shared `EMPTY`
  constant. Owned and shared recipes group together.
- `useRecipeVariants(id)` in `recipeStore.ts` subscribes to the recipes map
  and derives the group with `useMemo`. Only `VariantLinks` calls it, so a
  change to another recipe re-renders that row and not all of RecipeView.
- `src/components/VariantLinks.tsx` is a `nav` with one chip per member:
  - The open recipe's chip is highlighted and is not a link.
  - The other chips are links that keep the router state, so Back still
    returns to the list the person came from.
  - Chips show stored titles, which are not translated.
- Copy: `recipe.variants` and `recipe.variantOriginal`, in all four catalogs.

## Test mode

The member persona has "Herb roast chicken" (`FIXTURE_IDS.member.herbRoastChicken`),
an unfiled variant of "Lemon garlic roast chicken". The review state
`recipe-view-variants` opens it. The original, which `recipe-view-cook` and
`recipe-view-your-cooks` show, now has the row too. The viewer sees that
original through Weeknights without a row, because the variant is not shared.
