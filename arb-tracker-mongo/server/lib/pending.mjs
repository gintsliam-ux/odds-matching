/**
 * Bets still live, beside what the market has done since they were struck.
 *
 * The ticker answers "what is being backed right now". This answers the
 * question that matters once a bet is on the book: is it still a good bet for
 * us. So it reads the UNSETTLED singles rather than the newest ones, and sets
 * the price the customer took against our own current price for the same
 * selection — which is the only comparison that is strictly like-for-like,
 * being the same book, the same market and the same outcome.
 *
 * A FIRMER is a bet whose price has shortened since: we laid 3.40 and the same
 * selection is 2.90 now. The market has moved towards the customer, which means
 * the price we gave was too long, and every one of those is a position getting
 * worse while it sits there.
 *
 * Our own price comes from two stores shaped nothing like each other, because
 * the two brands are scraped by different code:
 *
 *   swiftbet   `events`        _id is the event UUID, prices nested as
 *                              markets[].selections[] with `odds` and a
 *                              `price_history` of {odds, ts}
 *   mybet      `mybet_events`  _id is the numeric event id, prices in a `comps`
 *                              map keyed by selection id, each `{team, win,
 *                              openingWin}`
 *
 * Both join on the id the bet already carries — the same one the deep links
 * use — so no name matching is needed to find the EVENT. Only to find the
 * selection within it, and that reuses the feed's own `pickByName` rather than
 * inventing a second rule.
 */

import { betsConfigured, betsDb } from './betsMongo.mjs';
import {
  classifyLeadSegments, enrich, mapMulti, mapSwift, pickByName, SPORT_SINGLE,
} from './ticker.mjs';

/**
 * Open, in each brand's own vocabulary. Read off the data rather than assumed —
 * see the note in exposure.mjs, which established the same two.
 */
const SWIFT_OPEN = 'Unresulted';
const MULTI_OPEN = ['Accepted', 'Partially Accepted'];

/**
 * Settled, in each brand's own vocabulary, read off a week of real statuses.
 *
 * swiftbet resolves everything to `paid` (2,328 sport singles in seven days);
 * `Rejected` (227) and `FullyRefunded` (28) are bets that never stood and are
 * not settled results. mybet writes `No Return` for a loser (691) and
 * `Return @<br>Tkt <n>` for a winner — a DISTINCT status string per ticket,
 * which is why it has to be matched by shape rather than listed. Note it is
 * "Return @" and not "Return of": the latter is COUNTER_ENTRY, the balancing
 * row rather than a bet.
 */
const SWIFT_SETTLED = 'paid';
const MULTI_SETTLED = [{ bet_status: 'No Return' }, { bet_status: /^Return @/ }];

/**
 * Fourteen days, and the bet limit raised to actually reach them.
 *
 * Settled bets are immutable, so the window itself costs nothing to widen —
 * and widening it alone would have changed NOTHING, which is the part worth
 * recording. At 250 bets the newest ones reached back twelve HOURS, so "the
 * last seven days" was really "the last half day" and the limit, not the
 * window, was what anyone was looking at. The limit is now above the
 * population: fourteen days holds 7,066 settled sport singles.
 *
 * The cost is not the bets, it is the FIXTURES behind them — 1,283 of them, one
 * request each in production, since nothing cheaper covers a fixture outside
 * the board window. That is bounded in ticker.mjs by CLOSING_FIXTURE_CAP and
 * CLOSING_BUDGET_MS, and the route caches the answer for an hour, which is what
 * makes asking for all of them affordable at all.
 *
 * Worth knowing when reading the span: the filter is on PLACED time, so a bet
 * laid three weeks ago and settled yesterday is outside it. For sport singles
 * that is a rounding error; for a futures market it would not be.
 */
const SETTLED_WINDOW_DAYS = 14;
const SETTLED_WINDOW_MS = SETTLED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const SETTLED_LIMIT = 8000;

