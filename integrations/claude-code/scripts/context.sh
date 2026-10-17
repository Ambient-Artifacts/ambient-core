#!/usr/bin/env bash
# Ambient for Claude Code: what Ambient knows, in Claude's context before anyone asks.
#
#   context.sh start    SessionStart hook: who you are, what's new in your wikis since your last
#                       session, what you owe, and when to look in Ambient. Again after /compact.
#   context.sh prompt   UserPromptSubmit hook: when your prompt names a person, organization or
#                       project your wikis have a page for, that page's current truth, once per
#                       session each.
#
# What this hook prints goes into Claude's context. Your prompt never leaves this computer: the
# hook keeps a list of the names in your wikis (refreshed hourly), finds them in the prompt here
# and asks Ambient only for those pages. Turn it off with the plugin's "context" option (off), or
# AMBIENT_CONTEXT=off. Needs bash, curl, grep, sed, awk; logs to $DATA/context.log.
set -u

MODE="${1:-prompt}"
TOKEN="${AMBIENT_TOKEN:-${CLAUDE_PLUGIN_OPTION_TOKEN:-}}"
SERVER="${AMBIENT_SERVER:-${CLAUDE_PLUGIN_OPTION_SERVER:-https://mcp.ambientartifacts.si}}"
SERVER="${SERVER%/}"
DATA="${AMBIENT_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.config/ambient}}"
SWITCH="${AMBIENT_CONTEXT:-${CLAUDE_PLUGIN_OPTION_CONTEXT:-on}}"
NAMES="$DATA/names.tsv"

case "$SWITCH" in off|OFF|false|no|0) exit 0 ;; esac
mkdir -p "$DATA/seen" 2>/dev/null || exit 0

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$DATA/context.log" 2>/dev/null
  if [ "$(wc -l <"$DATA/context.log" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -n 200 "$DATA/context.log" >"$DATA/context.log.tmp" 2>/dev/null && mv "$DATA/context.log.tmp" "$DATA/context.log"
  fi
}

# A string field from the hook's one-line JSON input.
field() { printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1; }

# GET a path into a file; prints the HTTP status ("000" when the server can't be reached).
get() {
  local path="$1" out="$2"
  shift 2
  # The token goes in through a file descriptor, not curl's arguments, which every user on the
  # machine can read (ps); printf is a shell builtin, so it never shows there either.
  curl -sS -G --max-time 4 -o "$out" -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$@" "$SERVER$path" 2>>"$DATA/context.log" || true
}

# The names in your wikis, one "id<TAB>name" per line; refreshed when older than an hour.
refresh_names() {
  local tmp="$DATA/names.tmp" status
  if [ -s "$NAMES" ] && [ -z "$(find "$NAMES" -mmin +60 2>/dev/null)" ]; then return 0; fi
  status="$(get /v1/context/names "$tmp" --data-urlencode format=tsv)"
  case "$status" in
    2??) grep -v '^[[:space:]]*$' "$tmp" | awk -F'\t' 'length($2) >= 3' >"$NAMES" 2>/dev/null; rm -f "$tmp" ;;
    *) rm -f "$tmp"; log "couldn't read names ($status)" ;;
  esac
}

input="$(cat 2>/dev/null | tr -d '\n')"
session="$(field session_id "$input" | tr -cd 'A-Za-z0-9-')"
[ -n "$session" ] || session="unknown"
SEEN="$DATA/seen/$session"

if [ -z "$TOKEN" ]; then
  log "no Ambient token set; add one in /plugin → ambient → configure"
  exit 0
fi

case "$MODE" in
  start)
    source="$(field source "$input")"
    # A resumed session still has its pack in context.
    [ "$source" = "resume" ] && exit 0
    # After /clear or /compact the pages are gone from context: they may come again.
    [ "$source" = "startup" ] || rm -f "$SEEN"
    since="$(cat "$DATA/last-start" 2>/dev/null || true)"
    out="$DATA/start.txt"
    status="$(get /v1/context/start "$out" --data-urlencode "since=$since")"
    case "$status" in
      2??)
        cat "$out"
        [ "$source" = "startup" ] && date -u +%Y-%m-%d >"$DATA/last-start"
        log "start ($source): pack of $(wc -c <"$out" | tr -d ' ') bytes"
        ;;
      *) log "start: no pack ($status)" ;;
    esac
    rm -f "$out"
    refresh_names
    find "$DATA/seen" -type f -mtime +7 -delete 2>/dev/null
    ;;
  prompt)
    refresh_names
    [ -s "$NAMES" ] || exit 0
    # The prompt is the input without the fields around it (a folder path can hold a name).
    text="$(printf '%s' "$input" | sed -E 's/"(session_id|transcript_path|cwd|permission_mode|hook_event_name)"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"//g')"
    cut -f2 "$NAMES" >"$DATA/names.list"
    matched="$(printf '%s\n' "$text" | grep -oiwF -f "$DATA/names.list" 2>/dev/null | sort -u)"
    [ -n "$matched" ] || exit 0
    touch "$SEEN"
    ids="$(printf '%s\n' "$matched" | awk -F'\t' 'NR == FNR { want[tolower($0)] = 1; next } (tolower($2) in want) { print $1 }' - "$NAMES" |
      awk '!seen[$0]++' | grep -vxF -f "$SEEN" | head -n 3 | paste -sd, -)"
    [ -n "$ids" ] || exit 0
    out="$DATA/pages.txt"
    headers="$DATA/pages.headers"
    status="$(get /v1/context/pages "$out" -D "$headers" --data-urlencode "ids=$ids")"
    case "$status" in
      2??)
        found="$(sed -n 's/^[Aa]mbient-[Ff]ound:[[:space:]]*//p' "$headers" | tr -d '\r')"
        if [ -s "$out" ] && [ -n "$found" ]; then
          cat "$out"
          printf '%s\n' "$found" | tr ',' '\n' >>"$SEEN"
          log "prompt: added $found"
        fi
        ;;
      *) log "prompt: no pages ($status)" ;;
    esac
    rm -f "$out" "$headers"
    ;;
esac
exit 0
