/**
 * The public `sport.gutsysapi.com` surface, mapped onto the shapes this app
 * already speaks.
 *
 * Why this exists: the odds live on `nas01`, which is a Tailscale address and
 * therefore unreachable from anywhere this app might be deployed. The same data
 * is already tunnelled out as an HTTP API — the pattern `next-to-go` uses — so
 * this module is the adapter that lets the board run off it instead of a direct
 * Mongo connection.
 *
 * It is NOT a full substitute. The API serves a wide pivot (one row per market
 * and line, with `oc1_pinn_odds`-style columns) built from the same underlying
 * odds, but it does not carry per-price history: no `flucs`, no 6h/3h/1h/30m/10m
 * snapshots, no `daily_prices`, no per-book `status`. Anything reading those
 * degrades rather than breaks — see `toOddsRows`.
 */

const DEFAULT_BASE = 'https://sport.gutsysapi.com';

export const sportApiConfigured = Boolean(process.env.SPORT_API_KEY);

const BASE = (process.env.SPORT_API_URL || DEFAULT_BASE).replace(/\/$/, '');
const KEY = process.env.SPORT_API_KEY;

/**
 * Sports the surface will answer for.
 *
 * Asked rather than assumed: `action=list_sports` is authoritative, and a
 * hardcoded list is how `handball` — which this feed does not carry — ended up
 * in a request, got rejected, and took the process down with an unhandled
 * rejection. The constant below is only the fallback for when discovery itself
 * fails, and is the list the surface returned.
 */
const FALLBACK_SPORTS = [
  'soccer', 'tennis', 'basketball', 'baseball', 'icehockey', 'amfootball',
  'aussierules', 'rugbyleague', 'rugbyunion', 'cricket', 'mma', 'boxing',
  'darts', 'esports', 'volleyball', 'golf',
];

let sportsCache = { at: 0, list: null };
const SPORTS_TTL_MS = 60 * 60 * 1000;

export async function apiSports() {
  if (sportsCache.list && Date.now() - sportsCache.at < SPORTS_TTL_MS) return sportsCache.list;
  try {
    const body = await call('odds-api', { action: 'list_sports' });
    const list = Array.isArray(body?.sports) ? body.sports.filter(Boolean) : null;
    if (list?.length) {
      sportsCache = { at: Date.now(), list };
      return list;
    }
  } catch {
    // Discovery is a convenience; the board should still come up without it.
  }
  return FALLBACK_SPORTS;
}

/** Kept for callers that need a list synchronously; prefer `apiSports()`. */
export const API_SPORTS = FALLBACK_SPORTS;

/**
 * The API's book keys are abbreviations of the canonical ones the UI columns
 * use. `lads`/`ladbrokes_australia` and `betfair_exchange_australia` are the
 * same aliasing the Mongo path folds — see foldBookAliases in queries.mjs.
 */
const BOOK_ALIASES = {
  pinn: 'pinnacle',
  sbet: 'sportsbet',
  lads: 'ladbrokes',
  ladbrokes_australia: 'ladbrokes',
  betfair_exchange_australia: 'betfair',
  betfair_exchange_australia_lay: 'betfair_lay',
};
const canonicalBook = (b) => BOOK_ALIASES[b] ?? b;

/**
 * The API names markets by shape (`h2h`, `total_games`); the grid keys off the
 * canonical market id (`moneyline`, `total`). Period prefixes — `1s_` a tennis
 * set, `1h_` a half, `1q_` a quarter, `1p_` a period, `1inn_` an inning — are
 * split off and put back, so `1s_total_games` becomes `1s_total` rather than
 * falling through as an unknown market and vanishing from the grid.
 */
const MARKET_IDS = {
  h2h: 'moneyline',
  h2h_3way: 'moneyline_3way',
  moneyline: 'moneyline',
  moneyline_3way: 'moneyline_3way',
  spreads: 'spread',
  spread: 'spread',
  game_spread: 'spread',
  set_spread: 'set_spread',
  totals: 'total',
  total: 'total',
  total_games: 'total',
  total_points: 'total',
  total_runs: 'total',
  total_sets: 'total_sets',
  asian_total: 'asian_total',
  dnb: 'dnb',
  double_chance: 'double_chance',
  btts: 'btts',
  outright: 'outright',
};

const PERIOD_PREFIX = /^(1s|1h|2h|1q|2q|3q|4q|1p|2p|3p|1inn)_/;

