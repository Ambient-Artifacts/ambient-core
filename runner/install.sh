#!/usr/bin/env bash
# Connects this Linux computer to Ambient: Ambient's chat, your bots and your brain's upkeep run here.
#
#   curl -fsSL https://<your Ambient server>/install.sh | sudo bash -s <CODE> [--user NAME]
#
# The code comes from the Ambient app (Bots → Connect a Computer). In order, it:
#   1. checks that it runs as root on Linux with systemd; warns when memory or disk is short
#   2. installs only what's missing: git, Node (for the whole system, or Ambient's own next to an
#      older one), Podman (bots run in their own containers), Claude Code for the bots' user
#   3. creates the user "ambient" that Ambient's sessions and bots run as (or uses --user NAME)
#   4. downloads the runner from the same server and connects the computer with the code
#   5. signs Claude in with your Claude plan (`claude setup-token`), unless the computer has a sign-in
# It never upgrades or replaces what's already installed (a Node, nvm, Claude Code), never changes
# another service, and keeps out of your own Claude Code: Ambient's sessions get a settings folder
# of their own (docs/self-hosting.md, "What the setup leaves alone"). Run it again any time: it
# does only what's still missing. Remove everything: sudo node /opt/ambient-runner/ambient-runner.mjs uninstall
set -euo pipefail
# Folders made here are passed through by the bots' user, whatever umask this shell came with.
umask 022

# The gateway that serves this script writes its own address here.
DEFAULT_SERVER="https://mcp.ambientartifacts.si"
SERVER="${AMBIENT_SERVER:-$DEFAULT_SERVER}"
NODE_MAJOR=22   # what it installs when there's no Node, or only an older one
OWN_NODE=/opt/ambient-runner/node/bin/node   # Ambient's own Node, next to a system Node that's too old
RUNNER=/opt/ambient-runner/ambient-runner.mjs
CONFIG=/etc/ambient-runner/runner.env

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Note: %s\n' "$*" >&2; }
die() { printf 'Stopped: %s\n' "$*" >&2; exit 1; }

usage() {
  say "usage: curl -fsSL $SERVER/install.sh | sudo bash -s <CODE> [--user NAME]"
  say "  <CODE>       the code from the Ambient app (Bots → Connect a Computer)"
  say "  --user NAME  run Ambient's sessions and bots as this existing user (default: a new user \"ambient\")"
}

CODE=""
RUN_USER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user) RUN_USER="${2:-}"; shift 2 ;;
    --user=*) RUN_USER="${1#*=}"; shift ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --server=*) SERVER="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$CODE" ] || { usage >&2; die "unexpected \"$1\""; }
      CODE="$1"; shift ;;
  esac
done
SERVER="${SERVER%/}"
[ -n "$CODE" ] || { usage >&2; die "the code from the Ambient app is missing"; }
[[ "$CODE" =~ ^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$ ]] || die "\"$CODE\" isn't a setup code (it looks like ABCD-1234)"

# ---- 1. checks ----

step "Checking this computer"
[ "$(id -u)" = 0 ] || die "run it with sudo: curl -fsSL $SERVER/install.sh | sudo bash -s $CODE"
[ "$(uname -s)" = Linux ] || die "Ambient's bots need Linux with systemd for now"
{ command -v systemctl >/dev/null && [ -d /run/systemd/system ]; } || die "this computer has no systemd, which runs the bots"
mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
if [ "${mem_kb:-0}" -lt 1500000 ]; then
  warn "this computer has $((mem_kb / 1024)) MB of memory. Claude Code sessions need about 500 MB each; 2 GB or more is better."
fi
disk_kb=$(df -Pk / 2>/dev/null | awk 'NR == 2 { print $4 }')
if [ "${disk_kb:-0}" -lt 3000000 ]; then
  warn "only $((${disk_kb:-0} / 1024)) MB of disk are free. Bots clone repos and keep sessions; 3 GB or more is better."
