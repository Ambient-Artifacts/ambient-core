#!/bin/sh
# Called by brain-notify@<unit>.service when a Brain unit fails. Posts the last
# journal lines to a Slack-compatible webhook (BRAIN_ALERT_WEBHOOK in /etc/brain/alert.env).
unit="$1"
[ -n "$BRAIN_ALERT_WEBHOOK" ] || exit 0
tail=$(journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | tail -c 1500)
body=$(node -e 'console.log(JSON.stringify({ text: `Ambient: ${process.argv[1]} failed on ${process.argv[2]}\n\`\`\`${process.argv[3]}\`\`\`` }))' "$unit" "$(hostname)" "$tail")
curl -fsS -m 10 -H "content-type: application/json" -d "$body" "$BRAIN_ALERT_WEBHOOK" >/dev/null
