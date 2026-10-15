#!/usr/bin/env bash
set -euo pipefail

# Builds the container and deploys it as the public Cloud Run service behind
# https://sous.kyrylo.lol. Modelled on match-cal's deploy/deploy-web.sh.
#
#   bash scripts/deploy.sh
#
# Secrets are typed once. On every later run they are read back off the
# deployed service, so a redeploy needs nothing in the environment.
# SESSION_SECRET is only generated when describe succeeds and the var was
# absent — regenerating it on a flaky describe would sign every device out.
# With no service at all it is generated only under
# ALLOW_NEW_SESSION_SECRET=1, so a first deploy in a new region cannot sign
# everyone out by accident.
#
# First deploy of an existing app in a new region: read the secrets off the
# old region's service instead of typing them,
#
#   SECRETS_FROM_REGION=europe-west1 bash scripts/deploy.sh
#
# Runs in Git Bash on Windows and unchanged in Cloud Shell. Does not create the
# project, enable APIs, or create the Artifact Registry repo; see
# docs/plans/sous-subdomain.md step 1 for those.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT="${PROJECT:-cooking-assistant-508423}"
# us-central1, where the members are (moved from europe-west1 in 2026-10,
# docs/plans/us-region-move.md). The region must support Cloud Run domain
# mappings (europe-west2, for one, does not): a service deployed in the wrong
# region cannot be mapped without redeploying. Firestore (sous-us) and the
# photo bucket are in the same region; a region change moves all three.
REGION="${REGION:-us-central1}"
# Where secrets are read back from; the deploy itself always goes to REGION.
SECRETS_REGION="${SECRETS_FROM_REGION:-$REGION}"
SERVICE_NAME="${SERVICE_NAME:-sous}"
REPO_NAME="${REPO_NAME:-sous}"
IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT}/${REPO_NAME}/${SERVICE_NAME}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Converts a Windows path (C:\Users\x) to the POSIX form bash needs (/c/Users/x).
to_posix_path() {
  local p="${1:-}"
  [[ -n "$p" ]] || return 1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$p"
  else
    printf '%s' "$p" | sed -e 's#\\#/#g' -e 's#^\([A-Za-z]\):#/\l\1#'
  fi
}

# The reverse: gcloud.cmd is a Windows program and cannot read /tmp/... or
# /c/Users/... paths. Native no-ops everywhere that isn't MSYS/Cygwin.
to_native_path() {
  local p="${1:-}"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p"
  else
    printf '%s' "$p"
  fi
}

# Windows: gcloud is often installed but not on PATH (and Git Bash will not see gcloud.cmd).
ensure_gcloud_on_path() {
  if command -v gcloud >/dev/null 2>&1; then
    return 0
  fi
  local candidates=(
    "$HOME/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Users/${USERNAME:-}/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Program Files (x86)/Google/Cloud SDK/google-cloud-sdk/bin"
    "/c/Program Files/Google/Cloud SDK/google-cloud-sdk/bin"
  )
  local localapp
  if localapp="$(to_posix_path "${LOCALAPPDATA:-}")" && [[ -n "$localapp" ]]; then
    candidates=("$localapp/Google/Cloud SDK/google-cloud-sdk/bin" "${candidates[@]}")
  fi
  local dir
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/gcloud" || -f "$dir/gcloud.cmd" ]]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done
}

require_gcloud() {
  ensure_gcloud_on_path
  command -v gcloud >/dev/null 2>&1 \
    || die "gcloud CLI not found on PATH. Install it and run 'gcloud auth login'. This script does not install it."
  gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
    || die "No active gcloud account. Run: gcloud auth login"
}

# One describe per run. Result: ok | no_service | failed (network, creds, empty JSON).
_DEPLOYED_SERVICE_JSON=""
_DEPLOYED_DESCRIBE_RESULT=""

load_deployed_service_describe() {
  [[ -n "$_DEPLOYED_DESCRIBE_RESULT" ]] && return 0
  local json stderr err
  err=0
  stderr="$(mktemp)"
  [[ "$SECRETS_REGION" == "$REGION" ]] \
    || info "Reading secrets off ${SERVICE_NAME} in ${SECRETS_REGION}; deploying to ${REGION}"
  json="$(gcloud run services describe "$SERVICE_NAME" --region="$SECRETS_REGION" \
    --project="$PROJECT" --format=json 2>"$stderr")" || err=$?
  if [[ "$err" -ne 0 ]]; then
    if grep -qiE 'NOT_FOUND|could not find|does not exist|Resource .* was not found' "$stderr"; then
      _DEPLOYED_DESCRIBE_RESULT=no_service
    else
      _DEPLOYED_DESCRIBE_RESULT=failed
    fi
    rm -f "$stderr"
    return 0
  fi
  rm -f "$stderr"
  if [[ -z "$json" ]]; then
    _DEPLOYED_DESCRIBE_RESULT=failed
    return 0
  fi
  _DEPLOYED_SERVICE_JSON="$json"
  _DEPLOYED_DESCRIBE_RESULT=ok
}

