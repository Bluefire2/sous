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
`server/env.ts`). `scripts/firestore-counts.ts` counts documents per
collection group for the before/after comparison. `.gcloudignore` and
`.dockerignore` leave out `.claude`, `.agents` and `.codex`, so a deploy from
a checkout holding agent worktrees does not upload them. Merged just before
the window, because the next deploy from `main` targets the US.

## Phase 3 — Cutover

Downtime runs from the freeze until the US service answers on the domain. The
client has no outbox, so a write during the window is lost; members are told
beforehand. Claude runs the commands with the owner's gcloud login and the
owner approves each one. gcloud commands are PowerShell, with
`$GC = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"`,
`$P = 'cooking-assistant-508423'`, and `--project=$P` on every call.

**Counting.** `scripts/firestore-counts.ts` is read-only and prints the
database first. Set the database explicitly for each run and clear it after:

```powershell
$env:FIRESTORE_DATABASE_ID = '(default)'   # or 'sous-us'
node --env-file=.env.local scripts/firestore-counts.ts
Remove-Item Env:FIRESTORE_DATABASE_ID
```

Compare the `comparable` total and each line. For the five TTL groups only
`unexpired` must match: the TTL sweep may delete expired documents on either
side at any time. Both runs must use the same instant: the script prints
`as-of <ISO time>`, and a later run passes it back as `--as-of=<ISO time>`.
MCP access tokens expire within the hour, so two runs that each use "now"
differ during the window without any data lost.

1. **Freeze EU.** `& $GC run services update sous --region=europe-west1 --ingress=internal --project=$P`.
   `https://sous.kyrylo.lol/` now answers 404. The EU service stays frozen
   until it is deleted, so its `run.app` URL cannot write to `(default)`
   again. Requests already running finish after the switch (a chat stream can
   run to the 300 s timeout and then writes `llmUsage`), and a managed export
   is not a consistent snapshot, so wait until the EU request log
   (`resource.type="cloud_run_revision"`, `resource.labels.location="europe-west1"`)
   has been quiet for five minutes. Then count `(default)` and record the
   `as-of` time it prints. That count, not the preflight one, is what
   `sous-us` must match.
2. **Export.** `& $GC firestore export gs://sous-migration-eu-cooking-assistant-508423/<UTC yyyymmdd-hhmm> --database='(default)' --project=$P`.
   The command waits for the operation and prints its name.
3. **Copy the export.** `& $GC storage cp -r gs://sous-migration-eu-cooking-assistant-508423/<ts> gs://sous-migration-us-cooking-assistant-508423/ --project=$P`.
4. **Import.** Count `sous-us` first: every line must be 0. Then
   `& $GC firestore import gs://sous-migration-us-cooking-assistant-508423/<ts> --database=sous-us --project=$P`.
   An import overwrites by id and never removes documents, so a second
   attempt (after a rollback, say) needs an emptied or recreated `sous-us`,
   or documents deleted in the EU meanwhile come back.
5. **Photos.** `& $GC storage rsync -r --delete-unmatched-destination-objects gs://sous-photos-cooking-assistant-508423 gs://sous-photos-us-cooking-assistant-508423 --project=$P`.
   Object count and `storage du -s` must match on both sides.
