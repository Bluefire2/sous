# GitHub Actions production deploy

`.github/workflows/deploy.yml` is **`workflow_dispatch` only**. It does not run
on push. Every run replaces the public Cloud Run service behind
https://sous.kyrylo.lol.

**Actions → Deploy → Run workflow.** Pick `main` unless you intend to ship
another ref. Tick **Omit RESEND_API_KEY** only for `SOUS_DISABLE_RESEND=1`.
The job prints the live revision, builds and pushes the image with Docker on
the runner, then runs `SKIP_BUILD=1 bash scripts/deploy.sh` for the Cloud Run
env map. It does **not** call `gcloud builds submit` — that command uploads
to `gs://PROJECT_cloudbuild`, which rejects the WIF identity with
"forbidden from accessing the bucket" even after bucket IAM. Local deploys
still use Cloud Build (`bash scripts/deploy.sh` on your machine). Secrets
are reused from the live service — do not put `GEMINI_API_KEY` or
`SESSION_SECRET` in GitHub Secrets.

The workflow authenticates with Workload Identity Federation as
`sous-github-deploy@cooking-assistant-508423.iam.gserviceaccount.com`. Until
the pool, provider, and service account exist, the job fails at
`google-github-actions/auth`.

Create those once, as the project owner (`chernyshov.k@gmail.com`), always
with `--project=cooking-assistant-508423`. **PowerShell is the better shell
for this block** (`gcloud.cmd` is a Windows program; no MSYS `://` rewriting).
Git Bash is here if you are already in that shell. Do not maintain a third
copy — if a flag changes, edit both listings below.

The GitHub environment is `production`. Add a required reviewer under
**Settings → Environments** if you want a second click before the job starts.
IAM can take a few minutes to propagate.

## If `google-github-actions/auth` rejects the credential

GitHub's OIDC `repository` claim is `Bluefire2/sous` (canonical owner
casing). A condition of `assertion.repository == 'bluefire2/sous'` is
rejected as `unauthorized_client` / "The given credential is rejected by
the attribute condition." Lower-case both the condition and the mapped
`attribute.repository` so the existing
`principalSet://…/attribute.repository/bluefire2/sous` binding still
matches.

If the provider already exists, update it (do not recreate):

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'

& $gcloud iam workload-identity-pools providers update-oidc github-actions --project=$P --location=global --workload-identity-pool=github --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository.lowerAscii(),attribute.repository_owner=assertion.repository_owner.lowerAscii()" --attribute-condition="assertion.repository.lowerAscii() == 'bluefire2/sous'"
```

```bash
export MSYS_NO_PATHCONV=1
gcloud iam workload-identity-pools providers update-oidc github-actions \
  --project=cooking-assistant-508423 \
  --location=global \
  --workload-identity-pool=github \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository.lowerAscii(),attribute.repository_owner=assertion.repository_owner.lowerAscii()" \
  --attribute-condition="assertion.repository.lowerAscii() == 'bluefire2/sous'"
```

Wait about five minutes (WIF provider updates are eventually consistent),
then rerun **Actions → Deploy**.

## PowerShell

`gcloud` is a native executable, so a non-zero exit does **not** stop the
session. Run these one at a time and check `$LASTEXITCODE` is `0` before
moving on.

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'
$PROJECT_NUMBER = '62867274312'
$SA = "sous-github-deploy@${P}.iam.gserviceaccount.com"
$REPO = 'bluefire2/sous'

& $gcloud config get account

& $gcloud services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project=$P

& $gcloud iam service-accounts create sous-github-deploy --project=$P --display-name="GitHub Actions deploy"
& $gcloud iam service-accounts describe $SA --project=$P
# $LASTEXITCODE must be 0 here. GCP reports a missing SA as PERMISSION_DENIED
# on the next command, not as NOT_FOUND.

& $gcloud iam workload-identity-pools create github --project=$P --location=global --display-name="GitHub Actions Pool"

& $gcloud iam workload-identity-pools providers create-oidc github-actions --project=$P --location=global --workload-identity-pool=github --display-name="GitHub Actions" --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository.lowerAscii(),attribute.repository_owner=assertion.repository_owner.lowerAscii()" --attribute-condition="assertion.repository.lowerAscii() == 'bluefire2/sous'"

& $gcloud iam service-accounts add-iam-policy-binding $SA --project=$P --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/run.admin --condition=None
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/cloudbuild.builds.editor --condition=None
& $gcloud projects add-iam-policy-binding $P --member="serviceAccount:${SA}" --role=roles/artifactregistry.writer --condition=None

& $gcloud iam service-accounts add-iam-policy-binding 62867274312-compute@developer.gserviceaccount.com --project=$P --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser

# Cloud Build's default worker is the Compute Engine SA above. The legacy
# PROJECT_NUMBER@cloudbuild.gserviceaccount.com is not created in this project
# — do not bind it. Confirm:
#   & $gcloud builds get-default-service-account --project=$P

# Not used by GitHub Actions (the workflow builds with Docker on the runner).
# Only needed if you run `gcloud builds submit` as the GitHub deploy SA.
& $gcloud storage buckets add-iam-policy-binding "gs://${P}_cloudbuild" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin --project=$P
```

