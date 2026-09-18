#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
deploy_host=${1:-vintage-shop-prod}
[[ "$deploy_host" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
release_id=${2:-$(ssh -o BatchMode=yes "$deploy_host" 'basename "$(readlink /opt/metastocker/previous)"')}
[[ "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]] || exit 2
ssh -o BatchMode=yes "$deploy_host" "METASTOCKER_ROLLBACK=1 bash /opt/metastocker/releases/$release_id/deploy/activate-release.sh $release_id"
# Static-only releases predate the collector. Stop it without removing its data.
ssh -o BatchMode=yes "$deploy_host" 'if ! grep -q "^  analytics:" /opt/metastocker/compose.yaml; then docker stop metastocker-analytics >/dev/null 2>&1 || true; fi'
python3 "$repo/deploy/verify_production.py" --release "$release_id"
