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

import { cached } from './cache.mjs';
import { expireStaleLive, isMultiDay, LIVE, MULTI_DAY_GRACE_MS } from './events.mjs';

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
  /*
   * The surface calls the European handicap `spread_3way`; the collection on
   * the NAS calls the same market `handicap_3way`. Unmapped, it passed through
   * under the surface's name, matched no market definition, and so never
   * rendered on a deployed instance — while the identical market rendered fine
   * on the tailnet. Mapped to the NAS name because that is what the market
   * definitions use, exactly as `h2h` is mapped to `moneyline`.
   */
  spread_3way: 'handicap_3way',
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
/*
 * Two retries rather than one, and the wait grows.
 *
 * A 429 answered 400ms later is usually a 429 again; the point of backing off
 * is to let the window move.
 */
const CALL_RETRIES = 2;
/** However long Retry-After asks for, never past this. */
const RETRY_AFTER_CAP_MS = 10_000;

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
/**
 * How many requests this instance will have open upstream at once.
 *
 * A cold board is 14 sports x 4 window spans x 3 drains = 168 requests, and
 * splitting the window to beat the response cap is what multiplied them. Fired
 * all at once the surface answers a large share with 429, each of which costs a
 * retry and a 400ms-then-1600ms backoff, and a cold build took 24s. The gate is
 * FASTER than unbounded concurrency despite doing less at a time, because the
 * work it declines to start is work that would have been thrown away.
 *
 * This is the same failure the retry logic in `call` was written for; that fixed
 * the lost sports, this removes the cause.
 */
/*
 * The published ceiling: GET /limits reports 10 req/s sustained, burst 30 and
 * max_in_flight 16. This was 10, chosen blind because a cold board opened about
 * fifty at once and took whole sports off the board with 429s.
 */
const MAX_INFLIGHT = 16;
let inflight = 0;
const queued = [];

function gate(fn) {
  if (inflight < MAX_INFLIGHT) return run(fn);
  return new Promise((resolve, reject) => {
    queued.push(() => run(fn).then(resolve, reject));
  });
}

function run(fn) {
  inflight++;
  return fn().finally(() => {
    inflight--;
    queued.shift()?.();
  });
}

/*
 * A real rate limit, not just a concurrency cap.
 *
 * GET /limits publishes three numbers and they constrain different things:
 * `max_in_flight` 16 is how many may be open at once, but `rate_per_sec` 10
 * with `burst` 30 is how many may be STARTED. Capping only the former let a
 * cold board start 16 at a time, each finishing in a few hundred ms, which is
 * comfortably over ten a second — and the board lost a whole sport to a 429
 * (gridiron, on the run that measured 288 requests).
 *
 * A token bucket: 30 to spend immediately, refilling at 10 a second. Bursty
 * where the allowance is bursty and patient after that, which is exactly the
 * shape of the published limit.
 */
/*
 * Just under the published ten, because the KEY is the unit the limit applies
 * to and a deployed instance is spending from the same allowance. Asking for
 * exactly the ceiling means any concurrent production traffic pushes us over
 * it, and the cost of a 429 here is a whole sport missing from the board.
 */
const RATE_PER_SEC = 8;
/*
 * A burst well under the published 30. The allowance is per KEY and a deployed
 * instance draws on the same one, so spending 24 in the first instant was
 * enough to get rate-limited even at 8/s sustained — and a 429 that outlives
 * its retries costs a whole sport off the board.
 */
const BURST = 10;
let tokens = BURST;
let lastRefill = Date.now();

async function takeToken() {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // How long until the next whole token, rather than a fixed poll.
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / RATE_PER_SEC) * 1000)));
  }
}

/** Rate-limited entry point; `callRaw` does the work and spends a token per attempt. */
const call = (route, params) => gate(() => callRaw(route, params));

async function callRaw(route, params) {
  if (!KEY) throw new Error('SPORT_API_KEY is not set');
  const qs = new URLSearchParams({ key: KEY, ...params });
  let lastErr;
  /** Set from a 429's Retry-After, and used in place of our own backoff once. */
  let retryAfterMs = null;
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    /*
     * A token per ATTEMPT, retries included.
     *
     * Taking one per CALL and letting the retry loop inside spend it three
     * times over was worth up to 30 requests a second against a limit of ten —
     * which produced more 429s, which produced more retries. A cold board went
     * from one sport lost to three, with 118 rate-limit responses across 190
     * requests. A retry is a request and costs the same as any other.
     */
    await takeToken();
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
        /*
         * 429 and 408 are transient, and treating them as "our mistake" was
         * the start of the board losing whole sports.
         *
         * The board drains sixteen sports and three markets each, so a cold
         * instance opens about fifty requests at once. The surface answers some
         * of them with 429, which fell in `< 500`, threw immediately with no
         * retry, and took that sport's fixtures out of the board entirely.
         */
        if (res.status < 500 && res.status !== 429 && res.status !== 408) throw err;
        lastErr = err;
        /*
         * Wait as long as the server says to.
         *
         * 429 now carries Retry-After, so backing off by our own escalating
         * guess is both slower than necessary when the window is about to move
         * and too fast when it is not. Capped, because a header is not a
         * licence to hang the request past the function's own budget.
         */
        const after = Number(res.headers.get('retry-after'));
        if (Number.isFinite(after) && after > 0) {
          retryAfterMs = Math.min(after * 1000, RETRY_AFTER_CAP_MS);
        }
      } else {
        return await res.json();
      }
    } catch (err) {
      lastErr = err;
      if (
        err instanceof Error && /\d{3}:/.test(err.message)
        && !/ 5\d\d:/.test(err.message) && !/ (429|408):/.test(err.message)
      ) throw err;
    }
    if (attempt < CALL_RETRIES) {
      const wait = retryAfterMs ?? 400 * (attempt + 1) ** 2;
      retryAfterMs = null;
      await new Promise((r) => setTimeout(r, wait));
    }
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

