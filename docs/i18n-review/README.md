# In-context translation review

Catalog parity tests prove every key exists in every language. They cannot
show whether the strings work together on a screen. This review looks at the
rendered page.

`npm run test:i18n` runs it (`testing/i18n-review/`, design in
`docs/plans/i18n-review-ci.md`). This file defines it: what it checks (the
rubric, which the suite's judge reads from here), which screens
(`screens.json`), when it runs, and what the report holds. Tool wrappers,
such as `.cursor/skills/i18n-visual-review/SKILL.md`, only point here.

## What the review does

For each screen state in the manifest and each language in scope:

1. Render the screen at phone width (390×844) and capture it, together with
   the English version of the same state as reference.
2. Give both screenshots, the language, and the rubric to a vision-capable
   LLM reviewer.
3. Get back pass/fail and a list of issues. Each issue names the visible
   text, the problem, a suggested fix, and severity (`blocker` or `nit`).
4. Fix blockers in the catalogs, then re-review the affected screens.
   Record nits in the report or fix them.

The reviewer judges only the app's own text; [Not judged](#not-judged) lists
what it leaves alone.

## Not judged

The reviewer never reports these, whatever language they are in. A recipe
in another language is expected. The suite's judge reads this list from
here and runs it together into one sentence, so a hand review and the suite
leave the same things alone. Its wording is calibrated: after changing it,
run `testing/i18n-review/calibration.ts` and update the sentence pinned in
`judge.test.ts`.

- recipe titles, descriptions, ingredients, steps, notes, and tags
- collection names
- people's names and email addresses
- names of connected apps
- links and URLs
- text the person typed or pasted, including where the app quotes it back
- the messages in a chat or assistant thread, both what the person asked
  and what the model answered, including what the model put in a card (a
  shopping list's title, sections, and items)

These are the user's data or the model's words and stay as the user wrote
them. Language names in the language picker are written in their own
language on purpose (English, Українська, Русский, 简体中文); that is
correct.

## Rubric

- **Sense in context.** Labels read as one coherent menu, form, or dialog.
  Each word is the right sense for its control, for example a verb on an
  action button, not a noun.
- **Consistent terms.** The same concept uses the same word everywhere on
  the page, and matches the glossary in the constitution's Current decisions.
- **Grammar across strings.** Case and gender agreement between neighbouring
  strings and with numbers (`uk`, `ru`), and correct plural forms.
- **Register.** Formal or informal address matches the decision recorded in
  the constitution.
- **Nothing left in English.** No untranslated or mixed-language app text.
- **Layout.** No truncation, overflow, clipped buttons, or bad line breaks.
  Russian runs long, and Chinese breaks lines differently.

## When it runs

The review runs once per task, at the end, before the PR, when the
implementation is complete and the PR may be ready to merge. It is a pre-PR
check, alongside the other verification. It does not run after each change
or each step, and it is not part of the iteration loop. There is no lighter
variant, including for rewording-only changes.

If it finds blockers, fix them and re-review the affected screens before
opening the PR. During iteration the only per-change requirement is the
cheap one: every new or changed string is in every catalog.

Two scopes:

- **Task run.** Every screen that shows keys the task added or changed, in
  all three non-English languages (`uk`, `ru`, `zh-Hans`). Required before
  the PR of any task that changed UI text. English is captured as the
  reference image for each of those states and is not judged.
- **Full run.** Every manifest state in every supported language (`en`,
  `uk`, `ru`, `zh-Hans`). Required before the PR for the i18n plan and for
  any task that adds a supported language. English screenshots are the
  reference for the other three languages. On the English column, the judge
  checks sense in context and layout only.

## Running it

It runs against test mode (`testing/README.md`): fake personas, a seeded
Firestore emulator, nothing in production. The model routes the app calls
(import, translation, the assistant) are mocked, so the test server needs
no Gemini key; only the judge calls Gemini, with `GEMINI_API_KEY` from
`.env.local`.

Once, install the browser: `npx playwright install chromium`.

Then, each time:

```
npm run build
gcloud emulators firestore start --host-port=127.0.0.1:8085   # needs Java
node testing/test-server.ts --static --port 4173              # wait for "Test mode ready"
npm run test:i18n -- --states library-populated,settings      # a task run
```

Start the test server fresh for each run: `testing/smoke.ts` and some hand
checks change the seed.

| Option | Meaning |
| --- | --- |
| `--states a,b` | The manifest ids to review. Default: all. A task run names the states that show the text the task touched. |
| `--langs uk,ru` | The languages to capture. Default: all four. English is always captured as the reference. |
| `--scope full` | Also judge the English column (sense in context and layout). Default `task`. English is always captured, so this applies whatever `--langs` says. |
| `--no-judge` | Capture only; no Gemini calls. |
| `--repeat 2` | Capture each state twice and fail if any pair differs (the determinism check). |
| `--out dir` | Where to write. Default `.i18n-review/<date>/`, which is gitignored. |
| `--base-url url` | The test server. Default `http://localhost:4173`. |

A finding counts only when two judgings of the same screen name the same
text; one named once is listed as unconfirmed. The run exits non-zero on a
failed capture, a confirmed blocker, a judge error, or the judge-call cap
(`MAX_JUDGE_CALLS`).

A change to the judge's prompt or model is measured with
`testing/i18n-review/calibration.ts` (planted defects and clean screens)
and recorded in `docs/plans/i18n-review-ci.md`.

## Scheduled run

`.github/workflows/i18n-review.yml` runs a full review of `main` every day at
06:00 UTC and keeps the open findings in one issue, "In-context translation
review: open findings", labelled `i18n-review`. It is a backstop for what
task reviews miss, not a replacement for them.

- **What is filed.** Confirmed findings only: blockers in a table, nits
  folded away, each with its candidate keys and the date it was first seen.
  The issue also lists screens the run could not judge, and a comment notes
  each run that found something new or saw something resolved. With nothing
  open, the issue is closed; a new finding reopens it.
- **Declining a finding.** Add it to `accepted.json` in this directory with
  a reason and the date, in a normal PR:
  `{ "fingerprint": "…", "reason": "…", "date": "YYYY-MM-DD" }`. The issue
  lists each finding's fingerprint. Optional `state`, `lang`, and `text`
  fields are for people reading the file.
- **When it runs.** A scheduled run on a commit it already reviewed in full
  stops early. Run it by hand from the Actions tab (`workflow_dispatch`),
  optionally for some state ids or languages; a partial run updates only
  the findings on the screens it judged.
- **Where the report is.** Each run uploads `report.md`, `results.json`,
  and the screenshots as a workflow artifact, kept 30 days; the issue links
  the run.

The issue body ends with the run's state in a hidden comment; the next run
rewrites the body from it, so edits to the body are lost. The repository is
public, so the issue and artifacts are too; they show only fixture data.

## Screen manifest

`screens.json` is a JSON array. Each object has:

| Field | Meaning |
| --- | --- |
| `id` | Stable name used in the report. |
| `route` | Path from `src/App.tsx`. A named collection is `/collections/:collectionId`. |
| `setup` | Plain language: what the state shows and how a person reaches it. The judge reads it too. |
| `needsData` | `true` when a hand review against a real account needs library or share data to be there already. The suite reaches these states from personas. |

Every manifest id has an entry in `testing/i18n-review/states.ts`: the
persona, the path, the steps that reach the state, and any mocks it needs.
`states.test.ts` fails when an id has no entry, so a new state cannot be
added to the manifest without a way to capture it, or one of the named
reasons in `SKIP_REASONS` not to.

Static pages in `public/*.html` are out of the manifest. Do not add them.

New screens or states are added to `screens.json`, with their entry in
`states.ts`, in the same change that introduces them.

## Glossary and register

Catalog text follows the register and glossary in
[Current decisions](../constitutions/i18n.md#current-decisions) of
`docs/constitutions/i18n.md`. Address the person as `uk` "ви", `ru` "вы",
and `zh-Hans` "你". Do not copy the glossary table into this file or into
a report; link that section. The judge reads it from the constitution.

## Report

The suite writes `report.md` and `results.json` to the output directory,
beside each capture (`<state>/<lang>.png`, and `.txt` for its page text).
Cursor agents pass `--out /opt/cursor/artifacts/i18n-review/<date>` so the
report is uploaded.

The report contains:

- Scope (`task` or `full`), the commit (and whether the tree had changes),
  the languages judged, and the judge calls used.
- A table, one row per manifest `id` and one column per language. Each cell
  is `pass`, `fail`, `reference` (English in a task run), or why the state
  was not judged (a capture failure, a judge error, the call limit, or a
  skip reason).
- Issues: confirmed blockers, nits, and unconfirmed findings, each with the
  screen id, language, rubric item, the visible text, the problem, a
  suggested fix, the catalog keys that may hold the text, and the
  screenshot.
- What was fixed in the catalogs, and which screens were re-reviewed.
- Every skipped state, with the reason.
- Translation cache docs written: none, since nothing reaches production.

Attach the report to the PR.

## Without the suite

A person can review by hand: sign in to test mode as a persona (`/__test/`),
switch language in Settings (or set `localStorage` key `cook.locale` to
`en`, `uk`, `ru`, or `zh-Hans` and reload), reach each state as its `setup`
says, capture it at 390×844, and judge it against the rubric. Write the
report in the format above.

A hand review against a real account, where test mode cannot show what is
needed, talks to production and keeps these rules:

- **Read-only.** Never create, edit, or delete library data: no recipes,
  collections, chat messages, cook state, or photos. Navigating, opening
  sheets and menus, switching language, and running an import up to its
  preview without saving are fine. Opening `ShareCollectionSheet` is fine;
  adding or removing a person is not. Never create a share to reach the
  viewer states. A state that needs data the account lacks is marked
  `skipped: needs data`, not faked.
- **Translation cache.** Tapping the translate chip writes a cache doc to
  production, so the translated and chip-loading states are captured only
  when the person who starts the run opts in for that run, on one named
  recipe, and the report lists every cache doc written. Without the opt-in,
  they are `skipped: needs opt-in`.
- **Other members' data.** A state that shows another member's recipe
  content or email (a shared recipe, the shared-with-you banner, grantee
  emails in `ShareCollectionSheet`, `/admin`) is captured only if that data
  is redacted, by cropping or blurring, before it goes to a model;
  otherwise it is `skipped: shows another member's data`. The report lists
  every state skipped or redacted for this reason.
