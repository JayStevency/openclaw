#!/usr/bin/env bash
# Fetch betman game schedule and send to Discord.
# Intended to be run by launchd every hour.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL="channel:1469228035143106736"
LOG_TAG="betman-schedule"

# Ensure PATH includes pnpm and homebrew
export PATH="$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"

msg=$(npx tsx "$SCRIPT_DIR/betman-schedule.ts" 2>/tmp/betman-schedule-err.log) || {
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "[$LOG_TAG] No changes, skipping." >&2
    exit 0
  fi
  echo "[$LOG_TAG] Script failed (exit $code):" >&2
  cat /tmp/betman-schedule-err.log >&2
  exit 1
}

if [ -z "$msg" ]; then
  echo "[$LOG_TAG] Empty message, skipping." >&2
  exit 0
fi

# Send via openclaw message send using heredoc to handle special chars
openclaw message send --channel discord --target "$CHANNEL" --message "$(cat <<EOF
$msg
EOF
)"

echo "[$LOG_TAG] Sent to Discord." >&2
