import { coll } from './mongo.mjs';
import { isApi } from './source.mjs';
import { SKIP_SPORTS } from './events.mjs';
import { apiOddsForSport, apiSports } from './sportApi.mjs';
import { cachedBoard } from './queries.mjs';

/**
 * Head-to-head prices that have moved, and who has not moved with them.
 *
 * The question this answers is not "what is the best price" — the board
 * already shows that — but "this market has moved, is anyone still asleep at
 * the old number". So each row carries the move the market made and the
 * biggest price still takeable, measured against BOTH the new consensus and
 * the old one. A book still sitting at the pre-move price is the whole point.
 *
 * It reads the per-sport head-to-head drains the board has already paid for
 * (`odds:<sport>:false`, which carries the price ladder because the board asks
 * for `flucs`), so it costs nothing upstream beyond what the board does.
 */

/**
 * How far back "before" is.
 *
 * `open` is the default because it is the only rung that is actually there.
 * Measured across the fresh active head-to-head rows: open_price 100%,
 * price_6h 24%, price_3h 9%, price_1h 2%, price_30m 1%. Defaulting to 6h threw
 * away three quarters of the market and found seven movers on a whole board.
 * The shorter rungs are offered, but they answer a narrower question than they
 * appear to.
 */
const WINDOWS = {
  '10m': 'price_10m',
  '30m': 'price_30m',
  '1h': 'price_1h',
  '3h': 'price_3h',
  '6h': 'price_6h',
  open: 'open_price',
};

/**
 * The exchange is not a bookmaker for this purpose.
 *
 * Betfair's back price is whatever liquidity happens to sit there, so it
 * drifts constantly without the market having moved, and an empty book parks
 * every runner near its floor. Same exclusion the ticker's best-price column
 * makes, for the same reason.
 */
const EXCHANGE = new Set(['betfair', 'betfair_lay']);

/**
 * A price nobody has touched recently is not a price.
 *
 * This matters more here than anywhere else on the site. A book whose capture
 * has frozen keeps its last number forever, and that number is often the
 * biggest one on the row — bet365 sat at 2.50 on a Sakkari/Vekic market for
 * 28 hours while the live market traded 2.30 to 2.49. Without this a frozen
 * book would be reported as the lagging price to take, which is the exact
 * opposite of true.
 */
const FRESH_MS = 30 * 60_000;

const MARKETS = new Set(['moneyline', 'moneyline_3way']);

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null);

/**
 * Movement in implied-probability points: (1/reference - 1/current) * 100.
 *
 * NOT the percentage change in the odds, which is the wrong measure and was
 * what this reported first. 1.10 -> 1.05 is only -4.5% of the odds but +4.3
 * points of probability; 10.0 -> 9.50 is the same -5% of the odds and +0.5 of
 * a point. The odds number flatters a drift at long prices and hides a serious
 * one at short, and it is the probability that moved.
 *
 * Sign follows the same convention the page already used: negative means the
 * price shortened, because the implied probability went up. 5.60 -> 4.34 is
 * 17.9% -> 23.0% implied, so -5.2 points.
 */
const pts = (reference, current) =>
  reference && current ? (1 / reference - 1 / current) * 100 : null;

