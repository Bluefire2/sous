# Move Sous from `europe-west1` to `us-central1`

Status: phases 0–2 done 2026-10-14; cutover (phase 3) and cleanup (phase 4)
are recorded below as they happen.

## Why

The owner and every member are in the US, so every request crossed the
Atlantic. The region was never chosen for the members:
[`sous-subdomain.md`](sous-subdomain.md) wanted London (`europe-west2`), found
it has no Cloud Run domain mappings, and took the nearest region that does.
Nothing needs EU residency ([`image-import` constitution](../constitutions/image-import.md) §9).

## Decisions

- **Region `us-central1`**: cheapest tier, supports Cloud Run domain mappings.
- **Named Firestore database `sous-us`**, not a re-created `(default)`. A
  Firestore location is permanent, so the US database is new either way; a
  named one lets the EU `(default)` stay untouched as the rollback.
  `firestoreConfig()` (`server/env.ts`) already reads `FIRESTORE_DATABASE_ID`,
  and every server path and script gets its client from `server/store.ts`, so
  one env var moves the app and the scripts. Cost: Firestore's free daily quota
  applies only to `(default)`, so `sous-us` bills from the first read.
- **Same service name, domain, OAuth client, `SESSION_SECRET`.** Sessions, MCP
  tokens, and grants live in env or Firestore and move with them; nobody signs
  in again.

## Names

| | EU (before) | US (after) |
|---|---|---|
| Cloud Run `sous` | `europe-west1` | `us-central1` |
| Firestore | `(default)` | `sous-us` (Native, delete protection on) |
| Photo bucket | `gs://sous-photos-cooking-assistant-508423` | `gs://sous-photos-us-cooking-assistant-508423` |
| Artifact Registry `sous` | `europe-west1-docker.pkg.dev/…` | `us-central1-docker.pkg.dev/…` |
| Migration buckets (temporary) | `gs://sous-migration-eu-cooking-assistant-508423` | `gs://sous-migration-us-cooking-assistant-508423` |

## Phase 0 — Preflight (2026-10-14, read-only)

- EU service: revision `sous-00031-xfc`, image
  `europe-west1-docker.pkg.dev/…/sous:20261011-211335`, one container,
  runtime SA `62867274312-compute@developer.gserviceaccount.com`, 1 CPU /
  512Mi, max 4 instances, timeout 300 s, concurrency 80, startup CPU boost.
  Ten env vars, no `RESEND_API_KEY` or `TRANSLATE_*`.
- `(default)`: no composite indexes, no single-field exemptions, five TTL
  policies on `expireAt` (`importFeedback`, `featureRequests`,
  `mcpAuthCodes`, `mcpTokens`, `llmUsage`), all `ACTIVE`. Pessimistic
  concurrency, Standard edition.
- Baseline: 351 documents over the collection groups in
  `FIRESTORE_COLLECTIONS` (117 `recipes`, 80 `chatMessages`, 88 `mcpTokens`,
  8 `users`, 7 `members`, …). Photo bucket: 4 objects, 753 847 bytes; IAM is
  the project legacy roles plus `roles/storage.objectAdmin` for the runtime SA.
- Domain mapping `sous.kyrylo.lol` → `europe-west1`, CNAME
  `ghs.googlehosted.com`.

## Phase 1 — US resources (2026-10-14, additive)

Done: the Artifact Registry repo, `sous-us` (same concurrency mode and
edition as `(default)`), the photo bucket with the runtime SA's
`objectAdmin`, both migration buckets, the five TTL policies on `sous-us`,
and a first photo copy (4 objects, same byte count).

## Phase 2 — Repo

`scripts/deploy.sh` defaults to `us-central1` and writes
`FIRESTORE_DATABASE_ID=sous-us` and the US bucket into the env map;
`.github/workflows/deploy.yml`, `.env.example`, `/privacy`, README, AGENTS.md
and two constitution sentences name the new region. `deploy.sh` also takes
`SECRETS_FROM_REGION` and refuses to mint a `SESSION_SECRET` when there is no
service to read one from (unless `ALLOW_NEW_SESSION_SECRET=1`), and every
script that opens Firestore prints its target (`firestoreTarget()` in
`server/env.ts`). Merged just before the window, because the next deploy from
`main` targets the US.

## Phase 3 — Cutover

Downtime runs from the freeze until the US service answers on the domain. The
client has no outbox, so a write during the window is lost; members are told
beforehand.

1. Freeze EU: `gcloud run services update sous --region=europe-west1
   --ingress=internal`. It stays frozen until deleted, so its `run.app` URL
   cannot write to `(default)` again.
2. `gcloud firestore export gs://sous-migration-eu-…/<ts> --database='(default)'`.
3. `gcloud storage cp -r` the export to the US migration bucket.
4. `gcloud firestore import gs://sous-migration-us-…/<ts> --database=sous-us`.
5. Photos: `gcloud storage rsync -r --delete-unmatched-destination-objects`
   EU → US, so a photo deleted in the EU since the first copy is not
   resurrected.
6. First US deploy from merged `main`:
   `SECRETS_FROM_REGION=europe-west1 bash scripts/deploy.sh`. `deploy.sh`
   reads secrets back from the service in `SECRETS_FROM_REGION` (the frozen
   EU one still answers `describe`) and deploys to `REGION`. Without it there
   is no service to read in `us-central1`, and it now refuses rather than
   mint a new `SESSION_SECRET`, which would sign every device out. Every
   secret must log "reused from the deployed service".
7. Compare the new service with the EU one (SA, container count, limits,
   timeout, concurrency, CPU boost, max instances, env names; never values),
   and apply any difference with `gcloud run services update`. Count
   `sous-us` against the baseline.
8. Every `.env.local` (the main checkout and each worktree copy) gets
   `FIRESTORE_DATABASE_ID=sous-us` and `PHOTO_BUCKET=sous-photos-us-cooking-assistant-508423`.
   Without them, `dev:api` and every script quietly use the frozen EU copy;
   the scripts print `Firestore: <project>/<database>` first, so check it.
9. Move the domain mapping: delete in `europe-west1`, create in
   `us-central1`, wait for `CertificateProvisioned=True` (minutes, sometimes
   hours; HTTPS is down meanwhile). DNS is unchanged while the target stays
   `ghs.googlehosted.com`.
10. Verify on the domain: sign-in, library, a photo, Refresh, one chat message
    (no `Content-Length` or `Content-Encoding` on `/api/chat`), one import, MCP.
11. Delete the export from both migration buckets as soon as step 10 passes:
    each is a full copy of every member's data. The buckets have 7-day soft
    delete, so the objects are gone for good a week later.

## Phase 4 — Cleanup

- After a clean week: delete the EU Cloud Run service, the EU Artifact
  Registry repo, and both (by then empty) migration buckets.
- After 30 days: delete the EU photo bucket and the EU `(default)` database,
  which holds stale personal data. **Until then, an account deletion request
  also covers the EU copy (README, deletion steps 4–5): run
  `FIRESTORE_DATABASE_ID= node --env-file=.env.local scripts/delete-account-data.ts <sub>`
  (an empty value means `(default)`; the script prints which database it is
  using) and remove the member's prefix in the EU bucket.**

## Rollback (until phase 4 deletes the EU side)

Writes made in the US after cutover do not flow back. Move the domain mapping
back to `europe-west1` (another certificate wait), set the EU service's
ingress to `all`, set the US service's to `internal`, revert this PR, and
restore `.env.local`.

## Record

| Date | Step |
|---|---|
| 2026-10-14 | Phases 0–1 done; phase 2 PR opened. |