/**
 * How far back to look for something still open.
 *
 * Generous, because an unsettled bet is unsettled however old it is — a futures
 * market can sit open for months. Bounded anyway, because the cost here is per
 * bet: each one wants a fixture and a price comparison.
 */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const LIMIT = 300;

const num = (v) => {
  const n = Number(v);
  // A brand store writes 0 for a selection it is no longer pricing — an
  // eliminated runner, a market pulled — and 0 is not a price. Treating it as
  // one would read as the shortest firmer on the page.
  return Number.isFinite(n) && n > 1 ? n : null;
};

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

async function openSwift(db, since) {
  const rows = await db
    .collection('bets')
    .find({ ...SPORT_SINGLE.bets, bet_status: SWIFT_OPEN, bet_time: { $gte: since } })
    .sort({ bet_time: -1 })
    .limit(LIMIT)
    .toArray();
  return rows.map(mapSwift);
}

async function openMulti(db, since) {
  const rows = await db
    .collection('multi_bets')
    .find({
      ...SPORT_SINGLE.multi_bets,
      bet_status: { $in: MULTI_OPEN },
      transaction_date: { $gte: since },
    })
    .sort({ transaction_date: -1 })
    .limit(LIMIT)
    .project({
      transaction_date: 1, price: 1, amount_bet: 1, bonus_bet: 1, bet_status: 1,
      transaction_id: 1, user_accountID: 1,
      sport_name: 1, bet_type: 1, selections: 1, event_string: 1,
      event_identifier: 1, transaction_licenseid: 1,
    })
    .toArray();
  return rows.map(mapMulti);
}

/** Words that say nothing about which market this is. */
const MARKET_STOPWORDS = new Set([
  'the', 'and', 'to', 'of', 'in', 'on', 'at', 'a', 'v', 'vs', 'bet', 'betting', 'market',
]);

const marketWords = (s) =>
  new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !MARKET_STOPWORDS.has(w)),
  );

/**
 * One price from however many candidates answered to the name.
 *
 * A brand event holds dozens of markets and a team's name appears in most of
 * them, so matching a name across the whole event legitimately returns several
 * rows: measured on a live book, 60 bets matched exactly one selection and 22
 * matched more than one. Dropping all 22 threw away a third of the page.
 *
 * Narrowed by the MARKET first, which is the thing that actually distinguishes
 * them, and only then by agreement: if every candidate carries the same price
 * then the ambiguity cannot change the answer and is not really an ambiguity.
 * Anything still genuinely undecided is dropped rather than guessed — "Australia
 * Test" at 2.15 in the match winner and 1.90 on a handicap are different bets.
 */
