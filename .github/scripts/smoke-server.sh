#!/usr/bin/env bash
set -euo pipefail

# Boot smoke test for the production server (scripts/server.ts serving dist/).
# CI runs it against the Docker image; locally it works against
# `npm run build && PORT=8080 node scripts/server.ts`.
#
#   bash .github/scripts/smoke-server.sh http://localhost:8080
#
# Needs no credentials: every request here is public or is rejected before
# Firestore is touched.

BASE_URL="${1:-http://localhost:8080}"
failures=0

# Prints the HTTP status, or 000 when the server did not answer. Always returns
# 0 so it is safe inside $(...) under `set -e`.
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}$1" || true
  return 0
}

# Same as status_of, for a POST with an empty JSON body.
post_status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    -H 'Content-Type: application/json' -d '{}' "${BASE_URL}$1" || true
  return 0
}

content_type_of() {
  curl -s -o /dev/null -w '%{content_type}' --max-time 10 "${BASE_URL}$1" || true
  return 0
}

expect_status() {
  local path="$1" want="$2" got
  got="$(status_of "$path")"
  if [[ "$got" == "$want" ]]; then
    printf 'ok    %s %s\n' "$got" "$path"
  else
    printf 'FAIL  %s %s (want %s)\n' "$got" "$path" "$want"
    failures=$((failures + 1))
  fi
}

expect_post_status() {
  local path="$1" want="$2" got
  got="$(post_status_of "$path")"
  if [[ "$got" == "$want" ]]; then
    printf 'ok    %s POST %s\n' "$got" "$path"
  else
    printf 'FAIL  %s POST %s (want %s)\n' "$got" "$path" "$want"
    failures=$((failures + 1))
  fi
}

expect_html() {
  local path="$1" type
  type="$(content_type_of "$path")"
  if [[ "$type" == text/html* ]]; then
    printf 'ok    html %s\n' "$path"
  else
    printf 'FAIL  %s is %s, not text/html\n' "$path" "${type:-nothing}"
    failures=$((failures + 1))
  fi
}

printf 'Waiting for %s\n' "$BASE_URL"
for _ in $(seq 1 30); do
  if [[ "$(status_of /)" != "000" ]]; then
    break
  fi
  sleep 1
done
if [[ "$(status_of /)" == "000" ]]; then
  printf 'FAIL  server never answered at %s\n' "$BASE_URL"
  exit 1
fi

# Static SPA and PWA files from dist/.
expect_status / 200
expect_html /
expect_status /about 200
expect_status /privacy 200
expect_status /terms 200
expect_status /manifest.webmanifest 200
expect_status /sw.js 200
# Client-side route falls back to index.html.
expect_status /settings 200
expect_html /settings

# API routes load and reject an anonymous caller as denied (401), not as
# unknown (503) or a crash (500).
expect_status /api/sync/pull 401
expect_status /api/sync/shared 401

# MCP: discovery documents are public; /mcp refuses a caller with no bearer
# token with 401 (the challenge that starts an MCP client's sign-in), never
# 503 or 500, and has no GET.
expect_status /.well-known/oauth-protected-resource/mcp 200
expect_status /.well-known/oauth-protected-resource 200
expect_status /.well-known/oauth-authorization-server 200
expect_post_status /mcp 401
expect_status /mcp 405

# Test mode (testing/, docs/plans/test-mode.md) is not in the image: its
# sign-in path is only the SPA fallback here, never a redirect with a session.
test_sign_in="$(curl -s -o /dev/null -D - --max-time 10 "${BASE_URL}/__test/sign-in?as=member" || true)"
if [[ ! "$test_sign_in" =~ ^HTTP/ ]]; then
  # No status line: curl failed, so nothing was checked.
  printf 'FAIL  /__test/sign-in did not answer\n'
  failures=$((failures + 1))
elif [[ "$test_sign_in" == *"sous_session="* || "$test_sign_in" =~ ^HTTP/[0-9.]+\ 303 ]]; then
  printf 'FAIL  /__test/sign-in signed someone in on the production server\n'
  failures=$((failures + 1))
else
  printf 'ok    /__test/sign-in signs nobody in\n'
fi

if (( failures > 0 )); then
  printf '%d smoke check(s) failed\n' "$failures"
  exit 1
fi
printf 'All smoke checks passed\n'
