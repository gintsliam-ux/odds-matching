// Mirror the three NAS-only collections to Atlas, so the deployed site can read them.
//
// `gutsys_sport` lives on a Tailscale address (100.96.58.9). Vercel cannot route
// to 100.64.0.0/10 at all, so the deployed Sports Odds Desk runs in `api` mode
// and has mapping, bets and crests switched off — not because the data is
// missing, but because it is on the wrong side of the tailnet.
//
// Only three collections are needed to light all three features back up:
//
//   event_mapping        the fixture -> book-event bridge. Bets need it: the bet
//                        rows themselves are already on Atlas, but the join from
//                        an OPTIC fixture to them goes through here.
//   competition_mapping  the tournament mapping page.
//   entities             club crests and player flags.
//
// ~20 MB in total, so this is a copy, not a replication problem. Odds and
// fixtures are deliberately NOT mirrored — they are large, they change
// constantly, and the deployed site already gets them from the tunnelled
// sport.gutsysapi.com surface.
//
// Atlas is shared with the user's scrapers, so this is written to be a quiet
// neighbour: a small pool, unordered bulk writes in chunks, and — for the two
// big collections — only the documents that changed since the last run.
//
// Usage:
//   node --env-file=.env scripts/sync-to-atlas.mjs             incremental
//   node --env-file=.env scripts/sync-to-atlas.mjs --full      re-copy everything
//   node --env-file=.env scripts/sync-to-atlas.mjs --dry-run   report, write nothing

import { MongoClient } from 'mongodb';

const SRC_URI = process.env.MONGO_URI;
const SRC_DB = process.env.MONGO_DB || 'gutsys_sport';
const DST_URI = process.env.MIRROR_URI || process.env.BETS_URI;
const DST_DB = process.env.MIRROR_DB || 'gutsys_sport';

const FULL = process.argv.includes('--full');
const DRY = process.argv.includes('--dry-run');

if (!SRC_URI) fail('MONGO_URI is not set — nothing to mirror from.');
if (!DST_URI) fail('MIRROR_URI (or BETS_URI) is not set — nowhere to mirror to.');

/**
 * How each collection is kept in step.
 *
 * `watermark` collections are only ever written or added to, so copying
 * everything stamped at or after the newest timestamp already on the mirror is
 * both correct and cheap. `replace` collections are small AND have rows deleted
 * out from under them — the matcher wipes every auto+unverified competition row
 * before rewriting — so a watermark would leave orphans behind and they are
 * re-copied whole instead.
 */
const PLAN = [
  { name: 'event_mapping', mode: 'watermark', field: 'resolved_at' },
  { name: 'entities', mode: 'watermark', field: 'resolved_at' },
  { name: 'competition_mapping', mode: 'replace' },
  { name: 'leagues', mode: 'replace' },
];

/** The team sample the mapping page scores candidates against. Matches TEAM_SAMPLE
 *  in server/lib/mapping.mjs — the summary below has to look like what that
 *  function's own aggregate produces. */
const TEAM_SAMPLE = 400;

const CHUNK = 1000;

const src = new MongoClient(SRC_URI, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 4 });
const dst = new MongoClient(DST_URI, { serverSelectionTimeoutMS: 20_000, maxPoolSize: 4 });

