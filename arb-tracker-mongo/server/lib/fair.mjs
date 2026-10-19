/**
 * A price with the bookmaker's margin taken out.
 *
 * Every quoted market totals more than 100%: sum 1/price across the outcomes
 * and the field on one NBA moneyline runs 104.1 to 106.3, Pinnacle among them
 * at 105.4. That excess is the book's charge. Dividing each outcome's implied
 * probability by the total removes it proportionally and leaves a set that sums
 * to exactly 100% — the "fair" price, which is always LONGER than the one
 * quoted, because taking the vig out can only make a price more generous.
 *
 * Two of them are published on the ticker:
 *
 *   Pinnacle fair   one book, de-vigged. Pinnacle is the reference because it
 *                   moves on money rather than on opinion, so its de-vigged
 *                   number is the closest thing to a single trustworthy
 *                   probability — not because it is always the thinnest, which
 *                   on the game above it was not.
 *   Blend fair      every book that prices the whole market, de-vigged
 *                   individually and then averaged. Averaging vectors that each
 *                   sum to 1 gives a vector that sums to 1, so the blend is
 *                   normalised to 100% by construction rather than by a second
 *                   correction.
 *
 * Both are null far more often than they are not, and that is the point — see
 * the completeness rule below. A fair derived from half a market is not a worse
 * fair, it is a different and much more flattering number, and it would sit in
 * the column looking exactly like a real one.
 */

/** The reference book. Canonical ids — see BOOK_ALIASES in sportApi.mjs. */
const PINNACLE = 'pinnacle';

/**
 * A blend of one book is not a blend.
 *
 * It is that book's own de-vigged price wearing a label that says several books
 * agreed on it — and when the one book is Pinnacle, it is the column beside it
 * repeated, which is worse than blank because two columns agreeing looks like
 * confirmation. On a 200-bet feed this withholds the blend from the handful of
 * bets where a single book prices the whole market and leaves the rest alone.
 */
const MIN_BLEND_BOOKS = 2;

/**
 * The outcome set to de-vig over, identified by `pair_key`.
 *
 * `pair_key` is the surface's own grouping of the outcomes that make up one
 * market at one line: the sentinel `-99999` for a moneyline (the whole market
 * is the group), the line for a total, and for a handicap it pairs the mirrored
 * sides — `-8.5` holds both "Pacers @8.5" and "Thunder @-8.5", which no rule
 * based on the line alone would put together.
 *
 * It is REQUIRED, with no fallback, and that was measured rather than assumed.
 * The obvious fallback — group by market and line, pairing handicaps on the
 * absolute line — was tested against the real partition on six fixtures and
 * reproduced it on none of them: 303 groups where `pair_key` makes 416 on one
 * NFL game, because player markets reuse the same line across different
 * players and the rule merged them. De-vigging across outcomes that are not
 * each other's alternatives produces a number that looks completely normal and
 * means nothing, so a row with no `pair_key` gets no fair.
 */
export const groupKey = (row) =>
  row?.pair_key == null ? null : `${row.market_id}|${row.pair_key}`;

/**
 * Which column holds the price, because there are two questions.
 *
 * `current_price` answers "is this a good bet now", which is the ticker. For a
 * SETTLED bet the only meaningful comparison is the close — where the market
 * finished, after everyone had their say — so the settled view reads
 * `close_price` through the same de-vig rather than a second implementation of
 * it.
 */
const priceIn = (row, field) => {
  const p = Number(row?.[field]);
  // 1.0 is not a price, it is a settled market or a placeholder, and it makes
  // an implied probability of exactly 1 that swamps a blend.
  return Number.isFinite(p) && p > 1 ? p : null;
};

/** Suspended prices are stale by definition — the book has stopped standing behind them. */
const usable = (row, field) =>
  !row.is_lay && String(row.status ?? '').toLowerCase() !== 'suspended' && priceIn(row, field) != null;

/**
 * De-vig one book's column: implied probabilities divided by their own total.
 *
 * Returns null unless the book prices EVERY outcome in `expected`. This is the
 * rule the whole module turns on, and it is borrowed from `bookMargins` in
 * markets.ts, which learned it the same way: a book quoting one side of a
 * two-way market totals ~60%, and dividing by 0.6 inflates that side's fair
 * price by two thirds. It does not read as broken, it reads as value.
 */
