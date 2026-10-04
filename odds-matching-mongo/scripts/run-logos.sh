#!/bin/bash
#
# Nightly crest/flag resolution for the Odds Library and Sports Odds Desk.
#
# Both resolvers write `entities` / `tournaments` in Mongo `gutsys_sport` on the
# NAS, which is a Tailscale address. That is the whole reason this is a launchd
# agent and not a Vercel cron: public infrastructure cannot route to 100.x.
#
# It also means the NAS is routinely unreachable — laptop asleep, off the
# tailnet, NAS rebooting. A run that cannot see the NAS is NOT a failure worth
# a stack trace in the log; it is just a night off. So probe first and exit 0,
# leaving the log readable enough that a real failure stands out.
#
# Neither resolver re-tries names already recorded as a miss, so a nightly pass
# over a drained backlog costs a handful of queries and no upstream lookups.
# Recorded misses are re-tried only by hand, with --retry-null.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
echo "=== $(stamp) start ==="

if ! nc -z -G 5 100.96.58.9 27017 >/dev/null 2>&1; then
  echo "$(stamp) NAS unreachable on the tailnet — skipping tonight"
  echo "=== $(stamp) end (skipped) ==="
  exit 0
fi

for job in resolve-entity-logos resolve-tournament-logos; do
  echo "--- $(stamp) $job ---"
  node --env-file=.env "scripts/$job.mjs" 2>&1
  echo "--- $(stamp) $job exit=$? ---"
done

echo "=== $(stamp) end ==="
