#!/bin/sh
# Scheduled refresh of tennis player -> country flags (launchd / cron entry point).
#
# The resolver upserts straight into tennis_player_countries when
# SUPABASE_SERVICE_ROLE_KEY is set in .env. Without that key a scheduled run
# could only emit seed SQL that nobody applies, so we skip rather than crawl
# Wikidata for nothing. Add the key to .env to switch automation on.

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)" || exit 1

if ! grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' .env 2>/dev/null; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S') skip — SUPABASE_SERVICE_ROLE_KEY not in .env (auto-upsert disabled)"
  exit 0
fi

echo "$(date '+%Y-%m-%dT%H:%M:%S') resolving new players…"
exec /opt/homebrew/bin/node scripts/resolve-player-countries.mjs