function resolveOne(candidates, betMarket) {
  if (candidates.length <= 1) return candidates[0] ?? null;

  const want = marketWords(betMarket);
  if (want.size) {
    const scored = candidates
      .map((c) => {
        const have = marketWords(c.market);
        let overlap = 0;
        for (const w of want) if (have.has(w)) overlap += 1;
        return { c, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);
    const best = scored[0].overlap;
    const tied = scored.filter((x) => x.overlap === best);
    if (best > 0 && tied.length === 1) return tied[0].c;
    // Still tied, but on the same number — fall through to the price test with
    // only the best-matching candidates in play.
    if (best > 0) candidates = tied.map((x) => x.c);
  }

  const prices = new Set(candidates.map((c) => c.price));
  return prices.size === 1 ? candidates[0] : null;
}

async function settledSwift(db, since) {
  const rows = await db
    .collection('bets')
    .find({ ...SPORT_SINGLE.bets, bet_status: SWIFT_SETTLED, bet_time: { $gte: since } })
    .sort({ bet_time: -1 })
    .limit(SETTLED_LIMIT)
    .toArray();
  return rows.map(mapSwift);
}

async function settledMulti(db, since) {
  const rows = await db
    .collection('multi_bets')
    .find({ ...SPORT_SINGLE.multi_bets, $or: MULTI_SETTLED, transaction_date: { $gte: since } })
    .sort({ transaction_date: -1 })
    .limit(SETTLED_LIMIT)
    .project({
      transaction_date: 1, price: 1, amount_bet: 1, bonus_bet: 1, bet_status: 1,
      transaction_id: 1, user_accountID: 1,
      sport_name: 1, bet_type: 1, selections: 1, event_string: 1,
      event_identifier: 1, transaction_licenseid: 1,
    })
    .toArray();
  return rows.map(mapMulti);
}

/**
 * Settled singles where the customer beat the closing price.
 *
 * The close is the market's last word — the number arrived at after everyone
 * had their say — so a bet struck longer than the close was a bet we should not
 * have offered at that price, whether or not it won. That is the whole point of
 * looking at settled business: a winner at a fair price is variance, and a
 * loser taken at 3.40 against a 2.60 close is a mistake that happened to be
 * rescued by the result.
 *
 * Judged against the closing FAIR rather than any one book's close, for the
 * reason the fair exists: every quoted close still carries that book's margin,
 * so beating the best quoted close is a lower bar than beating the true price.
 * Pinnacle's de-vigged close first, the blend of complete books second — see
 * fair.mjs. The book columns carry the raw closes so the number can be checked.
 */
export const SETTLED_DAYS = SETTLED_WINDOW_DAYS;

export async function settledBets() {
  if (!betsConfigured) return { configured: false, bets: [], counts: null };
  const db = await betsDb();
  if (!db) return { configured: false, bets: [], counts: null };

  const since = new Date(Date.now() - SETTLED_WINDOW_MS);
  const [swift, multi] = await Promise.all([
    settledSwift(db, since).catch(() => []),
    settledMulti(db, since).catch(() => []),
  ]);

  const all = [...swift, ...multi]
    .filter((b) => b.placedAt)
    .sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)))
    .slice(0, SETTLED_LIMIT);

  /*
   * BEFORE enrich, and that ordering is the whole of it.
   *
   * This is where a mybet slip's real market name comes from — the lead segment
   * of its event string — and both feeds here were skipping it, so every such
   * bet fell back to `bet_type` and read "Win". Bet 6667932 is a half-time /
   * full-time double on "Arsenal - Arsenal" at 2.26; labelled "Win" it parsed
   * as a moneyline and was compared against a 1.57 full-match close, which is a
   * different market. enrich also PROJECTS the bets into new objects on its way
   * out, so this cannot be moved after it — see the ticker's own call site.
   */
  await classifyLeadSegments(all).catch(() => {});
  /*
   * A timings object rather than null, because this is the only route whose
   * COVERAGE is in question. The per-fixture pricing is deadline-bounded, so
   * "how many of the window's fixtures did this answer actually price" has to
   * come back with the answer — a thin settled view otherwise looks identical
   * whether the market had no closes or we ran out of time asking.
   */
  const timings = {};
  const { bets: enriched, pricesError } = await enrich(all, timings, { closing: true });

  for (const b of enriched) {
    /*
     * ONE fair for the whole settled view: the blend.
     *
     * This preferred Pinnacle where it existed and fell back to the blend, and
     * EM% was later put on the blend to match `blend_em_pct` upstream. Two
     * different fairs answering the same question is the bug: on 108 of 304
     * flagged rows the two disagreed, because Pinnacle's de-vigged price is
     * systematically shorter than the blend, so the list said "beat the close"
     * while the column beside it read -1.78%.
     *
     * The blend wins because it is what EM means here and because EM gets
     * summed across thousands of bets, where an average of every book that
     * closed the market is a sounder input than any single book. The cost is
     * 135 bets priced by Pinnacle alone, which now go unjudged — and a market
     * only one book closed in full is exactly what MIN_BLEND_BOOKS already
     * declines to call a blend. `fairPinnacle` and `emPctPinn` stay on the
     * payload as the second reading.
     */
    b.closeFair = b.fairBlend ?? null;
    /*
     * Expected margin, on the same definition the polytracker enrichment uses
     * (`emPct` / `emPl` in enrich-soccer-em.mjs) so the two agree.
     *
     * That one is written for a prediction market, where the price IS a
     * probability: (trueProb - paidProb) / paidProb. In decimal odds the paid
     * probability is 1/price and the true one is 1/fair, and the whole thing
     * reduces to price/fair - 1 — the customer's expected value per dollar
     * staked. Positive means they had the edge.
     *
     * Off the BLEND fair, which is what `blend_em_pct` means upstream: every
     * book that closed the whole market, de-vigged individually and averaged.
     * One book's opinion de-vigged is still one book's opinion, and EM is a
     * number that gets totalled across thousands of bets — the average is the
     * more honest input to a sum. `emPctPinn` carries the Pinnacle-only reading
     * beside it, the same way the upstream table keeps both columns.
     *
     * Note this is a DIFFERENT fair from the one `closeFair` and `beatClose`
     * use, which prefer Pinnacle where it exists. The two can therefore
     * disagree on a thin market, and the Closed column shows which fair the
     * flag was struck against.
     *
     * Against the close either way, which is the only fair a settled bet has.
     * Not a verdict on the result: a +8% bet that lost was still a price we
     * should not have offered, which is the entire point of judging on close.
     */
    b.emPct = emPct(b.price, b.fairBlend);
    b.emPctPinn = emPct(b.price, b.fairPinnacle);
    // Signed dollars at stake. `emPl` upstream multiplies the traded cost by
    // the edge; the cost here is simply the stake.
    b.emPl = b.emPct != null && Number.isFinite(Number(b.stake))
      ? Math.round(Number(b.stake) * (b.emPct / 100) * 100) / 100
      : null;
    b.closeFrom = b.fairBlend != null ? 'blend' : null;
    b.movePct = movePct(b.price, b.closeFair);
    // Beat the close: they took a price longer than the market's own final
    // estimate of the chance.
    // Identical to `emPct > 0` by construction now, which is the point: the
    // flag and the column are one comparison expressed two ways.
    b.beatClose = b.price != null && b.closeFair != null && b.price > b.closeFair;
  }

  const judgeable = enriched.filter((b) => b.closeFair != null);
  const beat = judgeable.filter((b) => b.beatClose);

  return {
    configured: true,
    // The view exists to show the ones that beat it; the rest are the denominator.
    bets: judgeable,
    counts: {
      open: enriched.length,
      judgeable: judgeable.length,
      noClose: enriched.filter((b) => b.closeFair == null).length,
      firmed: beat.length,
      stake: judgeable.reduce((s, b) => s + (Number(b.stake) || 0), 0),
      firmedStake: beat.reduce((s, b) => s + (Number(b.stake) || 0), 0),
      // The window, sent rather than restated on the client: the page used to
      // say "the last 7 days" in two places as literal text, which is a number
      // that silently lies the moment this constant changes — as it just did.
      days: SETTLED_WINDOW_DAYS,
      // The oldest bet that actually made it in, so the page can show the span
      // it has rather than the span it asked for.
      from: enriched.length ? String(enriched[enriched.length - 1].placedAt ?? '').slice(0, 10) : null,
      fixtures: timings.fullFixtures ?? null,
      dropped: timings.droppedFixtures ?? 0,
      /*
       * The window's expected margin in dollars, over every judgeable bet —
       * not just the ones that beat the close.
       *
       * Summing only the beats would report what we lost on the bets we got
       * wrong while hiding what we earned on the rest, which is a number that
       * can only look alarming. The honest total is the whole book.
       */
      emPl: Math.round(judgeable.reduce((s, b) => s + (Number(b.emPl) || 0), 0) * 100) / 100,
      beatEmPl: Math.round(beat.reduce((s, b) => s + (Number(b.emPl) || 0), 0) * 100) / 100,
    },
    ...(pricesError ? { pricesError } : {}),
  };
}

