// Competitions whose optic_league changed mid-stream, leaving the history on
// the dead id.
//
// The signature is a stop and a start: one id's last fixture, then another's
// first, within a season break, with the same teams on both sides. That is a
// better detector than name similarity — it is what caught
// `soccer_efl_champ` → `soccer_england_championship`, whose names share
// nothing.
//
// Four classes of look-alike clear every one of those tests while being
// genuinely different competitions, and each cost a false positive before it
// was filtered out:
//
//   cup into league      Copa do Brasil ends, Série A begins — same clubs, same
//                        country, adjacent weeks
//   women's into men's   Coppa Italia into Serie A Femminile; national sides
//                        share their names exactly, so team overlap reads 100%
//   qualifier into final World Cup Qualifiers into the World Cup
//   format into format   FIBA 3x3 against FIBA 5x5; NBB (national) against
//                        BB Paulista (state)
//
// The first three are rules. The fourth is not, and pretending otherwise made
// things worse: dropping the sport prefix from the token comparison does reject
// NBB-vs-Paulista, but it also rejects eight genuine renames where the country
// holds and the name changes completely — Chile Campeonato into Primera
// División, Spain Segunda División into La Liga 2. Structurally those are
// indistinguishable from a national league sitting beside a state one. So the
// two that no rule catches are named here instead, with a reason, rather than
// bought at the price of eight false negatives.
//
// Usage:  node scripts/audit-stranded-ids.mjs
//         node scripts/audit-stranded-ids.mjs --all     include the rejects
//         node scripts/audit-stranded-ids.mjs --csv out.csv

import { writeFileSync } from 'node:fs';
import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const SHOW_ALL = argv.includes('--all');
const csvPath = (() => { const i = argv.indexOf('--csv'); return i === -1 ? null : argv[i + 1]; })();

const DAY = 864e5;
const MAX_GAP_DAYS = 90;
const MIN_TEAM_OVERLAP = 0.6;
const MIN_ID_OVERLAP = 0.6;

/* Shared teams is the strongest evidence a rename happened — and it is simply
   unavailable for some leagues, which made the detector blind rather than
   cautious.
 *
 * Individual sports have no recurring competitors: boxing runs 687 distinct
 * fighters across 985 fixtures, so two boxing ids share almost no names however
 * certainly one replaced the other. And 112 leagues have fewer than four teams
 * on file at all. Both fell below the gate and were never reported — which is
 * how `boxing_boxing` → `boxing_boxing_matches` and the two SANFL ids went
 * missing from a list whose whole job was to find them.
 *
 * So where team overlap cannot speak, fall back to the ids alone — but demand a
 * much closer match, and label the pair so it is read as the weaker evidence it
 * is. */
const INDIVIDUAL = new Set(['boxing', 'mma', 'tennis', 'darts', 'golf']);
const MIN_TEAMS_TO_JUDGE = 4;
const MIN_ID_OVERLAP_ALONE = 0.8;

/* Tokens that identify a competition, minus the sport prefix every id in that
   sport shares and the two-letter fragments that carry no meaning. */
function idTokens(id) {
  return new Set(id.split('_').filter((w) => w.length > 2));
}

/* Pairs that clear every structural test and are still two competitions.
   Checked by hand; each needs a reason, not just an entry. */
const NOT_A_RENAME = new Map([
  ['basketball_brazil_nbb|basketball_brazil_bb_paulista',
    'NBB is the national league, BB Paulista a state one — both still running'],
  ['darts_pdc_world_series_of_darts|darts_pdc_world_grand_prix',
    'two separate PDC events, not one renamed'],
]);

const overlap = (A, B) => {
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
};

const isWomens = (id) => /women|womens|femminile|ladies|wnbl|nrlw|aflw|wsl|feminin/.test(id);
const isCup = (id) => /(^|_)(cup|copa|pokal|trophy|shield|commissioners)(_|$)/.test(id);
const isQualifier = (id) => /qual/.test(id);
const is3x3 = (id) => /3x3/.test(id);

/** Why a candidate was rejected, or null if it stands. */
function reject(a, b) {
  const named = NOT_A_RENAME.get(`${a.id}|${b.id}`) ?? NOT_A_RENAME.get(`${b.id}|${a.id}`);
  if (named) return named;
  if (isWomens(a.id) !== isWomens(b.id)) return "one is women's";
  if (isCup(a.id) !== isCup(b.id)) return 'one is a cup, one a league';
  if (isQualifier(a.id) !== isQualifier(b.id)) return 'one is the qualifying round';
  if (is3x3(a.id) !== is3x3(b.id)) return 'different format (3x3 / 5x5)';
  return null;
}

