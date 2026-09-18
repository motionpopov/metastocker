#!/usr/bin/env bash
# Runs on vintage-shop-prod. Changes only MetaStocker's services and files.
set -Eeuo pipefail
base=/opt/metastocker
release_id=${1:?Usage: activate-release.sh RELEASE}
[[ "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]] || exit 2
target="$base/releases/$release_id"
test -d "$target/public"
exec 9>"$base/.deploy.lock"
flock -n 9 || { echo 'Another MetaStocker deployment is active.' >&2; exit 1; }
if test -n "${METASTOCKER_EXPECTED_RELEASE:-}"; then
  python3 - "$base/current/public/release.json" "$METASTOCKER_EXPECTED_RELEASE" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['release']==sys.argv[2], 'Active code changed during editorial generation; retry with the new release'
PY
fi
(cd "$target" && sha256sum --check --quiet SHA256SUMS)
if [[ "${METASTOCKER_ROLLBACK:-0}" != 1 ]] && test -d "$base/editorial/published"; then
  # Fail closed if a daily article appeared while a code release was being packaged.
  python3 - "$base/editorial/published" "$target/content-snapshot.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
manifest=json.loads(Path(sys.argv[2]).read_text())
for post in Path(sys.argv[1]).glob('*.json'):
    assert manifest.get(post.name)==hashlib.sha256(post.read_bytes()).hexdigest(), 'Release omits durable article: '+post.name
PY
fi
image=$(sed -n 's/^    image: \(caddy[^ ]*\)$/\1/p' "$target/deploy/compose.yaml")
docker image inspect "$image" >/dev/null
docker run --rm --network none --read-only -v "$base:/srv/metastocker:ro" "$image" \
  caddy validate --config "/srv/metastocker/releases/$release_id/Staticfile" --adapter caddyfile
docker compose -p metastocker -f "$target/deploy/compose.yaml" config --quiet
previous=$(readlink "$base/current" || true)
backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-$release_id"
mkdir -p "$backup"
chmod 700 "$base/backups" "$backup"
printf '%s\n' "$previous" >"$backup/previous-release"
if test -f "$base/compose.yaml"; then cp -p "$base/compose.yaml" "$backup/compose.yaml"; fi
if test -f "$base/data/analytics.sqlite"; then
  # The online SQLite backup includes committed WAL data; never copy a live database file.
  snapshot="analytics-before-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  node_image=$(sed -n 's/^FROM //p' "$target/server/Dockerfile")
  docker run --rm --network none --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges \
    -v "$base/data:/data" -v "$target/server:/app:ro" "$node_image" \
    node /app/backup.mjs /data/analytics.sqlite "/data/backups/$snapshot"
  chmod 600 "$base/data/backups/$snapshot"
  printf '%s\n' "$base/data/backups/$snapshot" >"$backup/analytics-backup-path"
fi
test -f "$base/secrets/auth.json" || { echo 'Provision MetaStocker owner credentials first (docs/analytics.md).' >&2; exit 1; }
mkdir -p "$base/data"
chown 1001:1001 "$base/data"
chmod 700 "$base/data"
# Build before changing the running release. No shared Caddy/container is recreated.
docker compose -p metastocker -f "$target/deploy/compose.yaml" build analytics

switch_current() {
  ln -s "$1" "$base/.current-$$"
  mv -Tf "$base/.current-$$" "$base/current"
}
recover() {
  trap - ERR
  echo "Activation failed; restoring previous MetaStocker release: $previous" >&2
  if test -n "$previous"; then
    switch_current "$previous"
    cp "$base/current/deploy/compose.yaml" "$base/compose.yaml"
    if grep -q '^  analytics:' "$base/compose.yaml"; then
      docker compose -p metastocker -f "$base/compose.yaml" up -d --no-deps analytics
    else
      docker stop metastocker-analytics >/dev/null 2>&1 || true
    fi
    docker compose -p metastocker -f "$base/compose.yaml" up -d --no-deps web
    docker exec metastocker-web caddy reload --config /srv/metastocker/current/Staticfile --adapter caddyfile
  else
    docker compose -p metastocker -f "$base/compose.yaml" stop web || true
    rm -f "$base/current"
  fi
  exit 1
}
trap recover ERR
switch_current "releases/$release_id"
cp "$target/deploy/compose.yaml" "$base/compose.yaml"
docker compose -p metastocker -f "$base/compose.yaml" up -d --no-deps analytics
analytics_healthy=false
for attempt in $(seq 1 30); do
  if docker exec metastocker-analytics node -e "fetch('http://127.0.0.1:8081/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    analytics_healthy=true
    break
  fi
  sleep 1
done
$analytics_healthy
docker compose -p metastocker -f "$base/compose.yaml" up -d --no-deps web
for attempt in $(seq 1 20); do
  if docker exec metastocker-web wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec metastocker-web caddy reload --config /srv/metastocker/current/Staticfile --adapter caddyfile
healthy=false
for attempt in $(seq 1 20); do
  if docker exec metastocker-web wget -qO- http://127.0.0.1:8080/release.json | \
    python3 -c 'import json,sys; assert json.load(sys.stdin)["release"] == sys.argv[1]' "$release_id"; then
    healthy=true
    break
  fi
  sleep 1
done
$healthy
if test -n "$previous" && test "$previous" != "releases/$release_id"; then
  ln -s "$previous" "$base/.previous-$$"
  mv -Tf "$base/.previous-$$" "$base/previous"
fi
trap - ERR
printf 'Active release: %s\nBackup: %s\n' "$release_id" "$backup"