function devigBook(byOutcome, expected) {
  let total = 0;
  for (const outcome of expected) {
    const p = byOutcome.get(outcome);
    if (p == null) return null;
    total += 1 / p;
  }
  if (!(total > 0)) return null;
  /*
   * An overround outside the plausible band is not a market.
   *
   * Exchanges keep quoting after the result is known: the winner trades at
   * 1.01 and so does the loser, because nobody is left to take the other side.
   * Betfair closed Nuggets -24.5 at 1.01 on BOTH sides, which de-vigs to a
   * 198% overround and a "fair" of 2.0 — and blended with DraftKings' real
   * 6.00 it produced a closing fair of 3.647 for a bet struck at 10.00. That
   * row sat at the top of the settled list claiming a 174% overlay, which was
   * entirely this.
   *
   * Below 100% a book's own prices arb against each other, which means at least
   * one of them is stale. Above the ceiling nothing legitimate survives. The
   * ceiling scales with the field because overround does: a two-way runs 104 to
   * 110, while a forty-runner first-scorer market is honestly 130+, and a flat
   * cap would either admit the artefact or throw away every big field.
   */
  if (total < 1 || total > 1 + 0.2 * expected.size) return null;
  const probs = new Map();
  for (const [outcome, p] of byOutcome) probs.set(outcome, 1 / p / total);
  return { probs, overround: total * 100 };
}

/**
 * The two fairs for one outcome of one market.
 *
 * `rows` is every row in the outcome group — all books, all outcomes — and
 * `outcomeNo` is the side the bet is on.
 */
export function fairsFor(rows, outcomeNo, { field = 'current_price' } = {}) {
  const none = { fairPinnacle: null, fairBlend: null, fairBooks: 0, pinnacleOverround: null };
  if (!rows?.length || outcomeNo == null) return none;

  const rowsOk = rows.filter((r) => usable(r, field));
  if (!rowsOk.length) return none;

  /*
   * What counts as the complete market is every outcome the group HAS, not
   * every outcome that happens to carry the price being read.
   *
   * This took `rowsOk`, which is filtered on the price field — so an outcome
   * with no price in that column disappeared from the market's definition, and
   * whatever was left looked complete. Barely visible on current prices;
   * glaring on closing ones, where a first-touchdown market with forty runners
   * came back with two closes and de-vigged as a two-way: a bet struck at 67.0
   * reported a closing fair of 1.925 and a 50% edge. The market is defined by
   * its outcomes; a book that cannot price all of them is the thing to exclude.
   */
  const expected = new Set(rows.filter((r) => !r.is_lay).map((r) => r.outcome_no));
  // One outcome is not a market. Dividing a single implied probability by
  // itself gives a fair price of exactly 1.0 for everything, every time.
  if (expected.size < 2) return none;
  if (!expected.has(outcomeNo)) return none;

  const byBook = new Map();
  for (const r of rowsOk) {
    const book = byBook.get(r.sportsbook) ?? new Map();
    // Best price per (book, outcome): the same book can appear twice when a
    // market is quoted at more than one id, and the better number is the one
    // the grid would show.
    const p = priceIn(r, field);
    const prev = book.get(r.outcome_no);
    if (prev == null || p > prev) book.set(r.outcome_no, p);
    byBook.set(r.sportsbook, book);
  }

  let pinn = null;
  let sum = 0;
  let books = 0;
  for (const [book, byOutcome] of byBook) {
    const d = devigBook(byOutcome, expected);
    if (!d) continue;
    const prob = d.probs.get(outcomeNo);
    if (prob == null || !(prob > 0)) continue;
    if (book === PINNACLE) pinn = d;
    sum += prob;
    books += 1;
  }

  const inv = (p) => (p != null && p > 0 ? Math.round((1 / p) * 1000) / 1000 : null);

  return {
    fairPinnacle: pinn ? inv(pinn.probs.get(outcomeNo)) : null,
    // The average of the per-book normalised probabilities. Each vector sums to
    // 1, so their mean does too — the blend needs no further normalising.
    fairBlend: books >= MIN_BLEND_BOOKS ? inv(sum / books) : null,
    fairBooks: books,
    pinnacleOverround: pinn ? Math.round(pinn.overround * 10) / 10 : null,
  };
}