try {
  await src.connect();
  await dst.connect();
  const S = src.db(SRC_DB);
  const D = dst.db(DST_DB);
  console.log(`mirror ${SRC_DB} (NAS) -> ${DST_DB} (atlas)${DRY ? '  [DRY RUN]' : ''}${FULL ? '  [FULL]' : ''}`);

  for (const spec of PLAN) {
    const t0 = Date.now();
    const from = S.collection(spec.name);
    const to = D.collection(spec.name);
    const total = await from.countDocuments();

    let filter = {};
    if (spec.mode === 'watermark' && !FULL) {
      const newest = await to.find({}, { projection: { [spec.field]: 1 } })
        .sort({ [spec.field]: -1 }).limit(1).next();
      const mark = newest?.[spec.field];
      // `$gte`, not `$gt`: several rows share a timestamp when a batch is
      // written in one pass, and `$gt` would skip every one but the first.
      if (mark) filter = { [spec.field]: { $gte: mark } };
    }

    const n = await from.countDocuments(filter);
    if (DRY) {
      console.log(`  ${spec.name.padEnd(21)} ${String(total).padStart(7)} docs on source, ${String(n).padStart(7)} to copy (${spec.mode})`);
      continue;
    }

    // Copy first, prune second: the mirror is read by a live site, so it should
    // never be empty mid-run. A replace that deleted up front would leave the
    // mapping page blank for the length of the copy.
    let copied = 0;
    const cursor = from.find(filter);
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await to.bulkWrite(
        batch.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
        { ordered: false },
      );
      copied += batch.length;
      batch = [];
    };
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= CHUNK) await flush();
    }
    await flush();

    let removed = 0;
    if (spec.mode === 'replace') {
      const keep = new Set((await from.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
      const stale = (await to.find({}, { projection: { _id: 1 } }).toArray())
        .filter((d) => !keep.has(String(d._id)))
        .map((d) => d._id);
      for (let i = 0; i < stale.length; i += CHUNK) {
        const r = await to.deleteMany({ _id: { $in: stale.slice(i, i + CHUNK) } });
        removed += r.deletedCount ?? 0;
      }
    }

    const dstTotal = await to.countDocuments();
    console.log(
      `  ${spec.name.padEnd(21)} copied ${String(copied).padStart(7)}` +
      (removed ? `  pruned ${removed}` : '') +
      `   mirror now ${dstTotal} / source ${total}   ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }

  await syncLeagueSquads(S, D);

  if (!DRY) await ensureIndexes(dst.db(DST_DB));
  console.log('done.');
} finally {
  await src.close().catch(() => {});
  await dst.close().catch(() => {});
}

/**
 * Precompute what the mapping page needs out of `fixtures`, and mirror that
 * instead of the collection.
 *
 * The page never reads a fixture document. It reads one aggregate — per optic
 * league, a sample of the teams that have played in it, a fixture count, and
 * how many distinct tournaments it spans — and uses the squad to tell Italy's
 * Serie A from Brazil's. That summary is 493 KB. `fixtures` is 148 MB and
 * changes every few minutes, so mirroring the source to serve a derived view
 * would be the wrong way round.
 *
 * Kept deliberately identical in shape to `opticLeagues()` in
 * server/lib/mapping.mjs: if the two drift, the deployed mapping page starts
 * scoring against a different squad than the local one and silently disagrees
 * with it.
 */
async function syncLeagueSquads(S, D) {
  const t0 = Date.now();
  const squads = await S.collection('fixtures')
    .aggregate(
      [
        { $match: { home_team: { $ne: null } } },
        { $sort: { scheduled_start: -1 } },
        {
          $group: {
            _id: '$optic_league',
            home: { $push: '$home_team' },
            away: { $push: '$away_team' },
            fixtures: { $sum: 1 },
            tournaments: { $addToSet: '$tournament' },
          },
        },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const docs = squads
    .filter((s) => s._id)
    .map((s) => ({
      _id: s._id,
      teams: [...s.home, ...s.away].filter(Boolean).slice(0, TEAM_SAMPLE),
      fixtures: s.fixtures,
      tournamentCount: (s.tournaments ?? []).filter(Boolean).length,
    }));

  if (DRY) {
    console.log(`  ${'league_squads'.padEnd(21)} ${String(docs.length).padStart(7)} leagues to derive (computed, not copied)`);
    return;
  }

  const to = D.collection('league_squads');
  for (let i = 0; i < docs.length; i += CHUNK) {
    await to.bulkWrite(
      docs.slice(i, i + CHUNK).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false },
    );
  }
  const keep = new Set(docs.map((d) => String(d._id)));
  const stale = (await to.find({}, { projection: { _id: 1 } }).toArray())
    .filter((d) => !keep.has(String(d._id)))
    .map((d) => d._id);
  if (stale.length) await to.deleteMany({ _id: { $in: stale } });

  console.log(
    `  ${'league_squads'.padEnd(21)} derived ${String(docs.length).padStart(7)}` +
    (stale.length ? `  pruned ${stale.length}` : '') +
    `   ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

/** The mirror is read exactly like the original, so it needs the same lookups. */
async function ensureIndexes(D) {
  const want = [
    ['event_mapping', { optic_fixture_id: 1 }, {}],
    ['event_mapping', { provider: 1, optic_fixture_id: 1 }, { unique: true }],
    ['competition_mapping', { optic_league: 1 }, {}],
    ['competition_mapping', { provider: 1 }, {}],
    ['entities', { sport: 1, normalized: 1 }, {}],
  ];
  for (const [c, key, opts] of want) {
    try {
      await D.collection(c).createIndex(key, opts);
    } catch (e) {
      // A pre-existing index with the same key but different options is fine —
      // it already serves the query, which is all this needs.
      console.log(`  (index ${c} ${JSON.stringify(key)}: ${String(e.message).slice(0, 70)})`);
    }
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
