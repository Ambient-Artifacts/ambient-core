#!/usr/bin/env bash
# Ambient for Claude Code: send a finished session to Ambient, which keeps a short note of it
# (what was worked on, decided, left open) and drops the transcript. Needs only bash, curl,
# gzip, grep and sed.
#
#   capture.sh end        SessionEnd hook: send this session.
#   capture.sh catch-up   SessionStart hook: in the background, send earlier sessions that never
#                         got a SessionEnd (closed terminal, remote session that timed out).
#
# Only sessions a person typed in are sent; scheduled `claude -p` jobs are left alone. Session
# ids listed in $DATA/hold (one per line) are never sent. Nothing is printed (SessionStart output
# would land in Claude's context); see $DATA/capture.log.
set -u

MODE="${1:-end}"
TOKEN="${AMBIENT_TOKEN:-${CLAUDE_PLUGIN_OPTION_TOKEN:-}}"
SERVER="${AMBIENT_SERVER:-${CLAUDE_PLUGIN_OPTION_SERVER:-https://mcp.ambientartifacts.si}}"
SERVER="${SERVER%/}"
DATA="${AMBIENT_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.config/ambient}}"
SENT="$DATA/sent"
HOLD="$DATA/hold"
MAX_BYTES=150000000

mkdir -p "$DATA" 2>/dev/null || exit 0

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$DATA/capture.log" 2>/dev/null
  # Keep the log short.
  if [ "$(wc -l <"$DATA/capture.log" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -n 200 "$DATA/capture.log" >"$DATA/capture.log.tmp" 2>/dev/null && mv "$DATA/capture.log.tmp" "$DATA/capture.log"
  fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# A string field from one line of JSON (good enough for the hook's flat input).
field() { printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1; }

size_of() { wc -c <"$1" 2>/dev/null | tr -d ' '; }

already_sent() { [ -f "$SENT" ] && grep -qx "$1 $2" "$SENT"; }

mark_sent() {
  { grep -v "^$1 " "$SENT" 2>/dev/null; printf '%s %s\n' "$1" "$2"; } >"$SENT.tmp" && mv "$SENT.tmp" "$SENT"
}

# Did a person type in this session? Newer Claude Code marks typed prompts with
# origin.kind "human"; older transcripts have no origin at all, so fall back to how it was started.
typed_by_a_person() {
  grep -q '"origin":{"kind":"human"' "$1" && return 0
  grep -q '"origin":' "$1" && return 1
  grep -qE '"entrypoint":"(cli|claude-desktop|claude-vscode|claude-jetbrains)"' "$1"
}

# send <transcript> <hook input as one line of JSON>
send() {
  local file="$1" meta="$2" id size cwd repo extra status out
  [ -f "$file" ] || return 0
  id="$(basename "$file" .jsonl)"
  if [ -f "$HOLD" ] && grep -qx "$id" "$HOLD"; then log "held $id (listed in $HOLD)"; return 0; fi
  size="$(size_of "$file")"
  already_sent "$id" "$size" && return 0
  if [ "${size:-0}" -gt "$MAX_BYTES" ]; then log "skip $id: transcript too large ($size bytes)"; return 0; fi
  if ! typed_by_a_person "$file"; then log "skip $id: nobody typed in it"; mark_sent "$id" "$size"; return 0; fi

  cwd="$(field cwd "$meta")"
  [ -n "$cwd" ] || cwd="$(grep -m 1 -o '"cwd":"[^"]*"' "$file" | sed 's/"cwd":"\(.*\)"/\1/')"
  repo=""
  [ -n "$cwd" ] && [ -d "$cwd" ] && repo="$(git -C "$cwd" config --get remote.origin.url 2>/dev/null || true)"
  extra="{\"home\":\"$(json_escape "$HOME")\",\"repo\":\"$(json_escape "$repo")\",\"tool\":\"claude-code\"}"
  # The hook's input with an "ambient" object added before its closing brace.
  meta="$(printf '%s' "$meta" | sed 's/}[[:space:]]*$//'),\"ambient\":$extra}"

  out="$DATA/last-response"
  status="$({ printf '%s\n' "$meta"; cat "$file"; } | gzip -c |
    curl -sS -o "$out" -w '%{http_code}' --max-time 25 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/x-ndjson" -H "Content-Encoding: gzip" \
      --data-binary @- "$SERVER/v1/sessions" 2>>"$DATA/capture.log")" || status="000"
  case "$status" in
    2??) mark_sent "$id" "$size"; log "sent $id ($status)" ;;
    401|403) log "the server refused the token ($status); create a new one in the Ambient app: $(head -c 300 "$out" 2>/dev/null)" ;;
    *) log "couldn't send $id ($status): $(head -c 300 "$out" 2>/dev/null)" ;;
  esac
}

catch_up() {
  local current="$1" root file id n=0
  root="$(dirname "$(dirname "$current")")"
  [ -d "$root" ] || return 0
  if [ ! -f "$SENT" ]; then
    # First run: start from now. Sessions before the plugin was installed stay unsent.
    find "$root" -mindepth 2 -maxdepth 2 -name '*.jsonl' 2>/dev/null | while read -r file; do
      printf '%s %s\n' "$(basename "$file" .jsonl)" "$(size_of "$file")"
    done >"$SENT"
    log "first run: $(wc -l <"$SENT" | tr -d ' ') earlier sessions left alone"
    return 0
  fi
  # Sessions idle for 20 minutes or more, changed in the last 3 days, not sent in this state.
  find "$root" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mmin +20 -mtime -3 2>/dev/null | while read -r file; do
    id="$(basename "$file" .jsonl)"
    [ "$file" = "$current" ] && continue
    already_sent "$id" "$(size_of "$file")" && continue
    send "$file" "{\"session_id\":\"$(json_escape "$id")\",\"reason\":\"catch-up\"}"
    n=$((n + 1))
    [ "$n" -ge 10 ] && break
  done
}

input="$(cat 2>/dev/null | tr -d '\n')"
transcript="$(field transcript_path "$input")"

if [ -z "$TOKEN" ]; then
  log "no Ambient token set; add one in /plugin → ambient → configure"
  exit 0
fi

case "$MODE" in
  end)
    [ -n "$transcript" ] && send "$transcript" "$input"
    ;;
  catch-up)
    [ -n "$transcript" ] || exit 0
    # In the background: the session shouldn't wait for uploads.
    if command -v setsid >/dev/null 2>&1; then
      setsid "$0" catch-up-run "$transcript" </dev/null >/dev/null 2>&1 &
    else
      nohup "$0" catch-up-run "$transcript" </dev/null >/dev/null 2>&1 &
    fi
    ;;
  catch-up-run)
    catch_up "${2:-}"
    ;;
esac
exit 0