fi

PKG=""
if command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
elif command -v yum >/dev/null; then PKG=yum
fi
install_pkg() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf|yum) "$PKG" install -y -q "$@" ;;
    *) die "install $* yourself (this computer has neither apt nor dnf), then run this again" ;;
  esac
}

# ---- 2. what's missing ----

step "Installing what's missing"
if command -v git >/dev/null; then say "git: $(git --version | awk '{ print $3 }'), already here"
else say "git: installing"; install_pkg git; fi
command -v script >/dev/null || { say "script (util-linux): installing"; install_pkg util-linux || true; }

# Node for the whole system: systemd runs the runner as root, so it must be a Node only root can
# change (/usr/bin/node and the like), never one in someone's home (nvm). A Node like that stays as
# it is; the system one goes next to it.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
root_owned() { [ "$(stat -c %u "$1")" = 0 ] && [ "$(stat -c %u "$(dirname "$1")")" = 0 ] && ! [ -n "$(find "$1" -maxdepth 0 -perm /022 2>/dev/null)" ]; }
NODE=""
for candidate in /usr/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  real=$(readlink -f "$candidate")
  root_owned "$real" || continue
  NODE="$real"
  break
done
# Node 22.13 or newer: a team's brain uses Node's own SQLite (docs/architecture.md, "A team on its own computer").
node_new_enough() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
# Ambient's own Node, from nodejs.org with its checksum, in /opt/ambient-runner: the system's Node stays as it is.
install_own_node() {
  local arch sums file tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  command -v sha256sum >/dev/null && command -v tar >/dev/null || return 1
  tmp=$(mktemp -d /tmp/ambient-node.XXXXXX)
  sums=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt") || { rm -rf "$tmp"; return 1; }
  file=$(printf '%s\n' "$sums" | awk -v a="linux-$arch.tar.gz" 'index($2, a) && $2 ~ /^node-v[0-9.]+-linux-/ { print $2; exit }')
  [ -n "$file" ] || { rm -rf "$tmp"; return 1; }
  if curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$file" -o "$tmp/$file" &&
    (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c --status -) &&
    mkdir -p "$(dirname "$(dirname "$OWN_NODE")")" &&
    tar -xzf "$tmp/$file" -C "$(dirname "$(dirname "$OWN_NODE")")" --strip-components=1 --no-same-owner "${file%.tar.gz}/bin/node" &&
    node_new_enough "$OWN_NODE"; then
    rm -rf "$tmp"; return 0
  fi
  rm -rf "$tmp"; return 1
}
if [ -n "$NODE" ] && node_new_enough "$NODE"; then
  say "Node: $("$NODE" --version), already here ($NODE)"
elif [ -n "$NODE" ]; then
  # An older Node that something here may depend on: it stays, and Ambient gets its own next to it.
  system_node="$NODE"
  if [ -x "$OWN_NODE" ] && node_new_enough "$OWN_NODE"; then
    NODE="$OWN_NODE"
    say "Node: $("$NODE" --version), Ambient's own ($NODE); the system's $("$system_node" --version) stays as it is"
  else
    say "Node: the system's is $("$system_node" --version), so installing Node $NODE_MAJOR for Ambient alone (the system's stays as it is)"
    if install_own_node; then
      NODE="$OWN_NODE"
      say "Node: $("$NODE" --version) ($NODE)"
    elif [ "$(node_major "$system_node")" -ge 18 ]; then
      warn "couldn't install Node $NODE_MAJOR from nodejs.org, so Ambient uses $("$system_node" --version). Bots and your own chat work with it; a team's brain needs Node 22.13 or newer."
    else
      die "$system_node is Node $(node_major "$system_node"), and the runner needs 18 or newer. Node $NODE_MAJOR from nodejs.org didn't install either: upgrade Node, then run this again."
    fi
  fi
