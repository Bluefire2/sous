# Feature requests

Status: built on `claude/feature-requests`, not deployed. TTL policy on
`featureRequests.expireAt` not yet applied (see Owner steps).

## Goal

A signed-in member can tell the owner "I wish Sous did X" from a page at `/suggest`.
The way in is visible but never in the way:

- a muted line under the last library card: "Missing something? **Suggest a feature**";
- a Feedback section in Settings, above the About / Privacy / Terms links.

There is no header control: the library header already holds five controls, and a
sixth crowds narrow phones.

## Out of scope

- An `/admin` screen. The owner reads suggestions with a script.
- Emailing the owner about a suggestion (it would send the text through Resend).
- Screenshots or attachments, voting, or a public list of suggestions.
- Signed-out or non-member suggestions. The route is behind `withMembership`.

## Decisions

- One required text box (trimmed, 1–4000 characters) and one optional checkbox,
  "You can email me about this", unchecked by default.
- The email address is **never** stored. When `contactOk` is true, the reader script
  looks it up from `users/{sub}` and prints it to the owner's terminal only.
- Context sent with the text: app language, which entry point opened the page, and
  whether Sous runs as an installed app. Nothing else: no user agent, URL, recipe, or
  library data. A "What's included" disclosure on the page says exactly this.
- Kept for one year, then deleted by a Firestore TTL policy.
- At most 5 new suggestions per member per hour, per container instance. Only a newly
  created document uses a slot: a store failure (503) or a repeat id gives it back. When
  the window is full, a resend of an id this member already stored is still 204 (checked
  with a read), so a lost response on the 5th send never looks like a failure. Any other
  send is 429.
- The text box takes focus on open only with a fine pointer, so a phone keyboard does
  not cover the intro and the contact choice.

## Where suggestions are stored

| | |
| --- | --- |
| GCP project | `cooking-assistant-508423` |
| Database | Firestore Native, `(default)`, region `europe-west1` (the same database as the library) |
| Collection | `featureRequests`, top level. Not under `users/{uid}`. |
| Document id | A UUID v4 the page generates for each suggestion. A retry of the same suggestion reuses it; "Suggest something else" makes a new one. |
| Writer | Only `POST /api/feature-request` (`server/featureRequest.ts`), through the Admin SDK, with `create()`. A repeat id (ALREADY_EXISTS, gRPC code 6) counts as success. No client writes Firestore directly. |
| Readers | The owner, through `scripts/feature-requests.ts` (read-only) or the Firestore console. The app never reads suggestions back. |
| Retention | A Firestore TTL policy on `expireAt` deletes each suggestion about 365 days after `createdAt`. Applying the policy is an owner step. |

Suggestions never sync, pull, or go into a backup.

## Suggestion schema

### Document `featureRequests/{id}` (`FeatureRequestDoc`)

| Field | Type | Notes |
| --- | --- | --- |
| `v` | `1` | Schema version. |
| `sub` | string | The sender's Google `sub`, from the session only; a `sub` in the body is ignored. |
| `createdAt` | number | Server time, ms since epoch. |
| `expireAt` | Timestamp | `createdAt` + 365 days. Drives the TTL policy. |
| `text` | string | Trimmed, 1–4000 characters. |
| `contactOk` | boolean | The sender allowed an email reply. Anything but `true` is stored as `false`. |
| `from` | `'library' \| 'settings'`, optional | Which entry point opened the page. Anything else is dropped. |
| `locale` | string, optional | The UI language, through `toSupportedLocale`. |
| `standalone` | boolean, optional | `display-mode: standalone` matched (installed app). |

Never stored: email address, display name, user agent, IP, URL, or any library data.

### Request body (`POST /api/feature-request`, `FeatureRequestBody`)

`{ id, text, contactOk, from?, locale?, standalone? }`, at most 16 KiB. A non-object
body, a non-UUID id, or empty text is 400 `feature-request-bad-request`; over 16 KiB is
413 `feature-request-too-large`; over the rate limit is 429
`feature-request-rate-limited` (except a resend of the sender's own stored id, which is
204); a store failure is 503. Success is 204 with no body.
Anything else that throws is rethrown as `sanitizedError('Feature request failed', …)`
so the dispatcher never logs the text.

### Log line

One `event: 'feature_request'` line per request: `sub`, `from`, `chars` (text length),
`contactOk`, `status`, `errorCode` (numeric gRPC code of a failed write), `ms`. Never the
text.

`/privacy` describes the stored suggestion and this line (What is stored, Server logs,
What it is used for, Retention and deletion). Change it with them. `/terms` does not
list stored data in general and is unchanged.

## Owner steps

1. Apply the TTL policy (PowerShell; gcloud is not on PATH):

   ```
   & "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" firestore fields ttls update expireAt --collection-group=featureRequests --enable-ttl --project=cooking-assistant-508423
   ```

2. Read suggestions:

   ```
   node --env-file=.env.local scripts/feature-requests.ts [--days N] [--email addr]
   ```

   `--days` defaults to 30. The script warns when a document is more than 3 days past
   `expireAt`, which means the TTL policy is not applied.

3. **Account deletion request.** `/privacy` promises that a deletion request covers
   suggestions. They sit in top-level `featureRequests`, outside `users/{uid}`;
   `scripts/delete-account-data.ts` deletes them with the rest of the account's data
   (README.md, "Manual deletion procedure"). To see what will go first, run
   `node --env-file=.env.local scripts/feature-requests.ts --days 366 --email <email>`.
