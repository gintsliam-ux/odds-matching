#!/bin/bash
#
# Mirror the two fast-moving collections to Atlas, often.
#
#   player_stats  the box score, rewritten about once a minute while a game runs
#   mybet.markets the brand market book: alternate lines, halves and quarters,
#                 none of which the event record carries
#
# These are the mirrored collections that change while anybody is
# watching it. A live NBA game rewrites its rows about once a minute, and the
# deployed site reads Atlas — so until this existed the stats tab was only as
# fresh as the slow mapping mirror, whose cycle measured 7 to 21 minutes. The
# FINAL stats were the worst case: they landed on the NAS at the whistle and
# could sit there twenty minutes before the site could show them.
#
# This is the same sync-to-atlas.mjs the slow job runs, with --only=player_stats,markets
# so it skips event_mapping (66s) and the derived-table rebuilds. The whole pass
# is about a second, and it is watermarked, so a minute with no game on costs
# one indexed query and writes nothing.
#
# Runs beside the slow mirror rather than instead of it: that one still carries
# event_mapping, entities, competitions and the schedule.
set -uo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd "$HOME/gutsy/odds-matching-mongo" || exit 1
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

if [ ! -f scripts/sync-to-atlas.mjs ]; then
  # Same failure the hourly runner learned to shout about: a missing script is
  # a broken install, not a quiet night, and silence here means a stale site.
  echo "$(stamp) player_stats mirror BROKEN: scripts/sync-to-atlas.mjs is missing"
  exit 1
fi

out=$(node --env-file=.env scripts/sync-to-atlas.mjs --only=player_stats,markets 2>&1)
code=$?
if [ $code -ne 0 ]; then
  echo "$(stamp) FAILED (code=$code)"
  echo "$out"
  exit $code
fi
# Speak only when the mirror actually grew.
#
# The watermark is a `$gte`, so every run re-copies the last batch written at
# the newest timestamp — harmless, idempotent, and it means "copied 83" is the
# steady state rather than news. At a run a minute, logging that buries the
# lines that matter, so the row count on the mirror is what decides: it is the
# number that only moves when something new arrived.
line=$(echo "$out" | grep player_stats)
now=$(echo "$line" | sed -n 's/.*mirror now \([0-9]*\).*/\1/p')
prev=$(cat logs/.player-stats-count 2>/dev/null || echo "")
if [ -n "$now" ] && [ "$now" != "$prev" ]; then
  echo "$(stamp) $line"
  echo "$now" > logs/.player-stats-count
fi
exit 0
