// When a Swiftbet fixture actually kicked off.
//
// Swiftbet publishes a status — prematch -> inprogress -> postmatch — but no
// timestamp for the change, and no history to mine: the scraper updates each
// event document in place, so the previous status is gone the moment it moves.
// The only way to know when a match started is to be watching when it does.
//
// Something used to: `event_mapping.swift_actual_start` holds 7,939 of these
// and the Details panel still reads it as "Observed jump". It stopped on
// 2026-09-16, when build-mapping-mongo.mjs was rewritten without the logic —
// the current file does not contain the word `inprogress`. This is that
// observation put back, on its own rather than bolted to the hourly matcher,
// because an hourly job can only date a kickoff to the hour.
//
// Accuracy is one scrape interval. The stamp is the event's own `scraped_at`,
// not the time this script ran: the scraper is what saw the change, and it runs
// far more often than this will.
//
// Writes `gutsy.swift_event_status` on Atlas, NOT event_mapping on the NAS.
// Two reasons: the deployed site reads Atlas directly, so a start time is
// visible immediately rather than after the next hourly mirror; and this needs
// no tailnet, so it can run anywhere.
//
// WHERE IT RUNS: nowhere yet — it needs a launchd agent on the Air, every
// minute or two. Deployed copies live under ~/gutsy, which is not a git
// checkout, so a change here must be copied across. See sync-to-atlas.mjs for
// the same warning.
//
// Usage:
//   node --env-file=.env scripts/watch-swift-starts.mjs
//   node --env-file=.env scripts/watch-swift-starts.mjs --dry-run
//   node --env-file=.env scripts/watch-swift-starts.mjs --back 12 --fwd 24

import { MongoClient } from 'mongodb';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const optNum = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : Number(argv[i + 1]);
};
/* The window a kickoff can plausibly be in. Wide enough to cover a late start
   or a long-running match, narrow enough that this is ~100 documents. */
const BACK_H = optNum('--back', 6);
const FWD_H = optNum('--fwd', 12);

const URI = process.env.BETS_URI;
const DB = process.env.BETS_DB || 'gutsy';
if (!URI) {
  console.error('BETS_URI is not set — nothing to watch.');
  process.exit(1);
}

/** Swiftbet's own vocabulary. `status` is the one that moves first. */
const LIVE = 'inprogress';
const DONE = new Set(['postmatch', 'abandoned']);

const iso = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

const client = new MongoClient(URI, { maxPoolSize: 3 });
try {
  await client.connect();
  const db = client.db(DB);
  const events = db.collection('events');
  const state = db.collection('swift_event_status');

  const now = Date.now();
  // `start_date` is a STRING here, so the bounds must be too — comparing it to
  // a Date silently matches nothing, which is how a sweep over this collection
  // once reported zero upcoming events.
  const from = new Date(now - BACK_H * 3600_000).toISOString();
  const to = new Date(now + FWD_H * 3600_000).toISOString();

  const live = await events
    .find({ start_date: { $gte: from, $lte: to } })
    .project({ _id: 1, status: 1, start_date: 1, scraped_at: 1, finished_at: 1, name: 1 })
    .toArray();

  const ids = live.map((e) => String(e._id));
  const known = new Map(
    (await state.find({ _id: { $in: ids } }).toArray()).map((d) => [String(d._id), d]),
  );

  const writes = [];
  let started = 0;
  let changed = 0;
  for (const e of live) {
    const id = String(e._id);
    const status = e.status ?? null;
    const prev = known.get(id);
    if (prev && prev.status === status) continue;
    changed += 1;

    const seenAt = iso(e.scraped_at) ?? new Date(now).toISOString();
    const doc = {
      status,
      previous: prev?.status ?? null,
      statusAt: seenAt,
      startDate: e.start_date ?? null,
      name: e.name ?? null,
      updatedAt: new Date(now).toISOString(),
    };

    /*
     * The kickoff itself, claimed only when we WATCHED it happen — a row we
     * first meet already in progress tells us it started, not when, and
     * guessing would put a confident wrong time next to Optic's.
     */
    if (status === LIVE && prev && prev.status !== LIVE && !prev.actualStart) {
      doc.actualStart = seenAt;
      started += 1;
    }
    // A match seen finishing without ever being seen live: record the end, not
    // a start we never saw.
    if (DONE.has(status) && e.finished_at) doc.finishedAt = iso(e.finished_at);

    writes.push({ updateOne: { filter: { _id: id }, update: { $set: doc }, upsert: true } });
  }

  console.log(
    `${live.length} swiftbet events in [-${BACK_H}h, +${FWD_H}h]; ` +
      `${changed} status change${changed === 1 ? '' : 's'}, ${started} kickoff${started === 1 ? '' : 's'} observed` +
      (DRY ? '  [DRY RUN — nothing written]' : ''),
  );
  for (const w of writes.filter((x) => x.updateOne.update.$set.actualStart).slice(0, 10)) {
    const d = w.updateOne.update.$set;
    console.log(`   kicked off ${d.actualStart}  (scheduled ${d.startDate})  ${String(d.name).slice(0, 44)}`);
  }
  if (!DRY && writes.length) {
    const r = await state.bulkWrite(writes, { ordered: false });
    console.log(`   wrote ${(r.upsertedCount ?? 0) + (r.modifiedCount ?? 0)} rows`);
  }
} finally {
  await client.close().catch(() => {});
}
