// Restore `pair_key`, `outcome_no` and `line_group` on `odds_sp` rows written
// without them.
//
// A writer stopped setting the three fields together; every row written since
// roughly 9 October is missing all of them, 1.69M rows and climbing by ~32k a
// day. This backfills what is already on disk. It does NOT fix the writer — new
// rows keep arriving without them until that changes.
//
// Why these three matter: `pair_key` is the line signed from the HOME side, and
// it is the only thing that separates the two sides of a two-way market. Fall
// back to the raw `line` and a fixture's "home -1 / away +1" collapses into the
// same bucket as its "home +1 / away -1" — one group of four where there should
// be two clean pairs. That is why soccer handicaps around ±1 read wrong.
//
// The rule, read off 1.6M rows that still carry the fields:
//
//   pair_key    HANDICAPS: the line signed from home — home → line, away → -line,
//               because the away team's handicap is the mirror of the home
//               team's. TOTALS: the line as-is — Over 2.5 and Under 2.5 are
//               two sides of ONE line, not mirrored ones. Validation caught
//               this: negating totals disagreed with 29.6% of stored rows.
//   line_group  |line|,  or 99999 when the market has no line
//   outcome_no  home/over/yes → 1,  away/under/no → 2,  draw → 3
//
// `normalized_selection` usually carries home/away/draw/over/under/yes/no. On
// about half the affected rows it carries the TEAM NAME instead — "gunma crane
// thunders", "warta poznań" — and spread is the single biggest group of those,
// which is the case this whole exercise is about. Those are resolved against
// the fixture's own `home_team` / `away_team`, so the side is read from the
// fixture rather than guessed.
//
// Double chance names two outcomes at once ("chicago blackhawks or draw"). The
// stored convention is home-or-draw → 1, away-or-draw → 2, home-or-away → 3,
// so it resolves the same way once the team names are known.
//
// Anything still unreadable is SKIPPED, not guessed.
//
// Usage:  node scripts/backfill-pair-key.mjs              validate + dry run
//         node scripts/backfill-pair-key.mjs --apply

import { db, close } from './lib/entities.mjs';

const APPLY = process.argv.includes('--apply');
const BATCH = 2000;

/* The unlined convention, taken from the existing rows: a market with no line
   carries pair_key -99999 and line_group 99999 rather than null, so that a
   downstream group-by never sees a null key. */
const NO_LINE_PAIR = -99999;
const NO_LINE_GROUP = 99999;

const SIDE = {
  home: 1, over: 1, yes: 1,
  away: 2, under: 2, no: 2,
  draw: 3, tie: 3,
};

/* Team names arrive lowercased but otherwise untouched, accents and all, so
   comparison folds accents and strips anything that is not a letter or digit.
   "warta poznań" and "Warta Poznan" have to meet. */
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');

/**
 * Which side a selection is on, when `normalized_selection` is a team name.
 * `teams` is { home, away } already folded. Returns 1, 2, 3 or null.
 */
function sideFromTeams(ns, teams, marketId) {
  if (!teams) return null;
  const f = fold(ns);
  if (!f) return null;

  /* Double chance names two outcomes joined by "or": home-or-draw is 1,
     away-or-draw is 2, home-or-away is 3. */
  if (/double_chance/.test(marketId)) {
    const parts = String(ns).toLowerCase().split(/\s+or\s+/).map(fold).filter(Boolean);
    if (parts.length !== 2) return null;
    const hasHome = parts.some((x) => x === teams.home);
    const hasAway = parts.some((x) => x === teams.away);
    const hasDraw = parts.some((x) => x === 'draw');
    if (hasHome && hasDraw) return 1;
    if (hasAway && hasDraw) return 2;
    if (hasHome && hasAway) return 3;
    return null;
  }

  if (f === teams.home) return 1;
  if (f === teams.away) return 2;
  if (f === 'draw' || f === 'tie') return 3;
  return null;
}

/** null when the side cannot be read, which means the row must be skipped. */
function derive(row, teams = null) {
  const ns = String(row.normalized_selection ?? '').trim().toLowerCase();
  const outcome = SIDE[ns] ?? sideFromTeams(ns, teams, String(row.market_id ?? ''));
  if (!outcome) return null;

  /* Double chance stores outcome_no as null, not 1/2/3 — the writer never
     assigned a side to a two-outcome selection. Deriving one is arguably
     better, and is still the wrong thing to backfill: the job here is to
     restore what the writer would have written, not to introduce a second
     convention half the corpus does not follow. Validation is what surfaced
     this, at 0.258% disagreement. */
  if (/double_chance/.test(String(row.market_id ?? ''))) {
    return { pair_key: NO_LINE_PAIR, line_group: NO_LINE_GROUP, outcome_no: null };
  }

  const line = row.line;
  if (line == null) {
    return { pair_key: NO_LINE_PAIR, line_group: NO_LINE_GROUP, outcome_no: outcome };
  }
  /* Only a handicap mirrors. The away team's -1.5 IS the home team's +1.5, so
     the home-signed line is its negation and the two meet on one pair_key —
     which is the whole point of the field. A total does not work that way:
     Over 2.5 and Under 2.5 are two sides of the SAME 2.5, and negating the
     under side would split every total into two one-sided groups. */
  const mirrored = /spread|handicap/.test(String(row.market_id ?? ''));
  const pair = (mirrored && outcome === 2) ? -line : line;
  return { pair_key: pair, line_group: Math.abs(line), outcome_no: outcome };
}

