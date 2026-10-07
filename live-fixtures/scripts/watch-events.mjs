// Map new events as they land, instead of waiting for the hourly run.
//
// `build-mapping-mongo.mjs` is fixture-driven: every run re-derives the whole
// 45-day window, which costs about 2m40s (82s matching, 76s mirroring). That is
// fine as a safety net and far too slow to run per event, so this watches for
// arrivals and triggers that same run — the proven path, not a second matcher
// that could drift from it.
//
// What actually needs mapping is narrower than what arrives. mybet mints an
// event per MARKET, and ~85% of new rows are those satellites ("Winning Margin
// - Atlanta Hawks vs …", league "-"), which resolve through their base event
// and need no mapping of their own. Only base events — a real league — count,
// and they arrive at roughly 19/hour against 2/min of total inserts.
//
// Single-flight with a short debounce: arrivals inside the window coalesce into
// one run, and an arrival during a run sets the run again rather than queueing
// several. With events flowing the effect is back-to-back mapping; with nothing
// happening it sits idle.
//
// The hourly job stays as it is. This only ever makes mapping EARLIER, and if
// this process dies the old cadence still covers everything.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const parseEnv = (p) => {
  try {
    return Object.fromEntries(
      readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
    );
  } catch {
    return {};
  }
};
const env = parseEnv(join(ROOT, '.env'));
const MONGO_URI = process.env.MONGO_URI ?? env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB ?? env.MONGO_DB ?? 'gutsy';
if (!MONGO_URI) {
  console.error('Missing MONGO_URI (gutsy on Atlas) — set it in live-fixtures/.env');
  process.exit(1);
}

/** Long enough to coalesce a burst, short enough to feel immediate. */
const DEBOUNCE_MS = 30_000;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

/*
 * Only the events that need a mapping.
 *
 * A real league is what separates a match's BASE event from the per-market
 * satellites mybet mints around it — the satellites carry "-" and resolve
 * through the base, so mapping them is work with no result.
 */
const MYBET_BASE = {
  operationType: 'insert',
  'fullDocument.league': { $nin: [null, '', '-'] },
};
/* gutsy.events has no such split; every insert is a candidate. */
const SWIFT_ANY = { operationType: 'insert' };

let running = false;
let pending = false;
let timer = null;
let seen = 0;

function schedule(why) {
  seen += 1;
  if (timer) return;                       // already waiting — this one joins it
  log(`${why} — mapping in ${DEBOUNCE_MS / 1000}s`);
  timer = setTimeout(() => {
    timer = null;
    run();
  }, DEBOUNCE_MS);
}

function run() {
  if (running) {
    // Something arrived mid-run and the run may have already read past it.
    pending = true;
    return;
  }
  running = true;
  const n = seen;
  seen = 0;
  log(`mapping (${n} new event${n === 1 ? '' : 's'})`);
  const t0 = Date.now();
  const child = spawn('bash', [join(HERE, 'run-mapping-mongo.sh')], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    running = false;
    log(`mapping finished in ${((Date.now() - t0) / 1000).toFixed(0)}s (exit=${code})`);
    if (pending) {
      pending = false;
      run();                               // arrivals during the run: go again
    }
  });
  child.on('error', (err) => {
    running = false;
    log('mapping could not start:', err.message);
  });
}

const client = new MongoClient(MONGO_URI, { maxPoolSize: 3 });
await client.connect();
const db = client.db(MONGO_DB);
log(`watching ${MONGO_DB}.mybet_events and ${MONGO_DB}.events for new events`);

/** One watcher, retried with back-off rather than abandoned. */
function watch(name, match, describe) {
  let delay = 5_000;
  const open = () => {
    const cs = db.collection(name).watch([{ $match: match }]);
    cs.on('change', (ev) => {
      delay = 5_000;                       // a delivered change proves it is healthy
      schedule(describe(ev.fullDocument));
    });
    cs.on('error', (err) => {
      log(`${name} stream error: ${err.message}`);
      cs.close().catch(() => {});
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  open();
}

watch('mybet_events', MYBET_BASE, (d) => `mybet: ${d?.sport ?? '?'} / ${d?.league ?? '?'}`);
watch('events', SWIFT_ANY, (d) => `swift: ${String(d?.name ?? '?').slice(0, 48)}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('shutting down');
    await client.close().catch(() => {});
    process.exit(0);
  });
}
