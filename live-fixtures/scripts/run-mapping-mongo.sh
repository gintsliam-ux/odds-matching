#!/bin/bash
#
# Hourly tournament/event mapping for gutsys_sport on the NAS.
#
# The Supabase copy of these tables is kept current by a daily Vercel cron plus
# a client-pinged mapping-tick. The Mongo copy — the one Sports Odds Desk and
# the Odds Library actually read — had no writer at all, so it froze on
# 2026-09-16 and every fixture created afterwards sat behind a placeholder row
# with a null gutsy_event_id. This is that missing writer.
#
# It has to be launchd rather than a Vercel cron for the same reason the logos
# job does: gutsys_sport lives on a Tailscale address that public infrastructure
# cannot route to.
#
# Hourly, because fixtures appear continuously and a book lists its market only
# a few days out — a fixture OPTIC knows about today may not reach SwiftBet
# until tomorrow, and until it does the matcher can only write a placeholder.
# Re-running is how the placeholder becomes a match. The work is idempotent:
# manual and verified rows are never touched, and auto rows are rebuilt wholesale.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
echo "=== $(stamp) start ==="

# Off the tailnet is a night off, not a failure — keep the log readable so a
# real error stands out.
if ! nc -z -G 5 100.96.58.9 27017 >/dev/null 2>&1; then
  echo "$(stamp) NAS unreachable on the tailnet — skipping this run"
  echo "=== $(stamp) end (skipped) ==="
  exit 0
fi

node scripts/build-mapping-mongo.mjs 2>&1
code=$?

# Push the three tailnet-only collections to Atlas, where the deployed site can
# read them. Mapping has just changed, which is exactly what needs mirroring;
# entities ride along and are at worst an hour behind the nightly logos job.
# Non-fatal: a mirror that misses a cycle leaves the site an hour stale, which
# is not worth failing the mapping run over.
echo "--- $(stamp) mirror to atlas ---"
( cd ../arb-tracker-mongo && node --env-file=.env scripts/sync-to-atlas.mjs 2>&1 ) || echo "$(stamp) mirror FAILED (mapping itself was fine)"

echo "=== $(stamp) end (exit=$code) ==="
exit $code