async function main() {
  const d = await db();
  const rows = await d.collection('fixtures').aggregate([
    { $match: { optic_league: { $ne: null }, scheduled_start: { $ne: null } } },
    {
      $group: {
        _id: { l: '$optic_league', s: '$sport' },
        n: { $sum: 1 },
        min: { $min: '$scheduled_start' },
        max: { $max: '$scheduled_start' },
        teams: { $addToSet: '$home_team' },
        cats: { $addToSet: '$category' },
      },
    },
  ], { allowDiskUse: true }).toArray();

  const bySport = new Map();
  for (const r of rows) {
    const L = {
      id: r._id.l, sport: r._id.s, n: r.n, min: r.min, max: r.max,
      teams: new Set(r.teams.filter(Boolean)),
      cats: new Set(r.cats.filter(Boolean)),
    };
    if (!bySport.has(L.sport)) bySport.set(L.sport, []);
    bySport.get(L.sport).push(L);
  }

  const kept = [], dropped = [];
  for (const [sport, list] of bySport) {
    for (const a of list) for (const b of list) {
      if (a.id >= b.id) continue;
      const [from, to] = a.max <= b.max ? [a, b] : [b, a];
      if (to.min < from.max) continue;                               // they overlap
      const gap = (to.min - from.max) / DAY;
      if (gap > MAX_GAP_DAYS) continue;
      const ids = overlap(idTokens(from.id), idTokens(to.id));
      const canJudgeTeams = !INDIVIDUAL.has(sport)
        && from.teams.size >= MIN_TEAMS_TO_JUDGE && to.teams.size >= MIN_TEAMS_TO_JUDGE;

      let teams = null;
      if (canJudgeTeams) {
        teams = overlap(to.teams, from.teams);
        if (teams < MIN_TEAM_OVERLAP) continue;
        if (ids < MIN_ID_OVERLAP) { dropped.push({ sport, from, to, why: 'ids are not variants' }); continue; }
      } else if (ids < MIN_ID_OVERLAP_ALONE) {
        continue;                                    // ids alone, and not close enough
      } else if (from.cats.size && to.cats.size
                 && ![...from.cats].some((c) => to.cats.has(c))) {
        /* Without shared competitors the ids carry the whole argument, and a
           short id wins that argument far too easily: `soccer_fa_cup` reduces
           to {soccer, cup}, which sits inside Belgium's, Bangladesh's and
           Spain's cups alike. Two leagues played in different places are
           different competitions, whatever their ids share. */
        continue;
      }

      const why = reject(from, to);
      const hit = {
        sport, from, to, gap: Math.round(gap),
        teams: teams === null ? null : Math.round(teams * 100),
        evidence: canJudgeTeams ? 'teams' : 'ids only',
        why,
      };
      (why ? dropped : kept).push(hit);
    }
  }

  /* Team-verified pairs are a list to act on. Ids-only pairs are a list to
     read: the fallback is what surfaced boxing at all, and also what proposed
     merging New Zealand's NBL into Uganda's, so it is reported apart rather
     than trusted the same way. */
  const confirmed = kept.filter((p) => p.evidence === 'teams');
  const review = kept.filter((p) => p.evidence !== 'teams');

  confirmed.sort((x, y) => y.from.n - x.from.n);
  review.sort((x, y) => y.from.n - x.from.n);
  console.log(`${confirmed.length} stranded pairs, confirmed by shared teams\n`);
  for (const p of confirmed) {
    console.log(`  ${p.sport.padEnd(12)}${p.from.id.padEnd(38)}${String(p.from.n).padStart(5)}  ends ${p.from.max.toISOString().slice(0, 10)}`);
    console.log(`  ${''.padEnd(12)}└→ ${p.to.id.padEnd(35)}${String(p.to.n).padStart(5)}  from ${p.to.min.toISOString().slice(0, 10)}   ${p.gap}d, ` +
      (p.teams === null ? 'no shared competitors to check — ids only' : `${p.teams}% same teams`));
  }
  console.log(`\n${confirmed.reduce((t, p) => t + p.from.n, 0)} fixtures would move`);

  if (review.length) {
    console.log(`\n${review.length} more where no competitor recurs, so only the ids agree — read before acting:`);
    for (const p of review) {
      console.log(`  ${p.from.id} (${p.from.n}) → ${p.to.id} (${p.to.n})   ${p.gap}d apart`);
    }
  }

  const named = dropped.filter((p) => p.why && p.why !== 'ids are not variants');
  if (named.length) {
    console.log(`\nrejected as different competitions (${named.length}):`);
    for (const p of named) {
      console.log(`  ${p.from.id} → ${p.to.id}   ${p.why}`);
    }
  }
  if (SHOW_ALL) {
    const weak = dropped.filter((p) => p.why === 'ids are not variants');
    console.log(`\nrejected because the ids are not variants (${weak.length}):`);
    for (const p of weak) console.log(`  ${p.from.id} → ${p.to.id}`);
  }

  if (csvPath) {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const out = [['sport', 'from_id', 'from_fixtures', 'from_last', 'to_id', 'to_fixtures', 'to_first', 'gap_days', 'team_overlap_pct', 'evidence'].join(',')];
    for (const p of [...confirmed, ...review]) {
      out.push([p.sport, p.from.id, p.from.n, p.from.max.toISOString().slice(0, 10),
        p.to.id, p.to.n, p.to.min.toISOString().slice(0, 10), p.gap, p.teams ?? '', p.evidence].map(esc).join(','));
    }
    writeFileSync(csvPath, out.join('\n') + '\n');
    console.log(`\nwrote ${csvPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
