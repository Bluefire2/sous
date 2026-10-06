# Agent rules for evals

## Scope

These rules apply to any change to the import prompts (`imageImportPrompt`, the
`importFromSource` prompt), model settings (the model, thinking level,
temperature, `maxOutputTokens`, `mediaResolution`), output checks or retry
policy in `server/recipeImport.ts`, `RECIPE_SCHEMA` descriptions, or any
`golden.json`. They sit alongside `docs/constitutions/image-import.md` and do
not replace it.

`generatePrompt` (the recipe-from-an-idea prompt behind `generateFromBrief`,
`evals/recipeGenerate.eval.ts`) has no goldens and no dev/holdout split, so
the measurement and acceptance rules below do not apply to it. Changes to
it are still recorded in `evals/EXPERIMENTS.md` with the eval's outcome
before and after, and it must never be used to loosen the extraction
prompts' "never invent" rules.

## What the split is for

`evals/import-handwritten/dev/` holds cards that people and agents have
already looked at, so they may be inspected, debugged, and quoted. A pass
there shows a change works on cards it was designed around. `holdout/` holds
cards nobody has used to design a change, so a pass there is the only evidence
a change generalizes. Once someone designs against a holdout card, it becomes
a dev card.

## Never look at holdout to design a change

Do not open holdout `page-*.jpg` or `golden.json` files, and do not look for
holdout extractions or judge reasons, in order to decide what to change. The
harness hides them on purpose: do not add logging, flags, or scripts that
reveal them. The fixture descriptions in `evals/README.md` are provenance,
not a to-do list. If the owner asks for a holdout card to be debugged, first
move it to `dev/` with `git mv` and log the move in `evals/EXPERIMENTS.md`.
Never move a card from dev to holdout.

## A qualifying change needs all three of these

- **A reason that is not specific to one fixture's content.** A failure seen
  on one card may prompt a change, but the change must not encode that card's
  words, symbols, layout, or quirks. Test: would the change make sense to
  someone who has never seen that card? A length check on units passes this
  test; "`#` after a number means pounds", written because one card used `#`,
  does not.
- **Measurement across all fixtures in both splits, before and after**, with
  `npm run eval:ocr-compare -- --split=all --runs=3` (or more runs), using the
  same model and flags, at the parent commit and at the change.
- **Acceptance:** the holdout A-approach pass count is not lower than before,
  and the dev A-approach total is not lower than before. Ties pass. Do not
  re-run to get a better number; if you repeat a run, record every run and
  use the sums.

## Goldens

Edit a golden only when it misreads the card, meaning it records something
the card does not say. Never edit a golden to match model output, unless the
model's reading is what the card actually says; in that case, say in the
commit message what the card shows and why the golden was wrong. Holdout
goldens are edited only at the owner's request, from the card, not by
comparing with model output. A golden edit is an experiment and is logged in
`evals/EXPERIMENTS.md`.

## Prompt text

Additions must be domain-general, for example how to handle any crossed-out
text, not a symbol one card uses. They are also bound by constitution
principle 5: never remove the `(?)` markers, the tablespoon/teaspoon doubt
notes, or the "Never invent" rule, and keep the pinned-substring test in
`server/recipeImport.test.ts` green.

## Record every experiment

Record every experiment in `evals/EXPERIMENTS.md`, newest first, including
rejected and reverted ones, in the format that file defines.

## Worked example: what not to do

Commit `58d193a` added "Recipe cards use shorthand: # after a number means
pounds (lb); T, Tbs, Tbsp, or Tbls means tablespoon; …" to the photo prompt
after `sweet-sour-pork` derailed on "1½ #". The owner reverted it in
`0b7d79e`, for three reasons:

- It was written from one failing card's content, and was checked on that
  same card, so a pass there proves nothing about other cards.
- It was not measured across the other fixtures, so a regression elsewhere
  would have gone unnoticed. On another card, `#` can mean "number"
  (`#10 can`).
- It answered a symptom, reasoning written into a unit, that a
  content-independent check could handle without teaching the model any
  card's notation. That check (a unit-length limit, plus one retry) was
  measured in `evals/EXPERIMENTS.md` and reverted: dev got worse and holdout
  did not improve.

The allowed path would have been to state a general reason, run
`--split=all --runs=3` before and after, keep the line only if holdout and
dev are not worse, check it against principle 5, and log it.
