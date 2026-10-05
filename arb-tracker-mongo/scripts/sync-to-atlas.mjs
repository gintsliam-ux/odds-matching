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
  { name: 'league_health', mode: 'replace' },
];

/** How far either side of now the health check looks. */
const HEALTH_BACK_D = 14;
const HEALTH_FWD_D = 7;

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

  // BEFORE the push, not after. competition_mapping is mirrored in `replace`
  // mode, which prunes mirror rows the NAS does not have — so a mapping saved
  // on the deployed site would be deleted on the way past unless it has already
  // been replayed upstream by the time the rebuild runs.
  await drainPendingWrites(S, D);
  await buildLeagueHealth(S);

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
 * Replay mapping writes made on a deployed instance onto the NAS.
 *
 * Vercel cannot reach `gutsys_sport`, so a save there lands on the mirror and
 * leaves an intent in `mapping_pending` (see queueForNas in
 * server/lib/mapping.mjs). This is the other half: apply each intent to the
 * source, then drop it. Anything that fails is LEFT in the queue — a write the
 * user made is worth retrying next hour, and dropping it silently is how a
 * mapping quietly un-applies itself.
 */
async function drainPendingWrites(S, D) {
  const queue = D.collection('mapping_pending');
  const pending = await queue.find({}).sort({ at: 1 }).limit(1000).toArray();
  if (!pending.length) return;

  const cm = S.collection('competition_mapping');
  const leagues = S.collection('leagues');
  let applied = 0, deleted = 0, failed = 0;

  for (const p of pending) {
    try {
      if (p.op === 'upsert') {
        const items = p.payload?.items ?? [];
        const now = new Date();
        for (const i of items) {
          if (!i?.opticLeague || !i?.provider) continue;
          const league = await leagues.findOne({ optic_league: i.opticLeague });
          await cm.updateOne(
            { provider: i.provider, optic_league: i.opticLeague, gutsy_competition_id: i.competitionId ?? null },
            {
              $set: {
                optic_sport: league?.sport ?? null,
                optic_league: i.opticLeague,
                // Empty for everything but tennis — the key Stage 2 looks up.
                // See matcherTournamentKey in server/lib/mapping.mjs; writing
                // the league's display name here makes the mapping invisible.
                optic_tournament: (league?.sport ?? '').toLowerCase() === 'tennis' ? (league?.tournament ?? '') : '',
                gutsy_sport: i.sport ?? null,
                gutsy_competition: i.competitionName ?? null,
                gutsy_competition_id: i.competitionId ?? null,
                confidence: i.confidence ?? 1,
                source: 'manual',
                provider: i.provider,
                resolved_at: now,
                verified: true,
                verified_at: now,
              },
            },
            { upsert: true },
          );
          applied++;
        }
      } else if (p.op === 'delete') {
        const { opticLeague, provider, competitionId } = p.payload ?? {};
        if (!opticLeague || !provider) throw new Error('bad delete intent');
        const filter = { provider, optic_league: opticLeague };
        if (competitionId != null) filter.gutsy_competition_id = competitionId;
        const r = await cm.deleteMany(filter);
        deleted += r.deletedCount ?? 0;
      } else {
        throw new Error(`unknown op ${p.op}`);
      }
      await queue.deleteOne({ _id: p._id });
    } catch (e) {
      failed++;
      console.log(`  (pending ${p._id} failed, left queued: ${String(e.message).slice(0, 70)})`);
    }
  }
  console.log(`  ${'mapping_pending'.padEnd(21)} replayed ${applied} upserts, ${deleted} deletes onto the NAS${failed ? `, ${failed} left queued` : ''}`);
}

/**
 * Per league and provider: is this mapping actually producing matches?
 *
 * A tournament mapped to the WRONG competition looks perfectly healthy on the
 * mapping page — it has a name, a confidence, a verified tick — and quietly
 * matches none of its fixtures. soccer_turkey_1_lig pointed at the Turkish Cup
 * rather than the second division; soccer_argentina_torneo_federal_a at the top
 * flight rather than the third tier. Nothing in the mapping itself says so. The
 * only evidence is downstream: events that never pair.
 *
 * `books` is what separates a wrong mapping from a quiet one. A competition the
 * book is not trading right now (NBA out of season) matches nothing for a
 * perfectly good reason, and flagging it would bury the real ones.
 *
 * Written to the NAS and mirrored, so the deployed page reads the same numbers
 * rather than recomputing them from `fixtures`, which it does not have.
 */
