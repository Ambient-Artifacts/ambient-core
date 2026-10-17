#!/usr/bin/env bash
# Ship the current checkout to a Brain VM and (re)start its services.
#   ops/deploy.sh core root@1.2.3.4
#   ops/deploy.sh team root@5.6.7.8
# First deploy: put the env file in place before (see ops/README.md).
set -euo pipefail
role=${1:?core|team}; host=${2:?user@host}
root=$(cd "$(dirname "$0")/.." && pwd)
rev=$(git -C "$root" rev-parse --short HEAD)

# Only what git has at HEAD: an env file, a backup or a token left in the checkout must never
# reach a VM (the gateway's secrets on a team VM, where routines run, would be the worst case).
# Uncommitted changes aren't shipped either, so REVISION tells the truth.
git -C "$root" diff --quiet HEAD -- || echo "note: uncommitted changes are not deployed" >&2
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git -C "$root" archive HEAD | tar -x -C "$stage"
rsync -az --delete --chown=root:root \
  --exclude node_modules --exclude '.env*' --exclude 'control/.convex' \
  "$stage/" "$host:/opt/brain/app/"

ssh "$host" bash -s -- "$role" "$rev" <<'REMOTE'
set -euo pipefail
role=$1; rev=$2
cd /opt/brain/app
npm ci --no-audit --no-fund --loglevel=error
echo "$rev" > /opt/brain/REVISION
install -m 0644 ops/systemd/brain-notify@.service /etc/systemd/system/
if [ "$role" = core ]; then
  test -f /etc/brain/gateway.env || { echo "missing /etc/brain/gateway.env" >&2; exit 1; }
  install -m 0644 ops/systemd/brain-gateway.service ops/systemd/brain-personal.service ops/systemd/brain-personal.timer \
    ops/systemd/brain-sessions.service ops/systemd/brain-sessions.timer \
    ops/systemd/brain-digest.service ops/systemd/brain-digest.timer \
    ops/systemd/brain-health.service ops/systemd/brain-health.timer ops/systemd/brain-health-daily.service ops/systemd/brain-health-daily.timer \
    /etc/systemd/system/
  caddyfile=ops/caddy/Caddyfile.core
  units="brain-gateway.service brain-personal.timer brain-sessions.timer brain-digest.timer brain-health.timer brain-health-daily.timer"
else
  test -f /etc/brain/team.env || { echo "missing /etc/brain/team.env" >&2; exit 1; }
  # The wiki, its history and raw transcripts: for the brain user only, not for routines.
  chmod 0750 /srv/brain && chmod -R o-rwx /srv/brain
  install -m 0644 ops/systemd/brain-team.service ops/systemd/brain-consolidate.service ops/systemd/brain-consolidate.timer /etc/systemd/system/
  caddyfile=ops/caddy/Caddyfile.team
  units="brain-team.service brain-consolidate.timer"
fi
# /etc/brain/host.env: BRAIN_HOST (public name) and, on team VMs, BRAIN_GATEWAY_IP.
test -f /etc/brain/host.env || { echo "missing /etc/brain/host.env" >&2; exit 1; }
. /etc/brain/host.env
sed -e "s/__BRAIN_HOST__/${BRAIN_HOST:?}/" -e "s/__BRAIN_GATEWAY_IP__/${BRAIN_GATEWAY_IP:-127.0.0.1}/" "$caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable $units >/dev/null
# Restart the services and (re)start the timers.
systemctl restart $units
systemctl reload caddy || systemctl restart caddy
sleep 2
port=$([ "$role" = core ] && echo 8080 || echo 8090)
curl -fsS "http://127.0.0.1:$port/health" && echo
echo "deployed $rev ($role)"
REMOTE
