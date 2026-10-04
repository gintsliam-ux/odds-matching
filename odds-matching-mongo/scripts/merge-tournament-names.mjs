// Fold the duplicate competition names in `gutsys_sport.fixtures`.
//
// Three passes, each independently selectable, all dry by default:
//
//   --names       one league id carrying two tournament strings  (51 ids)
//   --categories  one league id filed under two categories       (3 ids)
//   --ids         a competition whose optic_league itself changed (17 pairs)
//
// WHICH NAME WINS: the `leagues` row, because that is now what ingest writes.
//
// The sync used to take `tournament` from the Optic payload, so a rename
// upstream created a second row on the same league id. It now reads the stored
// `leagues` row instead and ignores the payload's name — which stops new splits
// but does nothing about the ones already on file, because a historical fixture
// is never touched again. Hence this backfill.
//
// Taking the target from `leagues.tournament` is what makes the two agree: any
// row ingest does happen to rewrite lands on exactly the name this script
// chose. An earlier version picked whichever name the feed had written most
// recently, which read the wrong direction for the big leagues depending on
// which batch had run last, and would have rewritten ten times as many rows.
//
// All 52 split ids that have a directory row have one that matches a name
// already in `fixtures`, and none names a third string — so this is a lookup,
// not a judgement. Ids with no directory row are skipped and reported.
//
// `odds` and `odds_sp` carry no league or tournament field, so none of this
// touches a price. The blast radius is `fixtures`, plus the `leagues`
// directory row for --ids.
//
// Usage:  node scripts/merge-tournament-names.mjs --names            dry run
//         node scripts/merge-tournament-names.mjs --names --apply
//         node scripts/merge-tournament-names.mjs --names --categories --apply

import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const WANT = {
  names: argv.includes('--names'),
  categories: argv.includes('--categories'),
  ids: argv.includes('--ids'),
  labels: argv.includes('--labels'),
};
if (!Object.values(WANT).some(Boolean)) {
  console.error('pick at least one pass: --names, --categories, --ids, --labels');
  process.exit(1);
}

/* Names that are not a variant of anything — just wrong, so no amount of
   merging reaches them.
 *
 *   "Nbl1" / "Wnbl1"  the id title-cased, where the league is an acronym
 *   "Boxing" with category "Boxing Matches"  a competition name in a place field
 *   "Matches"         says nothing at all
 *
 * The two boxing ids are the same competition either side of an id change
 * (`boxing_boxing` stops 2026-09-05, `boxing_boxing_matches` starts 09-19), so
 * they are given the SAME label here. That is worth doing before the ids are
 * merged rather than after: it makes the sidebar correct immediately, and it
 * makes the eventual merge a no-op as far as display is concerned.
 *
 * Written to `leagues` first and then to `fixtures`, because the directory is
 * what ingest reads — fixing only the fixtures gets quietly undone, which is
 * how the Estonian categories came back. */
const LABELS = {
  basketball_nbl1:       { tournament: 'NBL1' },
  basketball_wnbl1:      { tournament: 'WNBL1' },
  boxing_boxing:         { tournament: 'Boxing', category: 'International' },
  boxing_boxing_matches: { tournament: 'Boxing', category: 'International' },
};

async function passLabels(d) {
  const fixtures = d.collection('fixtures');
  const leagues = d.collection('leagues');
  console.log(`\n── labels ──  ${Object.keys(LABELS).length} leagues renamed at the directory, then backfilled${tag()}\n`);

  let rows = 0;
  for (const [league, want] of Object.entries(LABELS)) {
    const row = await leagues.findOne({ optic_league: league });
    const need = Object.entries(want).filter(([k, v]) => !row || row[k] !== v);
    const wrong = await fixtures.countDocuments({
      optic_league: league,
      $or: Object.entries(want).map(([k, v]) => ({ [k]: { $ne: v } })),
    });

    console.log(`${league}`);
    for (const [k, v] of Object.entries(want)) {
      const from = row ? row[k] : '(no row)';
      console.log(`   ${k.padEnd(11)} ${JSON.stringify(from)} → ${JSON.stringify(v)}` +
        (need.some(([nk]) => nk === k) ? '' : '   (already correct)'));
    }
    console.log(`   ${wrong} fixtures to update`);
    rows += wrong;

    if (APPLY) {
      await leagues.updateOne({ optic_league: league }, { $set: want });
      await fixtures.updateMany({ optic_league: league }, { $set: want });
    }
    console.log('');
  }
  console.log(`${rows} fixtures ${APPLY ? 'relabelled' : 'would be relabelled'}`);
}