/** fixture_id -> { home, away } folded, for the fixtures a batch touches. */
async function teamMap(SP, ids) {
  const F = SP.s.db.collection('fixtures');
  const out = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = await F.find({ fixture_id: { $in: ids.slice(i, i + 5000) } },
      { projection: { _id: 0, fixture_id: 1, home_team: 1, away_team: 1 } }).toArray();
    for (const f of rows) out.set(f.fixture_id, { home: fold(f.home_team), away: fold(f.away_team) });
  }
  return out;
}

async function validate(SP) {
  /* Derive against rows that still HAVE the fields and check the rule
     reproduces them exactly. If it cannot, the rule is wrong and nothing
     should be written. */
  const sample = await SP.aggregate([
    { $match: { pair_key: { $exists: true } } },
    { $sample: { size: 60000 } },
    { $project: { pair_key: 1, outcome_no: 1, line_group: 1, line: 1, normalized_selection: 1, market_id: 1, fixture_id: 1 } },
  ], { allowDiskUse: true }).toArray();
  const teams = await teamMap(SP, [...new Set(sample.map((r) => r.fixture_id))]);

  let checked = 0, skipped = 0;
  const wrong = { pair_key: 0, outcome_no: 0, line_group: 0 };
  const examples = [];
  for (const r of sample) {
    const got = derive(r, teams.get(r.fixture_id));
    if (!got) { skipped++; continue; }
    checked++;
    let bad = false;
    for (const f of ['pair_key', 'outcome_no', 'line_group']) {
      if (r[f] !== got[f]) { wrong[f]++; bad = true; }
    }
    if (r.pair_key !== got.pair_key && examples.length < 6) examples.push({ r, got });
  }

  console.log(`\nvalidation against ${sample.length.toLocaleString()} rows that still carry the fields`);
  console.log(`  derivable        ${checked.toLocaleString()}`);
  console.log(`  not derivable    ${skipped.toLocaleString()}   (normalized_selection is not a side)`);
  for (const f of ['pair_key', 'outcome_no', 'line_group']) {
    const pct = checked ? (wrong[f] / checked * 100).toFixed(3) : '0';
    console.log(`  ${f.padEnd(12)} mismatched ${String(wrong[f]).padStart(6)}   ${pct}%`);
  }
  for (const e of examples) {
    console.log(`     line=${e.r.line} ns=${e.r.normalized_selection} market=${e.r.market_id}` +
      `  stored pair=${e.r.pair_key}/out=${e.r.outcome_no}/grp=${e.r.line_group}` +
      `  derived pair=${e.got.pair_key}/out=${e.got.outcome_no}/grp=${e.got.line_group}`);
  }
  return { checked, wrong };
}

async function main() {
  const d = await db();
  const SP = d.collection('odds_sp');

  const { checked, wrong } = await validate(SP);
  const worst = Math.max(...Object.values(wrong));
  if (!checked || worst / checked > 0.001) {
    console.log('\nSTOP: the rule does not reproduce the stored fields. Nothing written.');
    return;
  }
  console.log('\nrule reproduces the stored fields — safe to apply to the rows that lack them');

  /* Any of the three, not just pair_key. The writer was fixed to set pair_key
     and outcome_no but still omits line_group, so a pair_key-only filter walks
     straight past rows that are missing one field out of three. */
  const MISSING = {
    $or: [
      { pair_key: { $exists: false } },
      { outcome_no: { $exists: false } },
      { line_group: { $exists: false } },
    ],
  };

  const cursor = SP.find(MISSING,
    { projection: { _id: 1, line: 1, normalized_selection: 1, market_id: 1, fixture_id: 1 } });

  let seen = 0, fixable = 0, skipped = 0, written = 0;
  let buf = [];

  /* Rows are buffered so one fixtures lookup serves a whole batch — resolving
     the home side per row would be a query per row. */
  const flush = async () => {
    if (!buf.length) return;
    const teams = await teamMap(SP, [...new Set(buf.map((r) => r.fixture_id))]);
    const ops = [];
    for (const row of buf) {
      const got = derive(row, teams.get(row.fixture_id));
      if (!got) { skipped++; continue; }
      fixable++;
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: got } } });
    }
    if (APPLY && ops.length) {
      const r = await SP.bulkWrite(ops, { ordered: false });
      written += r.modifiedCount;
    }
    buf = [];
  };

  for await (const row of cursor) {
    seen++;
    buf.push(row);
    if (buf.length >= BATCH) {
      await flush();
      if (fixable % 200000 < BATCH) {
        console.log(`  ${seen.toLocaleString()} seen, ${fixable.toLocaleString()} derived${APPLY ? `, ${written.toLocaleString()} written` : ''}…`);
      }
    }
  }
  await flush();

  console.log(`\nrows missing any of the three   ${seen.toLocaleString()}`);
  console.log(`  derivable               ${fixable.toLocaleString()}`);
  console.log(`  not derivable, skipped  ${skipped.toLocaleString()}`);
  console.log(APPLY ? `  written                 ${written.toLocaleString()}`
    : '\n  dry run — re-run with --apply to write.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