# Single-line node -e: a multiline script inside $(...) prints nothing under Git Bash.
env_value_from_deployed_json() {
  local name="$1"
  [[ -n "$_DEPLOYED_SERVICE_JSON" ]] || return 0
  printf '%s' "$_DEPLOYED_SERVICE_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const env=JSON.parse(s).spec.template.spec.containers[0].env||[];const hit=env.find((e)=>e.name===process.argv[1]);if(hit&&typeof hit.value==="string")process.stdout.write(hit.value);}catch{}});' "$name" || return 0
}

# Reads one env var off the deployed service when describe succeeded; empty on first deploy.
read_deployed_env() {
  load_deployed_service_describe
  case "$_DEPLOYED_DESCRIBE_RESULT" in
    ok) env_value_from_deployed_json "$1" ;;
    *) return 0 ;;
  esac
}

# Git Bash `read -rs` + Windows paste can prefix a C0 control (STX #x0002 is the
# one gcloud's YAML parser has actually rejected). These secrets are printable,
# so strip rather than fail. Single-line node -e: a multiline script inside
# $(...) prints nothing under Git Bash. [\x01-\x1F] not [\u0000-...]: bash cannot
# store NUL anyway, and \u0000 in -e is a quoting footgun on Windows.
strip_controls() {
  printf '%s' "${1:-}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.replace(/[\x01-\x1F\x7F]/g,"")));'
}

# Environment wins, then the deployed service, then an interactive prompt. Never echoed.
resolve_secret() {
  local name="$1" prompt="$2" value orig
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    info "${name} taken from the environment"
  else
    value="$(read_deployed_env "$name" || true)"
    if [[ -n "$value" ]]; then
      info "${name} reused from the deployed service"
    elif [[ -t 0 ]]; then
      printf '%s: ' "$prompt" >&2
      read -rs value
      printf '\n' >&2
    fi
  fi
  orig="$value"
  value="$(strip_controls "$value")"
  if [[ -n "$orig" && "$value" != "$orig" ]]; then
    warn "${name} contained non-printable characters (often a Git Bash paste artefact); they were stripped."
  fi
  [[ -n "$value" ]] || die "${name} is not set, is not on the deployed service, and there is no terminal to prompt on. Export it and re-run."
  printf -v "$name" '%s' "$value"
  export "$name"
}

# Same precedence as resolve_secret, but an empty value is allowed (optional secrets).
resolve_optional_secret() {
  local name="$1" prompt="$2" value orig
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    info "${name} taken from the environment"
  else
    value="$(read_deployed_env "$name" || true)"
    if [[ -n "$value" ]]; then
      info "${name} reused from the deployed service"
    elif [[ -t 0 ]]; then
      printf '%s: ' "$prompt" >&2
      read -rs value
      printf '\n' >&2
    fi
  fi
  orig="$value"
  value="$(strip_controls "$value")"
  if [[ -n "$orig" && "$value" != "$orig" ]]; then
    warn "${name} contained non-printable characters (often a Git Bash paste artefact); they were stripped."
  fi
  if [[ -n "$value" ]]; then
    printf -v "$name" '%s' "$value"
    export "$name"
  else
    unset "$name" 2>/dev/null || true
  fi
}

# Environment, then deployed service, then generate — generate only when describe
# succeeded (or there is no service yet). A failed describe must not mint a secret.
resolve_session_secret() {
  local value orig
  value="${SESSION_SECRET:-}"
  if [[ -n "$value" ]]; then
    info "SESSION_SECRET taken from the environment"
  else
    load_deployed_service_describe
    case "$_DEPLOYED_DESCRIBE_RESULT" in
      failed)
        die "could not read SESSION_SECRET off the service; refusing to generate a new one because it would sign every device out"
        ;;
      ok)
        value="$(env_value_from_deployed_json SESSION_SECRET)"
        if [[ -n "$value" ]]; then
          info "SESSION_SECRET reused from the deployed service"
        else
          value="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
          info "SESSION_SECRET generated (32 random bytes); save it in a password manager — changing it signs every device out"
        fi
        ;;
      no_service)
        [[ "${ALLOW_NEW_SESSION_SECRET:-}" == "1" ]] \
          || die "no ${SERVICE_NAME} service in ${SECRETS_REGION} to read SESSION_SECRET from. A new secret signs every device out: for a move between regions, set SECRETS_FROM_REGION to the old region; for a brand-new app, set ALLOW_NEW_SESSION_SECRET=1."
        value="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
        info "SESSION_SECRET generated (32 random bytes); save it in a password manager — changing it signs every device out"
        ;;
    esac
  fi
  orig="$value"
  value="$(strip_controls "$value")"
  if [[ -n "$orig" && "$value" != "$orig" ]]; then
    warn "SESSION_SECRET contained non-printable characters (often a Git Bash paste artefact); they were stripped."
  fi
  [[ -n "$value" ]] || die "SESSION_SECRET is empty after resolution."
  export SESSION_SECRET="$value"
}

require_gcloud
command -v node >/dev/null 2>&1 || die "node not found; it is needed to read env vars back off the deployed service."