function marketId(type) {
  if (!type) return type;
  const m = PERIOD_PREFIX.exec(type);
  if (!m) return MARKET_IDS[type] ?? type;
  const rest = type.slice(m[0].length);
  // `1s_set_spread` would be nonsense; a period-scoped set handicap is just the
  // period's spread.
  const mapped = MARKET_IDS[rest] ?? rest;
  return `${m[1]}_${mapped === 'set_spread' ? 'spread' : mapped}`;
}

/**
 * Per-request timeout, deliberately well inside the function's own budget.
 *
 * It used to be 120s against a 60s `maxDuration`, which is the wrong way round:
 * one slow sport held the whole board until the platform killed the function,
 * and the board came back empty. Failing a single sport fast leaves the other
 * thirteen to answer.
 */
const CALL_TIMEOUT_MS = 20_000;
/** One retry, because most upstream failures here are momentary. */
const CALL_RETRIES = 1;

/**
 * `include_stale=true` is what makes the feed complete.
 *
 * Without it the surface publishes only rows a book is actively quoting, which
 * for an in-play market is a fraction of the truth: on an 8-2 blowout every
 * price on the leading side was suspended, so the whole outcome vanished and
 * the moneyline rendered one-sided. With it, 12 of 12 live prices come through
 * and match `gutsys_sport.odds` to the decimal.
 *
 * What still does not come through is WHICH of them are suspended — the pivot
 * carries no status column — so the grid cannot strike those prices through the
 * way the direct-Mongo path does. Showing a stale price beats showing a gap,
 * but it is worth knowing they are not all takeable.
 *
 * It is passed per call rather than globally, because the one question it must
 * NOT be asked is "what is live": a stale live row survives long after the game
 * ends, so including them turned 11 live fixtures into 554.
 */
async function call(route, params) {
  if (!KEY) throw new Error('SPORT_API_KEY is not set');
  const qs = new URLSearchParams({ key: KEY, ...params });
  let lastErr;
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE}/${route}?${qs}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // A 4xx is our mistake — a bad sport, a bad key — and will not improve
        // on a retry. Only a server-side or transport failure is worth another go.
        const err = new Error(`${route} ${res.status}: ${body.slice(0, 160)}`);
        if (res.status < 500) throw err;
        lastErr = err;
      } else {
        return await res.json();
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /\d{3}:/.test(err.message) && !/ 5\d\d:/.test(err.message)) throw err;
    }
    if (attempt < CALL_RETRIES) await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr ?? new Error(`${route}: failed`);
}

/**
 * Cache of drained pages, keyed by the call.
 *
 * Every board read is the same handful of upstream calls — one pivot per sport —
 * and a sport can run to several pages of a few MB. The ticker asking for head
 * to head prices across the whole board would otherwise refetch all of it,
 * which measured at 20 seconds. Single-flight so concurrent callers share one
 * fetch rather than starting their own.
 */
const PIVOT_TTL_MS = 60_000;
const pivotCache = new Map();

function cachedDrain(key, produce) {
  const hit = pivotCache.get(key);
  if (hit && Date.now() - hit.at < PIVOT_TTL_MS) return hit.value;
  if (hit?.inflight) return hit.inflight;

  const inflight = produce()
    .then((value) => {
      pivotCache.set(key, { value: Promise.resolve(value), at: Date.now() });
      return value;
    })
    .catch((err) => {
      pivotCache.delete(key);
      throw err;
    });
  // A caller that never awaits this — a warm-up tick, a request that gave up —
  // must not turn a failed fetch into an unhandled rejection and take the
  // process with it. The error still reaches whoever did await.
  inflight.catch(() => {});
  pivotCache.set(key, { ...hit, inflight });
  return inflight;
}

/**
 * The board needs one row per fixture, not every line of every market.
 *
 * `market=h2h` is the cheapest way to get that and the head-to-head prices the
 * ticker shows: across seven sports it is 622 fixtures in 0.5 MB against 633 in
 * 28 MB unfiltered — 56x less data and five times faster. The eleven fixtures
 * it misses are ones with no head-to-head market at all, which could not have
 * shown a ticker price anyway; opening one by link still loads every market,
 * because the event page fetches by `fixture_id` without this filter.
 */
const BOARD_MARKET = 'h2h';

/**
 * How much of the surface's week the board actually wants, as `date_from` /
 * `date_to`. Asking for the whole thing and discarding most of it is what made
 * a cold board take 38 seconds; bounded, all fourteen sports come back in three.
 */
