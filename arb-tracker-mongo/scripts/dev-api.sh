#!/usr/bin/env bash
# Keep the API up.
#
# The API process has been observed exiting cleanly (code 0, empty log, Mongo
# reachable) after running fine for a while. It is not a crash and it has not
# been reproducible on demand — but each time it happens the board goes dead,
# and with `concurrently -k` it takes the dev server down with it.
#
# Rather than keep chasing an intermittent quiet exit, respawn it. A server
# that comes back in a second is a non-event; one that stays down is an outage.
set -uo pipefail
cd "$(dirname "$0")/.."

# Back off on repeated fast failures, so a genuinely broken start (bad
# MONGO_URI, port in use) surfaces in the log instead of spinning invisibly.
fails=0

while true; do
  started=$(date +%s)
  node --env-file-if-exists=.env --watch server/index.mjs
  code=$?
  ran=$(( $(date +%s) - started ))

  # A deliberate Ctrl-C / SIGTERM (128+signal) means stop, not restart.
  if [ $code -ge 128 ]; then
    echo "[dev-api] exited on signal ($code) — not restarting"
    exit $code
  fi

  if [ $ran -ge 30 ]; then
    fails=0
  else
    fails=$(( fails + 1 ))
  fi

  if [ $fails -ge 5 ]; then
    echo "[dev-api] exited $fails times in under 30s (last code $code) — giving up; see the error above"
    exit 1
  fi

  delay=$(( fails > 0 ? fails : 1 ))
  echo "[dev-api] exited with code $code after ${ran}s — restarting in ${delay}s"
  sleep $delay
done
