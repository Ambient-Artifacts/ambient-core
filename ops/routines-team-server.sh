#!/usr/bin/env bash
# Set a team's server up to run the team's routines. Run once after the team has the server
# (and again to repair it: every step is safe to repeat). Needs the gateway deployed first,
# and CONVEX_DEPLOY_KEY for the setup code.
#   ops/routines-team-server.sh acme root@203.0.113.10
#
# On the server:
# - a `routines` user (no sudo; the wiki's own files and the server's keys stay unreadable to it)
# - Claude Code for that user (it updates itself), gh, python3-pil and webp for routines' usual work
# - git signs in to GitHub through gh, so a GH_TOKEN secret is all a routine needs to push
# - /etc/ambient-runner/extra.env with the team's ANTHROPIC_API_KEY from /etc/brain/team.env
# - the runner, connected as the team's server with a fresh one-time code
set -euo pipefail
slug=${1:?team slug}; host=${2:?user@host}
origin=${BRAIN_ORIGIN:-https://mcp.ambientartifacts.si}
# Claude Code's flags for every run: no prompts, and at most $10 of the team's key per run.
claude_args=${CLAUDE_ARGS:---permission-mode auto --max-budget-usd 10}
root=$(cd "$(dirname "$0")/.." && pwd)
code=$(cd "$root" && node ops/new-computer.mjs --team "$slug" "Team server")

# ssh joins its arguments into one command line: quote each so the flags arrive as one argument.
ssh "$host" "bash -s -- $(printf '%q ' "$code" "$origin" "$claude_args")" <<'REMOTE'
set -euo pipefail
code=$1; origin=$2; claude_args=$3
id routines >/dev/null 2>&1 || useradd --create-home --shell /bin/bash routines

if ! command -v gh >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh python3-pil webp >/dev/null

su - routines -c 'test -x ~/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
su - routines -c 'git config --global credential.https://github.com.helper "!gh auth git-credential"
  git config --global user.name "Ambient routines"
  git config --global user.email "routines@ambientartifacts.si"
  git config --global init.defaultBranch main'

install -d -m 0700 /etc/ambient-runner
grep '^ANTHROPIC_API_KEY=' /etc/brain/team.env > /etc/ambient-runner/extra.env
chmod 600 /etc/ambient-runner/extra.env

runner_file=$(mktemp --suffix=.mjs)   # not a fixed name in /tmp, which another user could create first
curl -fsSL "$origin/runner/ambient-runner.mjs" -o "$runner_file"
node "$runner_file" setup "$code" --user routines --claude-args "$claude_args"
rm -f "$runner_file"
REMOTE
