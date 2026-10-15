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

const price = (row) => {
  const p = Number(row?.current_price);
  // 1.0 is not a price, it is a settled market or a placeholder, and it makes
  // an implied probability of exactly 1 that swamps a blend.
  return Number.isFinite(p) && p > 1 ? p : null;
};

/** Suspended prices are stale by definition — the book has stopped standing behind them. */
const usable = (row) =>
  !row.is_lay && String(row.status ?? '').toLowerCase() !== 'suspended' && price(row) != null;

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
export function fairsFor(rows, outcomeNo) {
  const none = { fairPinnacle: null, fairBlend: null, fairBooks: 0, pinnacleOverround: null };
  if (!rows?.length || outcomeNo == null) return none;

  const rowsOk = rows.filter(usable);
  if (!rowsOk.length) return none;

  /*
   * What counts as the complete market is what the FIELD prices, not a number
   * declared anywhere: a two-way market is two outcomes because every book
   * quoting it quotes two. Taking the union across books rather than trusting
   * one of them means a book that has pulled a side is measured against the
   * others and excluded, instead of silently redefining the market as smaller.
   */
  const expected = new Set(rowsOk.map((r) => r.outcome_no));
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
    const p = price(r);
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
