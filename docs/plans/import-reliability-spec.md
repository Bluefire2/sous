# Spec: Recipe Import Reliability

**Status:** Draft
**Area:** Recipe import (URL → Recipe entity)

The feature request that `import-reliability.md` plans. Section numbers (§)
in the plan refer to this file. Kept as written; the plan records where the
build departs from it.

## 1. Background

Recipe import takes a URL, fetches the page, and uses an LLM to parse it into a `Recipe` entity. Dogfooding a bulk import (~50 recipes) surfaced two problems:

1. **Hard failures.** Some imports fail outright. The user has to re-import by hand.
2. **Silent partial failures.** Some imports "succeed" but are missing whole sections. The most common case is ingredients with no instructions. The app shows a generic "check over everything" message, which users ignore during bulk import, so the bad recipes go unnoticed.

The dogfooder estimates that a simple retry would fix ~90% of hard failures. This is anecdotal and should be measured (see §8).

## 2. Goals

- Recover from transient extraction failures automatically, without user action.
- Detect incomplete or suspicious parses deterministically wherever possible.
- Tell the user exactly *what* is wrong with a specific recipe, instead of asking them to review everything.
- Make bulk import trustworthy: if a recipe has no warning, the user can assume it's complete.

## 3. Non-goals

- Fixing page-fetching limitations (JavaScript-rendered content, paywalls). This spec detects and reports them but doesn't solve them. See §9.
- An LLM-as-judge validation pass. Deferred until the data shows programmatic validation leaves meaningful gaps (§6.4).
- Editing or repair suggestions beyond flagging.

## 4. Import pipeline

```
fetch page
  └─> JSON-LD Recipe present & valid? ──yes──> map to Recipe ──> validate
                    │ no
                    v
          LLM extraction (schema-constrained)
                    │
                    v
               validate ──pass──> save (no warnings)
                    │ fail
                    v
           classify failure
             ├─ extraction failure ──> auto-retry (≤ N) ──> validate
             └─ source failure ──────> save with warning (no retry)
```

### 4.1 JSON-LD fast path

Many recipe sites embed schema.org `Recipe` markup as JSON-LD.

- If it's present and passes the structural checks (§6.1), map it directly to `Recipe` and skip the LLM.
- If it's present but incomplete, fall through to LLM extraction and keep the JSON-LD as a **reference** for the cross-checks in §6.2.

### 4.2 LLM extraction

- Use structured output against the `Recipe` schema so the result is always well-formed.
- Add self-report fields to the extraction schema at no extra cost:
  - `instructions_found_on_page: bool`
  - `ingredients_found_on_page: bool`
  - `extraction_notes: string` (optional)

  These are weak signals. Use them as inputs to failure classification, never as the only basis for a pass or fail.

## 5. Failure classification and retry policy

Validation must report *why* a recipe failed, because the cause decides whether a retry can help.

| Failure class | Example | Detected by | Action |
|---|---|---|---|
| **Hard failure** | LLM call errors, times out, or returns unparseable output | Pipeline error | Auto-retry |
| **Extraction failure** | Page text contains instructions, but the output has none | Validation + source check (§6.2) | Auto-retry |
| **Source failure** | Page text contains no instructions (JS-rendered, truncated, behind a link) | Source check (§6.2) | **No retry.** Save with a warning |
| **Soft anomaly** | Ingredient count differs from the JSON-LD count | Cross-check (§6.2) | Save with a warning (no retry, to start) |

**Retry rules**

- Max auto-retries: **2** (initial value; tune using §8 data).
- Retries run in the background and the user never sees them. An attempt counts as a success only if it passes validation.
- If every retry fails, the import ends in the **Failed** state (§7.1) or **Imported with warnings** (§7.2), depending on whether any usable recipe came out.
- Never retry a source failure. The LLM sees the same incomplete input on every attempt and fails the same way.

## 6. Validation

All checks are programmatic and deterministic. Each failed check produces a typed warning code, which drives retries and UI copy.

### 6.1 Structural checks (output only)

| Code | Check |
|---|---|
| `MISSING_INSTRUCTIONS` | Instructions list is empty |
| `MISSING_INGREDIENTS` | Ingredients list is empty |
| `TOO_FEW_STEPS` | Fewer than N steps (initial N = 2; tune) |
| `MISSING_TITLE` | Title is empty |
| `EMPTY_ITEMS` | Any ingredient or step is blank or whitespace only |

### 6.2 Source cross-checks (output vs. fetched page)

