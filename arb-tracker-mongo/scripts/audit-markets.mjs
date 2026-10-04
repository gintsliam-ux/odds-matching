// Structural audit of what the board actually serves, across every sport.
//
// Checks invariants rather than spot-reading fixtures, because every odds bug
// found today was a shape error that looked fine in one cell and only showed up
// as a contradiction across a market:
//
//   handicap lines must be opposite    Zverev -1.5 pairs with Djokovic +1.5,
//                                      never two -1.5s (the pivot's `line`
//                                      belongs to oc1 only).
//   totals lines must be identical     Over 2.5 pairs with Under 2.5. Negating
//                                      one would invent "Under -2.5".
//   a close needs a closed book        close_price must not be the current
//                                      price wearing a close's hat on a market
//                                      still being quoted.
//   no in-play prices                  this is a pre-match board; an `active`
//                                      price on a fixture that kicked off hours
//                                      ago is an in-play quote.
//   margins must be plausible          a two-way market summing to 60% or 198%
//                                      is not a generous book, it is a broken
//                                      row.
//
// Usage:
//   node scripts/audit-markets.mjs                 sample every sport
//   node scripts/audit-markets.mjs --per 10        fixtures per sport
//   node scripts/audit-markets.mjs tennis soccer   only these
//   node scripts/audit-markets.mjs --verbose       list every finding

import { apiFixtures, apiOddsForFixture, apiSports } from '../server/lib/sportApi.mjs';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const perIdx = argv.indexOf('--per');
const PER = perIdx >= 0 ? Number(argv[perIdx + 1]) : 6;
const only = argv.filter((a, i) => !a.startsWith('--') && i !== perIdx + 1);

/** Margins outside this are structurally wrong, not merely sharp or soft. */
const MARGIN_MIN = 98;
const MARGIN_MAX = 130;
/**
 * An exchange with no liquidity parks every outcome near its minimum price, so
 * both sides read ~1.01-1.05 and the "margin" comes out near 200%. That is an
 * empty market, not a mispriced one, and counting it as a structural fault
 * buries the real findings — 170 of them on the first run, every one Betfair.
 */
const EXCHANGES = new Set(['betfair', 'betfair_lay']);
const FLOOR = 1.10;

const findings = [];
const add = (sport, kind, detail) => findings.push({ sport, kind, detail });

const counts = {};
const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

const sports = only.length ? only : await apiSports();
console.log(`auditing ${sports.length} sports, up to ${PER} fixtures each\n`);