else
  say "Node: installing Node $NODE_MAJOR for the whole system"
  case "$PKG" in
    apt) curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs ;;
    dnf|yum) curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null && "$PKG" install -y -q nodejs ;;
    *) die "install Node $NODE_MAJOR for the whole system yourself (https://nodejs.org), then run this again" ;;
  esac
  NODE=$(readlink -f "$(command -v node)")
  say "Node: $("$NODE" --version) ($NODE)"
fi

# Podman: a bot runs in its own container unless it is switched to the computer itself, and can't answer without it.
if command -v podman >/dev/null; then
  say "Podman: $(podman --version 2>/dev/null | awk '{ print $NF }'), already here"
else
  say "Podman: installing (bots run in their own containers)"
  if (install_pkg podman) >/dev/null 2>&1 && command -v podman >/dev/null; then
    say "Podman: $(podman --version 2>/dev/null | awk '{ print $NF }')"
  else
    warn "Podman didn't install. Bots that run in their own container need it: install it yourself (apt-get install -y podman), or switch a bot to run on the computer itself."
  fi
fi

# ---- 3. the user Ambient runs as ----

# Already connected: keep the user it runs as, unless --user says otherwise.
if [ -z "$RUN_USER" ] && [ -f "$CONFIG" ]; then RUN_USER=$(sed -n 's/^AMBIENT_USER=//p' "$CONFIG" | head -n 1); fi
if [ -z "$RUN_USER" ]; then
  RUN_USER=ambient
  if ! id ambient >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/ambient --shell /bin/bash --comment "Ambient chat and bots" ambient
    say "User: created \"ambient\" (home /var/lib/ambient, no password, no login)"
  else
    say "User: \"ambient\", already here"
  fi
else
  id "$RUN_USER" >/dev/null 2>&1 || die "there's no user \"$RUN_USER\" on this computer"
  say "User: $RUN_USER"
fi
USER_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || die "$RUN_USER has no home folder"
as_user() {
  if [ "$RUN_USER" = root ]; then env HOME="$USER_HOME" PATH="$USER_HOME/.local/bin:$PATH" "$@"
  else runuser -u "$RUN_USER" -- env HOME="$USER_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" PATH="$USER_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; fi
}

# Claude Code for that user: theirs if they have one (never updated here), else the official installer.
CLAUDE=""
for candidate in "$USER_HOME/.local/bin/claude" "$USER_HOME/.claude/local/claude" /usr/local/bin/claude /usr/bin/claude; do
  if [ -x "$candidate" ]; then CLAUDE="$candidate"; break; fi
done
if [ -z "$CLAUDE" ]; then
  CLAUDE=$(as_user sh -c 'command -v claude' 2>/dev/null || true)
fi
if [ -n "$CLAUDE" ]; then
  say "Claude Code: $(as_user "$CLAUDE" --version 2>/dev/null | head -n 1), already here ($CLAUDE)"
else
  say "Claude Code: installing for $RUN_USER (https://claude.ai/install.sh)"
  as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
  CLAUDE="$USER_HOME/.local/bin/claude"
  [ -x "$CLAUDE" ] || die "Claude Code didn't install. Install it for $RUN_USER (https://claude.com/claude-code), then run this again."
  say "Claude Code: $(as_user "$CLAUDE" --version 2>/dev/null | head -n 1)"
fi

# ---- 4. the runner ----

step "Connecting this computer to $SERVER"
work=$(mktemp -d /tmp/ambient-setup.XXXXXX)
trap 'rm -rf "$work"' EXIT
curl -fsSL "$SERVER/runner/ambient-runner.mjs" -o "$work/ambient-runner.mjs" || die "couldn't download the runner from $SERVER"
"$NODE" "$work/ambient-runner.mjs" setup "$CODE" --user "$RUN_USER" --server "$SERVER" --claude "$CLAUDE"

# ---- 5. Claude's sign-in ----

