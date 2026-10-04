// Find tournaments within one sport that are probably the same competition
// under two names.
//
// The page already merges a lot of this on its own: `groupCompetitions` keys on
// (category, tournament) after `cleanTournament`, which folds the
// "soccer_france_ligue_1 / soccer_france_ligue_one" kind of split. What this
// audit looks for is what SURVIVES that merge and still looks duplicated — the
// pairs a person would look at in the sidebar and say "those are the same
// thing".
//
// It deliberately does not decide anything. Two competitions can share a name
// and be genuinely different (Serie A is Brazil AND Italy), so every pair comes
// with the evidence needed to judge: fixture counts, date ranges, whether they
// ever ran on the same day, and how much their team rosters overlap. The
// strongest single signal is the last two together — same teams and never the
// same day means one replaced the other.
//
// Usage:  node scripts/audit-tournament-dupes.mjs
//         node scripts/audit-tournament-dupes.mjs soccer tennis
//         node scripts/audit-tournament-dupes.mjs --csv out.csv

import { writeFileSync } from 'node:fs';
import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const csvPath = (() => {
  const i = argv.indexOf('--csv');
  return i === -1 ? null : argv[i + 1];
})();
const onlySports = argv.filter((a) => !a.startsWith('--') && a !== csvPath);

/* ------------------------------------------------------------------ naming */

const deaccent = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/* The feed writes the same competition three ways: "La Liga", "Spain - La
   Liga", "Spain La Liga". Comparing raw names finds none of those, so strip the
   category off the front before comparing — but keep the original for display,
   because which spelling to keep is the user's call. */
function stripCategory(name, category) {
  let s = String(name || '');
  const cat = String(category || '').trim();
  if (cat) {
    const rx = new RegExp(`^\\s*${cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—:]?\\s*`, 'i');
    s = s.replace(rx, '');
  }
  return s.replace(/^\s*[-–—:]\s*/, '');
}

const slug = (s) =>
  deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* Words that carry no distinguishing information once the sport and category
   are already known. "England - Premier League" vs "Premier League" is the same
   competition; "Liga 1" vs "Liga I" is the same competition written in two
   numeral systems. */
const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };
const NOISE = new Set(['the', 'of', 'and', 'league', 'div', 'division', 'liga',
  'championship', 'cup', 'tournament', 'series', 'season', 'men', 'mens']);

function tokens(s) {
  return slug(s).split(' ').filter(Boolean).map((w) => ROMAN[w] ?? w);
}

/** Tokens minus the words that never distinguish two competitions. */
function core(s) {
  const t = tokens(s).filter((w) => !NOISE.has(w));
  return t.length ? t : tokens(s);
}

const setOf = (arr) => new Set(arr);
function jaccard(a, b) {
  const A = setOf(a), B = setOf(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / (A.size + B.size - hit);
}

/* Character-level similarity, for the cases token sets miss: a typo, a missing
   space, an abbreviation glued on ("Ligue1" / "Ligue 1"). */
function ratio(a, b) {
  const s = slug(a).replace(/ /g, ''), t = slug(b).replace(/ /g, '');
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length, n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/* ------------------------------------------------------------------- shapes */

/**
 * One row per (sport, optic_league, tournament, category), with the evidence a
 * judgement needs. Teams are capped: a competition's identity is clear from a
 * few hundred names and the full set would be most of `fixtures` in memory.
 */
async function competitions(sports) {
  const d = await db();
  const match = { tournament: { $ne: null } };
  if (sports.length) match.sport = { $in: sports };

  return d.collection('fixtures').aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          sport: '$sport',
          league: '$optic_league',
          tournament: '$tournament',
          category: '$category',
        },
        n: { $sum: 1 },
        first: { $min: '$scheduled_start' },
        last: { $max: '$scheduled_start' },
        days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$scheduled_start' } } },
        home: { $addToSet: '$home_team' },
        away: { $addToSet: '$away_team' },
      },
    },
    {
      $project: {
        _id: 0, n: 1, first: 1, last: 1,
        sport: '$_id.sport', league: '$_id.league',
        tournament: '$_id.tournament', category: '$_id.category',
        days: { $slice: ['$days', 400] },
        teams: { $slice: [{ $setUnion: ['$home', '$away'] }, 400] },
      },
    },
  ], { allowDiskUse: true }).toArray();
}

/* ------------------------------------------------------------------ compare */

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

/* Two traps that look exactly like a duplicate and are not.

   Gender: a women's competition shares its team names with the men's one almost
   perfectly — national sides are literally the same strings — so the team
   overlap signal reads 95% and points the wrong way. "UEFA - Nations League"
   against "Uefa Nations League Women" is two competitions, not one.

   Edition: tennis runs several Challenger weeks at one venue and numbers them,
   so "Phan Thiet 3, Vietnam" and "Phan Thiet 4, Vietnam" differ by a single
   character and share most of their draw. Names that differ ONLY in a number
   are different editions. */
const isWomens = (s) => /\b(women|womens|ladies|wta|w\b)/i.test(String(s || ''));
const dropDigits = (s) => slug(s).replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

