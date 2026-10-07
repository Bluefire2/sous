---
name: Cook log
description: Dated records of cooking a recipe (rating, servings, notes, lessons, photos), the /cooks journal, and promoting a lesson into recipe notes. Read before changing CookLog data, its sync ops or cascade, its photos, its backup handling, or those screens.
status: ratified
scope:
  - src/lib/types.ts (CookLog)
  - src/lib/cookLogShape.ts
  - src/lib/cookLogShape.test.ts (CookLog key-set lock)
  - test/cookLogFixtures.ts (valid/invalid entries shared by client and server validator tests)
  - src/lib/cookLogStore.ts
  - src/lib/recipeStore.ts (remove's snapshot rollback covers the recipe's cook logs)
  - src/lib/backupImportRemap.ts (cookLog namespace)
  - server/store.ts (cookLogs kind, cookLog ops, putDoc parent check, cascadeRecipeDelete)
  - server/sync.ts (cookLogs kind and ops)
  - src/lib/remote.ts (cookLogs pull)
  - src/lib/pushOps.ts (cookLog ops)
  - src/lib/libraryMemory.ts (cookLogs map, removeRecipeLocal)
  - src/lib/syncEngine.ts (cookLogs accumulator)
  - src/lib/backup.ts (cookLogs, photo attribution)
  - src/screens/CookLogEdit.tsx
  - src/screens/CookJournal.tsx
  - src/components/CookLogCard.tsx
  - src/components/PhotoPickerField.tsx (as used by CookLogEdit; shared with the recipe gallery)
  - src/App.tsx (cook log routes)
  - src/screens/RecipeView.tsx (Log this cook, Your cooks)
  - src/screens/Library.tsx (delete dialog copy, Cooks link)
  - public/privacy.html (cook log copy)
---

# Cook log constitution