resolve_secret AUTH_GOOGLE_ID     "AUTH_GOOGLE_ID"
resolve_secret AUTH_GOOGLE_SECRET "AUTH_GOOGLE_SECRET"
resolve_secret ALLOWED_EMAILS     "ALLOWED_EMAILS (comma-separated allowlist)"
resolve_secret GEMINI_API_KEY     "GEMINI_API_KEY"
resolve_session_secret
resolve_secret MAIL_FROM          "MAIL_FROM (Resend sender address)"
resolve_secret OWNER_NOTIFY_EMAIL "OWNER_NOTIFY_EMAIL (access-request notification recipient)"
if [[ -n "${SOUS_DISABLE_RESEND:-}" ]]; then
  info "SOUS_DISABLE_RESEND set — notification email disabled (RESEND_API_KEY omitted from deploy map)"
  unset RESEND_API_KEY
else
  resolve_optional_secret RESEND_API_KEY "RESEND_API_KEY (blank to disable notification email)"
fi
# Optional. Blank keeps the gemini / gemini-3.5-flash-lite defaults. An empty
# value is omitted from the env file so a redeploy does not fail closed.
resolve_optional_secret TRANSLATE_PROVIDER "TRANSLATE_PROVIDER (blank keeps gemini)"
resolve_optional_secret TRANSLATE_MODEL "TRANSLATE_MODEL (blank keeps gemini-3.5-flash-lite)"

IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE="${IMAGE:-${IMAGE_REPO}:${IMAGE_TAG}}"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  info "SKIP_BUILD=1, deploying existing image ${IMAGE}"
else
  info "Building ${IMAGE}"
  # .gcloudignore keeps .env* out of the uploaded source. Verify with:
  #   gcloud meta list-files-for-upload
  gcloud builds submit "$(to_native_path "$REPO_ROOT")" --tag "$IMAGE" --project="$PROJECT"
fi

# --env-vars-file, not --set-env-vars: gcloud splits --set-env-vars values on
# commas, and escaping that on Windows needs quadrupled carets. A YAML file has
# no such problem, and keeps the secrets off the command line and out of shell
# history. The file replaces the whole env map on the service — omitting a key
# Omitting a key that is still on the service deletes that var on the next deploy.
ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
trap 'rm -f "$ENV_FILE"' EXIT
# JSON.stringify produces a double-quoted YAML scalar and escapes quotes and
# backslashes. Do not put the values on the node command line — they are
# already in the environment. Single-line -e: see strip_controls.
node -e 'const fs=require("fs");const dest=process.argv[process.argv.length-1];const fixed={PUBLIC_ORIGIN:"https://sous.kyrylo.lol",GOOGLE_CLOUD_PROJECT:"cooking-assistant-508423",FIRESTORE_DATABASE_ID:"sous-us",PHOTO_BUCKET:"sous-photos-us-cooking-assistant-508423"};const keys=["GEMINI_API_KEY","AUTH_GOOGLE_ID","AUTH_GOOGLE_SECRET","SESSION_SECRET","ALLOWED_EMAILS","PUBLIC_ORIGIN","GOOGLE_CLOUD_PROJECT","FIRESTORE_DATABASE_ID","PHOTO_BUCKET","MAIL_FROM","OWNER_NOTIFY_EMAIL","RESEND_API_KEY","TRANSLATE_PROVIDER","TRANSLATE_MODEL"];const optional=new Set(["RESEND_API_KEY","TRANSLATE_PROVIDER","TRANSLATE_MODEL"]);const lines=keys.flatMap(k=>{const v=fixed[k]??process.env[k];if(typeof v!=="string"||v===""){if(optional.has(k))return[];process.exit(2)}return[k+": "+JSON.stringify(v)]});fs.writeFileSync(dest,lines.join("\n")+"\n");' "$(to_native_path "$ENV_FILE")" \
  || die "failed to write --env-vars-file (a required secret was empty?)"

info "Deploying Cloud Run service ${SERVICE_NAME} in ${REGION}"
gcloud run deploy "$SERVICE_NAME" \
  --quiet \
  --region="$REGION" \
  --project="$PROJECT" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=4 \
  --image="$IMAGE" \
  --env-vars-file="$(to_native_path "$ENV_FILE")"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" \
  --project="$PROJECT" --format='value(status.url)' 2>/dev/null || true)"
DIGEST="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" \
  --project="$PROJECT" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"

info "Deployed to ${SERVICE_URL:-(url unavailable)}"
info "Running image: ${DIGEST:-(unknown)}"
info ""
info "After this deploy (step 20): fill OAuth consent-screen Branding URLs and publish (step 21)."
info ""
info "Domain mapping history (sous.kyrylo.lol is already mapped):"
info "  gcloud beta run domain-mappings create --service=${SERVICE_NAME} \\"
info "    --domain=sous.kyrylo.lol --region=${REGION} --project=${PROJECT}"
info "  DNS in Cloudflare must stay DNS-only (grey cloud), not proxied."
info "  Wait for CertificateProvisioned=True before relying on HTTPS."
