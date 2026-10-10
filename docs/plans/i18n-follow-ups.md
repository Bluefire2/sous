# i18n follow-ups

Open work left after `docs/plans/i18n.md` was implemented and verified on
`cursor/i18n-implement-5489` (PR #42). Read that plan's
[Verification results](i18n.md#verification-results-2026-09-28) and
`docs/constitutions/i18n.md` first. The constitution wins where they disagree.

Each item names who does it, where the change goes, and how to check it.

## 1. Owner steps after the production deploy

These need production and the owner's credentials. No agent runs them.

1. **Cloud Run translate latency.** Tap the translate chip on a few foreign
   recipes in production, one new language each, so every tap misses the
   cache. Read the `/api/translate` request times from Cloud Run logs or the
   browser's network panel. Record p50/p95 in the constitution's Current
   decisions. If p95 is above about 4 s, apply the switch rule there: split
   the Gemini request first, then consider NMT. That rule needs its own
   reviewed PR.
2. **Dictation clips.** Record a short question in `en`, `uk`, `ru` and
   `zh-Hans` in the Ask composer (mic button), with the UI in the same
   language. Also try one recipe whose title is Cyrillic and one whose title
   is Chinese. Record the results in the constitution's Current decisions
   under Dictation. Only if a language transcribes poorly: send `en` for it
   from `src/lib/sttApi.ts`, and add the "EN" badge described in the plan's
   Dictation section.
3. **`lang` backfill.** Run it after installed PWAs have picked up the new
   client:

   ```
   node --env-file=.env.local scripts/backfill-recipe-lang.ts
   node --env-file=.env.local scripts/backfill-recipe-lang.ts --write
   ```

   Review the dry run's counts before running with `--write`. The script
   writes only `lang` and `serverUpdatedAt`, and never `updatedAt`.
4. **Old translation cache docs.** None to clean up. The detection fix bumped
   `TRANSLATION_VERSION` to 2, so older cache docs miss and are overwritten
   on the next translate. They are still deleted with their recipe.

## 2. Checks that were not run

| Check | Why not | How to run it |
| --- | --- | --- |
| Dictation transcription quality | No microphone in the test browser | Owner step 2 above |
| "This collection already has 20 people" in a non-English UI | Needs 20 grantees | Firestore emulator (`FIRESTORE_EMULATOR_HOST`) with seeded grants, or unit-test the code → catalog mapping in `src/lib/errorText.ts` |
| Viewer chat "Save as a new recipe" copies `lang` | Needs an existing chat proposal in the viewer's own chat. Creating one leaves viewer chat rows that are not cleaned up on revoke (root `AGENTS.md`, Sharing). | Covered by `src/lib/recipeStore.createFromAsk.test.ts`. A live check needs a viewer who already has a proposal. |
| Invite link expiry label in each language | Needs an unused invite link, which the review does not create | Owner opens `/admin` after creating a link |
| `library-empty` and `sync-toast` review states | Need an empty account or a failed refresh | A fresh test account; force `sync-toast` offline |
| Phone-width layout of grantee states (shared banner, leave sheet, editor edit form) | Captured in a desktop-width window | Rerun those states at 390×844 with a signed-in grantee |

## 3. Review nits not fixed on this branch

Each is small; none blocks use. Any fix must follow the constitution:
catalog text goes in all four catalogs, and changed screens get the
in-context review.

1. **Unit words don't agree with numbers.** `uk`/`ru` show "4 фунт" (should
   be фунта / фунти), and `en` shows "2 piece onion". Unit labels are fixed
   strings (`src/i18n/unitLabel.ts`, keys `unit.*`). The fix is plural-aware
   unit labels: turn `unit.piece` and `unit.lb` (and `unit.cup` for `en`)
   into plural keys, and pass the scaled quantity from `ingredientLabel` in
   `src/screens/RecipeView.tsx`. Fractions use the `other` form.
2. **Truncated placeholders in `uk`/`ru`.** The Ask input ("Запитайте
   помічника…") and the ingredient note field are cut off at phone width.
   Shorten the catalog text (`chat.placeholder`, `form.notePlaceholder`) or
   let the fields grow.
3. **`ru` cook section header wraps.** On a recipe, "Ваши приготовления" and
   its "Записать приготовление" link each wrap onto two lines at 390 px.
   Shorten one of them, or stack the link under the heading.
4. **`zh-Hans` import hint register.** "如果不对，请你改一下。" reads a
   little stiff; "如果不对，可以修改。" is more natural. Optional.

## 4. Typed message parameters

**Problem.** Missing catalog keys fail `tsc`, but parameter names do not.
`t('import.looksLike', { langauge: name })` compiles, and the page shows a
literal `{language}`. `src/i18n/messages.test.ts` only checks that every
locale uses the same placeholders as English; it cannot see call sites.
Compile-time parameter checking is the main advantage the i18n libraries
reviewed on 2026-09-28 (Paraglide JS, i18next with `as const` resources)
have over this code. It needs about 20 lines of types, not a library. See
the constitution's Current decisions, "Catalogs: no i18n library".

**Change** (`src/i18n/en.ts`, `src/i18n/index.ts`; no catalog text
changes):
1. Derive each key's parameter names from the English template. `en` is
   already `as const satisfies …`, so a template-literal type can extract
   them. For a plural key, read the names from its `other` form, and always
   include `count: number`:

   ```ts
   type Placeholders<S extends string> =
     S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
   ```

2. Type the parameters per key: `ParamsFor<K>` is `undefined` when there are
   no placeholders, and otherwise
   `{ [N in Placeholders<…>]: N extends 'count' ? number : string | number }`.
3. Give `translate`, `t`, and `useT` a generic signature:
   `<K extends MessageKey>(key: K, ...params: ParamsFor<K> extends undefined ? [] : [ParamsFor<K>])`.
   Then a key with placeholders requires them, and a key without them takes
   none.
4. Fix any call sites `tsc` reports. The 2026-09-28 pass found no wrong
   names, so expect few or none.
5. Some call sites build the key at runtime and pass a key union, for
   example `unitLabel` (`unit.${token}`) and `serverErrorText` in
   `src/lib/errorText.ts` (a code → key map with computed parameters). Keep
   them compiling with a narrow, documented escape: an internal untyped
   `translateDynamic`, or a per-map parameter type. Don't loosen the
   public `t`.

**Check.**
- Add a type-level test (for example `expectTypeOf` in Vitest, or
  `// @ts-expect-error` lines in a `*.test-d.ts` file):
  - a misspelled parameter fails;
  - a missing required parameter fails;
  - a plural key without `count` fails;
  - a key without placeholders rejects extra parameters.
- `npm run build` and `npm test` pass.
- There is no runtime change, so no in-context review is needed. It changes
  no user-facing text (principle 16).

## 5. Behaviour found during verification (outside the review rubric)

These are product or quality questions, not catalog bugs. Decide before
changing anything.

1. **Tags stay in the source language after translation.** Principle 4
   lists what is translated, and tags are not on the list. Translating them
   would amend principle 4.
2. **Bulk import without translation can leave `lang` unset.** With
   `translateTo` absent, a missing `lang` from the extraction model is not
   filled in by detection (one French page came back unlabelled). This is
   allowed by principle 6. A cheap `detectLanguage` call when `lang` is
   missing would fill it.
3. **Translation quality.**
   - A Chinese translation kept "(originale)" in a title and the English
     word "creamy" in a description.
   - A title was rendered as a descriptive Chinese name instead of keeping
     "Carbonara" recognisable.
   - Prompt changes go through `evals/AGENTS.md` (dev/holdout split,
     experiments logged in `evals/EXPERIMENTS.md`) and bump
     `TRANSLATION_VERSION`.
4. **Import eval flakiness.** `evals/recipeImport.eval.ts` fails
   intermittently with `parse_error` or garbled output, at the same rate on
   `main`. When the carbonara or bourguignon fixture fails, the translate
   eval's setup skips all six tests. Worth its own investigation, for
   example logging the raw model text on `parse_error`.
5. **Rapid servings taps.** After many quick +/− taps, a reload sometimes
   showed an intermediate servings value. That suggests cook-state pushes
   can land out of order. Not i18n; unverified beyond one session.
6. **Bulk mode with one link** falls back to the single-recipe preview.
   Existing behaviour, noted only because it surprised the reviewer.

## 6. In-context review procedure

1. **Test data (open question for the owner).** Principle 16 says the
   review writes nothing. About a dozen manifest states (share sheet,
   grantee banner and leave sheet, editor form, cook log edit, translated
   chip states) are unreachable without data, so a strictly read-only full
   run skips them. The 2026-09-28 run wrote clearly labelled test data, with
   the owner's explicit consent, and the owner deleted it afterwards.
   Options:
   - amend principle 16 to allow owner-approved `[i18n test]` data under a
     separate test account, deleted at the end of the run;
   - or keep it read-only and have the standalone suite
     (`npm run test:i18n`, plan milestone) run against seeded emulator data.

   Test mode (`docs/plans/test-mode.md`) now provides the second option:
   fake personas against a seeded emulator, with no production data in
   reach. The standalone suite is expected to run on it.
2. **Standalone suite.** Unchanged; see the plan's "Upcoming milestone:
   standalone i18n review suite".