| Code | Check |
|---|---|
| `INSTRUCTIONS_NOT_ON_PAGE` | Page text has no instruction-like content: no numbered or ordered step block, no "Instructions/Directions/Method" heading, and the LLM self-report says false. Classifies the problem as a **source failure**. |
| `INSTRUCTIONS_DROPPED` | Page text *does* contain instruction-like content, but the output has none. Classifies the problem as an **extraction failure**. |
| `INGREDIENT_COUNT_MISMATCH` | JSON-LD is present and the extracted ingredient count differs from `recipeIngredient.length` by more than a threshold |
| `STEP_COUNT_MISMATCH` | Same comparison against `recipeInstructions` |
| `UNGROUNDED_INGREDIENT` | An extracted ingredient's core name doesn't appear anywhere in the page text. Indicates hallucination. |

Notes:
- Grounding should match normalized ingredient names (lowercased, stripped of quantities and units, lightly stemmed), not exact lines.
- Heuristics for "instruction-like content" will be imperfect. Start conservative: a false banner costs more trust than a missed one.

### 6.3 Severity

- **Blocking:** `MISSING_INSTRUCTIONS`, `MISSING_INGREDIENTS`, `INSTRUCTIONS_DROPPED`, `INSTRUCTIONS_NOT_ON_PAGE`. These trigger a retry where §5 allows one, and a warning if the recipe still fails.
- **Advisory:** everything else. These produce a warning only.

### 6.4 Deferred: LLM judge

Reconsider a second LLM validation pass only if §8 metrics show a meaningful rate of bad imports that pass every programmatic check. Known limitation: a judge that sees the same fetched input as the extractor can't detect content that never made it into that input.

## 7. UX

### 7.1 Failed import

- Show the failed import in the import list with an error state and a **Retry** button.
- Manual retry runs the full pipeline again, including a fresh fetch of the page.
- Copy: "Couldn't import this recipe." Add a short reason when one is known.

### 7.2 Imported with warnings

- Show a warning banner at the top of the recipe view naming the **specific** issue. Example copy:
  - `INSTRUCTIONS_NOT_ON_PAGE`: "We couldn't find instructions on this page. Add them manually or check the original."
  - `INGREDIENT_COUNT_MISMATCH`: "Some ingredients may be missing. Compare with the original."
  - `UNGROUNDED_INGREDIENT`: "'Saffron' doesn't appear on the original page. Double-check it."
- Banner actions: **Retry import**, **View original**, **Dismiss**.
- Dismissing hides the banner for that recipe only and records the dismissal (§8).

### 7.3 Clean import

- No banner. **Remove the generic "check over everything" message.** A missing warning should mean the recipe is complete; a blanket disclaimer undermines that.

### 7.4 Bulk import

- Summary on completion: "48 imported · 3 need attention · 2 failed."
- The "need attention" and "failed" counts are tappable and filter the list to those recipes.
- Each recipe in the list shows a warning or error indicator.

## 8. Metrics and logging

Log the following for each import:

- Path taken (JSON-LD fast path vs. LLM)
- Number of attempts, and the result of each
- Warning codes raised, and the final state
- Source URL and domain (to find sites that fail repeatedly)
- Banner dismissals, and manual edits made after a warning

Key questions these should answer:

- **Retry efficacy:** what fraction of first-attempt failures pass on attempt 2 and on attempt 3? This tests the ~90% estimate.
- **Source vs. extraction split:** of `MISSING_INSTRUCTIONS` cases, how many are source failures? If most are, the right investment is page fetching (§9), not retries.
- **False positive rate:** how often is a warning dismissed without any edit?
- **JSON-LD coverage:** what percentage of imports use the fast path?

## 9. Open questions

1. **Page fetching.** If source failures dominate, do we add headless rendering for JavaScript-heavy sites, follow "jump to recipe" links, or use per-domain handling? Out of scope for this spec, but likely the next one.
2. **Thresholds.** Initial values for the minimum step count and the count-mismatch tolerance. Calibrate them against the dogfooder's failing batch before launch.
3. **Should advisory warnings trigger a retry?** Not for now. Revisit once retry costs and efficacy data are in.
4. **Retry backoff.** Should retries be immediate or delayed? This matters if failures turn out to be rate limits rather than model variance.

## 10. Rollout

1. Pull the URLs that failed in the dogfooder's batch and classify them by hand into source vs. extraction failures. This validates §5 before any code is written.
2. Ship validation and logging first, with warnings enabled and auto-retry disabled. Measure.
3. Enable auto-retry for extraction failures.
4. Add the JSON-LD fast path.