const WINDOW_BACK_DAYS = 2;
/*
 * A full week forward, not one day.
 *
 * `+1` dated from when this drain only ever returned settled fixtures, so the
 * forward edge bought nothing and a tight window was free. Now that `flucs=true`
 * brings unsettled fixtures through (see UNSETTLED), the forward edge is the
 * board's whole upcoming half — and at +1 it cut the weekend off: on a Friday,
 * Sunday's NRL simply did not exist as far as the board was concerned.
 *
 * It is close to free because the books themselves only list a few days out, so
 * the extra days add almost nothing. Measured across seven sports:
 *
 *     +1d   1570 fixtures   3.5 MB
 *     +3d   1785 fixtures   3.9 MB
 *     +7d   1870 fixtures   4.1 MB
 */
const WINDOW_FWD_DAYS = 7;
const ymd = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

export function boardWindow() {
  return { date_from: ymd(-WINDOW_BACK_DAYS), date_to: ymd(WINDOW_FWD_DAYS) };
}

/**
 * `flucs=true` on a CLOSING drain is not about the ladder — it is what makes
 * unsettled fixtures visible at all.
 *
 * Without it the closing pivot answers with settled fixtures only: the same
 * windowed icehockey query returns 104 fixtures and NOT ONE of them is in the
 * future, which is why the board showed 522 finals, 14 live and zero upcoming,
 * and why the ticker had nothing to put a price against. With it the same query
 * returns 299 fixtures, 190 of them future. It also explains why a game that
 * had just started looked absent from the closing pivot entirely.
 *
 * The cost is payload — 0.1 MB to 0.5 MB per sport — which the function's
 * five-minute cache absorbs. The ladder columns themselves go unread here.
 */
const UNSETTLED = { flucs: 'true' };

/** How long after a scheduled start a fixture is presumed in play rather than
 *  finished, while waiting for a book to open its in-play market. */
const KICKOFF_GRACE_MS = 15 * 60_000;

/**
 * One page big enough to hold a windowed sport whole. The surface answers
 * `has_more: false` for every sport at this size, so `drain` almost never
 * loops — but it still can, because a busy weekend is not this week.
 */
const PAGE_LIMIT = 50_000;

/**
 * Drain a paginated endpoint. The surface caps a page and reports `has_more`
 * with a `next_offset`; a busy sport runs to several pages.
 */
async function drain(route, params, { maxPages = 12 } = {}) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = await call(route, {
      limit: String(PAGE_LIMIT),
      ...params,
      offset: String(offset),
    });
    out.push(...(body.data ?? []));
    if (!body.has_more || body.next_offset == null) break;
    offset = body.next_offset;
  }
  return out;
}

/* ------------------------------------------------------------- odds rows */

/** Columns that describe the fixture rather than a price. */
const FIXTURE_COLS = new Set([
  'optic_fixture_id', 'date', 'commence_time', 'sport_key', 'optic_league',
  'category', 'tournament', 'location', 'home_team', 'away_team', 'event_name',
  'home_score', 'away_score', 'sports_market_type', 'market_display_name',
  'line', 'pair_key',
]);

/**
 * Explode one wide pivot row into the tall per-(selection, book) rows the
 * market grid expects.
 *
 * Two shapes arrive here. Plain, the pivot carries `oc1_pinn_odds` and
 * `oc1_pinn_at`. With `flucs=true` it carries the whole life of each price —
 * `_open`, `_6h`, `_3h`, `_1h`, `_30m`, `_10m`, `_close`, `_current`, `_at` and
 * crucially `_status`. Both are handled, because the board asks for the cheap
 * shape and an event page asks for the rich one.
 *
 * `outcome_no` comes from the `ocN` prefix, which is exactly the
 * 1 = home/over/yes, 2 = away/under/no, 3 = draw convention the grid keys on.
 */
const PRICE_FIELDS = new Set([
  'odds', 'open', '6h', '3h', '1h', '30m', '10m', 'close', 'current', 'at', 'status', 'fair',
]);

