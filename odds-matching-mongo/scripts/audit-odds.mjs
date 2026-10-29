// A read-only sweep of `odds_sp` and `odds` for anything that looks wrong with
// a price, a fair value, or the fields that say how prices pair up.
//
// Nothing here writes. Counts are exact unless a check says it sampled.
//
// Usage:  node scripts/audit-odds.mjs
//         node scripts/audit-odds.mjs --json report.json

import { writeFileSync } from 'node:fs';
import { db, close } from './lib/entities.mjs';

const argv = process.argv.slice(2);
const jsonPath = (() => { const i = argv.indexOf('--json'); return i === -1 ? null : argv[i + 1]; })();

const report = {};
const head = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n${'─'.repeat(n.length)}`);
const line = (k, v, note = '') => console.log(`  ${String(v).padStart(10)}  ${k}${note ? `   ${note}` : ''}`);
const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)}%` : '—');

async function main() {
  const d = await db();
  const SP = d.collection('odds_sp');
  const OD = d.collection('odds');

  const spTotal = await SP.estimatedDocumentCount();
  const odTotal = await OD.estimatedDocumentCount();

  /* ------------------------------------------------- pairing fields */
  head('1. The fields that say how prices pair up');

  /* `pair_key` is the line signed from the HOME side and is the only thing
     that separates the two sides of a two-way market correctly. Without it a
     consumer falls back to `line_group`, then to the raw `line` — which folds
     "home -1 / away +1" together with "home +1 / away -1" into one bucket of
     four rows where there should be two clean pairs.

     Counted in ONE pass. Ten separate countDocuments over 9.5M rows with
     $exists:false cannot use an index and each one is a full scan; the first
     version of this script was still running after twelve minutes. */
  const cut = new Date(Date.now() - 864e5);
  const [tally] = await SP.aggregate([
    {
      $group: {
        _id: null,
        rows: { $sum: 1 },
        noPair: { $sum: { $cond: [{ $eq: [{ $type: '$pair_key' }, 'missing'] }, 1, 0] } },
        noOutcome: { $sum: { $cond: [{ $eq: [{ $type: '$outcome_no' }, 'missing'] }, 1, 0] } },
        noGroup: { $sum: { $cond: [{ $eq: [{ $type: '$line_group' }, 'missing'] }, 1, 0] } },
        noNOut: { $sum: { $cond: [{ $eq: [{ $type: '$n_outcomes' }, 'missing'] }, 1, 0] } },
        noNorm: { $sum: { $cond: [{ $eq: [{ $type: '$normalized_selection' }, 'missing'] }, 1, 0] } },
        recentWith: { $sum: { $cond: [{ $and: [{ $gte: ['$computed_at', cut] }, { $ne: [{ $type: '$pair_key' }, 'missing'] }] }, 1, 0] } },
        recentWithout: { $sum: { $cond: [{ $and: [{ $gte: ['$computed_at', cut] }, { $eq: [{ $type: '$pair_key' }, 'missing'] }] }, 1, 0] } },
        won: { $sum: { $cond: [{ $in: ['$won', [true, false]] }, 1, 0] } },
        wonNull: { $sum: { $cond: [{ $eq: ['$won', null] }, 1, 0] } },
        emptyPrices: { $sum: { $cond: [{ $eq: [{ $size: { $objectToArray: { $ifNull: ['$book_prices', {}] } } }, 0] }, 1, 0] } },
      },
    },
  ], { allowDiskUse: true }).toArray();

  for (const [label, v] of [['pair_key', tally.noPair], ['outcome_no', tally.noOutcome],
    ['line_group', tally.noGroup], ['n_outcomes', tally.noNOut], ['normalized_selection', tally.noNorm]]) {
    line(`odds_sp missing ${label}`, v, pct(v, tally.rows));
  }
  line('written in the last 24h WITH pair_key', tally.recentWith);
  line('written in the last 24h WITHOUT it', tally.recentWithout,
    tally.recentWithout && !tally.recentWith ? '← every new row is missing it' : '');

  report.pairing = {
    rows: tally.rows, noPair: tally.noPair, noOutcome: tally.noOutcome, noGroup: tally.noGroup,
    noNOutcomes: tally.noNOut, noNormalized: tally.noNorm,
    recentWith: tally.recentWith, recentWithout: tally.recentWithout,
  };

  /* ------------------------------------------------------ price sanity */
  head('2. Prices that cannot be right');

  /* Decimal odds below 1.01 pay less than the stake back. Above a few hundred
     they are either a placeholder or a misparse. Checked across the jsonb maps
     rather than a single column, so this walks a sample. */
  const sample = await SP.aggregate([
    { $sample: { size: 200000 } },
    { $project: { book_prices: 1, book_fairs: 1, fair_blend: 1, fair_prob: 1, n_books: 1, market_id: 1, sport: 1 } },
  ], { allowDiskUse: true }).toArray();

  let belowOne = 0, absurd = 0, nonNumeric = 0, emptyPrices = 0;
  let fairBelowPrice = 0, fairPairs = 0;
  let probOutOfRange = 0, blendMismatch = 0;
  for (const r of sample) {
    const prices = Object.values(r.book_prices || {});
    if (!prices.length) emptyPrices++;
    for (const v of prices) {
      if (typeof v !== 'number' || Number.isNaN(v)) { nonNumeric++; continue; }
      if (v < 1.01) belowOne++;
      if (v > 1000) absurd++;
    }
    /* Removing vig can only lengthen a price: the fair must be >= the quoted
       price, or the vig was negative. A tiny tolerance absorbs rounding. */
    for (const [book, price] of Object.entries(r.book_prices || {})) {
      const fair = (r.book_fairs || {})[book];
      if (typeof price === 'number' && typeof fair === 'number') {
        fairPairs++;
        if (fair < price - 1e-6) fairBelowPrice++;
      }
    }
    if (r.fair_prob != null && (r.fair_prob <= 0 || r.fair_prob >= 1)) probOutOfRange++;
    /* fair_prob should be 1/fair_blend. */
    if (r.fair_blend != null && r.fair_prob != null && r.fair_blend > 0) {
      if (Math.abs(1 / r.fair_blend - r.fair_prob) > 0.005) blendMismatch++;
    }
  }
  report.prices = { sampled: sample.length, belowOne, absurd, nonNumeric, emptyPrices, fairBelowPrice, fairPairs, probOutOfRange, blendMismatch };
  line('rows sampled', sample.length);
  line('book prices below 1.01', belowOne);
  line('book prices above 1000', absurd);
  line('book prices not a number', nonNumeric);
  line('rows with an empty book_prices (whole collection)', tally.emptyPrices, pct(tally.emptyPrices, tally.rows));
  line('fair shorter than the quoted price', fairBelowPrice, `of ${fairPairs} price/fair pairs`);
  line('fair_prob outside (0,1)', probOutOfRange);
  line('fair_prob != 1 / fair_blend', blendMismatch, '(tolerance 0.005)');

  /* --------------------------------------------------- book bookkeeping */
  head('3. Does n_books match the books actually there?');

  let nBooksWrong = 0, blendNotSubset = 0, checked = 0;
  for (const r of sample) {
    if (r.n_books == null) continue;
    checked++;
    const have = Object.keys(r.book_prices || {}).length;
    if (r.n_books > have) nBooksWrong++;
  }
  const blendSample = await SP.aggregate([
    { $sample: { size: 50000 } },
    { $project: { blend_books: 1, book_fairs: 1 } },
  ], { allowDiskUse: true }).toArray();
  for (const r of blendSample) {
    const fairs = new Set(Object.keys(r.book_fairs || {}));
    for (const b of r.blend_books || []) if (!fairs.has(b)) { blendNotSubset++; break; }
  }
  report.books = { checked, nBooksWrong, blendNotSubset, blendSampled: blendSample.length };
  line('n_books greater than the books present', nBooksWrong, `of ${checked}`);
  line('blend_books naming a book with no fair', blendNotSubset, `of ${blendSample.length} sampled`);

  /* -------------------------------------------------------- duplicates */
  head('4. The same selection priced twice');

  const dupes = await SP.aggregate([
    { $group: { _id: { f: '$fixture_id', m: '$market_id', s: '$selection', l: '$line' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, keys: { $sum: 1 }, extra: { $sum: { $subtract: ['$n', 1] } } } },
  ], { allowDiskUse: true }).toArray();
  report.duplicates = { keys: dupes[0]?.keys ?? 0, extra: dupes[0]?.extra ?? 0 };
  line('(fixture, market, selection, line) seen twice', report.duplicates.keys);
  line('extra rows', report.duplicates.extra);

  /* ----------------------------------------------------------- orphans */
  head('5. Prices with no fixture');

  /* `distinct('fixture_id')` over 9.5M rows is another full scan, and the
     integrity audit already answers this against the same collections. Run
     `audit-integrity.mjs` for the orphan counts rather than paying twice. */
  line('see audit-integrity.mjs section 4', '—', 'orphan fixture_ids are counted there');
  report.orphans = 'see audit-integrity.mjs';

  /* ------------------------------------------------------------ results */
  head('6. Results');

  const multiWinner = await SP.aggregate([
    { $match: { market_id: 'moneyline', won: true } },
    { $group: { _id: '$fixture_id', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'n' },
  ], { allowDiskUse: true }).toArray();
  const wonSet = tally.won, wonNull = tally.wonNull;

  report.results = { wonNull, wonSet, moneylineMultipleWinners: multiWinner[0]?.n ?? 0 };
  line('rows with a result', wonSet, pct(wonSet, spTotal));
  line('rows with won = null', wonNull, pct(wonNull, spTotal));
  line('moneyline markets with MORE than one winner', report.results.moneylineMultipleWinners,
    '← a fixture cannot have two');

  console.log(`\n${'─'.repeat(72)}\nodds_sp ${spTotal.toLocaleString()} rows · odds ${odTotal.toLocaleString()} rows`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`wrote ${jsonPath}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
