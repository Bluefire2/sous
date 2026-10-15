#!/bin/sh
# Records the commit an image is built from in server/build-info.json, which
# the image picks up through `COPY server` and GET /api/version reports.
# scripts/deploy.sh runs it before `gcloud builds submit`, and the Deploy
# workflow before `docker build`. The file is gitignored.
#
# Prints the recorded commit on stdout (the log line goes to stderr).
#
# "-dirty" marks a build with uncommitted changes to tracked files; untracked
# files do not count.
set -eu

root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse HEAD)
if ! git -C "$root" diff --quiet HEAD --; then
  commit="$commit-dirty"
fi
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{"commit":"%s","builtAt":"%s"}\n' "$commit" "$built_at" > "$root/server/build-info.json"
printf '==> Build info: %s (built %s)\n' "$commit" "$built_at" >&2
printf '%s\n' "$commit"
