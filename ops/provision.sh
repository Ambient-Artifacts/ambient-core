#!/usr/bin/env bash
# Create a Brain VM on Hetzner Cloud.
#   ops/provision.sh core main        -> brain-core-main
#   ops/provision.sh team acme        -> brain-team-acme
# Needs: hcloud CLI logged in (HCLOUD_TOKEN) and HCLOUD_SSH_KEY = name(s) of SSH keys in Hetzner,
# space-separated (e.g. "brain-ops laptop").
set -euo pipefail
role=${1:?core|team}; name=${2:?name or team slug}
case "$role" in core|team) ;; *) echo "role must be core or team" >&2; exit 2 ;; esac
# 2 vCPU / 4 GB, cheapest first. CX23 (Intel) is often sold out in 2026; CAX11 (Arm) runs
# the same stack; CPX22 (AMD) is the always-available but ~3x pricier fallback.
types=${HCLOUD_TYPES:-cx23 cax11 cpx22}
location=${HCLOUD_LOCATION:-nbg1}  # nbg1 or fsn1 (Germany)
server="brain-${role}-${name}"
here=$(cd "$(dirname "$0")" && pwd)
key_args=()
for k in ${HCLOUD_SSH_KEY:?set HCLOUD_SSH_KEY}; do key_args+=(--ssh-key "$k"); done

created=""
for type in $types; do
  echo "Trying $type in $location…"
  if hcloud server create \
      --name "$server" --type "$type" --image ubuntu-24.04 --location "$location" \
      "${key_args[@]}" \
      --user-data-from-file "$here/cloud-init/base.yaml" \
      --label app=brain --label role="$role" --label name="$name"; then
    created=$type
    break
  fi
done
[ -n "$created" ] || { echo "No server type available ($types) in $location" >&2; exit 1; }
hcloud server enable-backup "$server"
ip=$(hcloud server ip "$server")
echo
echo "Created $server at $ip (daily Hetzner backups on)."
echo "1. DNS: point $([ "$role" = core ] && echo "mcp.<your-domain>" || echo "t-$name.<your-domain>") to $ip (A record, DNS only)."
echo "2. Wait for setup: ssh root@$ip cloud-init status --wait"
echo "3. Deploy: ops/deploy.sh $role root@$ip"