/**
 * Beyond this a stale pivot is no longer worth standing behind, and a caller
 * waits for a fresh one rather than being told something this old.
 */
const PIVOT_STALE_MAX_MS = 3 * PIVOT_TTL_MS;
/*
 * It bounds how long a stale pivot is served WITHOUT a wait, not how old the
 * data can get. While drains keep failing the last good value is still handed
 * out past this, because a stale sport beats a vanished one — see beginDrain.
 */

/**
 * Single-flight drain cache, now stale-while-revalidate — which `cached` in
 * cache.mjs has done all along and this did not.
 *
 * On expiry this used to AWAIT a fresh drain, and that is what made the ticker
 * slow in a way no phase timing explained. Its response cache and this one both
 * last 60s, so almost every ticker rebuild found the pivots just expired and
 * paid full upstream freight for them: `oddsPerSport` was measured at 840ms,
 * 6.2s and 19.3s on three consecutive rebuilds, entirely according to whether
 * it had to re-drain.
 *
 * A caller is now handed the stale pivot and the refresh runs behind it, so a
 * rebuild never blocks on the network. That includes callers that arrive DURING
 * a refresh: the stale check deliberately comes before the in-flight check,
 * because joining the refresh is the very wait this exists to avoid.
 */
function cachedDrain(key, produce) {
  const hit = pivotCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit?.value && age < PIVOT_TTL_MS) return hit.value;

  const refresh = hit?.inflight ?? beginDrain(key, produce, hit);
  if (hit?.value && age < PIVOT_STALE_MAX_MS) return hit.value;
  return refresh;
}

/**
 * The cached drain if we already have one, otherwise start it and return empty.
 *
 * For a drain whose rows are worth having but not worth WAITING for. The live
 * pivot is the case: measured against the real bisecting drains across six
 * sports, it contributes 19 fixtures of 4,477 — 0.4% — while costing half of
 * every cold board build. Blocking the first paint on it charged every visitor
 * eight seconds for one fixture in 235.
 *
 * So the first build on a cold instance goes without those rows and kicks the
 * drain off behind itself; the next build, forty-five seconds later, has them.
 * Self-healing, and nothing is lost permanently — which is the only reason this
 * is acceptable at all, because a board that quietly drops fixtures is the
 * failure mode this file has been bitten by twice.
 */
const DEFER_MS = 15_000;
/** key -> when its drain was scheduled, so a timer that never fired is retried. */
const deferred = new Map();

function cachedDrainSoon(key, produce) {
  const hit = pivotCache.get(key);
  if (hit?.value && Date.now() - hit.at < PIVOT_STALE_MAX_MS) return hit.value;

  /*
   * Started on a TIMER, not immediately, and that delay is the whole point.
   *
   * Kicking it off at once moved the live drain off the critical path but not
   * out of the way: every request spends a token from one shared bucket at
   * eight a second, so the background drains simply queued ahead of the board's
   * own pages and a cold build went from 16.5s to 14.6s instead of to 6s. The
   * work has to be deferred in TIME, not just in await.
   *
   * Fifteen seconds clears a cold board (about 25 blocking calls) and still
   * lands these rows well inside the board's 45-second TTL, so the next build
   * has them.
   *
   * Re-schedulable: the timestamp is kept rather than a flag, because a
   * serverless instance can freeze before a timer fires. If the scheduled time
   * is long past and still nothing is cached, the next caller schedules again,
   * so nothing is lost permanently.
   */
  const at = deferred.get(key);
  if (!hit?.inflight && (at == null || Date.now() - at > DEFER_MS * 4)) {
    deferred.set(key, Date.now());
    const timer = setTimeout(() => {
      deferred.delete(key);
      // Errors swallowed: beginDrain keeps the last good value, and a failed
      // background drain must never reject the board that did not wait for it.
      beginDrain(key, produce, pivotCache.get(key)).catch(() => {});
    }, DEFER_MS);
    // Never hold the process open for a drain nobody is waiting on.
    timer.unref?.();
  }
  return Promise.resolve([]);
}

