#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
deploy_host=${1:-vintage-shop-prod}
mode=${2:-verify}
[[ "$deploy_host" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
[[ "$mode" == verify || "$mode" == --bootstrap ]] || exit 2
test -z "$(git status --porcelain)" || { echo 'Commit repository changes before deploying.' >&2; exit 1; }
node --check app.js
node --check local-ai.js
node --check local-ai-worker.mjs
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_deploy.py'
git diff --check
commit=$(git rev-parse HEAD)
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}"
stage=$(mktemp -d "${TMPDIR:-/tmp}/metastocker-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/source"
git archive HEAD | tar -x -C "$stage/source"
python3 deploy/build_release.py --source "$stage/source" --output "$stage/release" \
  --release "$release_id" --commit "$commit" >"$stage/release-metadata.json"
ssh -o BatchMode=yes "$deploy_host" "test ! -e /opt/metastocker/releases/$release_id && mkdir -p /opt/metastocker/releases/$release_id"
rsync -az --chmod=D755,F644 "$stage/release/" "$deploy_host:/opt/metastocker/releases/$release_id/"
ssh -o BatchMode=yes "$deploy_host" "bash /opt/metastocker/releases/$release_id/deploy/activate-release.sh $release_id"
if [[ "$mode" == --bootstrap ]]; then
  echo 'Initial internal deployment ready. Add the shared Caddy fragment, then run verify_production.py.'
else
  python3 deploy/verify_production.py --release "$release_id" --commit "$commit"
fi
printf 'Release: %s\nCommit: %s\n' "$release_id" "$commit"