for (const sport of sports) {
  let fixtures = [];
  try {
    fixtures = await apiFixtures(sport);
  } catch (e) {
    add(sport, 'sport-failed', String(e.message).slice(0, 90));
    continue;
  }
  if (!fixtures.length) {
    bump('sports-empty');
    continue;
  }
  // Mix of played and upcoming: the close-price and in-play rules only bite on
  // one side of kickoff, so sampling only upcoming fixtures would miss them.
  const played = fixtures.filter((f) => f.status === 'completed' || f.status === 'live');
  const upcoming = fixtures.filter((f) => f.status === 'upcoming');
  const sample = [...upcoming.slice(0, Math.ceil(PER / 2)), ...played.slice(0, Math.floor(PER / 2))];

  for (const f of sample) {
    let rows = [];
    try {
      rows = await apiOddsForFixture(f.fixture_id, sport);
    } catch (e) {
      add(sport, 'fixture-failed', `${f.fixture_id}: ${String(e.message).slice(0, 70)}`);
      continue;
    }
    if (!rows.length) {
      bump('fixtures-no-odds');
      continue;
    }
    bump('fixtures-audited');
    bump('rows', rows.length);

    const started = new Date(f.scheduled_start).getTime() < Date.now();
    const where = `${f.home_team ?? f.event_name} v ${f.away_team ?? ''}`.trim();

    for (const r of rows) {
      // --- a close price implies a closed book -------------------------------
      if (r.close_price != null && r.status === 'active') {
        bump('close-on-active');
        add(sport, 'close-on-active', `${where} ${r.market_id} ${r.sportsbook} ${r.selection}: close=${r.close_price} while active`);
      }
      // --- pre-match board: no in-play quotes --------------------------------
      if (started && r.status === 'active' && r.current_at) {
        const after = new Date(r.current_at).getTime() - new Date(f.scheduled_start).getTime();
        if (after > 20 * 60_000) {
          bump('in-play-price');
          add(sport, 'in-play-price', `${where} ${r.market_id} ${r.sportsbook} ${r.selection}: quoted ${Math.round(after / 60000)}m after start @ ${r.current_price}`);
        }
      }
      if (r.current_price != null && !(r.current_price > 1)) {
        bump('bad-price');
        add(sport, 'bad-price', `${where} ${r.market_id} ${r.sportsbook} ${r.selection}: ${r.current_price}`);
      }
    }

    // --- market shape, per book per line -------------------------------------
    const groups = new Map();
    for (const r of rows) {
      if (r.is_lay) continue;
      const key = `${r.market_id}|${r.sportsbook}|${r.pair_key ?? r.line_group ?? 'x'}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
    }

    for (const [key, list] of groups) {
      const [market, book] = key.split('|');
      const handicap = /spread/.test(market);
      const total = /total/.test(market) && !/sets$/.test(market);
      const h2h = /moneyline/.test(market);

      if (handicap || total) {
        bump('two-way-groups');
        if (list.length === 1) {
          bump('one-sided');
          continue;
        }
        if (list.length !== 2) {
          bump('odd-group-size');
          add(sport, 'odd-group-size', `${where} ${key}: ${list.length} rows`);
          continue;
        }
        const [a, b] = list;
        if (a.line == null || b.line == null) {
          bump('line-missing');
          add(sport, 'line-missing', `${where} ${key}: lines ${a.line} / ${b.line}`);
        } else if (handicap && a.line !== -b.line) {
          bump('handicap-not-opposite');
          add(sport, 'handicap-not-opposite', `${where} ${key}: ${a.selection} ${a.line} vs ${b.selection} ${b.line}`);
        } else if (total && a.line !== b.line) {
          bump('total-lines-differ');
          add(sport, 'total-lines-differ', `${where} ${key}: ${a.selection} ${a.line} vs ${b.selection} ${b.line}`);
        }
      } else if (h2h) {
        bump('h2h-groups');
        // A 3-way market needs all three outcomes before its margin means
        // anything: two legs of a 1X2 sum to ~60% and look like a free lunch.
        const want = /3way/.test(market) ? 3 : 2;
        if (list.length < want) {
          bump(want === 3 ? 'h2h-3way-incomplete' : 'h2h-one-sided');
          continue;
        }
      } else {
        continue;
      }

      // --- margin -------------------------------------------------------------
      if (list.length < 2 || list.some((r) => !(r.current_price > 1))) continue;
      // Soccer's moneyline IS 1X2 at every period scope (moneyline, 1h_moneyline
      // …); two rows means one of the three outcomes is missing, not a two-way
      // market offering a free lunch.
      if (h2h && sport === 'soccer' && /(^|_)moneyline$/.test(market) && list.length === 2) {
        bump('h2h-3way-incomplete');
        continue;
      }
      const margin = list.reduce((s, r) => s + 1 / r.current_price, 0) * 100;
      const atFloor = EXCHANGES.has(book) && list.every((r) => r.current_price <= FLOOR);
      if (atFloor) {
        bump('exchange-floor');
        continue;
      }
      if (margin < MARGIN_MIN) {
        bump('margin-under-100');
        add(sport, 'margin-under-100', `${where} ${key}: ${margin.toFixed(1)}% — ${list.map((r) => `${r.selection} @ ${r.current_price}`).join(' / ')}`);
      } else if (margin > MARGIN_MAX) {
        bump('margin-implausible');
        add(sport, 'margin-implausible', `${where} ${key}: ${margin.toFixed(1)}%`);
      } else {
        bump('margin-ok');
      }
    }
  }
  process.stdout.write(`  ${sport} `);
}

console.log('\n\n================ TOTALS ================');
for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(24)} ${counts[k]}`);

console.log('\n================ FINDINGS ================');
const byKind = {};
for (const f of findings) (byKind[f.kind] ??= []).push(f);
if (!findings.length) console.log('  none');
for (const kind of Object.keys(byKind).sort()) {
  const list = byKind[kind];
  const sportsHit = [...new Set(list.map((f) => f.sport))];
  console.log(`\n  ${kind}: ${list.length}  (${sportsHit.join(', ')})`);
  for (const f of (VERBOSE ? list : list.slice(0, 4))) console.log(`     [${f.sport}] ${f.detail}`);
  if (!VERBOSE && list.length > 4) console.log(`     … ${list.length - 4} more (--verbose)`);
}
process.exit(0);