# A token from `claude setup-token`, out of what it printed: escape codes out, and a token the
# terminal wrapped over lines joined again (a wrapped line holds only token characters).
extract_token() {
  "$NODE" -e '
    const raw = require("fs").readFileSync(process.argv[1], "utf8");
    const text = raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n").map((l) => l.trim());
    let found = "";
    for (let i = 0; i < lines.length; i++) {
      const m = /sk-ant-oat01-[A-Za-z0-9_-]+/.exec(lines[i]);
      if (!m) continue;
      let token = m[0];
      if (m.index + m[0].length === lines[i].length) for (let j = i + 1; j < lines.length && /^[A-Za-z0-9_-]+$/.test(lines[j]); j++) token += lines[j];
      found = token;
    }
    process.stdout.write(found);' "$1" 2>/dev/null || true
}

# Whether a plan's token works: one tiny request with it, in a settings folder of its own.
token_works() {
  local dir
  dir=$(mktemp -d /tmp/ambient-check.XXXXXX)
  chown "$RUN_USER" "$dir"
  # The token goes in through the environment (runuser keeps it), never on a command line.
  if printf 'Reply with the word OK.' | CLAUDE_CODE_OAUTH_TOKEN="$1" as_user env CLAUDE_CONFIG_DIR="$dir" \
    timeout 120 "$CLAUDE" -p --tools "" --strict-mcp-config --no-session-persistence >/dev/null 2>&1; then
    rm -rf "$dir"; return 0
  fi
  rm -rf "$dir"; return 1
}

claude_state=$("$NODE" "$RUNNER" claude-status 2>/dev/null || true)
if [ "$claude_state" = signed-in ]; then
  say "Claude: signed in already"
elif ! (exec </dev/tty) 2>/dev/null; then
  warn "there's no terminal here to sign Claude in from. Add your Claude plan in the Ambient app instead (the computer, then Claude)."
else
  step "Signing in to Claude"
  say "Ambient's chat and your bots use your own Claude plan here. Below, Claude Code shows a link:"
  say "open it in a browser, sign in, and paste the code it gives you back here."
  tmp=$(mktemp -d /tmp/ambient-claude.XXXXXX)
  chown "$RUN_USER" "$tmp"
  chmod 700 "$tmp"
  # Its own settings folder, deleted after: your own Claude Code login, if you have one, stays as it is.
  as_user env CLAUDE_CONFIG_DIR="$tmp/config" script -q -e -c "'$CLAUDE' setup-token" "$tmp/out.log" </dev/tty >/dev/tty 2>&1 || true
  token=""
  [ -f "$tmp/out.log" ] && token=$(extract_token "$tmp/out.log")
  rm -rf "$tmp"
  if [ -n "$token" ] && ! token_works "$token"; then token=""; fi
  if [ -z "$token" ]; then
    printf 'Paste the token it showed (it starts with sk-ant-oat), or press Enter to skip: ' >/dev/tty
    IFS= read -rs token </dev/tty || token=""
    printf '\n' >/dev/tty
    token=$(printf '%s' "$token" | tr -d '[:space:]')
  fi
  if [ -z "$token" ]; then
    warn "skipped. Add your Claude plan in the Ambient app (the computer, then Claude), or run this again."
  elif printf '%s' "$token" | "$NODE" "$RUNNER" claude-token; then
    say "Claude: signed in with your plan (kept encrypted in Ambient, sent only to this computer)"
  else
    warn "Ambient didn't take the token. Add your Claude plan in the Ambient app (the computer, then Claude)."
  fi
  unset token
fi

step "Ready"
say "Ambient's chat and your bots run here as $RUN_USER. The app shows this computer under Bots."
say "Logs:    journalctl -u ambient-runner -u ambient-runner-ambient -u 'ambient-routine-*'"
say "Status:  sudo node $RUNNER status"
say "Remove:  sudo node $RUNNER uninstall"