const DORMANT_DAYS = 7;
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const tag = () => (APPLY ? '' : '  [dry run]');

/* A bucket league carries a different event name per week by design — tennis
   Challengers, golf tournaments — so many names is not a duplicate.
   `leagues.event_per_fixture` now says so explicitly, which beats counting
   names: `golf_liv` has only two events on file and no count can tell it apart
   from a league renamed once. The count stays as the fallback for rows not
   carrying the flag yet (233 of 642 do). */
const BUCKET_NAMES = 3;

/* The name count alone is not enough. `golf_liv` carries only two names in a
   window — "Indianapolis 2026" and "New York 2026" — and they are two different
   tournaments, so merging on count would have destroyed both. A pair only
   merges when the two strings are variants OF EACH OTHER: the same words once
   the category prefix and the filler are gone, or near-identical spelling, or
   one wholly inside the other. */
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const slug = (s) => deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };
const FILLER = new Set(['the', 'of', 'and', 'league', 'div', 'division', 'liga',
  'championship', 'cup', 'tournament', 'series', 'season', 'men', 'mens']);

function core(s, category) {
  let t = String(s || '');
  const cat = String(category || '').trim();
  if (cat) {
    const rx = new RegExp(`^\\s*${cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—:]?\\s*`, 'i');
    t = t.replace(rx, '');
  }
  const w = slug(t).split(' ').filter(Boolean).map((x) => ROMAN[x] ?? x);
  const kept = w.filter((x) => !FILLER.has(x));
  return kept.length ? kept : w;
}