/**
 * Our own current price on each bet's selection.
 *
 * One query per brand rather than per bet. The selection is found with the
 * feed's `pickByName`, which wants rows shaped `{selection}` — so each store's
 * own field name is mapped onto that rather than teaching `pickByName` about
 * two more shapes.
 */
async function ourPrices(db, bets) {
  const swiftIds = [];
  const multiIds = [];
  for (const b of bets) {
    if (!b.eventId) continue;
    if (b.brand === 'swiftbet') swiftIds.push(String(b.eventId));
    else if (/^\d+$/.test(String(b.eventId))) multiIds.push(Number(b.eventId));
  }

  const [swiftEvents, multiEvents] = await Promise.all([
    swiftIds.length
      ? db
          .collection('events')
          .find({ _id: { $in: [...new Set(swiftIds)] } })
          .project({ _id: 1, 'markets.selections': 1, 'markets.status': 1, scraped_at: 1 })
          .toArray()
          .catch(() => [])
      : [],
    multiIds.length
      ? db
          .collection('mybet_events')
          .find({ _id: { $in: [...new Set(multiIds)] } })
          .project({ _id: 1, comps: 1, lastSeenAt: 1 })
          .toArray()
          .catch(() => [])
      : [],
  ]);

  /** eventId -> [{selection, price, opening, at}] */
  const bySwift = new Map(
    swiftEvents.map((e) => [
      String(e._id),
      {
        at: iso(e.scraped_at),
        rows: (e.markets ?? []).flatMap((m) =>
          (m.selections ?? []).map((s) => ({
            selection: s.name,
            // Which market it came from, because the same name appears in
            // several — see resolveOne.
            market: `${m.market_type_name ?? ''} ${m.name ?? ''}`,
            price: num(s.odds),
            // The first price in the history is the one it opened at.
            opening: num((s.price_history ?? [])[0]?.odds),
            suspended: String(s.status ?? '').toLowerCase() !== 'trading',
          })),
        ),
      },
    ]),
  );

  const byMulti = new Map(
    multiEvents.map((e) => [
      String(e._id),
      {
        at: iso(e.lastSeenAt),
        rows: Object.values(e.comps ?? {}).map((c) => ({
          selection: c.team,
          // mybet's store is one market per document, named on the document
          // itself, so every row in it shares the one market.
          market: e.description ?? '',
          price: num(c.win),
          opening: num(c.openingWin),
          // `eliminated` is the brand's own word for a runner out of the market.
          suspended: Boolean(c.eliminated),
        })),
      },
    ]),
  );

  for (const b of bets) {
    const store = b.brand === 'swiftbet' ? bySwift : byMulti;
    const hit = b.eventId ? store.get(String(b.eventId)) : null;
    if (!hit || !b.outcome) continue;
    const one = resolveOne(pickByName(hit.rows, b.outcome), b.market);
    if (!one) continue;
    b.ourNow = one.price;
    b.ourOpen = one.opening;
    b.ourAt = hit.at;
    b.ourSuspended = one.suspended;
    /*
     * Which store the number came from, so the column can say.
     *
     * For swiftbet and mybet it is the brand's own book and the comparison is
     * exact. For MULTIS it is mybet's store, because there is no Multis event
     * store — the two are one platform behind two front ends, sharing the
     * `multi_bets` collection and split only by licence, and every Multis event
     * id resolves in `mybet_events`. Still the price the bet was struck
     * against, then, but worth naming rather than leaving the reader to assume
     * a Multis-specific feed exists.
     */
    b.ourBook = b.brand === 'swiftbet' ? 'swiftbet' : 'mybet';
  }
}