function classify(a, b) {
  const an = stripCategory(a.tournament, a.category);
  const bn = stripCategory(b.tournament, b.category);

  if (isWomens(a.tournament) !== isWomens(b.tournament)) return null;
  if (slug(an) !== slug(bn) && dropDigits(an) === dropDigits(bn)) return null;

  if (slug(an) === slug(bn)) return { kind: 'same name', score: 1 };

  const ca = core(an), cb = core(bn);
  const j = jaccard(ca, cb);
  if (j === 1) return { kind: 'same words', score: 1 };

  const r = ratio(an, bn);
  if (r >= 0.88) return { kind: 'near-identical spelling', score: r };

  /* One name contained in the other — "League Two" inside "England - League 2".
     Only when the shorter side is substantial, or every two-word name in a
     sport matches every longer one. */
  const sa = ca.join(' '), sb = cb.join(' ');
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) {
    const shorter = Math.min(sa.length, sb.length);
    if (shorter >= 6) return { kind: 'one name inside the other', score: 0.8 };
  }

  if (j >= 0.6 && ca.length > 1 && cb.length > 1) return { kind: 'most words shared', score: j };
  return null;
}

function overlap(a, b) {
  const teams = jaccard(a.teams, b.teams);
  const sameDay = a.days.some((d) => b.days.includes(d));
  return { teams, sameDay };
}

/**
 * What the evidence says, in the same vocabulary the earlier cutover audit
 * used. Same teams and never the same day is a rename: one league id replaced
 * another. Same teams AND the same days is worse — both are being written, so
 * the fixtures are duplicated rather than migrated.
 */
function reading(o, a, b) {
  const t = Math.round(o.teams * 100);
  if (o.teams >= 0.6 && !o.sameDay) return `RENAME — ${t}% shared teams, never the same day`;
  if (o.teams >= 0.6 && o.sameDay) return `DUPLICATE COVERAGE — ${t}% shared teams, overlapping days`;
  if (o.teams >= 0.25) return `RELATED — ${t}% shared teams`;
  if (a.category && b.category && slug(a.category) !== slug(b.category)) {
    return `PROBABLY DISTINCT — different categories (${a.category} / ${b.category})`;
  }
  return `UNCLEAR — ${t}% shared teams`;
}

/* --------------------------------------------------------------------- run */

async function main() {
  const rows = await competitions(onlySports);
  console.log(`competitions on file: ${rows.length}${onlySports.length ? ` (${onlySports.join(', ')})` : ''}\n`);

  const bySport = new Map();
  for (const r of rows) {
    if (!bySport.has(r.sport)) bySport.set(r.sport, []);
    bySport.get(r.sport).push(r);
  }

  const found = [];
  for (const [sport, list] of [...bySport].sort((a, b) => b[1].length - a[1].length)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        // Two rows of the same league id are the split-name case the page
        // already merges; still worth listing, but they are never "distinct".
        const c = classify(a, b);
        if (!c) continue;
        const o = overlap(a, b);
        found.push({ sport, a, b, ...c, ...o, reading: reading(o, a, b) });
      }
    }
  }

  const rank = { 'DUPLICATE COVERAGE': 0, RENAME: 1, RELATED: 2, UNCLEAR: 3, 'PROBABLY DISTINCT': 4 };
  found.sort((x, y) => {
    const rx = rank[x.reading.split(' —')[0]] ?? 9, ry = rank[y.reading.split(' —')[0]] ?? 9;
    return rx - ry || y.score - x.score || (y.a.n + y.b.n) - (x.a.n + x.b.n);
  });

  for (const f of found) {
    const { a, b } = f;
    console.log(`${f.sport}  ·  ${f.kind}  ·  ${f.reading}`);
    console.log(`   A  ${a.tournament}${a.category ? `  [${a.category}]` : ''}`);
    console.log(`      ${a.league ?? '(no league id)'}   ${a.n} fixtures   ${ymd(a.first)} → ${ymd(a.last)}`);
    console.log(`   B  ${b.tournament}${b.category ? `  [${b.category}]` : ''}`);
    console.log(`      ${b.league ?? '(no league id)'}   ${b.n} fixtures   ${ymd(b.first)} → ${ymd(b.last)}`);
    console.log('');
  }

  const counts = found.reduce((m, f) => {
    const k = f.reading.split(' —')[0];
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  console.log('─'.repeat(72));
  console.log(`${found.length} candidate pairs`);
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  if (csvPath) {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['sport', 'kind', 'reading', 'team_overlap_pct', 'same_day',
      'a_tournament', 'a_category', 'a_league', 'a_fixtures', 'a_first', 'a_last',
      'b_tournament', 'b_category', 'b_league', 'b_fixtures', 'b_first', 'b_last'];
    const lines = [head.join(',')];
    for (const f of found) {
      lines.push([f.sport, f.kind, f.reading, Math.round(f.teams * 100), f.sameDay ? 'yes' : 'no',
        f.a.tournament, f.a.category, f.a.league, f.a.n, ymd(f.a.first), ymd(f.a.last),
        f.b.tournament, f.b.category, f.b.league, f.b.n, ymd(f.b.first), ymd(f.b.last),
      ].map(esc).join(','));
    }
    writeFileSync(csvPath, lines.join('\n') + '\n');
    console.log(`\nwrote ${csvPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