6. **First US deploy, from a clean checkout of merged `main`.** `deploy.sh`
   uploads the folder it lives in, uncommitted and untracked files included,
   so never run it from the main checkout (it is usually on another branch,
   with work in progress and the agents' worktrees under `.claude/`). In Git
   Bash:

   ```bash
   git -C /c/Users/chern/Documents/cook fetch origin main
   git -C /c/Users/chern/Documents/cook worktree add --detach /c/Users/chern/Documents/sous-deploy origin/main
   cd /c/Users/chern/Documents/sous-deploy
   git status --short   # must print nothing
   git log -1 --oneline # must be the merge of this PR
   SECRETS_FROM_REGION=europe-west1 bash scripts/deploy.sh
   ```

   Give `SECRETS_FROM_REGION` inline, never `export` it: left in the shell, a
   later deploy would keep reading `ALLOWED_EMAILS` and the other secrets from
   the frozen EU service, and the env map it writes replaces the whole map.
   `deploy.sh` reads the secrets from the EU service (the frozen one still
   answers `describe`) and deploys to `us-central1`. Without the variable it
   refuses rather than mint a new `SESSION_SECRET`, which would sign every
   device out. Every secret must log "reused from the deployed service".
   Afterwards: `git -C /c/Users/chern/Documents/cook worktree remove /c/Users/chern/Documents/sous-deploy`.
7. **Check the new service's shape.** Compare
   `& $GC run services describe sous --region=us-central1 --project=$P --format=json`
   with the EU one: runtime SA, one container, limits, timeout 300,
   concurrency 80, startup CPU boost, max instances, the service-level
   `run.googleapis.com/maxScale`, and env names (never values). Apply any
   difference with `gcloud run services update`. Count `sous-us` with
   `--as-of=<the step 1 time>` and compare it with the step 1 count. Check the `run.app` URL serves `/` and `/about`,
   and the new service's log shows a clean start.
8. **Local env.** Every `.env.local` (the main checkout and each worktree
   copy) gets `FIRESTORE_DATABASE_ID=sous-us` and
   `PHOTO_BUCKET=sous-photos-us-cooking-assistant-508423`. Without them,
   `dev:api` and every script quietly use the frozen EU copy; the scripts
   print `Firestore: <project>/<database>` first.
9. **Move the domain.** A domain maps to one service at a time:

   ```powershell
   & $GC beta run domain-mappings delete --domain=sous.kyrylo.lol --region=europe-west1 --project=$P
   & $GC beta run domain-mappings create --service=sous --domain=sous.kyrylo.lol --region=us-central1 --project=$P
   & $GC beta run domain-mappings describe --domain=sous.kyrylo.lol --region=us-central1 --project=$P --format="yaml(status.conditions,status.resourceRecords)"
   ```

   The record must still be CNAME `sous` → `ghs.googlehosted.com.`; if it is
   anything else, the owner changes it in Cloudflare (grey cloud, DNS only).
   Rerun `describe` until `CertificateProvisioned` is `True` (minutes,
   sometimes hours; HTTPS is down meanwhile). Do not touch DNS while waiting.
10. **Verify on the domain.** Owner: sign in, open the library, open a recipe
    with a photo, Settings → Refresh, send one chat message, import one
    recipe, list recipes over MCP. Claude: the chat framing check (no
    `Content-Length` or `Content-Encoding` on `/api/chat`), `/privacy` says
    `us-central1`, and `event: 'import'` lines under the US service.
11. **Delete the exports** from both migration buckets as soon as step 10
    passes: each is a full copy of every member's data. The buckets keep
    deleted objects 7 days (soft delete), then they are gone.

## Phase 4 — Cleanup

- After a clean week: delete the EU Cloud Run service, the EU Artifact
  Registry repo, and both (by then empty) migration buckets. This ends the
  rollback window.
- After 30 days: delete the EU photo bucket and the EU `(default)` database,
  which holds stale personal data. **Until then, an account deletion request
  also covers the EU copy, as README deletion step 4 describes: mark
  `members/{sub}` revoked in `(default)` (the frozen copy still says
  `active`, so `--apply` refuses), run the script with
  `$env:FIRESTORE_DATABASE_ID = '(default)'` (never empty: PowerShell unsets
  an empty variable and `--env-file` puts `sous-us` back), check it prints
  `cooking-assistant-508423/(default)`, clear the variable, and remove the
  member's prefix in the EU bucket.**

## Rollback (until the EU service is deleted, one week after cutover)

Writes made in the US after cutover do not flow back. In order:

1. Delete the domain mapping in `us-central1`, then create it in
   `europe-west1` (another certificate wait).
2. Set the EU service's ingress to `all` and the US service's to `internal`.
3. Revert this PR and restore `.env.local`. Do not redeploy the EU service
   with `REGION=europe-west1 bash scripts/deploy.sh` before the revert: the
   env map's fixed values do not follow `REGION`, so it would point the EU
   service at `sous-us` and the US bucket.

## Record

| Date | Step |
|---|---|
| 2026-10-14 | Phases 0–1 done; phase 2 PR opened. |