async function buildLeagueHealth(S) {
  const t0 = Date.now();
  const from = new Date(Date.now() - HEALTH_BACK_D * 86_400_000);
  const to = new Date(Date.now() + HEALTH_FWD_D * 86_400_000);

  const per = await S.collection('fixtures')
    .aggregate(
      [
        { $match: { source: 'optic', scheduled_start: { $gte: from, $lte: to } } },
        { $group: { _id: '$optic_league', ids: { $push: '$fixture_id' }, n: { $sum: 1 } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const allIds = per.flatMap((p) => p.ids);
  const em = await S.collection('event_mapping')
    .find({ optic_fixture_id: { $in: allIds }, gutsy_event_id: { $ne: null } })
    .project({ _id: 0, optic_fixture_id: 1, provider: 1 })
    .toArray();
  const matched = { swift: new Set(), mybet: new Set() };
  for (const m of em) matched[m.provider]?.add(m.optic_fixture_id);

  // What each book is trading in the same window, by competition id.
  const books = new MongoClient(process.env.BETS_URI ?? DST_URI, { maxPoolSize: 3 });
  const trading = { swift: new Map(), mybet: new Map() };
  try {
    await books.connect();
    const g = books.db('gutsy');
    for (const r of await g.collection('events').aggregate([
      { $match: { start_date: { $gte: from.toISOString(), $lte: to.toISOString() } } },
      { $group: { _id: '$competition.id', n: { $sum: 1 } } },
    ]).toArray()) if (r._id) trading.swift.set(String(r._id), r.n);
    for (const r of await g.collection('mybet_events').aggregate([
      { $match: { outcomeAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$leagueId', n: { $sum: 1 } } },
    ]).toArray()) if (r._id != null) trading.mybet.set(String(r._id), r.n);
  } finally {
    await books.close().catch(() => {});
  }

  const maps = await S.collection('competition_mapping')
    .find({ gutsy_competition_id: { $nin: [null, ''] } })
    .project({ _id: 0, provider: 1, optic_league: 1, gutsy_competition_id: 1 })
    .toArray();
  const byLeagueProvider = new Map();
  for (const m of maps) {
    const k = `${m.optic_league}|${m.provider}`;
    const n = trading[m.provider]?.get(String(m.gutsy_competition_id)) ?? 0;
    byLeagueProvider.set(k, (byLeagueProvider.get(k) ?? 0) + n);
  }

  const docs = per.filter((p) => p._id).map((p) => {
    const out = { _id: p._id, fixtures: p.n, computed_at: new Date(), providers: {} };
    for (const provider of ['swift', 'mybet']) {
      const hit = p.ids.filter((id) => matched[provider].has(id)).length;
      const k = `${p._id}|${provider}`;
      if (!byLeagueProvider.has(k)) continue; // not mapped for this provider
      out.providers[provider] = { matched: hit, bookEvents: byLeagueProvider.get(k) };
    }
    return out;
  });

  const to_ = S.collection('league_health');
  for (let i = 0; i < docs.length; i += CHUNK) {
    await to_.bulkWrite(
      docs.slice(i, i + CHUNK).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false },
    );
  }
  const keep = new Set(docs.map((d) => String(d._id)));
  const stale = (await to_.find({}, { projection: { _id: 1 } }).toArray())
    .filter((d) => !keep.has(String(d._id))).map((d) => d._id);
  if (stale.length) await to_.deleteMany({ _id: { $in: stale } });

  const suspect = docs.filter((d) =>
    Object.values(d.providers).some((v) => v.matched === 0 && v.bookEvents > 0));
  console.log(`  ${'league_health'.padEnd(21)} ${docs.length} leagues, ${suspect.length} mapped-but-matching-nothing   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