Status: ratified with the initial cook log implementation
(`docs/plans/cook-log.md`, [PR #36](https://github.com/Bluefire2/cook/pull/36)).

This document states the principles of the cook log and why each one exists.
It binds any change to the files and concepts in the frontmatter `scope`. For
shared files, only the part named in parentheses is in scope. A change may
break a principle, but only by following **Amending this constitution** in the
same PR. Breaking a principle silently is a defect, even if the tests pass.

The `name` and `description` in the frontmatter are copied word for word into
the index in root `AGENTS.md`, and `scripts/constitutions.test.ts` checks that
they match. If the feature's reach changes, update `description` and `scope`
and the index in the same PR.

## What the cook log is for

A cook log entry records one time you cooked a recipe: when, how it went, what
you changed, what you would do differently, and photos. The recipe is the
current best version of the dish, and the log is the history behind it. The
feature exists so that a lesson from one cook improves the next one.

## Principles

### 1. The cook log is its own entity. Cook-log data never adds fields to `Recipe`, `ChatMessage`, or `CookStateRow`.

**Rule.** Entries live in their own store kind (`users/{uid}/cookLogs/{id}`),
with a `recipeId` pointing to the recipe. Do not put "last cooked", ratings,
counts, lessons, or any other log data on `Recipe`, `ChatMessage`, or
`CookStateRow`. Other features extend those types only through the schema-lock
process in `AGENTS.md` (a plan, an optional field, and the lock tests changed
on purpose), never to carry log data.

**Why.** `compactRecipe` and `compactRecipeFields` drop unknown keys, and
`src/lib/recipeStore.test.ts` locks the exact recipe key set. The `Recipe` shape
also appears in the import and `update_recipe` Gemini schemas, so a new field
leaks into model output and evals. The lifecycles also differ. A recipe has
one current version that LWW overwrites, while a log is many entries that
accumulate and are never rewritten by recipe edits. Putting the two together
would let a recipe edit erase history.

**If you need a derived value** such as "cooked 4 times" or "last cooked", compute
it from the entries in memory. Do not store it.

### 2. Entries are history, and the recipe is the current truth. The log changes the recipe only through an explicit user action.

**Rule.** The only path from the log into the recipe is "Add to recipe notes",
which the user triggers one lesson at a time. Nothing automatic writes to a
recipe from log data. That includes AI rewrites, merging all lessons, and
changing servings to match past cooks.

**Why.** The recipe is what someone reads with flour on their hands, so it must
only change when the user decides to change it. Automatic promotion would also
create LWW conflicts with edits on other devices, and LWW is the product
(there is no merge UI). Keeping promotion manual keeps the recipe trustworthy.

### 3. Every entry belongs to exactly one recipe and is deleted with it.

**Rule.** `recipeId` is required and must point to a live recipe **owned by
this account** on every put (the `putDoc` parent check returns
`recipe-deleted` otherwise). Unlike chat and cook state, cook logs never fall
back to a recipe shared with you: `putDoc` treats them like photos, and the UI
hides "Log this cook" and "Your cooks" on shared recipes. `recipeId`
cannot change: `putDoc` rejects a put whose `recipeId` differs from the live
stored entry's. `cascadeRecipeDelete` tombstones the recipe's entries and all of its
photos at `max(delete time, stored updatedAt)`, so an entry edited on a device
with a fast clock still dies with its recipe. `removeRecipeLocal` removes them
from memory. The journal skips entries whose recipe is not in memory. There are
no free-floating entries.

**Why.** Photos are owned by `recipeId` (the photos route requires a live
recipe, and cascade finds photos by `recipeId`), so an entry that outlived its
recipe would keep photos nobody can delete. The privacy page promises that
deleting a recipe deletes everything attached to it. The cost is that deleting
a recipe loses its history. We accept that cost, and the delete dialog says so.
Shared recipes are excluded because cook photos can only be uploaded under a
recipe you own (`server/photos.ts`), and an entry under someone else's recipe
would survive a revoked share with nothing to cascade from.
Moving an entry would leave its photos attributed to the old recipe, and
deleting that recipe would then kill photos that a live entry still shows. The
cascade's normal last-write-wins comparison would skip any child whose
`updatedAt` is newer than the delete. That is harmless for a single progress
row, but cook entries are back-dated and edited later, so the cascade forces
the tombstone. Forcing it is safe because the parent check blocks any later
put.

**Accepted side effect.** A tombstone carries no `recipeId`, so a newer put
could revive a deleted entry under a different live recipe. The client never
sends one. If a feature ever needs to revive entries, keep `recipeId` on
cook-log tombstones first.

### 4. Cook logs follow the existing sync rules. No exceptions.

**Rule.** The server is the source of truth. Conflicts resolve last-write-wins
on `updatedAt`. Deletes are tombstones, never hard deletes. `uid` comes only
from the session. Writes push immediately. There is no outbox, no polling, no
listeners, and no WebSockets. The client keeps entries in memory after a pull,
never in IndexedDB.

**Why.** Every other entity works this way (see root `AGENTS.md`, "Sync"). A
second sync model for one feature would double the failure modes. A hard
delete would be invisible to another device's pull cursor, so that device
would keep the entry forever.

### 5. `cookedOn` is a calendar date string, not a timestamp.

**Rule.** `cookedOn` is `YYYY-MM-DD`, meaning the user's local date as they
entered it. `createdAt` and `updatedAt` remain milliseconds for sync. Sort by
`cookedOn` descending, then by `createdAt` descending.

**Why.** "I made this on Tuesday" is a date, not an instant. A millisecond
value at local midnight moves to the previous day in another timezone, and
users back-date entries.

### 6. Fields stay few and freeform. Only `lessons` is separate, because only lessons get promoted.

**Rule.** An entry has `cookedOn`, an optional 1-5 `rating`, optional `servings`,
optional `notes`, optional `lessons`, and up to 8 `photoIds`. Substitutions and
"how it went" go in `notes`. Do not add structured substitution lists,
per-ingredient tweaks, tags, or timers without amending this document.

**Why.** Logging happens right after cooking, when people are tired. Every
extra field lowers the chance of logging at all. `notes` describes what
happened, and `lessons` says what to do next time. That difference is the only
reason they are separate: the "next time" field is what makes one-tap promotion
make sense. A structured substitution model would be a second recipe schema.

### 7. Promotion is explicit and idempotent, and its state is derived.

**Rule.** `appendLessonToNotes(notes, lesson)` adds the lesson as a new
paragraph and does nothing if the notes already contain it. "In notes" is
shown by checking whether the recipe's notes contain the lesson text. There is
no `promotedAt` flag on the entry or the recipe.

**Why.** Storing a flag would add schema, and it would go stale when the user
edits or deletes the text in the recipe notes. The containment check is always
consistent with what the user can see.

**Accepted side effect.** Promotion saves the recipe and bumps `updatedAt`.
Because `progressFor` treats that as a shape change, it resets cook-mode
checked ingredients and the current step. People log after cooking, so this is
acceptable. Do not fix it by weakening the staleness check in `useCookState`
without amending this document and the WS-1 reasoning it depends on.

### 8. The assistant sees lessons only through the recipe's notes.

**Rule.** Entries, lessons, ratings, and cook photos are not sent to Gemini.
The Ask assistant already receives the whole recipe as JSON, so a promoted
lesson reaches it through `notes`.

**Why.** The Gemini request shape is on the root `AGENTS.md` "Do not touch"
list. Sending history would also grow token cost with every cook and send
photos and personal notes to a third party beyond what `/privacy` describes.
Promotion is the user deciding what the assistant should know.

### 9. Photos reuse the existing photo pipeline.

**Rule.** Cook photos are re-encoded with `encodeImageForStorage` (the server
accepts only JPEG or PNG under 2 MB), then use `photoStore.add`, then
`postPhoto(id, log.recipeId, log.updatedAt, blob)` **before** `cookLog.put`,
exactly like chat photos. There are at most 8 per entry. Removing a photo or
deleting an entry sends `photo.delete`. The photos route and GCS layout do not
change. Cook photos are never used as the recipe cover or in the recipe
gallery automatically.

**Why.** One upload path means one set of size limits, one GCS cleanup path
(`gcsDeletes`), and one cascade. Uploading before the put means another device
never pulls an entry that points to bytes that do not exist yet. The cap
matches chat and the recipe gallery.

### 10. The server validates, the client compacts to the same keys, and a test locks the key set.

**Rule.** `validateCookLogPut` enforces the following: UUID `id` and `recipeId`;
`cookedOn` in `YYYY-MM-DD` format and a real calendar date (the same check as
the client's `isCookedOn`); finite `createdAt` and `updatedAt`; integer rating
1-5; servings a finite number in 0-1000 (exclusive of 0); `notes` and `lessons`
at most 10,000 characters each; at most 8 unique UUID `photoIds`; payload JSON
under 200k.
`compactCookLogFields` on the server and `compactCookLog` on the client drop
unknown keys. The key-set test for `compactCookLog` is a schema lock just like
the recipe one. Growing its allow-list counts as amending Principle 6.

**Why.** The server cannot trust clients, including old or malicious ones. A
doc stored without a finite `updatedAt` has no last-write-wins state
(`readStoredState` returns null), so any later write would win. A date the
server accepts but the client rejects would be dropped on pull, leaving an
invisible entry that still owns photos. Compaction on both sides keeps stray
keys out of Firestore and backups. The lock test makes schema growth a
decision someone has to make on purpose.

### 11. Changes are additive and backward compatible.

**Rule.** `cookLogs` is optional in pull responses and cursors, so old clients
ignore it and new clients handle an old server. The backup export moved to
version 4 with an optional `cookLogs` array. Import still accepts versions 1-4.
`app: 'cook'` and the `cook-backup-` file names never change.

**Why.** Installed PWAs update at different times, and people keep old backup
files. A breaking change would strand one device or lose one backup.

### 12. The journal is a view, not a second store.

**Rule.** `/cooks` and "Your cooks" both read from the same in-memory
`cookLogs` map through `cookLogStore` hooks and render the same `CookLogCard`.
Screens never `fetch`.

**Why.** Only `syncEngine` and `remote` fetch library data (root `AGENTS.md`,
"Architecture"). A single card component keeps the two surfaces from drifting
apart.

## Non-goals (a PR that adds one of these amends this document)

- Sending log data to the assistant directly (Principle 8)
- Stats, streaks, charts, or stored aggregates (Principle 1)
- Resetting cook progress automatically after logging
- Sharing entries with other users or collections
- Entries without a recipe, or moving an entry between recipes (Principle 3)
- A lightbox or photo reordering

## Tests

Tests stay pure, as the root `AGENTS.md` requires: validators, compaction and
the key lock, `cookedOn` checks, sorting, `appendLessonToNotes`, applying pull
changes, and the backup round trip. Do not add a Firestore emulator, a GCS
mock, or a DOM testing library for this feature.

## Amending this constitution

A change that breaks or relaxes a principle must, in the same PR:

1. Edit the principle so it describes the new rule, keeping the **Why**
   accurate. Do not leave the old text in place with an exception bolted on.
2. Add an entry to the amendment log with the principle number, what changed,
   why the change is worth breaking the original intent, what risk the
   original principle guarded against, and how the new design handles that
   risk.
3. Say in the PR description, under a "Constitution amendment" heading, that
   the PR amends `docs/constitutions/cook-log.md`.

A reviewer or verifier who finds a principle broken without an amendment
should treat it as a failing check.

## Amendment log

- **Principle 1 (clarified), with parallel steps (`docs/plans/parallel-steps.md`).**
  What changed: the rule now bans cook-log data on `Recipe`, `ChatMessage`,
  and `CookStateRow`, instead of every new field. `CookStateRow` gains the
  optional `doneSteps` (steps done ahead of `currentStep` when two people cook
  lanes of a recipe at the same time). Why: that is cook progress, not log
  data, and it has to live in the progress row; a sibling entity would split
  one row's last-write-wins into two that could disagree. Risk guarded: the
  original P1 risk, a recipe edit erasing history, and schema growth.
  How handled: `doneSteps` resets with `recipeUpdatedAt` exactly like
  `currentStep`, so it is never history; it is normalized on every write and
  omitted when empty, so a recipe without lanes writes the old row; the
  `CookStateRow` key-set lock tests were changed on purpose; older clients
  ignore it. No cook-log field was added anywhere.

- **Principle 3 (tightened), with the merge of view-only shared collections.**
  What changed: the parent recipe must be owned by this account. Chat and cook
  state may now attach to a recipe shared with you; cook logs may not. Why:
  cook logs own photos, and photo uploads stay owned-parent-only, so allowing a
  shared parent would create entries whose photos cannot be stored and which a
  revoked share would orphan. Risk guarded: the original P3 risk (entries and
  photos outliving their recipe). How handled: `putDoc` rejects a cook log
  whose recipe is not owned, `cookLogStore` refuses shared recipes, and the UI
  hides the cook log controls on them. No principle was relaxed.
