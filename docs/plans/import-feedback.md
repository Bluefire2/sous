# Import feedback

Status: merged (#107), not deployed. TTL policy applied 2026-10-01.

## Goal

When a recipe import goes wrong, the person can send the owner a report with one tap,
without typing anything. "Goes wrong" means either:

- `POST /api/import` returned an error; or
- the import check from PR #103 flagged warnings.

The report bundles three things: the source (the link, or the pasted text), the error,
and what the import returned. A note is allowed, and the card says it is optional.

The preview of a clean import gets a small 👍/👎 row below the form. 👎 opens the same
report card.

Why: the import log line keeps only `origin + pathname` and codes, so the owner cannot
see which link failed or what came out. `docs/plans/import-reliability.md` phase 1 is
blocked on exactly this.

## Out of scope

- The RecipeView warning banner (`src/components/ImportWarningBanner.tsx`).
- The Chrome extension (`extension/`) and `POST /api/extension/import`.
- An `/admin` screen for reports. The owner reads them with a script.
- Emailing the owner about a report.
- Changing `Recipe`, `RecipeDraft`, `ImportRecipeResult`'s fields, the import prompt,
  or the import pipeline (`server/recipeImport.ts`).

## Decisions (final; do not revisit)

1. **Storage.** Reports go in Firestore, in the top-level collection
   `importFeedback/{id}`.
   - **Not under `users/{uid}`:** a report is for the owner, not library data. It must
     never sync, pull, or go into a backup.
   - **Not a log line:** logs are kept free of recipe text by rule, and a report needs
     that text.
2. **Report id.** The client generates the id with `crypto.randomUUID()`, and the
   server writes with `DocumentReference.create()`. A resend after a lost response
   then hits ALREADY_EXISTS. The Admin SDK `@google-cloud/firestore` reports that as
   gRPC `code === 6`, a number. The server treats it as success (204).
3. **Stored document:** `ImportFeedbackDoc`.
   - It holds the full link, as submitted, with `user:pass@` removed.
   - For a paste import it holds the pasted text, capped at 150,000 UTF-8 bytes.
   - For a photo import it holds the photo count only.
   - It holds the error's code, HTTP status, site status, and message.
   - It holds the original extraction as a JSON string (`recipeJson`), capped at
     200,000 UTF-8 bytes. The extraction is kept as a string because a broken one
     would fail draft validation, and broken ones are the reports that matter.
   - It also holds the warning codes, the translation state, an optional comment of
     up to 2,000 characters, and the UI locale.
   - It never holds an email address, photo bytes, or the notes typed with photos.
4. **Lenient validation.** The server rejects a request only when:
   - the body is not an object;
   - `trigger` or `via` is unknown; or
   - `id` is not a UUID.

   Any other malformed field is dropped or truncated, and the report is still
   stored.
5. **👍 stores no document.** It only writes the `import_feedback` log line. The
   import log lines already give the denominator.
6. **Retention.** Each document carries `expireAt`, a JS `Date` that the Admin SDK
   stores as a Timestamp, set to `createdAt + 180 days`.
   - A Firestore TTL policy on `expireAt` deletes expired reports. Setting it up is a
     one-time owner step (Owner steps below), not part of the implementation.
   - An account deletion request covers reports too.
7. **Rate limit.** 20 requests per hour per `sub`, per container instance. It reuses
   `admitTranslateCall` from `server/recipeTranslation.ts`, which is generic, with a
   separate bucket map.
8. **Who sees a card.** A card appears only for an error that `importRecipe` threw
   with a numeric HTTP `status` other than 401 (see `importFailureDetails`).
   That excludes:
   - client-side validation and photo-size messages;
   - an expired session;
   - network errors;
   - in bulk import, `recipeStore.create` and missing-collection failures, and the
     rows filled in after a session expired.
9. **Surfaces:**
   - **Single import fails:** a full card under the error.
   - **Preview with warnings:** a compact card placed right *after* the warning
     notice, as a sibling. It must not go inside the notice, because that notice is
     `role="status"`.
   - **Clean preview:** the 👍/👎 row after the form. 👍 replaces the row with
     "Thanks". 👎 replaces the row with a full card. Only one of the two can be sent.
   - **Bulk summary:** a "Report a problem" text button on failed rows that have
     failure details, and on needs-attention rows. It expands a card inside the row.
10. **Photos.** A report from a photo import never holds the photos or the notes.
    Photo imports run no import check, so only `failed` (count and error) and 👎
    (count and the extraction) apply. This adds a Firestore write that
    `docs/constitutions/image-import.md` principle 3 did not allow, so that principle is
    amended in the same change.
11. **Privacy.** `/privacy` and `/terms` change in the same change.
    - Reports are a new store of recipe text, which i18n principle 14 requires the
      pages to disclose.
    - `import_feedback` is a new log line, and AGENTS.md says those pages change with
      the log lines.

## Where reports are stored

| | |
| --- | --- |
| GCP project | `cooking-assistant-508423` |
| Database | Firestore Native, `(default)`, region `europe-west1` (the same database as the library) |
| Collection | `importFeedback`, top level. Not under `users/{uid}`. |
| Document id | A UUID v4 that the client generates for each report card. A retry from the same card reuses it. |
| Writer | Only `POST /api/import-feedback` (`server/importFeedback.ts`), through the Admin SDK, with `create()`. A repeat id counts as success. No client writes Firestore directly. |
| Readers | The owner, through `scripts/import-feedback.ts` (read-only) or the Firestore console. The app never reads reports back. |
| Retention | A Firestore TTL policy on `expireAt` deletes each report about 180 days after `createdAt`. Applying the policy is an owner step (see Owner steps). |
| Not stored | 👍 ratings. They write only the `import_feedback` log line. |

Reports never sync, pull, or go into a backup. Nothing in `src/lib/syncEngine.ts`,
`server/sync.ts`, or `src/lib/backup.ts` touches this collection.

## Report schema

The source of truth is `ImportFeedbackDoc` in `server/importFeedback.ts`, together
with the wire types in `server/importFeedbackShape.ts`. The server validates every
field leniently: a malformed field is dropped or truncated, and the rest of the
report is still stored. An absent field is omitted, never stored as `null` or
`undefined`.

### Document `importFeedback/{id}`

| Field | Type | Present | Meaning and limits |
| --- | --- | --- | --- |
| `v` | `1` | always | Schema version. |
| `sub` | string | always | The sender's Google account `sub`, taken from the session and never from the request body. |
| `createdAt` | number | always | Server time, in milliseconds since the epoch. |
| `expireAt` | Timestamp | always | `createdAt + 180 days`. The TTL field. |
| `trigger` | `'failed'` \| `'warnings'` \| `'down'` | always | `failed`: `/api/import` returned an error. `warnings`: the import check flagged the result. `down`: a 👎 on a clean preview. |
| `via` | `'url'` \| `'paste'` \| `'photos'` \| `'generate'` | always | How the recipe arrived. Bulk rows are `url`. `generate` is a recipe the model wrote from an idea (`docs/plans/recipe-generation.md`). |
| `url` | string | when the import had a link | The full http(s) link as submitted, including any query and fragment, with `user:pass@` removed. At most 2,048 characters; a longer link is dropped. |
| `pastedText` | string | `via: 'paste'` or `'generate'` | The text the person pasted, or for `generate` the idea they typed, cut to at most 150,000 UTF-8 bytes without splitting a character. |
| `pastedTruncated` | `true` | when `pastedText` was cut | |
| `photos` | integer 1–4 | `via: 'photos'` only | How many photos were sent. The photos and the notes typed with them are never stored (`docs/constitutions/image-import.md`, principle 3). |
| `error` | map | `failed` reports | See `error` below. Omitted when no part of it is valid. |
| `result` | map | `warnings` and `down` reports | See `result` below. Omitted when no part of it is valid. |
| `comment` | string | when the person wrote a note | Trimmed, at most 2,000 characters. |
| `locale` | `'en'` \| `'uk'` \| `'ru'` \| `'zh-Hans'` | normally | The UI language when the report was sent. |

### `error`

| Field | Type | Meaning and limits |
| --- | --- | --- |
| `code` | string matching `^[a-z0-9-]{1,64}$` | The machine code from `/api/import`, for example `import-no-recipe` or `import-refused`. Absent when the response had none, such as the dispatcher's plain-text 500. |
| `status` | integer 100–599 | The HTTP status `/api/import` answered with. |
| `siteStatus` | integer 100–599 | The recipe site's own status, when it refused the fetch (`import-refused`). |
| `message` | string, at most 500 characters | The error text the person saw, in their UI language. |

### `result`

| Field | Type | Meaning and limits |
| --- | --- | --- |
| `recipeJson` | string | `JSON.stringify` of the original extraction (`RecipeDraft`), before any edit the person made in the preview. Capped at 200,000 UTF-8 bytes, so a truncated value may not parse. It is a string, not a map, because a broken extraction would fail draft validation, and broken extractions are what reports are for. |
| `recipeTruncated` | `true` | Set when `recipeJson` was cut. |
| `warnings` | array of `{ code, at? }` | The import check's warnings, read with `readImportWarnings` (`server/importWarnings.ts`). `code` is an `ImportWarningCode`. `at` is `[section, item]` in `ingredientSections`. |
| `translationFailed` | `true` | Translation was requested and failed. |
| `translatedTo` | supported locale | The language the preview was translated into. |

### Request bodies (`POST /api/import-feedback`)

- **A report** is the document above, minus `v`, `sub`, `createdAt`, and
  `expireAt`, plus the id: `{ id, trigger, via, url?, pastedText?,
  pastedTruncated?, photos?, error?, result?, comment?, locale? }`
  (`ImportFeedbackReport`). Answers 204, even for a repeat id.
- **A 👍** is `{ trigger: 'up', via, url? }` (`ImportRatingUp`). Nothing is
  stored. Answers 204.
- **Errors:**
  - 400 `feedback-bad-request`: the body is not an object, `trigger` or `via` is
    unknown, or a report's `id` is not a UUID.
  - 413 `feedback-too-large`: the body is over 512 KiB.
  - 429 `feedback-rate-limited`: more than 20 requests an hour from one `sub`, per
    instance.
  - 503: the store failed.
  - 401: the membership gate (`withMembership`) refused the request.

### Log line

Every request writes one line with these fields:
`{ event: 'import_feedback', sub, trigger, via, host?, codes?, hasComment?, status, errorCode?, ms }`.

- `host` is the link's host name only.
- `codes` are the warning codes.
- `errorCode` is a numeric gRPC code, set when the store write failed.
- The line never contains the link's path or query, recipe text, pasted text, the
  comment, or an error message.

## Owner steps (not for the implementer; recorded so they are not lost)

1. **TTL policy.** Done 2026-10-01 (the state read `CREATING` right after; it becomes `ACTIVE`). Recorded for a new database or project: before the first deploy that contains this feature, run
   `gcloud firestore fields ttls update expireAt --collection-group=importFeedback --enable-ttl --project=cooking-assistant-508423`.
   - Confirm it with
     `gcloud firestore fields ttls list --collection-group=importFeedback --project=cooking-assistant-508423`.
   - `gcloud` is at
     `C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
     It is not on PATH, and the machine's default project is a different one, so
     always pass `--project`.
   - Without the policy, `/privacy`'s 180-day promise is false.
2. **Account deletion request:** `scripts/delete-account-data.ts` deletes the
   member's reports with the rest of their data (README.md, "Manual deletion
   procedure").

## Implementation

New:

- `server/importFeedbackShape.ts` and its test: the wire shape, `truncateUtf8`, `feedbackUrl`.
- `server/importFeedback.ts` and its test: `POST /api/import-feedback`.
- `src/lib/importFeedback.ts` and its test: the report builder.
- `src/lib/importFeedbackApi.ts` and its test: `sendImportFeedback`.
- `src/components/ImportFeedbackCard.tsx`, `src/components/ImportFeedbackRating.tsx`.
- `scripts/import-feedback.ts`: read-only owner script.

Edited:

- `src/lib/importApi.ts` (and test): a failed import carries `code`, `status`, `siteStatus`.
- `src/lib/icons.tsx`, `src/components/ImportPreview.tsx`, `src/screens/ImportScreen.tsx`.
- `scripts/server.ts`: the route.
- `server/membership.test.ts`: the `authorizedSub` architecture lock counts the new route's one use, and assertion 5 checks it is wrapped in `withMembership`.
- The four `src/i18n/*.ts` catalogs and `docs/i18n-review/screens.json`.
- `public/privacy.html`, `public/terms.html`, `docs/constitutions/image-import.md`, `AGENTS.md`.