/**
 * Movement in implied probability, signed, as the movers page measures it:
 * `(1/struck - 1/now) * 100`. Negative means the price SHORTENED, because the
 * implied probability went up — 3.40 to 2.90 is 29.4% to 34.5%, so -5.07.
 *
 * Percent of probability rather than percent of the odds, deliberately: 2.00 to
 * 1.90 and 10.0 to 9.50 are both "5% shorter" in odds terms and are not
 * remotely the same move.
 */
/**
 * Expected margin as a percentage of stake — see the call site.
 *
 * Both prices must be real decimals above 1. A `fair` of exactly 1 would divide
 * a price by certainty and report an edge of several hundred percent, which is
 * the shape a settled or placeholder price arrives in.
 */
const emPct = (price, fair) => {
  const p = Number(price);
  const f = Number(fair);
  if (!(p > 1) || !(f > 1)) return null;
  // Two decimals, not one. At one, an edge of four hundredths of a percent
  // rounded to a flat 0.0% while `beatClose` still flagged the row — a column
  // that reads zero beside a flag that says otherwise.
  return Math.round((p / f - 1) * 10000) / 100;
};

const movePct = (struck, now) =>
  struck && now ? (1 / struck - 1 / now) * 100 : null;

/**
 * Pending singles, with the market's answer so far.
 *
 * `firmed` is the signal the page is for. It needs OUR price, not the field's:
 * a bet struck at a price we no longer offer is the thing to look at, and the
 * other books' columns are the context for why.
 */