function explode(row, { live }) {
  const out = [];
  const byOutcome = new Map();

  for (const [col, value] of Object.entries(row)) {
    if (FIXTURE_COLS.has(col) || value == null) continue;
    const m = /^oc(\d+)_(.+?)_([a-z0-9]+)$/.exec(col);
    if (!m) continue;
    const [, n, rawBook, field] = m;
    if (!PRICE_FIELDS.has(field)) continue;
    const book = canonicalBook(rawBook);
    const key = `${n}|${book}`;
    const rec = byOutcome.get(key) ?? { outcome: Number(n), book };
    rec[field] = value;
    byOutcome.set(key, rec);
  }

  for (const rec of byOutcome.values()) {
    // `odds` is the plain shape's only price; `current` is the rich shape's.
    const price = Number(rec.current ?? rec.odds ?? rec.close);
    if (!Number.isFinite(price)) continue;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    /*
     * A close, or nothing — never the current price wearing a close's hat.
     *
     * The plain shape has no `_close` column at all: `odds` is its only price,
     * and because that shape only ever carried SETTLED fixtures, treating it as
     * the close was right. `flucs=true` then brought unsettled fixtures down
     * the same path, and the fallback started inventing a close for games that
     * have not kicked off — Richmond v Geelong showed Ladbrokes 1.05 as a
     * closing price while the book was still actively quoting it.
     *
     * So the fallback now needs the book to have actually stopped: an explicit
     * `closed` status, or the plain shape's absence of any status at all.
     */
    const settled = !live && rec.status !== 'active' && rec.status !== 'suspended';
    const closePrice = num(rec.close) ?? (settled ? price : null);

    const mid = marketId(row.sports_market_type);
    /*
     * On a handicap the pivot's `line` belongs to oc1, and oc2 takes its
     * opposite. Copying it to both sides gave Zverev -1.5 AND Djokovic -1.5 —
     * two favourites in one market, where the real pairing is -1.5 against
     * +1.5. The Mongo path has always stored the two sides with opposite lines
     * ("Browns +0.5" beside "Steelers -0.5"), so this is the adapter catching
     * up with the convention rather than inventing one.
     *
     * Totals are the exception and must NOT be flipped: Over 2.5 and Under 2.5
     * share the same number, and negating it would invent an "Under -2.5".
     */
    const handicap = /spread/.test(mid);
    const line =
      row.line == null ? null : handicap && rec.outcome === 2 ? -row.line : row.line;

    out.push({
      market_id: mid,
      market_name: row.market_display_name ?? null,
      selection: row[`oc${rec.outcome}_name`] ?? null,
      normalized_selection: null,
      line,
      // Grouped on magnitude, so the two sides of one handicap stay one row.
      line_group: line == null ? null : Math.abs(line),
      pair_key: row.pair_key ?? null,
      outcome_no: rec.outcome,
      is_main: true,
      sportsbook: rec.book,
      is_lay: rec.book.endsWith('_lay'),
      current_price: price,
      open_price: num(rec.open),
      close_price: closePrice,
      // `closed_at` is what gates the grid's close-price rule. Only claim a
      // close when there genuinely is one — same test as the price above, so
      // the two can never disagree.
      closed_at: closePrice != null ? (row.commence_time ?? null) : null,
      current_at: rec.at ?? null,
      open_at: null,
      // The status the book had this price in — "suspended" is what makes the
      // grid strike it through, and it only arrives with flucs=true.
      status: rec.status ?? null,
      // Still no point-by-point series upstream; the snapshots below are the
      // whole of the available history, so the hover card draws no sparkline.
      flucs: [],
      daily_prices: {},
      price_6h: num(rec['6h']),
      price_3h: num(rec['3h']),
      price_1h: num(rec['1h']),
      price_30m: num(rec['30m']),
      price_10m: num(rec['10m']),
      fair: num(rec.fair),
      fair_blend: row[`oc${rec.outcome}_fair_blend`] ?? null,
      fair_prob: row[`oc${rec.outcome}_fair_prob`] ?? null,
      og_blend: row[`oc${rec.outcome}_og_blend`] ?? null,
      blend_tier: row[`oc${rec.outcome}_blend_tier`] ?? null,
    });
  }
  return out;
}

/**
 * Merge the opening prices from the settled (tall) surface onto rows built from
 * the pivot. `book_opens` is the only place an opening price is published.
 */
function mergeOpens(rows, spRows) {
  if (!spRows?.length) return rows;
  const opens = new Map();
  for (const r of spRows) {
    for (const [book, price] of Object.entries(r.book_opens ?? {})) {
      opens.set(`${r.market_id}|${r.selection}|${r.line ?? ''}|${canonicalBook(book)}`, price);
    }
  }
  for (const row of rows) {
    const hit = opens.get(
      `${row.market_id}|${row.selection}|${row.line ?? ''}|${row.sportsbook}`,
    );
    if (hit != null) row.open_price = hit;
  }
  return rows;
}