/** Every non-lay head-to-head row across the board, with its ladder. */
async function h2hRows() {
  if (isApi) {
    const sports = (await apiSports()).filter((s) => !SKIP_SPORTS.has(s));
    const perSport = await Promise.all(sports.map((s) => apiOddsForSport(s).catch(() => [])));
    return perSport.flat().filter((r) => MARKETS.has(r.market_id) && !r.is_lay);
  }
  // On the tailnet, straight from `odds` — bounded to the board's fixtures so
  // this is an indexed read rather than a scan of seven million rows.
  const board = await cachedBoard();
  const ids = board.map((e) => e.id);
  const out = [];
  const odds = await coll('odds');
  for (let i = 0; i < ids.length; i += 300) {
    const rows = await odds
      .find({
        fixture_id: { $in: ids.slice(i, i + 300) },
        market_id: { $in: [...MARKETS] },
        is_lay: false,
        is_live: { $ne: true },
        // Only live, recently-touched rows are ever used below, so asking for
        // them here rather than filtering in memory is both the same answer
        // and a far smaller read — 3,600 rows instead of every head-to-head
        // row on 2,900 fixtures.
        status: 'active',
        current_at: { $gte: new Date(Date.now() - FRESH_MS) },
      })
      .project({
        _id: 0, fixture_id: 1, market_id: 1, selection: 1, sportsbook: 1, status: 1,
        current_price: 1, current_at: 1, open_price: 1,
        price_6h: 1, price_3h: 1, price_1h: 1, price_30m: 1, price_10m: 1,
      })
      .toArray();
    out.push(...rows);
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {keyof WINDOWS} [opts.window] Which rung of the ladder counts as "before".
 * @param {number} [opts.minMove] Smallest consensus move worth reporting, in
 *   implied-probability POINTS — 2 is a real move, 5 is enormous.
 * @param {number} [opts.minBooks] Fewest live books for a median to mean anything.
 */
export async function marketMovers({ window = 'open', minMove = 2, minBooks = 3 } = {}) {
  const field = WINDOWS[window] ?? WINDOWS.open;
  const [rows, board] = await Promise.all([h2hRows(), cachedBoard()]);
  const fixtures = new Map(board.map((e) => [e.id, e]));
  const now = Date.now();

  // (fixture, market, selection) — never mixing a two-way moneyline with a
  // three-way one, which are different markets at different prices.
  const groups = new Map();
  for (const r of rows) {
    const price = num(r.current_price);
    if (price == null) continue;
    const key = `${r.fixture_id}|${r.market_id}|${r.selection}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out = [];
  let staleSkipped = 0;
  let groupsWithRef = 0;

  for (const [key, list] of groups) {
    const [fixtureId, market, selection] = key.split('|');
    const fixture = fixtures.get(fixtureId);
    // A mover on a fixture the board is not showing is not actionable.
    if (!fixture || fixture.status !== 'upcoming') continue;

    const live = [];
    for (const r of list) {
      if (EXCHANGE.has(r.sportsbook)) continue;
      if (r.status !== 'active') continue;
      const at = r.current_at ? new Date(r.current_at).getTime() : null;
      if (at == null || now - at > FRESH_MS) { staleSkipped++; continue; }
      const price = num(r.current_price);
      if (price == null) continue;
      live.push({ book: r.sportsbook, price, at, then: num(r[field]) });
    }
    if (live.length < minBooks) continue;

    const withThen = live.filter((b) => b.then != null);
    if (withThen.length < minBooks) continue;
    groupsWithRef++;

    const nowMid = median(live.map((b) => b.price));
    const thenMid = median(withThen.map((b) => b.then));
    const movePts = pts(thenMid, nowMid);
    if (movePts == null || Math.abs(movePts) < minMove) continue;

    const sorted = [...live].sort((a, b) => b.price - a.price);
    const best = sorted[0];

    out.push({
      fixtureId,
      name: fixture.name,
      sport: fixture.sport,
      league: fixture.league?.name ?? null,
      startsAt: fixture.startsAt,
      market,
      selection,
      // The move the market made, on the median so one stuck book cannot
      // invent it.
      then: Number(thenMid.toFixed(3)),
      now: Number(nowMid.toFixed(3)),
      movePts: Number(movePts.toFixed(2)),
      direction: movePts < 0 ? 'shortened' : 'drifted',
      books: sorted.map((b) => ({
        book: b.book,
        price: b.price,
        then: b.then,
        movePts: b.then ? Number(pts(b.then, b.price).toFixed(2)) : null,
        ageMins: Math.round((now - b.at) / 60_000),
      })),
      best: {
        book: best.book,
        price: best.price,
        // The best book's OWN move, which is what separates a book that has
        // not followed the market from one that simply always prices this
        // selection highest.
        movePts: best.then ? Number(pts(best.then, best.price).toFixed(2)) : null,
      },
      /* The two numbers that answer "is anyone still on the old price": how
         much better the best price is than where the market now sits, and
         whether it is still at or beyond where the market was BEFORE it
         moved. The second is the one that matters on a shortening market. */
      // How many points of probability the best price gives away against the
      // market now, and against where it was before it moved.
      bestVsNowPts: Number(pts(nowMid, best.price).toFixed(2)),
      bestVsThenPts: Number(pts(thenMid, best.price).toFixed(2)),
      /*
       * Lagging means the market shortened and the best price did NOT follow
       * it — not merely that some book is the highest number on the row, which
       * is often just that book's standing opinion. Judged on the best book's
       * own move against the market's: less than half as far, or none at all.
       */
      lagging:
        movePts < -minMove
        && best.then != null
        && pts(best.then, best.price) > movePts / 2,
    });
  }

  out.sort((a, b) => {
    // A book still on the old price first — that is the actionable half —
    // then by the size of the move.
    if (a.lagging !== b.lagging) return a.lagging ? -1 : 1;
    return Math.abs(b.movePts) - Math.abs(a.movePts);
  });

  return {
    window,
    thresholds: { minMove, minBooks, freshMins: FRESH_MS / 60_000 },
    counts: {
      markets: groups.size,
      // How many had enough books publishing a price at the chosen window to
      // be judged at all — the gap between this and `markets` is the ladder's
      // coverage, not an absence of movement.
      comparable: groupsWithRef,
      movers: out.length,
      lagging: out.filter((m) => m.lagging).length,
      staleRowsIgnored: staleSkipped,
    },
    movers: out.slice(0, 300),
  };
}
