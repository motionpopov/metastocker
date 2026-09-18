#!/usr/bin/env bash
# Runs on vintage-shop-prod. Changes only /opt/metastocker and metastocker-web.
set -Eeuo pipefail
base=/opt/metastocker
release_id=${1:?Usage: activate-release.sh RELEASE}
[[ "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$ ]] || exit 2
target="$base/releases/$release_id"
test -d "$target/public"
exec 9>"$base/.deploy.lock"
flock -n 9 || { echo 'Another MetaStocker deployment is active.' >&2; exit 1; }
(cd "$target" && sha256sum --check --quiet SHA256SUMS)
image=$(sed -n 's/^    image: //p' "$target/deploy/compose.yaml")
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
docker compose -p metastocker -f "$base/compose.yaml" up -d --no-deps web
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