/** Every odds row the surface has for one sport, tall and canonicalised. */
export async function apiOddsForSport(sport, { live = false } = {}) {
  const w = boardWindow();
  const pivot = await cachedDrain(`odds:${sport}:${live}`, () =>
    drain('odds-api', live
      ? { sport, live: 'true', include_stale: 'true', market: BOARD_MARKET, ...w }
      // Upcoming fixtures only exist on this drain with `flucs=true` — see
      // UNSETTLED. Without it the ticker has no price to show for anything
      // that has not already been played.
      : { sport, include_stale: 'true', market: BOARD_MARKET, ...UNSETTLED, ...w }),
  );
  const rows = [];
  for (const r of pivot) {
    for (const row of explode(r, { live })) {
      row.fixture_id = r.optic_fixture_id;
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The status the pivot implies.
 *
 * Start time is the only trustworthy signal here. The pivot carries `home_score`
 * and `away_score` on every row including fixtures that have not kicked off —
 * "Club Libertad 0-1" for a match starting at 22:00 tonight — so treating a
 * present score as evidence the game was played marks the entire board final
 * and paints phantom scorelines onto tomorrow's fixtures.
 *
 * So: a future start is upcoming, a past start is finished, and whether
 * something is actually in play is answered by the live feed rather than
 * guessed at from a clock.
 */
function impliedStatus(row, now, liveIds) {
  if (liveIds?.has(row.optic_fixture_id)) return 'live';
  const start = row.commence_time ? new Date(row.commence_time).getTime() : NaN;
  if (!Number.isFinite(start)) return null;
  // `upcoming`, not null. This returned null back when the closing pivot carried
  // only settled fixtures, so a future start time meant "we have no idea" and
  // the client's mapStatus() quietly defaulted it. Now that `flucs=true` brings
  // unsettled fixtures through (see UNSETTLED), a future start is a fact worth
  // stating rather than something downstream has to infer from a null.
  if (start > now) return 'upcoming';
  /*
   * A game that has just started is not finished.
   *
   * `liveIds` only holds fixtures a book is actively quoting in-play, and books
   * open those markets a few minutes AFTER the off — so for that gap a fixture
   * fell through to 'completed' and the board read "Final" on a game that had
   * tipped off ninety seconds earlier. Milwaukee v Minnesota showed Final at
   * 00:14 for a 00:00 start.
   *
   * Of the two possible errors here, calling a running game finished is much
   * the worse: "Final" with no score is obviously broken, where a brief "live"
   * on something postponed is merely early. So the first few minutes after a
   * scheduled start resolve to live, and only after that does an unquoted
   * fixture read as completed.
   */
  return now - start < KICKOFF_GRACE_MS ? 'live' : 'completed';
}

/**
 * The pivot rows for whatever is in play.
 *
 * This is a second source, not an overlay. A fixture that is still running has
 * no closing price, so it does not appear in the closing pivot at all — which
 * is why both the board and the per-fixture odds have to consult it. Failing
 * softly matters: live is an enhancement, and losing it should not take the
 * closing prices down with it.
 */
async function liveRows(sport) {
  try {
    // Deliberately WITHOUT include_stale. A stale live row outlives the game it
    // belongs to, so asking for them here reports finished matches as in play —
    // it took the board from 11 live to 554. A price someone is actively
    // quoting is the only honest signal that a game is still running.
    return await cachedDrain(`live:${sport}`, () =>
      drain('odds-api', { sport, live: 'true', market: BOARD_MARKET, ...boardWindow() }),
    );
  } catch {
    return [];
  }
}

/**
 * Odds for one fixture.
 *
 * `fixture_id` (with `sport`, which the surface requires) fetches just this
 * match — 89 rows against the 1,130 of a whole-sport drain — so an event page
 * no longer pays for the entire sport to render one grid.
 *
 * Both pivots are still consulted, for the same reason the fixture list does:
 * a game still running has no closing price and appears only in the live feed,
 * while a finished one is only in the closing pivot.
 *
 * Precedence depends on whether the price is still trading, NOT on which pivot
 * it came from. A live row only wins while its book is actually quoting it:
 * once a match ends those rows freeze at the last in-play price — pinnacle at
 * 1.021 on a dead market — and carry no snapshot ladder, so letting them win
 * showed stale in-play numbers and no history for exactly the six books the
 * live feed covers, while the four it does not were correct.
 */
export async function apiOddsForFixture(fixtureId, sport) {
  if (!sport) return [];
  const one = (extra) =>
    cachedDrain(`fx:${fixtureId}:${extra.live ?? '0'}`, () =>
      drain('odds-api', {
        sport,
        fixture_id: fixtureId,
        include_stale: 'true',
        // The event page is the one place the full price history is worth
        // paying for: open, the 6h->10m ladder, close, and per-book status.
        flucs: 'true',
        ...extra,
      }),
    ).catch(() => []);

  // No live pivot. This site shows pre-match prices only, so the in-play feed
  // is not a source here at all — see the merge note below.
  const [closing, sp] = await Promise.all([
    one({}),
    call('odds-sp-api', { fixture_id: fixtureId }).then((b) => b.data ?? []).catch(() => []),
  ]);

  const explodeAll = (pivotRows, isLive) => {
    const out = [];
    for (const r of pivotRows) {
      if (r.optic_fixture_id !== fixtureId) continue;
      for (const row of explode(r, { live: isLive })) {
        row.fixture_id = fixtureId;
        out.push(row);
      }
    }
    return out;
  };

  /*
   * Closing pivot only — never the live one.
   *
   * This board is a pre-match product: every price on it should be one you
   * could have taken before the off. The live feed quotes the same market
   * mid-game, and the two are not comparable. Merging them put FanDuel at 81
   * for the Phillies next to Pinnacle at 2.01 — both "correct", three hours
   * apart, and meaningless side by side. Most books close their market at the
   * off; the one or two still trading in-play then looked like outliers rather
   * than what they were.
   *
   * The earlier rule here was "live wins while it is still trading", which is
   * right only until a close exists. Rather than restore that subtlety, the
   * live pivot is simply not consulted: the closing pivot already carries both
   * halves of the fixture's life — `current` for an upcoming game (it tracks
   * pre-match moves right up to the off) and `close` plus the full
   * open/6h/3h/1h/30m/10m ladder once it starts.
   *
   * The live feed is still used elsewhere, but only to ENUMERATE fixtures and
   * to decide whether one is in play (apiFixtures) — never for a price.
   */
  const rows = explodeAll(closing, false);
  return mergeOpens(rows, sp);
}

/** The fixtures the surface knows about for a sport, in board shape. */
export async function apiFixtures(sport) {
  const [closing, liveAll, liveActive] = await Promise.all([
    cachedDrain(`odds:${sport}:false`, () =>
      drain('odds-api', { sport, include_stale: 'true', market: BOARD_MARKET, ...UNSETTLED, ...boardWindow() }),
    ),
    // Enumeration needs the stale live rows too. A match that has just finished
    // has no active price left, and is not yet settled into `odds_sp` — so it
    // is in neither of the other two queries, and fell off the board entirely
    // for the hour or so between the final whistle and settlement. Asking for
    // stale live rows is what covers that gap.
    cachedDrain(`live-all:${sport}`, () =>
      drain('odds-api', {
        sport, live: 'true', include_stale: 'true', market: BOARD_MARKET, ...boardWindow(),
      }),
    ).catch(() => []),
    liveRows(sport),
  ]);
  // Liveness still comes from actively-quoted prices only — a stale live row
  // outlives its game, so using these would report finished matches as in play.
  const liveIds = new Set(liveActive.map((r) => r.optic_fixture_id).filter(Boolean));
  const now = Date.now();
  const byId = new Map();
  // Live first, so an in-play fixture wins over any closing row for it.
  const rows = [...liveAll, ...closing];
  for (const r of rows) {
    if (!r.optic_fixture_id || byId.has(r.optic_fixture_id)) continue;
    const status = impliedStatus(r, now, liveIds);
    // A score on an unplayed fixture is left over from some other meeting;
    // only show one once the thing has actually started.
    const played = status === 'completed' || status === 'live';
    byId.set(r.optic_fixture_id, {
      fixture_id: r.optic_fixture_id,
      sport,
      category: r.category ?? null,
      optic_league: r.optic_league ?? null,
      tournament: r.tournament ?? null,
      tournament_stage: null,
      event_name: r.event_name ?? null,
      home_team: r.home_team ?? null,
      away_team: r.away_team ?? null,
      scheduled_start: r.commence_time ?? null,
      actual_start: null,
      is_live: status === 'live',
      status,
      end_date: null,
      current_round: null,
      scores: played ? { home: r.home_score ?? null, away: r.away_score ?? null } : null,
      in_play_data: null,
      has_odds: true,
    });
  }
  return [...byId.values()];
}

/** Is the surface reachable and answering? */
export async function apiHealth() {
  try {
    const res = await fetch(`${BASE}/health?key=${KEY}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}