export async function pendingBets() {
  if (!betsConfigured) return { configured: false, bets: [], counts: null };
  const db = await betsDb();
  if (!db) return { configured: false, bets: [], counts: null };

  const since = new Date(Date.now() - WINDOW_MS);
  const [swift, multi] = await Promise.all([
    openSwift(db, since).catch(() => []),
    openMulti(db, since).catch(() => []),
  ]);

  const all = [...swift, ...multi]
    .filter((b) => b.placedAt)
    .sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)))
    .slice(0, LIMIT);

  /*
   * BEFORE enrich, and that ordering is the whole of it.
   *
   * This is where a mybet slip's real market name comes from — the lead segment
   * of its event string — and both feeds here were skipping it, so every such
   * bet fell back to `bet_type` and read "Win". Bet 6667932 is a half-time /
   * full-time double on "Arsenal - Arsenal" at 2.26; labelled "Win" it parsed
   * as a moneyline and was compared against a 1.57 full-match close, which is a
   * different market. enrich also PROJECTS the bets into new objects on its way
   * out, so this cannot be moved after it — see the ticker's own call site.
   */
  await classifyLeadSegments(all).catch(() => {});
  const { bets: enriched, pricesError } = await enrich(all);
  await ourPrices(db, enriched);

  for (const b of enriched) {
    b.movePct = movePct(b.price, b.ourNow);
    b.firmed = b.movePct != null && b.movePct < 0;
    // Our opening price against what the customer got: a bet taken at a price
    // the book had already moved away from reads differently from one taken at
    // the top of the market.
    b.vsOpenPct = movePct(b.price, b.ourOpen);
  }

  /*
   * Only rows we can actually judge.
   *
   * The page exists to compare three numbers — what the customer took, what we
   * offer now, and what the field offers. A row missing either of the last two
   * cannot answer the question and would sit there looking like a bet nobody
   * had an opinion on. Counted rather than silently dropped, so the header can
   * say how much of the book is unjudgeable.
   */
  const judgeable = enriched.filter((b) => b.ourNow != null && b.prices && Object.keys(b.prices).length);

  return {
    configured: true,
    bets: judgeable,
    counts: {
      open: enriched.length,
      judgeable: judgeable.length,
      noOurPrice: enriched.filter((b) => b.ourNow == null).length,
      noFieldPrice: enriched.filter((b) => !b.prices || !Object.keys(b.prices).length).length,
      firmed: judgeable.filter((b) => b.firmed).length,
      stake: judgeable.reduce((s, b) => s + (Number(b.stake) || 0), 0),
      firmedStake: judgeable
        .filter((b) => b.firmed)
        .reduce((s, b) => s + (Number(b.stake) || 0), 0),
    },
    ...(pricesError ? { pricesError } : {}),
  };
}
