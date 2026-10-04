// What the archive is missing, league by league and month by month.
//
// Comparing whole years is misleading: 2026 stops at the day you run this, so a
// year-round league will always look like it lost ground. And a league with no
// January fixtures may simply be out of season rather than missing.
//
// So the test is a league against ITSELF. A competition's season months barely
// move year to year, so the union of months it has ever played is a good model
// of when it should have played. A month inside that pattern with no fixtures
// is a hole; a month outside it is just the off-season.
//
// Thin months matter as much as empty ones — a league that played 40 matches in
// March 2026 and 3 in March 2025 is not covered, it is sampled. Anything under
// a third of the same month's best is flagged too.
//
// Usage:  node scripts/audit-coverage.mjs
//         node scripts/audit-coverage.mjs soccer basketball
//         node scripts/audit-coverage.mjs --top 12        leagues per sport
//         node scripts/audit-coverage.mjs --csv out.csv

import { writeFileSync } from 'node:fs';
import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const TOP = Number(opt('--top', 8));
const csvPath = opt('--csv', null);
const onlySports = argv.filter((a) => !a.startsWith('--') && a !== csvPath && a !== String(TOP));

const YEARS = [2024, 2025, 2026];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/* The archive is still being written, so the current month is half-formed and
   future months are simply not due yet. Neither is a gap. */
const now = new Date();
const CUR_Y = now.getUTCFullYear();
const CUR_M = now.getUTCMonth() + 1;
const isDue = (y, m) => y < CUR_Y || (y === CUR_Y && m < CUR_M);

/** Fixtures per (league, year, month), for the biggest leagues in each sport. */
async function grid(sports) {
  const d = await db();
  const match = { scheduled_start: { $ne: null }, optic_league: { $ne: null } };
  if (sports.length) match.sport = { $in: sports };

  const rows = await d.collection('fixtures').aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          sport: '$sport',
          league: '$optic_league',
          y: { $year: '$scheduled_start' },
          m: { $month: '$scheduled_start' },
        },
        n: { $sum: 1 },
      },
    },
  ], { allowDiskUse: true }).toArray();

  const leagues = new Map();
  for (const r of rows) {
    const key = r._id.league;
    if (!leagues.has(key)) leagues.set(key, { sport: r._id.sport, league: key, cells: new Map(), total: 0 });
    const L = leagues.get(key);
    L.cells.set(`${r._id.y}-${r._id.m}`, r.n);
    L.total += r.n;
  }

  // The biggest leagues in a sport are the ones anyone means by "the main ones".
  const bySport = new Map();
  for (const L of leagues.values()) {
    if (!bySport.has(L.sport)) bySport.set(L.sport, []);
    bySport.get(L.sport).push(L);
  }
  for (const [, list] of bySport) {
    list.sort((a, b) => b.total - a.total);
    list.length = Math.min(list.length, TOP);
  }
  return bySport;
}

/**
 * A league's season, learned from its own history.
 *
 * Any month it has played in some year is a month it is expected to play in
 * every year. That over-counts a league that genuinely moved its calendar, and
 * under-counts one whose season has never been captured at all — which is why
 * the output prints the months rather than only a verdict.
 */
function expectedMonths(cells) {
  const months = new Set();
  for (const key of cells.keys()) months.add(Number(key.split('-')[1]));
  return months;
}

function best(cells, m) {
  let top = 0;
  for (const y of YEARS) top = Math.max(top, cells.get(`${y}-${m}`) ?? 0);
  return top;
}

function assess(L) {
  const season = expectedMonths(L.cells);
  const holes = [];
  for (const y of YEARS) {
    for (let m = 1; m <= 12; m++) {
      if (!season.has(m) || !isDue(y, m)) continue;
      const n = L.cells.get(`${y}-${m}`) ?? 0;
      const peak = best(L.cells, m);
      if (peak < 5) continue;                     // too thin anywhere to judge
      if (n === 0) holes.push({ y, m, n, peak, kind: 'empty' });
      else if (n < peak / 3) holes.push({ y, m, n, peak, kind: 'thin' });
    }
  }
  return { season, holes };
}

/* A row of twelve cells per year: a count bucket, "." for out of season, " " for
   not due yet. Reading three years stacked makes a missing season obvious in a
   way a table of totals never does. */
function strip(L, y, season) {
  let out = '';
  for (let m = 1; m <= 12; m++) {
    if (!isDue(y, m)) { out += ' ·'; continue; }
    if (!season.has(m)) { out += '  '; continue; }
    const n = L.cells.get(`${y}-${m}`) ?? 0;
    const peak = best(L.cells, m);
    if (n === 0) out += ' ✗';
    else if (peak >= 5 && n < peak / 3) out += ' ▪';
    else out += ' █';
  }
  return out;
}

async function main() {
  const bySport = await grid(onlySports);
  const csv = [['sport', 'league', 'year', 'month', 'fixtures', 'best_for_that_month', 'verdict'].join(',')];

  console.log('  █ covered    ▪ thin (under a third of that month\'s best)    ✗ empty    · not due yet\n');

  let totalHoles = 0, totalLeagues = 0;
  for (const [sport, list] of [...bySport].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\x1b[1m${sport}\x1b[0m`);
    console.log(`  ${''.padEnd(34)}${MONTHS.map((x) => ` ${x}`).join('')}`);
    for (const L of list) {
      totalLeagues++;
      const { season, holes } = assess(L);
      totalHoles += holes.length;
      for (const y of YEARS) {
        const label = y === YEARS[0] ? L.league.slice(0, 32) : '';
        const miss = holes.filter((h) => h.y === y).length;
        console.log(`  ${label.padEnd(32)}${String(y).padStart(2)}${strip(L, y, season)}` +
          (miss ? `   ${miss} missing` : ''));
      }
      for (const h of holes) {
        csv.push([sport, L.league, h.y, h.m, h.n, h.peak, h.kind].join(','));
      }
      console.log('');
    }
  }

  console.log('─'.repeat(72));
  console.log(`${totalLeagues} leagues examined, ${totalHoles} league-months missing or thin`);
  if (csvPath) {
    writeFileSync(csvPath, csv.join('\n') + '\n');
    console.log(`wrote ${csvPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
