#!/bin/bash
#
# Keeps watch-events.mjs alive.
#
# launchd's KeepAlive restarts it if it exits, but a crash loop against a dead
# Atlas would then spin invisibly; the back-off here makes a genuinely broken
# start show up in the log instead. Same shape as scripts/dev-api.sh.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
fails=0

while true; do
  started=$(date +%s)
  echo "=== $(stamp) watcher start ==="
  node scripts/watch-events.mjs 2>&1
  code=$?
  ran=$(( $(date +%s) - started ))
  echo "=== $(stamp) watcher exited (code=$code, up ${ran}s) ==="

  # Up for a while then gone is a blip; gone immediately, repeatedly, is broken.
  if [ "$ran" -gt 120 ]; then fails=0; else fails=$((fails + 1)); fi
  sleep $(( fails > 5 ? 300 : 10 ))
done
