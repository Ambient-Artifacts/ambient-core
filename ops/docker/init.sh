#!/usr/bin/env bash
# First start of a self-hosted server (docs/self-hosting.md). Run from anywhere in the checkout:
#   ops/docker/init.sh ambient.example.com   # public: HTTPS from Let's Encrypt on ports 80/443
#   ops/docker/init.sh --local               # try it on this machine at http://localhost:8080
# Writes .env with fresh secrets (only if there is none), gets the Convex admin key, builds the
# image and starts everything. Safe to run again: it keeps .env and the data.
set -euo pipefail
# .env (and its temporary copy) hold every secret: never readable by anyone else, not even briefly.
umask 077
cd "$(dirname "$0")/../.."
target=${1:-}
if [ -z "$target" ] || [ "$target" = -h ] || [ "$target" = --help ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
command -v docker >/dev/null || { echo "Docker is needed: https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is needed (docker compose …)." >&2; exit 1; }

image=$(grep -s '^AMBIENT_IMAGE=' .env | cut -d= -f2- || true)
image=${image:-ambient-platform:local}
echo "==> Building $image"
docker build -q -t "$image" . >/dev/null

if [ -f .env ]; then
  echo "==> .env exists: keeping its settings and secrets"
else
  if [ "$target" = --local ]; then
    domain=localhost origin=http://localhost:8080 profiles=
  else
    domain=$target origin=https://$target profiles=caddy
  fi
  echo "==> Writing .env for $origin"
  secrets=$(docker run --rm "$image" node ops/gen-secrets.mjs --env)
  {
    echo "# Written by ops/docker/init.sh on $(date -u +%Y-%m-%d). Back this file up: losing"
    echo "# BRAIN_MASTER_KEY makes every stored personal note unreadable. All settings: .env.example"
    echo "BRAIN_DOMAIN=$domain"
    echo "BRAIN_ORIGIN=$origin"
    echo "COMPOSE_PROFILES=$profiles"
    echo "AMBIENT_IMAGE=$image"
    echo "$secrets"
    echo
    sed -n '/^# ---- Optional ----$/,$p' .env.example | grep -v '^AMBIENT_IMAGE='
  } > .env
  chmod 600 .env
fi

echo "==> Starting Convex"
docker compose up -d --wait convex
if ! grep -q "^CONVEX_SELF_HOSTED_ADMIN_KEY='\?[^'[:space:]]" .env; then
  key=$(docker compose exec -T convex ./generate_admin_key.sh | tr -d '\r' | grep '|' | tail -1)
  case $key in *"|"*) ;; *) echo "Couldn't read the Convex admin key. Run: docker compose exec convex ./generate_admin_key.sh" >&2; exit 1 ;; esac
  # Replace an empty line from .env.example, or append.
  grep -v '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
  echo "CONVEX_SELF_HOSTED_ADMIN_KEY='$key'" >> .env
  echo "==> Saved the Convex admin key in .env"
fi

echo "==> Starting the gateway, the team server and their jobs"
docker compose up -d
port=$(grep -s '^GATEWAY_PORT=' .env | cut -d= -f2- || true)
for _ in $(seq 1 90); do
  if docker compose exec -T gateway node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    origin=$(grep '^BRAIN_ORIGIN=' .env | cut -d= -f2-)
    cat <<EOF

Ambient is running at $origin (and on this machine at http://127.0.0.1:${port:-8080}).
Next, make your account and connect an AI app (docs/self-hosting.md, "First account"):
  docker compose exec gateway admin user add you@example.com --name "Your Name"
  docker compose exec gateway admin connect-code you@example.com
EOF
    exit 0
  fi
  sleep 2
done
echo "The gateway didn't come up. Look at: docker compose logs setup gateway" >&2
exit 1