function beginDrain(key, produce, hit) {
  const inflight = produce()
    .then((value) => {
      pivotCache.set(key, { value: Promise.resolve(value), at: Date.now() });
      return value;
    })
    .catch((err) => {
      /*
       * Keep the last good value. A failure here used to DELETE it, so a blip
       * did not make a sport stale, it made the sport disappear: the next
       * caller got nothing, allEvents turned that into zero events for it, and
       * the partial board was cached for 45s and served to everyone on that
       * instance. Consecutive polls returned 1,461 events, then 15, then
       * 1,222 — whole sports coming and going in the rail.
       *
       * The original `at` is kept, so the value stays stale: it is served
       * straight away while inside PIVOT_STALE_MAX_MS, and past that a caller
       * waits on a fresh attempt instead of being handed it immediately. Note
       * that if the attempt ALSO fails they still receive this value rather
       * than an error — however old it is, that is the lesson above.
       */
      if (hit?.value) {
        pivotCache.set(key, { value: hit.value, at: hit.at });
        return hit.value;
      }
      pivotCache.delete(key);
      throw err;
    });
  // A caller that never awaits this — a warm-up tick, a request served the
  // stale copy instead — must not turn a failed fetch into an unhandled
  // rejection and take the process with it. The error still reaches whoever
  // did await.
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
/*
 * Three, not two, because the date picker is allowed to reach back three and a
 * day the board does not hold is a day the picker cannot show.
 */
const WINDOW_BACK_DAYS = 3;
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
 * `include_unsettled=true` now does that job on its own, which is what this
 * asks for. Measured side by side over the board window: identical fixture
 * counts and identical future counts — icehockey 357/99, soccer 1237/0,
 * basketball 475/97 — for about 30% fewer bytes, because the fluc ladder is
 * not bought. Every caller of this constant enumerates fixtures or reads a
 * current price; the ladder columns went unread by all of them. The event page,
 * which genuinely wants the ladder, asks for `flucs=true` itself.
 */
const UNSETTLED = { include_unsettled: 'true' };

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
/**
 * Page one request to exhaustion, reporting whether the window was CAPPED.
 *
 * Capped means the surface stopped because of its own hard limit rather than
 * because the window was exhausted: `has_more` still true while `next_offset`
 * refuses to advance. That is not a paging problem to retry — the cap is
 * terminal for the window, and `truncated_hint` says so literally ("narrow the
 * date window"). Measured: soccer over the ten-day board window returns 1,237
 * fixtures and will not page past them, where asking day by day returns 2,263.
 * The caller has to narrow; see drainSpan.
 */
async function drainReport(route, params, { maxPages = 12 } = {}) {
  const out = [];
  let offset = 0;
  let capped = false;
  for (let page = 0; page < maxPages; page++) {
    const body = await call(route, {
      limit: String(PAGE_LIMIT),
      ...params,
      offset: String(offset),
    });
    out.push(...(body.data ?? []));
    if (!body.has_more || body.next_offset == null) break;
    /*
     * An offset that does not move is the end, whatever `has_more` says.
     *
     * Cheap insurance on a loop that now carries the whole window: the old
     * failure here was `next_offset` advancing by the requested limit instead
     * of the rows returned, and the mirror-image fault — not advancing at all —
     * would spin until maxPages rather than stopping.
     */
    if (body.next_offset <= offset) {
      // More to come and no way to ask for it: the hard cap.
      capped = true;
      break;
    }
    offset = body.next_offset;
    // Ran out of pages with the surface still offering more.
    if (page === maxPages - 1) capped = true;
  }
  return { rows: out, capped };
}

/** The common case: just the rows. */
async function drain(route, params, opts) {
  return (await drainReport(route, params, opts)).rows;
}

const SPAN_MAX_DEPTH = 5;

const ymdOf = (d) => new Date(d).toISOString().slice(0, 10);
const shiftYmd = (ymd, days) =>
  ymdOf(new Date(`${ymd}T00:00:00Z`).getTime() + days * 86_400_000);
const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * One sport across a date window, narrowing only where the surface says to.
 *
 * The window still has to be split — see drainReport — but the trigger is now a
 * REPORTED cap rather than the old guess, which was "this response came back
 * with 900+ rows and its last fixture is more than a day short of the span I
 * asked for, so it was probably cut". That heuristic fired on windows that were
 * actually complete and missed ones that were not: a cold board made 288
 * requests for 24.9 MB in 161 seconds, 108 of those responses reporting the cap.
 *
 * Splitting on the fact instead means a span that fits is one request, and only
 * a span that is genuinely truncated pays for a bisect.
 */
async function drainSpan(params, from, to, depth = 0) {
  /*
   * Pre-split at the top, for sports known not to fit — see PRESPLIT_DAYS.
   *
   * It lives here rather than in drainBoard because buildFixtures, which is
   * what the board's fixture list actually comes from, calls drainSpan directly and
   * never goes through drainBoard. Putting the hint in the wrong one of those
   * two changed nothing at all.
   */
  if (depth === 0) {
    const chunk = PRESPLIT_DAYS[String(params.sport ?? '').toLowerCase()];
    if (chunk && daysBetween(from, to) >= chunk) {
      const spans = [];
      // YYYY-MM-DD compares correctly as a string, which is why the window is
      // carried in that form rather than as dates.
      for (let start = from; start <= to; start = shiftYmd(start, chunk)) {
        const last = shiftYmd(start, chunk - 1);
        spans.push([start, last > to ? to : last]);
      }
      const out = await Promise.all(spans.map(([a, b]) => drainSpan(params, a, b, 1)));
      return out.flat();
    }
  }
  const { rows, capped } = await drainReport('odds-api', { ...params, date_from: from, date_to: to });
  const span = daysBetween(from, to);
  if (!capped || span < 1 || depth >= SPAN_MAX_DEPTH) return rows;
  const mid = shiftYmd(from, Math.floor(span / 2));
  const [a, b] = await Promise.all([
    drainSpan(params, from, mid, depth + 1),
    drainSpan(params, shiftYmd(mid, 1), to, depth + 1),
  ]);
  return [...a, ...b];
}

/**
 * The surface truncates a (sport, window) query and says it is complete.
 *
 * Measured on the deployed board. Soccer, `market=h2h`, window 10-10..10-19:
 *
 *     limit=50000   1 page    1239 rows   has_more=false   latest start 10-11T18:15
 *     limit=4000    4 pages   1248 rows   has_more=false   latest start 10-11T18:15
 *
 * Both stop at the same place, roughly 1,240 rows and about 4 MB, and both
 * report that there is nothing more. There is: the identical query windowed to
 * 10-13..10-20 returns 630 rows, every one of them upcoming. The response is
 * ordered by start time, so what the cap removes is always the far end of the
 * window — which for the board is its entire upcoming half.
 *
 * That is why the deployed board carried 1,205 soccer fixtures and NOT ONE of
 * them was yet to start, while the same fixtures fetched by id returned 333 and
 * 851 price rows apiece. Rugby union and volleyball were empty for the same
 * reason. It reads exactly like an empty schedule, which is why it survived
 * this long.
 *
 * Paging past it does not work either, and the reason is worth recording:
 * `next_offset` advances by the REQUESTED `limit`, not by the number of rows
 * actually returned. At `limit=4000` the pages came back 404, 345, 438, 61 rows
 * while `next_offset` went 4000, 8000, 12000 — so each step skipped the roughly
 * 3,600 rows between what arrived and what was asked for. Honouring that offset
 * is worse than ignoring it, so `PAGE_LIMIT` stays large enough that a span is
 * answered in one page and the broken offset is never used.
 *
 * So the window is split instead, and a span that still looks truncated is
 * split again. Truncation is detected directly rather than inferred: a span
 * whose last fixture starts well before the span's own `date_to`, on a response
 * big enough to be near the cap, did not fit.
 */
/**
 * Drain one sport across a date window.
 *
 * This used to SPLIT the window — recursively, bisecting whenever a response
 * came back looking saturated — because the surface answered truncated spans
 * with `has_more: false` and a `next_offset` that advanced by the requested
 * limit rather than the rows returned. Paging was unusable, so the only way to
 * get a whole window was to ask for narrower pieces of it until each piece fit.
 *
 * It worked and it was expensive: a cold board was 288 upstream requests,
 * 24.9 MB and 161 seconds, with 108 of those responses reporting the cap hit.
 *
 * `has_more` and `next_offset` are now honest, and `drain` already follows
 * them, so the splitting is pure duplication of work the surface will do
 * properly. Measured after: paging one window to exhaustion takes 2 requests
 * for soccer and 1 for each of basketball, tennis, ice hockey, baseball and
 * gridiron — 7 for six sports where the splitting made dozens.
 *
 * Note the units, which are not obvious: `limit`, `offset` and `next_offset`
 * count ROWS, while `count` counts FIXTURES. A limit of 5,000 came back with
 * 703 fixtures and `next_offset: 5000`, which is offset plus rows returned,
 * exactly as documented.
 */
/**
 * The board window for one sport, narrowed only where the surface says to.
 *
 * Discovered rather than pre-split, which is the opposite of what this did
 * before and for a measured reason. Pre-splitting the window into three-day
 * spans sent 15 sports x 4 spans x 2 drains before anything was known, and
 * exactly ONE sport needs narrowing: soccer returns 1,237 fixtures against a
 * ground truth of 2,263 and reports the cap, while basketball, tennis, ice
 * hockey, baseball, gridiron and Aussie rules all come back whole and uncapped.
 * So the pre-split spent a hundred-odd requests to save soccer one round trip,
 * and the rate limit is ten a second.
 *
 * Starting whole costs the one sport that needs it a single extra round trip
 * and leaves the other fourteen at one request each.
 */
/**
 * Sports whose board window cannot fit in one response, in days per request.
 *
 * A PERFORMANCE hint only: correctness still comes from the cap discovery in
 * drainSpan, which bisects further if a chunk this size still truncates. Get
 * the number wrong and the board is slower or chattier, never incomplete.
 *
 * Why it is needed: discovery costs a serial round trip per level, and the
 * capped call at each level has its rows DISCARDED. Soccer carries 2,604
 * fixtures over the eleven-day window and took 10 calls and 14.2 seconds of a
 * 16-second cold board — every other sport finished inside 1.4s. Three days is
 * roughly 700 rows against a cap near 1,240, so each chunk lands in one call
 * and the four chunks go out together.
 */
const PRESPLIT_DAYS = { soccer: 3 };

function drainBoard(params) {
  const { date_from: from, date_to: to } = boardWindow();
  return drainSpan(params, from, to);
}

/* ------------------------------------------------------------- odds rows */

/** Columns that describe the fixture rather than a price. */
const FIXTURE_COLS = new Set([
  'optic_fixture_id', 'date', 'commence_time', 'sport_key', 'optic_league',
  'category', 'tournament', 'location', 'home_team', 'away_team', 'event_name',
  'home_score', 'away_score', 'sports_market_type', 'market_display_name',
  'line', 'pair_key',
  // In-play, added so a deployed instance can say where a live game is up to
  // rather than only "LIVE". Fixture-level facts repeated on every row of a
  // fixture, exactly as the scoreline already was.
  'period_number', 'period', 'clock', 'is_clock_stopped',
  'home_period_scores', 'away_period_scores',
  // `actual_start` is the real jump. `scheduled_start` is Optic's not-before
  // slot, which tennis never replaces, so a match already in play can carry a
  // start time hours away. The two write timestamps feed the status bar.
  'actual_start', 'fixture_updated_at', 'score_updated_at',
  /*
   * Added by the surface so none of this has to be inferred any more.
   *
   * `fixture_status` is derived from the fixture document alone — never from
   * scores, prices or a clock — which is exactly the thing impliedStatus could
   * not do and why a Test read Final on day two. `source_status` is Optic's raw
   * value, kept for when the mapped one looks wrong. `finished_at` is stamped
   * only on a completed fixture and is NOT synthesised, which is what makes it
   * usable where `fixtures.settled_at` is not. `market_id` is the collection's
   * own id beside the alias.
   */
  'fixture_status', 'source_status', 'finished_at', 'market_id',
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

/**
 * The canonical leg for an outcome the surface names after the teams.
 *
 * `normalized_selection` was hard-coded null on every row this builds, because
 * the pivot has no such column — and for most markets that costs nothing, since
 * the grid resolves the side through `outcome_no` instead (moneyline, spreads
 * and totals all go that way) and Yes/No names are distinct on their face.
 *
 * Double chance is the exception, and it is the one that broke. Its three
 * outcomes are named "Sydney FC Or Draw", "Western Sydney Wanderers FC Or
 * Draw", "Sydney FC Or Western Sydney Wanderers FC" — and with no canonical
 * leg the grid had nothing to group on but those strings. Where the surface
 * repeats one of them across all three outcomes, three outcomes became one row
 * and the other two outcomes' prices went with it. The Mongo source carries
 * `home_draw` / `draw_away` / `home_away` for exactly this reason: 30k rows of
 * each, against 4,836 distinct team-named variants.
 *
 * Derived from the fixture's OWN `home_team` and `away_team`, which the pivot
 * does carry, so this is a match rather than a guess — and it returns null
 * unless both halves resolve, leaving the previous behaviour in place for
 * anything it does not recognise. Not inferred from `outcome_no`: that mapping
 * holds on the collection measured here but has never been checked against
 * this surface, and a wrong leg is worse than no leg now that the grid trusts
 * one when it is present.
 */
const legSlug = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

function canonicalLeg(name, home, away) {
  const parts = legSlug(name).split('_or_');
  if (parts.length !== 2) return null;
  const h = legSlug(home);
  const a = legSlug(away);
  const has = (w) => Boolean(w) && parts.includes(w);
  if (has(h) && has('draw')) return 'home_draw';
  if (has(a) && has('draw')) return 'draw_away';
  if (has(h) && has(a)) return 'home_away';
  return null;
}

function explode(row, { live, unsettled }) {
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
    /*
     * `unsettled` disables the fallback entirely.
     *
     * It infers "this must be the close" from the plain shape having no status
     * column, which held while the plain shape only carried settled fixtures.
     * `include_unsettled=true` returns that same column-less shape for games
     * that have not kicked off, so without this the current price would be
     * stamped as a closing price on every upcoming fixture.
     */
    const settled =
      !unsettled && !live && rec.status !== 'active' && rec.status !== 'suspended';
    const closePrice = num(rec.close) ?? (settled ? price : null);

    /*
     * The collection's own id, straight off the row.
     *
     * `marketId` maps the surface's alias onto it and agrees with the published
     * table on all 23 types — but a type that appears tomorrow and is not in
     * that table passes through under the alias, matches no market definition,
     * and is invisible with nothing to say so. That is exactly how the 3-way
     * handicap went unrendered. Reading `market_id` when the row carries it
     * means a new market is wrong-looking rather than absent.
     */
    const mid = row.market_id ?? marketId(row.sports_market_type);
    /*
     * The handicap each side is actually getting, taken from the row rather
     * than inferred.
     *
     * This used to derive oc2's line by negating oc1's, on the understanding
     * that `line` belonged to oc1. It did not, reliably: the pivot returned
     * the same pair in both orientations, so the same team came back at the
     * same line with two incompatible prices — Saints +16.5 at 1.081 from one
     * row and at 6.75 from the other, when 6.75 is the price for Saints -16.5.
     * Half of every alternate-line ladder read backwards as a result, and a
     * handicap bet was compared against the opposite side of its own market.
     *
     * `oc1_line` / `oc2_line` now say outright what each outcome's line is, so
     * nothing is inferred. The negation survives only as a fallback for a row
     * that predates them, which is safe now that `line` is guaranteed to be
     * oc1's.
     *
     * Totals never had a side to get wrong: Over 2.5 and Under 2.5 share the
     * one number, and negating it would invent an "Under -2.5".
     */
    const handicap = /spread/.test(mid);
    const ownLine = num(row[`oc${rec.outcome}_line`]);
    const line =
      ownLine != null
        ? ownLine
        : row.line == null
          ? null
          : handicap && rec.outcome === 2
            ? -row.line
            : row.line;

    out.push({
      market_id: mid,
      market_name: row.market_display_name ?? null,
      selection: row[`oc${rec.outcome}_name`] ?? null,
      /*
       * `ocN_selection` is the canonical leg, and it was here the whole time.
       *
       * This field was hard-coded null on the belief that the pivot had no
       * such column. It does: beside `oc1_name: "Eintracht Frankfurt"` sits
       * `oc1_selection: "home"`, and beside `oc3_name: "Draw"` sits
       * `oc3_selection: "draw"` — the same vocabulary the NAS collection
       * stores. Every market read through this surface was therefore served
       * with no leg at all, leaving the grid to group outcomes on their
       * display names and collapsing any market whose names were not distinct.
       *
       * `canonicalLeg` stays as the fallback for a row that lacks the column.
       */
      normalized_selection:
        row[`oc${rec.outcome}_selection`] ??
        canonicalLeg(row[`oc${rec.outcome}_name`], row.home_team, row.away_team),
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
  const pivot = await cachedDrain(`odds:${sport}:${live}`, () =>
    drainBoard(live
      ? { sport, live: 'true', include_stale: 'true', market: BOARD_MARKET }
      // Upcoming fixtures only exist on this drain with `flucs=true` — see
      // UNSETTLED. Without it the ticker has no price to show for anything
      // that has not already been played.
      : { sport, include_stale: 'true', market: BOARD_MARKET, ...UNSETTLED }),
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
function impliedStatus(row, now, liveIds, sport) {
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
  /*
   * A format that runs for days is not finished because nobody is quoting it
   * right now.
   *
   * This is the rule that put "Final" on South Africa v Australia on day two of
   * a five-day Test. `liveIds` holds only fixtures a book is actively quoting
   * in-play, and between sessions — overnight, at a declaration, through rain —
   * nothing is. Past the fifteen-minute kick-off grace the fixture then fell to
   * `completed`, and the board reported a match in progress as over.
   *
   * So multi-day formats get the same six-day benefit of the doubt the Mongo
   * path already gives them, from the same shared rule. The trade is the one
   * this function already states: of the two possible errors, calling a running
   * game finished is much the worse. "Final" on a Test still being played is
   * wrong in a way anyone can see; a Test reading live for a day after it ends
   * is merely late.
   */
  const grace = isMultiDay(sport, row.optic_league) ? MULTI_DAY_GRACE_MS : KICKOFF_GRACE_MS;
  return now - start < grace ? 'live' : 'completed';
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
      drainBoard({ sport, live: 'true', market: BOARD_MARKET }),
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
/**
 * @param {object} [opts]
 * @param {boolean} [opts.history] Fetch the full price history. True for the
 *   event page, which draws it. False for callers that only want the current
 *   price — see the note on `flucs` below.
 */
/**
 * @param {object} [opts]
 * @param {boolean} [opts.currentOnly] Current prices only -- no ladder, no
 *   settled prices. For the ticker's comparison columns, which read
 *   `current_price` and nothing else. The event page leaves it false and gets
 *   the full history it draws.
 */
export async function apiOddsForFixture(fixtureId, sport, { currentOnly = false, opens = !currentOnly } = {}) {
  if (!sport) return [];
  const one = (extra) =>
    cachedDrain(`fx:${fixtureId}:${extra.live ?? '0'}:${currentOnly ? 'c' : 'h'}`, () =>
      drain('odds-api', {
        sport,
        fixture_id: fixtureId,
        include_stale: 'true',
        /*
         * `flucs` used to be the ONLY way to see an upcoming fixture here, so
         * dropping it to avoid buying the ladder silently emptied every one of
         * them -- bets priced fell from 96 of 150 to 50 and the columns read
         * blank. `include_unsettled` now does that job on its own, so the two
         * can finally be asked for separately.
         */
        ...(currentOnly ? { include_unsettled: 'true' } : { flucs: 'true' }),
        ...extra,
      }),
    ).catch(() => []);

  // No live pivot. This site shows pre-match prices only, so the in-play feed
  // is not a source here at all — see the merge note below.
  /*
   * `opens` is a SECOND REQUEST per fixture, and the settled view does not
   * read it.
   *
   * Measured on the live surface: every fixture here costs exactly two calls,
   * the pivot and this one. That is invisible at the forty fixtures the ticker
   * asks for and decisive at the 1,283 behind fourteen days of settled bets —
   * 2,566 requests, which at eight a second is 321 seconds against a
   * 300-second function. The settled build was therefore guaranteed to hit its
   * own deadline and return about half the window.
   *
   * Nothing in ticker.mjs reads `open_price`: the closing comparison is
   * `close_price` through `fairsFor`, and the "vs open" column on the pending
   * page comes from our own brand stores, not from here. The board, the event
   * page and movers do read it, so the default is unchanged and only the
   * caller that has no use for it opts out.
   */
  const [closing, sp] = await Promise.all([
    one({}),
    opens
      ? call('odds-sp-api', { fixture_id: fixtureId }).then((b) => b.data ?? []).catch(() => [])
      : Promise.resolve([]),
  ]);

  const explodeAll = (pivotRows, isLive) => {
    const out = [];
    for (const r of pivotRows) {
      if (r.optic_fixture_id !== fixtureId) continue;
      for (const row of explode(r, { live: isLive, unsettled: currentOnly })) {
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
/**
 * One fixture by id, outside the board's rolling window.
 *
 * Asked for BY ID rather than by date or by market, because neither narrowing
 * holds across the whole archive:
 *
 *   a third of fixture ids carry no date — 53,442 of 167,493 look like
 *   "afc_-_champions_league:0AB36224A28A" — so deriving the day from the id
 *   worked for the dated two thirds and silently returned nothing for the rest.
 *
 *   filtering to head-to-head loses any fixture that never had one. Darts,
 *   volleyball and rugby union fixtures exist with no h2h market at all, and
 *   their pages would not open while their odds sat there.
 *
 * Fanned out across sports because the id does not say which one it is. One
 * fixture per call is a small ask and the answer is cached, so it costs a
 * single cold page load.
 */
export async function apiFixtureById(fixtureId, sports) {
  if (!fixtureId) return null;
  const list = sports?.length ? sports : FALLBACK_SPORTS;

  const hits = await Promise.all(
    list.map(async (sport) => {
      const rows = await cachedDrain(`fx-by-id:${sport}:${fixtureId}`, () =>
        drain('odds-api', {
          sport, fixture_id: fixtureId, include_stale: 'true', ...UNSETTLED,
        }, { maxPages: 1 }),
      ).catch(() => []);
      const row = rows.find((r) => r.optic_fixture_id === fixtureId);
      return row ? { row, sport } : null;
    }),
  );
  const hit = hits.find(Boolean);
  return hit ? fixtureFromPivot(hit.row, hit.sport, Date.now(), new Set()) : null;
}

/**
 * Fixture metadata only, for callers that never ask whether a game is live.
 *
 * The ticker reads exactly seven fields off a fixture -- sport, category,
 * tournament, home_team, away_team, event_name, scheduled_start -- and not one
 * of them is live state. It was paying for all three of buildFixtures' drains
 * anyway, and on a cold build those were 4.7s of the ticker's 9.2s.
 *
 * Two of the three are kept because they decide WHICH fixtures exist, and both
 * share their cached result with the board (`odds:<sport>:false` and
 * `odds:<sport>:true`), so they are usually paid for already. The third,
 * liveRows, is dropped: it exists solely to work out which fixtures are in play,
 * its `live:<sport>` key is shared with nothing, and a third of the ticker's
 * upstream work went on an answer it discards.
 *
 * Deliberately NOT a thinner request. Dropping the live pivot too would lose the
 * fixtures that exist only there -- a game between the final whistle and
 * settlement has no active closing price -- and those are exactly the
 * just-finished games a bet feed is full of.
 */
export function apiFixtureIndex(sport) {
  // Short-lived, because the explode-and-map pass over every sport's pivot is
  // CPU the ticker was repeating on each build even when the drains were warm.
  return cached(`fxindex:${sport}`, PIVOT_TTL_MS, async () => {
    const w = boardWindow();
    const [closing, liveAll] = await Promise.all([
      cachedDrain(`odds:${sport}:false`, () =>
        drainSpan({ sport, include_stale: 'true', market: BOARD_MARKET, ...UNSETTLED },
          w.date_from, w.date_to),
      ),
      // Not worth waiting for here either — this index makes no live claim at
      // all (see NO_LIVE below), so these rows only ever add fixtures.
      cachedDrainSoon(`odds:${sport}:true`, () =>
        drainSpan({ sport, live: 'true', include_stale: 'true', market: BOARD_MARKET },
          w.date_from, w.date_to),
      ),
    ]);
    const now = Date.now();
    const byId = new Map();
    for (const r of [...liveAll, ...closing]) {
      if (!r.optic_fixture_id || byId.has(r.optic_fixture_id)) continue;
      // No live set: this index makes no claim about what is in play.
      byId.set(r.optic_fixture_id, fixtureFromPivot(r, sport, now, NO_LIVE));
    }
    return [...byId.values()];
  });
}

const NO_LIVE = new Set();

export async function apiFixtures(sport) {
  return buildFixtures(sport, boardWindow());
}

/**
 * One sport's fixtures for ONE calendar day, whatever the board window holds.
 *
 * The board reaches three days back and seven forward, and the date picker is
 * allowed past both ends. Filtering an already-built board cannot answer for a
 * day outside it — it returned an empty board and said nothing — so a day out
 * there is asked for directly. One request per sport per day, cached, which is
 * why it is not how the board itself is built.
 */
export async function apiFixturesForDay(sport, date) {
  return buildFixtures(sport, { date_from: date, date_to: date }, `:day:${date}`);
}

/**
 * `keySuffix` exists because the drain keys below deliberately carry no window.
 *
 * The board shares one cached drain per sport with apiOddsForSport, and that
 * sharing is load bearing — see the notes on each key. The consequence is that
 * the `window` argument is ignored the moment the cache is warm, so asking for
 * a different window with the same keys returns the BOARD's rows and nothing
 * says so. A per-day request passes its date as the suffix and gets its own
 * entry; the board passes nothing and keeps the shared one.
 */
async function buildFixtures(sport, window, keySuffix = '') {
  const [closing, liveAll] = await Promise.all([
    // SAME key apiOddsForSport uses. These two drain the identical request and
    // deliberately share one cached result; giving this one a window-specific
    // key split them in two, doubled the upstream work per sport, and the extra
    // drains then failed — which `pricesFor` swallows, so the deployed ticker
    // simply showed no comparison prices at all and said nothing was wrong.
    cachedDrain(`odds:${sport}:false${keySuffix}`, () =>
      drainSpan({ sport, include_stale: 'true', market: BOARD_MARKET, ...UNSETTLED },
        window.date_from, window.date_to),
    ),
    // Enumeration needs the stale live rows too. A match that has just finished
    // has no active price left, and is not yet settled into `odds_sp` — so it
    // is in neither of the other two queries, and fell off the board entirely
    // for the hour or so between the final whistle and settlement. Asking for
    // stale live rows is what covers that gap.
    // SAME key apiOddsForSport({ live: true }) uses, for the same reason the
    // closing drain above shares one: the request is byte-identical, and two
    // keys over one request is two drains. The pulse bar reads these rows for
    // the live heartbeat and must not pay for a second copy of them.
    cachedDrainSoon(`odds:${sport}:true${keySuffix}`, () =>
      drainSpan({ sport, live: 'true', include_stale: 'true', market: BOARD_MARKET },
        window.date_from, window.date_to),
    ),
  ]);
  /*
   * The live-ACTIVE drain is now fetched only if something actually needs it.
   *
   * Its rows exist for one purpose: `liveIds`, which `impliedStatus` consults
   * when the pivot carries no usable `fixture_status`. The surface publishes
   * that field on every row now — measured at 0 missing across 2,200 rows in
   * four sports — so this was a request per sport, sixteen of them on a cold
   * board, feeding a fallback that never fired.
   *
   * The test is the same one fixtureFromPivot applies, so the two cannot drift:
   * if no row needs the fallback, no drain is made, and liveness comes entirely
   * from the published status.
   *
   * Still actively-quoted prices only when it IS fetched — a stale live row
   * outlives its game, so the stale drain's rows would report finished matches
   * as in play.
   */
  const rows = [...liveAll, ...closing];
  const unknown = (r) => {
    const t = String(r.fixture_status ?? '').toLowerCase();
    return !t || t === 'unknown';
  };
  const liveActive = rows.some(unknown) ? await liveRows(sport).catch(() => []) : [];
  const liveIds = new Set(liveActive.map((r) => r.optic_fixture_id).filter(Boolean));
  const now = Date.now();
  const byId = new Map();
  // Live first, so an in-play fixture wins over any closing row for it — see
  // `rows` above, built before the liveActive decision because that decision
  // reads it.
  for (const r of rows) {
    if (!r.optic_fixture_id || byId.has(r.optic_fixture_id)) continue;
    byId.set(r.optic_fixture_id, fixtureFromPivot(r, sport, now, liveIds));
  }
  return [...byId.values()];
}

/**
 * `[17, 14, 10, 14]` -> `{ period_1: 17, period_2: 14, … }`, the shape the
 * board's period breakdown reads. Index 0 is period 1.
 */
function periodsFrom(scores) {
  if (!Array.isArray(scores)) return {};
  const out = {};
  scores.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[`period_${i + 1}`] = v;
  });
  return out;
}

/**
 * One pivot row as a fixture record. Shared with the by-id lookup.
 *
 * The result goes through `expireStaleLive` on the way out, because a published
 * status is only better than a guess for fixtures somebody upstream has closed.
 * Optic leaves finished games on `break` — see the note on that function — and
 * without this a basketball game two days over, 72-57 with every quarter
 * scored, reported itself live indefinitely.
 */
function fixtureFromPivot(r, sport, now, liveIds) {
  /*
   * The surface's own status wins, and `impliedStatus` is now only a fallback.
   *
   * It is derived from the fixture document rather than from scores, prices or
   * a clock, which is the one thing deriving it here could never do: our rule
   * had to treat "no book is quoting this in-play" as finished, and so reported
   * a Test in progress as Final between sessions.
   *
   * `unknown` is explicitly NOT trusted — it is the surface saying it does not
   * know, and guessing from the clock is better than asserting upcoming.
   */
  const given = String(r.fixture_status ?? '').toLowerCase();
  const status = given && given !== 'unknown' ? given : impliedStatus(r, now, liveIds, sport);
  /*
   * Has it actually been played? A score on an unplayed fixture is left over
   * from some other meeting, so one is only shown once the thing has started.
   *
   * Tested against the LIVE set rather than the string 'live', because the
   * status may now be the surface's own word — `in_play` or `break` — and this
   * line read `status === 'live'`, which would have blanked the scoreline on
   * every game actually in progress.
   */
  const live = LIVE.has(status);
  /*
   * A SUSPENDED match is none of those statuses and has a real score.
   *
   * Tennis fixture 2026101989BE5F03 (Ribecai v Vasami, Florence Challenger)
   * started 2026-10-19T15:02Z, played to one set each — 4-6, 6-0 — and was
   * suspended. The feed briefly called it `completed` and settled it, then
   * corrected itself to `upcoming` with a resume time the following morning.
   * Correct, and it left this guard reporting no score for a match whose
   * scoreline is the single most useful thing about it: it restarts at one set
   * each.
   *
   * `actual_start` is the honest test for "has this begun" — a fixture that has
   * never run carries none, which is what the stale-score worry above is really
   * about. Kept as an OR rather than a replacement, because the reverse also
   * happens: fixtures arrive `completed` with no actual_start at all.
   *
   * A score is required alongside it so that an actual_start on its own, which
   * upstream has been known to stamp early, cannot put an empty scoreline on an
   * unplayed game.
   */
  const begun = r.actual_start != null && (r.home_score != null || r.away_score != null);
  const played = live || status === 'completed' || status === 'final' || begun;
  const record = {
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
      actual_start: r.actual_start ?? null,
      // `in_play` and `break` are both a game being played — see LIVE.
      is_live: live,
      status,
      /** Optic's raw word, for when the mapped one looks wrong. */
      source_status: r.source_status ?? null,
      // Stamped only on a completed fixture and never synthesised, unlike
      // `fixtures.settled_at`, which is start+4h on 2,017 of 2,048 rows.
      end_date: r.finished_at ?? null,
      current_round: null,
      scores: played
        ? {
            home: { total: r.home_score ?? null, periods: periodsFrom(r.home_period_scores) },
            away: { total: r.away_score ?? null, periods: periodsFrom(r.away_period_scores) },
          }
        : null,
      /*
       * Null when nothing is in play, matching the fixtures store rather than
       * an object of nulls -- `period == null` is what the badge reads as
       * "LIVE", and that should mean "not in play", not "in play, unknown".
       *
       * `clock` is passed through exactly as the surface sends it: MM:SS for
       * the countdown sports, a bare minute count for soccer. The label does
       * that formatting, and a clock is never synthesised when the feed omits
       * one -- eight of 29 live fixtures run without one.
       */
      in_play_data:
        r.period_number != null || r.period != null || r.clock != null || r.is_clock_stopped != null
          ? {
              period_number: r.period_number ?? null,
              period: r.period ?? null,
              clock: r.clock ?? null,
              is_clock_stopped: r.is_clock_stopped ?? false,
            }
          : null,
      // For the status bar: the fixture row's own write time, and the moment a
      // score last changed. The latter is null until the store stamps it, and
      // is never derived from price movement — see pulse.mjs.
      updated_at: r.fixture_updated_at ?? null,
      score_updated_at: r.score_updated_at ?? null,
      has_odds: true,
  };
  // See the note above the function: a status nobody upstream closed.
  return expireStaleLive(record);
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
