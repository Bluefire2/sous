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
and two constitution sentences name the new region. Merged just before the
window, because the next deploy from `main` targets the US.

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
5. Photos: `gcloud storage rsync -r` EU → US again.
6. First US deploy. `deploy.sh` reads secrets back from the service in
   `REGION`, and there is none in `us-central1` yet, so it would prompt for
   each and **mint a new `SESSION_SECRET`** (signing every device out). Run it
   with the EU service's env preloaded (environment wins over the service
   read) and confirm every secret logs "taken from the environment".
7. Compare the new service with the EU one (SA, container count, limits, env
   names) and count `sous-us` against the baseline.
8. Move the domain mapping: delete in `europe-west1`, create in
   `us-central1`, wait for `CertificateProvisioned=True`. DNS is unchanged
   while the target stays `ghs.googlehosted.com`.
9. Verify on the domain: sign-in, library, a photo, Refresh, one chat message
   (no `Content-Length` or `Content-Encoding` on `/api/chat`), one import, MCP.

## Phase 4 — Cleanup

- After a clean week: delete the EU Cloud Run service, the EU Artifact
  Registry repo, and both migration buckets.
- After 30 days: delete the EU photo bucket and the EU `(default)` database,
  which holds stale personal data. **Until then, an account deletion request
  must also run `scripts/delete-account-data.ts` with `FIRESTORE_DATABASE_ID`
  unset (the EU copy) and remove the EU bucket prefix.**

## Rollback (until phase 4 deletes the EU side)

Writes made in the US after cutover do not flow back. Move the domain mapping
back to `europe-west1`, set the EU service's ingress to `all`, set the US
service's to `internal`, and revert this PR.

## Record

| Date | Step |
|---|---|
| 2026-10-14 | Phases 0–1 done; phase 2 PR opened. |
