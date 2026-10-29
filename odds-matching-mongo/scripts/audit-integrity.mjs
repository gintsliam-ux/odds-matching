// A read-only sweep of `gutsys_sport` for everything that looks wrong.
//
// Each check prints a count, a sample, and — where it matters — whether the
// thing is safely fixable or needs a judgement. Nothing here writes.
//
// Usage:  node scripts/audit-integrity.mjs
//         node scripts/audit-integrity.mjs --json report.json

import { writeFileSync } from 'node:fs';
import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const jsonPath = (() => { const i = argv.indexOf('--json'); return i === -1 ? null : argv[i + 1]; })();

const report = {};
const head = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n${'─'.repeat(n.length)}`);
const line = (k, v, note = '') => console.log(`  ${String(v).padStart(8)}  ${k}${note ? `   ${note}` : ''}`);

/** Same two teams, same exact kick-off — a doubleheader differs in time. */
const pairKey = {
  $cond: [{ $lt: ['$home_team', '$away_team'] },
    { $concat: ['$home_team', '|', '$away_team'] },
    { $concat: ['$away_team', '|', '$home_team'] }],
};

async function main() {
  const d = await db();
  const F = d.collection('fixtures');
  const total = await F.countDocuments({});

  /* ---------------------------------------------------------- identity */
  head('1. Fixture identity');

  const dupId = await F.aggregate([
    { $group: { _id: '$fixture_id', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, keys: { $sum: 1 }, extra: { $sum: { $subtract: ['$n', 1] } } } },
  ], { allowDiskUse: true }).toArray();
  const objectIdKeyed = await F.countDocuments({ $expr: { $ne: ['$_id', '$fixture_id'] } });
  const idx = await F.indexes();
  const uniqueOnFixtureId = idx.some((i) => i.unique && i.key.fixture_id);

  report.identity = {
    total,
    duplicateFixtureIds: dupId[0]?.keys ?? 0,
    extraDocuments: dupId[0]?.extra ?? 0,
    objectIdKeyed,
    uniqueIndexOnFixtureId: uniqueOnFixtureId,
  };
  line('fixtures', total);
  line('fixture_ids on more than one document', report.identity.duplicateFixtureIds,
    '← the same match stored twice under one id');
  line('documents keyed by ObjectId, not fixture_id', objectIdKeyed,
    '← a second insert path that cannot be idempotent');
  line('unique index on fixture_id', uniqueOnFixtureId ? 'yes' : 'NO',
    uniqueOnFixtureId ? '' : '← nothing prevents the above');

  /* -------------------------------------------------------- duplicates */
  head('2. The same match stored as two fixtures');

  const dupMatch = await F.aggregate([
    { $match: { home_team: { $nin: [null, ''] }, away_team: { $nin: [null, ''] }, scheduled_start: { $ne: null } } },
    { $project: { sport: 1, fixture_id: 1, optic_league: 1, has_odds: 1, has_sp: 1, source: 1, scheduled_start: 1, pair: pairKey } },
    {
      $group: {
        _id: { s: '$sport', t: '$scheduled_start', p: '$pair' },
        n: { $sum: 1 },
        ids: { $push: { f: '$fixture_id', l: '$optic_league', o: '$has_odds', sp: '$has_sp', src: '$source' } },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ], { allowDiskUse: true }).toArray();

  let sameId = 0, archiveTwin = 0, crossLeague = 0, sameLeague = 0;
  let onlyOneHasOdds = 0, bothHaveOdds = 0, neitherHasOdds = 0;
  for (const g of dupMatch) {
    const ids = new Set(g.ids.map((x) => x.f));
    const leagues = new Set(g.ids.map((x) => x.l));
    if (ids.size === 1) sameId++;
    else if (g.ids.some((x) => x.src === 'archive') && g.ids.some((x) => x.src !== 'archive')) archiveTwin++;
    else if (leagues.size > 1) crossLeague++;
    else sameLeague++;

    const priced = g.ids.filter((x) => x.o || x.sp).length;
    if (priced === 0) neitherHasOdds++; else if (priced === 1) onlyOneHasOdds++; else bothHaveOdds++;
  }
  report.duplicateMatches = {
    groups: dupMatch.length,
    extra: dupMatch.reduce((t, x) => t + x.n - 1, 0),
    sameId, archiveTwin, crossLeague, sameLeague,
    onlyOneHasOdds, bothHaveOdds, neitherHasOdds,
  };
  line('groups (same teams, same exact kick-off)', dupMatch.length);
  line('extra fixtures', report.duplicateMatches.extra);
  console.log('  by cause:');
  line('one fixture_id, two documents', sameId, '← check 1; safe to dedupe');
  line('an `archive` row beside an `optic` one', archiveTwin, '← the 20 Aug backfill overlapping live data');
  line('two different league ids', crossLeague, '← a match filed under two competitions');
  line('two ids within one league', sameLeague);
  console.log('  by where the odds sit:');
  line('only one side priced', onlyOneHasOdds, '← drop the empty one');
  line('neither side priced', neitherHasOdds, '← drop either');
  line('both sides priced', bothHaveOdds, '← needs a merge, not a delete');

  /* ------------------------------------------------------------- flags */
  head('3. Flags against reality');

  const odds = d.collection('odds');
  const oddsSp = d.collection('odds_sp');
  const pricedIds = new Set(await odds.distinct('fixture_id'));
  const spIds = new Set(await oddsSp.distinct('fixture_id'));

  const flagRows = await F.find({}, { projection: { _id: 0, fixture_id: 1, has_odds: 1, has_sp: 1 } }).toArray();
  let oddsTrueNoRows = 0, oddsFalseHasRows = 0, spTrueNoRows = 0, spFalseHasRows = 0;
  for (const f of flagRows) {
    const o = pricedIds.has(f.fixture_id), s = spIds.has(f.fixture_id);
    if (f.has_odds && !o) oddsTrueNoRows++;
    if (!f.has_odds && o) oddsFalseHasRows++;
    if (f.has_sp && !s) spTrueNoRows++;
    if (!f.has_sp && s) spFalseHasRows++;
  }
  report.flags = { oddsTrueNoRows, oddsFalseHasRows, spTrueNoRows, spFalseHasRows };
  line('has_odds true, no rows in `odds`', oddsTrueNoRows);
  line('has_odds false, rows exist', oddsFalseHasRows);
  line('has_sp true, no rows in `odds_sp`', spTrueNoRows);
  line('has_sp false, rows exist', spFalseHasRows);

  /* ------------------------------------------------------------ orphans */
  head('4. Odds with no fixture');

  const fixtureIds = new Set(await F.distinct('fixture_id'));
  const orphanOdds = [...pricedIds].filter((x) => !fixtureIds.has(x));
  const orphanSp = [...spIds].filter((x) => !fixtureIds.has(x));
  report.orphans = { odds: orphanOdds.length, oddsSp: orphanSp.length };
  line('fixture_ids in `odds` with no fixture', orphanOdds.length);
  line('fixture_ids in `odds_sp` with no fixture', orphanSp.length);
  if (orphanOdds.length) console.log(`     e.g. ${orphanOdds.slice(0, 3).join(', ')}`);

  /* ------------------------------------------------------------- state */
  head('5. Status against the clock');

  const now = new Date();
  const dayAgo = new Date(now - 864e5);
  const [completedNoScore, liveStale, upcomingPast] = await Promise.all([
    F.countDocuments({ status: 'completed', scores: null, scheduled_start: { $lt: dayAgo } }),
    F.countDocuments({ $or: [{ status: 'live' }, { is_live: true }], scheduled_start: { $lt: dayAgo } }),
    F.countDocuments({ status: 'upcoming', scheduled_start: { $lt: dayAgo } }),
  ]);
  report.state = { completedNoScore, liveStale, upcomingPast };
  line('completed, finished over a day ago, no score', completedNoScore);
  line('still marked live, started over a day ago', liveStale);
  line('still marked upcoming, started over a day ago', upcomingPast);

  /* --------------------------------------------------------- reference */
  head('6. Reference data');

  const leagues = d.collection('leagues');
  const usedLeagues = await F.distinct('optic_league', { optic_league: { $ne: null } });
  const knownLeagues = new Set(await leagues.distinct('optic_league'));
  const missingRow = usedLeagues.filter((x) => !knownLeagues.has(x));
  const noName = await leagues.countDocuments({ tournament: { $in: [null, ''] }, event_per_fixture: { $ne: true } });
  const orphanLeagueRows = [...knownLeagues].filter((x) => !usedLeagues.includes(x));

  report.reference = {
    leaguesUsed: usedLeagues.length,
    leaguesRows: knownLeagues.size,
    missingRow: missingRow.length,
    rowsWithNoName: noName,
    rowsForLeaguesWithNoFixtures: orphanLeagueRows.length,
  };
  line('league ids in use', usedLeagues.length);
  line('league ids with no `leagues` row', missingRow.length);
  line('`leagues` rows with no tournament name', noName, '(excluding declared buckets)');
  line('`leagues` rows for ids with no fixtures', orphanLeagueRows.length);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nwrote ${jsonPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