function sameCompetition(a, b, category) {
  const ca = core(a, category), cb = core(b, category);
  if (!ca.length || !cb.length) return false;
  const A = new Set(ca), B = new Set(cb);
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  const j = hit / (A.size + B.size - hit);
  if (j === 1) return true;

  const sa = ca.join(' '), sb = cb.join(' ');
  if ((sa.includes(sb) || sb.includes(sa)) && Math.min(sa.length, sb.length) >= 6) return true;

  /* Edit distance on the squashed strings, for a glued word or a typo. */
  const x = sa.replace(/ /g, ''), y = sb.replace(/ /g, '');
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let k = 1; k <= y.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (x[i - 1] === y[k - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length) >= 0.88;
}

/* ------------------------------------------------------------------- names */

async function pickNames(d) {
  const groups = await d.collection('fixtures').aggregate([
    { $match: { tournament: { $ne: null }, optic_league: { $ne: null } } },
    {
      $group: {
        _id: { lg: '$optic_league', t: '$tournament' },
        n: { $sum: 1 },
        updated: { $max: '$updated_at' },
        maxStart: { $max: '$scheduled_start' },
        category: { $last: '$category' },
      },
    },
    {
      $group: {
        _id: '$_id.lg',
        names: { $push: { t: '$_id.t', n: '$n', updated: '$updated', maxStart: '$maxStart', category: '$category' } },
        k: { $sum: 1 },
      },
    },
    { $match: { k: { $gt: 1, $lte: BUCKET_NAMES } } },
  ], { allowDiskUse: true }).toArray();

  const now = Date.now();
  const rows = await d.collection('leagues')
    .find({}, { projection: { _id: 0, optic_league: 1, tournament: 1, event_per_fixture: 1 } })
    .toArray();
  const dir = new Map(rows.filter((r) => r.tournament).map((r) => [r.optic_league, r.tournament]));
  const buckets = new Set(rows.filter((r) => r.event_per_fixture).map((r) => r.optic_league));

  const orphans = [];
  const out = groups.map((g) => {
    if (buckets.has(g._id)) return null;          // declared one-event-per-fixture
    const want = dir.get(g._id);
    if (!want) { orphans.push(g); return null; }
    const keep = g.names.find((x) => x.t === want);
    if (!keep) { orphans.push(g); return null; }

    /* With a directory row in hand the string test is not just unnecessary, it
       is wrong: one league id IS one competition, so every other name on it is
       a variant whatever it looks like. The gate was rejecting six real merges
       — "Greek Super League" / "Greece - Super League" failed on a three-letter
       shared stem, and "Liga 1 Peru" / "Peru - Primera Division" share no words
       at all while being the same league. It stays only as a flag, so a pair
       that does not look alike is visible in the output rather than silent.
       Buckets are still excluded: by the name count, and by golf_liv having no
       directory row to merge toward in the first place. */
    const drop = g.names.filter((o) => o.t !== want).map((o) => ({
      ...o,
      unlike: !sameCompetition(keep.t, o.t, o.category ?? keep.category),
    }));
    const live = drop.some((o) =>
      (o.maxStart && o.maxStart > new Date()) ||
      (o.updated && now - new Date(o.updated).getTime() < DORMANT_DAYS * 864e5));
    return { league: g._id, keep, drop, live };
  }).filter((g) => g && g.drop.length).sort((a, b) => b.drop.reduce((t, x) => t + x.n, 0) - a.drop.reduce((t, x) => t + x.n, 0));

  if (orphans.length) {
    console.log(`\n   skipped — no \`leagues\` row to name the winner:`);
    for (const g of orphans) {
      console.log(`     ${g._id}  [${g.names.map((n) => n.t).join(' | ')}]`);
    }
  }
  return out;
}

async function passNames(d) {
  const groups = await pickNames(d);
  const fixtures = d.collection('fixtures');
  let moved = 0, dormant = 0, live = 0;

  console.log(`\n── names ──  ${groups.length} league ids carry more than one tournament name${tag()}\n`);
  for (const g of groups) {
    const total = g.drop.reduce((t, x) => t + x.n, 0);
    console.log(`${g.league}${g.live ? '   (STILL LIVE — will drift again)' : ''}`);
    console.log(`   keep  ${JSON.stringify(g.keep.t)}  ${g.keep.n} fixtures, written ${ymd(g.keep.updated)}`);
    for (const o of g.drop) {
      console.log(`   move  ${JSON.stringify(o.t)}  ${o.n} fixtures, last written ${ymd(o.updated)}` +
        (o.unlike ? '   (names do not resemble each other — directory is the only link)' : ''));
      if (APPLY) {
        const r = await fixtures.updateMany(
          { optic_league: g.league, tournament: o.t },
          { $set: { tournament: g.keep.t } },
        );
        if (r.modifiedCount !== o.n) {
          console.log(`         ! expected ${o.n}, modified ${r.modifiedCount}`);
        }
      }
    }
    moved += total;
    g.live ? live++ : dormant++;
    console.log('');
  }
  console.log(`${moved} fixtures ${APPLY ? 'renamed' : 'would be renamed'} across ${groups.length} competitions`);
  /* `live` means the losing name still has recent or future fixtures. Since
     ingest reads the `leagues` row now, those get rewritten to the same name
     this script picks the next time they are touched — so it is a note about
     overlap, not a warning. */
  console.log(`  ${dormant} are pure archive; ${live} also have live rows that ingest will rewrite to the same name`);
}

/* -------------------------------------------------------------- categories */

/* Which multi-category ids are safe to touch.

   Only the ones where both candidates are PLACES and the league id settles
   which: `soccer_estonia_esiliiga` is Estonian however many of its rows say
   Finland. Everything else in this bucket is the feed changing its mind about
   what a category is for — it is now writing "MLB", "WNBA" and "UEFA" where it
   used to write "USA" and "International", which reverses the rule that a
   category is a real place. Rewriting 5,133 MLB fixtures to category "MLB"
   would bake that reversal into the archive, so those are reported, never
   applied. Add an id here once you have decided it is a genuine misfiling. */
const CATEGORY_FIXES = new Set([
  'soccer_estonia_esiliiga',
  'soccer_estonia_esiliiga_b',
  'soccer_estonia_meistriliiga_women',
]);

/* Some ids are wrong under their ONLY category, so there is no disagreement to
   detect — `soccer_estonia_meistriliiga` is 112 fixtures all filed under
   Finland, and the pass above never sees it because it looks consistent. The
   Estonian top flight is not played in Finland, so these are named outright.
   Keyed by id, applied whatever the current value is. */
const CATEGORY_OVERRIDES = {
  soccer_estonia_meistriliiga: 'Estonia',
  soccer_estonia_esiliiga: 'Estonia',
  soccer_estonia_esiliiga_b: 'Estonia',
  soccer_estonia_meistriliiga_women: 'Estonia',
};

async function passCategories(d) {
  const groups = await d.collection('fixtures').aggregate([
    { $match: { optic_league: { $ne: null }, category: { $ne: null } } },
    { $group: { _id: { lg: '$optic_league', c: '$category' }, n: { $sum: 1 }, updated: { $max: '$updated_at' } } },
    { $group: { _id: '$_id.lg', cats: { $push: { c: '$_id.c', n: '$n', updated: '$updated' } }, k: { $sum: 1 } } },
    { $match: { k: { $gt: 1 } } },
  ], { allowDiskUse: true }).toArray();

  const fixtures = d.collection('fixtures');
  const act = groups.filter((g) => CATEGORY_FIXES.has(g._id));
  const report = groups.filter((g) => !CATEGORY_FIXES.has(g._id));

  console.log(`\n── categories ──  ${groups.length} league ids filed under more than one category${tag()}`);
  console.log(`   ${act.length} will be fixed; ${report.length} are the feed's own convention change — reported only\n`);

  for (const g of report) {
    const sorted = g.cats.slice().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    console.log(`   (report) ${g._id}: now writing ${JSON.stringify(sorted[0].c)} (${sorted[0].n}), was ` +
      sorted.slice(1).map((c) => `${JSON.stringify(c.c)} (${c.n})`).join(', '));
  }
  if (report.length) console.log('');

  let moved = 0;

  for (const [league, want] of Object.entries(CATEGORY_OVERRIDES)) {
    const wrong = await fixtures.countDocuments({ optic_league: league, category: { $ne: want } });
    if (!wrong) continue;
    console.log(`${league}`);
    console.log(`   set category to ${JSON.stringify(want)} on ${wrong} fixtures that disagree`);
    moved += wrong;
    if (APPLY) {
      await fixtures.updateMany(
        { optic_league: league, category: { $ne: want } },
        { $set: { category: want } },
      );
    }
    console.log('');
  }

  for (const g of act) {
    if (CATEGORY_OVERRIDES[g._id]) continue;   // already named outright above
    /* Freshest write wins, the same rule the names pass uses — and for the same
       reason: the feed is the thing that will overwrite whatever we choose.

       Matching the league id instead looks right and is not. `basketball_wnba`
       contains "wnba", so an id match keeps the category "WNBA" over "USA" and
       recategorises 626 fixtures to a league name rather than a country. The
       id tells you what the competition is called, never where it is played. */
    const keep = g.cats.slice().sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    const drop = g.cats.filter((c) => c.c !== keep.c);
    console.log(`${g._id}`);
    console.log(`   keep  ${JSON.stringify(keep.c)}  ${keep.n} fixtures, written ${ymd(keep.updated)}`);
    for (const o of drop) {
      console.log(`   move  ${JSON.stringify(o.c)}  ${o.n} fixtures`);
      moved += o.n;
      if (APPLY) {
        await fixtures.updateMany(
          { optic_league: g._id, category: o.c },
          { $set: { category: keep.c } },
        );
      }
    }
    console.log('');
  }
  console.log(`${moved} fixtures ${APPLY ? 'recategorised' : 'would be recategorised'}`);
}

/* ---------------------------------------------------------------------- ids */

/* Pairs confirmed by the audit: same sport, same teams, no overlapping days.
   The arrow points at the id the feed now writes. */
const ID_MERGES = [
  ['soccer_japan_j_league', 'soccer_japan_j1_league'],
  ['basketball_japan_b1', 'basketball_japan_b1_league'],
  ['soccer_chile_campeonato', 'soccer_chile_primera_division'],
  ['soccer_australia_aleague', 'soccer_australia_a_league'],
  ['basketball_nbl', 'basketball_australia_nbl'],
  ['soccer_ukraine_premier', 'soccer_ukraine_premier_league'],
  ['soccer_belarus_premier', 'soccer_belarus_premier_league'],
  ['soccer_costa_rica_primera', 'soccer_costa_rica_primera_division'],
  ['soccer_canada_premier', 'soccer_canada_premier_league'],
  ['icehockey_ahl', 'icehockey_usa_ahl'],
  ['aussierules_aflw', 'aussierules_australia_afl_women'],
  ['soccer_south_africa_premier', 'soccer_south_africa_premier_league'],
  ['soccer_paraguay_primera', 'soccer_paraguay_primera_division'],
  ['soccer_hungary_nb1', 'soccer_hungary_nb_i'],
  ['soccer_croatia_1hnl', 'soccer_croatia_1_hnl'],
  ['soccer_venezuela_primera', 'soccer_venezuela_primera_division'],
  ['soccer_uruguay_primera', 'soccer_uruguay_primera_division'],
];

async function passIds(d) {
  const fixtures = d.collection('fixtures');
  const leagues = d.collection('leagues');
  console.log(`\n── ids ──  ${ID_MERGES.length} competitions whose optic_league changed${tag()}`);
  console.log('   NOTE: optic_league is the page\'s URL slug, so an existing deep link to the');
  console.log('   old id stops resolving. `odds`/`odds_sp` carry no league field and are untouched.\n');

  let moved = 0;
  for (const [from, to] of ID_MERGES) {
    const n = await fixtures.countDocuments({ optic_league: from });
    const m = await fixtures.countDocuments({ optic_league: to });
    const dir = await leagues.findOne({ optic_league: to });
    console.log(`${from}  ->  ${to}`);
    console.log(`   ${n} fixtures move onto ${m} already there${dir ? '' : '   (no `leagues` row for the new id — will be copied)'}`);
    moved += n;
    if (APPLY) {
      await fixtures.updateMany({ optic_league: from }, { $set: { optic_league: to } });
      if (!dir) {
        const old = await leagues.findOne({ optic_league: from });
        if (old) {
          const { _id, ...rest } = old;
          await leagues.updateOne(
            { optic_league: to },
            { $set: { ...rest, optic_league: to } },
            { upsert: true },
          );
        }
      }
      await leagues.updateOne({ optic_league: from }, { $set: { active: false, superseded_by: to } });
    }
  }
  console.log(`\n${moved} fixtures ${APPLY ? 'moved' : 'would move'} onto the new ids`);
}

/* --------------------------------------------------------------------- run */

async function main() {
  const d = await db();
  if (!APPLY) {
    console.log('DRY RUN — nothing is written. Re-run with --apply to commit.');
  }
  if (WANT.names) await passNames(d);
  if (WANT.categories) await passCategories(d);
  if (WANT.ids) await passIds(d);
  if (WANT.labels) await passLabels(d);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