Space-separated service names are separate arguments; do not join them with
commas. Do not use `--set-env-vars` anywhere in this flow (`ALLOWED_EMAILS` is
comma-separated; `deploy.sh` writes `--env-vars-file`).

If `add-iam-policy-binding` on `$SA` returns `iam.serviceAccounts.setIamPolicy`
denied (or it may not exist):

```powershell
& $gcloud iam service-accounts describe $SA --project=$P
& $gcloud projects get-iam-policy $P --flatten="bindings[].members" --filter="bindings.members:user:chernyshov.k@gmail.com" --format="table(bindings.role)"
```

`describe` failing means the create step did not land — re-run create, wait a
minute, describe again. `describe` succeeding but the binding still denied
means this account is not `roles/owner` or `roles/iam.serviceAccountAdmin` on
`$P`. `roles/editor` can create a service account and still cannot set IAM on
it. The same `setIamPolicy` permission is required later for the Cloud Run
runtime SA (the Compute Engine default). Do not bind
`PROJECT_NUMBER@cloudbuild.gserviceaccount.com` — it does not exist in this
project; Cloud Build runs as the Compute Engine SA.

## Git Bash

`gcloud` is often not on PATH, and MSYS rewrites arguments that look like
`https://`, `gs://`, or `principalSet://` when it invokes `gcloud.cmd`. Export
`MSYS_NO_PATHCONV=1` first or those bindings land on the wrong resource.

```bash
export MSYS_NO_PATHCONV=1
if ! command -v gcloud >/dev/null 2>&1; then
  PATH="$HOME/AppData/Local/Google Cloud SDK/google-cloud-sdk/bin:$PATH"
  export PATH
fi
command -v gcloud >/dev/null 2>&1 || { echo "gcloud not found; add the Cloud SDK bin dir to PATH"; exit 1; }

PROJECT=cooking-assistant-508423
PROJECT_NUMBER=62867274312
SA=sous-github-deploy@${PROJECT}.iam.gserviceaccount.com
REPO=bluefire2/sous

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project="$PROJECT"

gcloud iam service-accounts create sous-github-deploy \
  --project="$PROJECT" \
  --display-name="GitHub Actions deploy"
gcloud iam service-accounts describe "$SA" --project="$PROJECT"

gcloud iam workload-identity-pools create github \
  --project="$PROJECT" \
  --location=global \
  --display-name="GitHub Actions Pool"

gcloud iam workload-identity-pools providers create-oidc github-actions \
  --project="$PROJECT" \
  --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub Actions" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository.lowerAscii(),attribute.repository_owner=assertion.repository_owner.lowerAscii()" \
  --attribute-condition="assertion.repository.lowerAscii() == 'bluefire2/sous'"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/run.admin --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/cloudbuild.builds.editor --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role=roles/artifactregistry.writer --condition=None

gcloud iam service-accounts add-iam-policy-binding \
  62867274312-compute@developer.gserviceaccount.com \
  --project="$PROJECT" \
  --member="serviceAccount:${SA}" \
  --role=roles/iam.serviceAccountUser

# Cloud Build's default worker is the Compute Engine SA above. The legacy
# PROJECT_NUMBER@cloudbuild.gserviceaccount.com is not created in this project.
#   gcloud builds get-default-service-account --project="$PROJECT"

# Not used by GitHub Actions (the workflow builds with Docker on the runner).
gcloud storage buckets add-iam-policy-binding "gs://${PROJECT}_cloudbuild" \
  --member="serviceAccount:${SA}" \
  --role=roles/storage.objectAdmin \
  --project="$PROJECT"
```

Stay in Git Bash for local deploys (`bash scripts/deploy.sh`). The Actions job
replaces that once this IAM exists.
