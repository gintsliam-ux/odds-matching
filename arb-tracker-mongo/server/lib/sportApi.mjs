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
/**
 * A rate limit gets more goes than a failure does.
 *
 * Two retries is the right budget for something broken — a third attempt at a
 * 500 is usually a third 500. A 429 is the opposite: it is the surface saying
 * "not yet", and since a 429 now pauses the whole bucket (see pauseAll) the
 * next attempt starts on the far side of that pause, when the window has
 * actually moved. Giving up after three attempts was costing a whole sport
 * off the board to save two requests.
 */
const RATE_LIMIT_RETRIES = 5;
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

/**
 * When a 429 arrives, EVERY request waits, not just the one that got it.
 *
 * This is the piece the bucket was missing. A cold board opens about fifty
 * requests across sixteen sports; the bucket paces them at eight a second,
 * and the first 429 came back while the other forty-nine were still queued
 * behind it. Each of those then spent its token into a surface that had
 * already said stop, collected its own 429, and retried — so one rate-limit
 * answer became dozens, and the drain burned its retry budget on requests
 * that could not have succeeded. Five of fifteen sports failing on a run that
 * should comfortably fit inside ten a second is what that looks like.
 *
 * The limit is published per KEY, so the thing being rate-limited is all of
 * us at once; pausing one caller while the rest carry on is not a response to
 * it. The shared pause is, and it is cheap: `retry_after_sec` is typically 1.
 */
let pausedUntil = 0;

/**
 * Whether the surface has told us this key is not rate-limited at all.
 *
 * The surface exempts its own keys and says so with
 * `X-RateLimit-Limit: unlimited` on every answer. Once seen, the bucket below
 * is skipped: pacing ourselves at eight a second against a limit that does
 * not exist only made the board slower. A 429 can still arrive (the in-flight
 * cap, or an older surface), and `pauseAll` still applies to it.
 */
let unlimited = false;

/** Hold every request back for as long as the surface asked. */
function pauseAll(ms) {
  const until = Date.now() + Math.min(ms, RETRY_AFTER_CAP_MS);
  if (until > pausedUntil) pausedUntil = until;
}

async function takeToken() {
  for (;;) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (unlimited) return;
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
  /** Raised to RATE_LIMIT_RETRIES the moment we are told we are too fast. */
  let budget = CALL_RETRIES;
  for (let attempt = 0; attempt <= budget; attempt++) {
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
      if (res.headers.get('x-ratelimit-limit') === 'unlimited') unlimited = true;
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
        /*
         * Hold the whole bucket, not just this call. The body carries
         * `retry_after_sec` even where the header does not, and a second is
         * the usual answer — cheap against losing a sport off the board.
         */
        if (res.status === 429) {
          const body429 = Number(/"retry_after_sec"\s*:\s*(\d+(?:\.\d+)?)/.exec(body)?.[1]);
          const ms = retryAfterMs ?? (Number.isFinite(body429) ? body429 * 1000 : 1000);
          pauseAll(ms);
          budget = Math.max(budget, RATE_LIMIT_RETRIES);
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
    if (attempt < budget) {
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
function cachedDrain(key, produce, ttlMs = PIVOT_TTL_MS) {
  const hit = pivotCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit?.value && age < ttlMs) return hit.value;

  const refresh = hit?.inflight ?? beginDrain(key, produce, hit);
  if (hit?.value && age < 3 * ttlMs) return hit.value;
  return refresh;
}

/** One fixture's in-play rows, for the event page's live view (see apiOddsForFixture). */
const FX_LIVE_TTL_MS = 5_000;

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
 * brings unsettled fixtures through (the board carries unsettled fixtures), the forward edge is the
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

/** How long after a scheduled start a fixture is presumed in play rather than
 *  finished, while waiting for a book to open its in-play market. */
const KICKOFF_GRACE_MS = 15 * 60_000;

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
/* ------------------------------------------------------------ board reads */

/*
 * The board and everything derived from it come from the surface's /board:
 * one call per sport returns every fixture in the window with status, scores
 * and clock, plus every moneyline row on it, already in this site's row
 * shape. Before this the same data was assembled from the wide odds pivot —
 * a drain per sport per market, bisected on the row cap, then exploded back
 * into fixtures and prices — which cost 15-20s a sport and ~290 requests on
 * a cold instance. /board answers in well under a second, so the pivot
 * machinery (drainSpan, explode, mergeOpens) is gone with it.
 */
const BOARD_TTL_MS = 15_000;
/** An in-play row older than this is a book that has stopped quoting. */
const LIVE_FRESH_MS = 3 * 60_000;

const canonicalRow = (r) => ({ ...r, sportsbook: canonicalBook(r.sportsbook) });
const isFresh = (r, now) => !!r.current_at && now - Date.parse(r.current_at) < LIVE_FRESH_MS;
/** The fixtures a book is actively quoting in-play right now. */
const quotedLiveIds = (prices, now) =>
  new Set(
    prices
      .filter((r) => r.is_live && r.status === 'active' && isFresh(r, now))
      .map((r) => r.fixture_id),
  );

const EMPTY_BOARD = Object.freeze({ fixtures: [], prices: [] });

/**
 * Whether the surface answers `sport=all`. Flipped off on the first 400 that
 * says it does not — an older surface — and the board goes back to one call
 * per sport. Never flipped back: a restart of this instance tries again.
 */
let allSupported = true;

/**
 * The whole board in ONE request, split per sport.
 *
 * Sixteen requests per sport per instance was the board's own rate-limit
 * problem: a cold instance opened them together, the surface answered some
 * with 429, and a sport fell off the board (see allEvents). One request
 * cannot be partially rate-limited, and the surface reads all sixteen sports
 * in a single pass over its fixtures index.
 */
function boardAll(window) {
  return cachedDrain(
    'board:all',
    async () => {
      const body = await call('board', { sport: 'all', date_from: window.date_from, date_to: window.date_to });
      const bySport = new Map();
      const sportOf = new Map();
      for (const f of body.data ?? []) {
        const sport = f.sport;
        if (!sport) continue;
        sportOf.set(f.optic_fixture_id, sport);
        if (!bySport.has(sport)) bySport.set(sport, { fixtures: [], prices: [] });
        bySport.get(sport).fixtures.push(f);
      }
      // Price rows carry no sport; they follow their fixture.
      for (const r of body.prices ?? []) {
        const sport = sportOf.get(r.fixture_id);
        if (sport) bySport.get(sport).prices.push(canonicalRow(r));
      }
      return bySport;
    },
    BOARD_TTL_MS,
  );
}

function boardOne(sport, window, keySuffix = '') {
  return cachedDrain(
    `board:${sport}${keySuffix}`,
    async () => {
      const body = await call('board', { sport, date_from: window.date_from, date_to: window.date_to });
      return { fixtures: body.data ?? [], prices: (body.prices ?? []).map(canonicalRow) };
    },
    BOARD_TTL_MS,
  );
}

/**
 * One sport's slice of the board window. The default window comes out of the
 * single all-sports call; a day outside it (keySuffix) is still its own request.
 */
function boardFor(sport, window, keySuffix = '') {
  if (keySuffix || !allSupported) return boardOne(sport, window, keySuffix);
  return boardAll(window).then(
    (bySport) => bySport.get(sport) ?? EMPTY_BOARD,
    (err) => {
      if (/Invalid sport/i.test(err?.message ?? '')) {
        allSupported = false;
        return boardOne(sport, window, keySuffix);
      }
      throw err;
    },
  );
}

const PROP_TTL_MS = 15_000;

/**
 * Player-market prices for one fixture, asked of Optic through the surface at
 * request time and never stored: the capture keeps no player props, so a bet
 * on "Tatum 25+ points" has no row to be compared against anywhere else.
 * `markets` are Optic's display names ("Player Points", "1st Quarter Player
 * Rebounds"). Rows come back in the OddsRow shape: selection is the player,
 * line the number, outcome_no 1 over / 2 under, market_name the Optic name.
 */
export async function apiPropOdds(fixtureId, markets) {
  const list = [...new Set((markets ?? []).filter(Boolean))].sort();
  if (!fixtureId || !list.length) return [];
  const body = await cachedDrain(
    `prop:${fixtureId}:${list.join('|')}`,
    () => call('prop-odds', { id: fixtureId, market: list.join(',') }),
    PROP_TTL_MS,
  );
  return (body.data ?? []).map(canonicalRow);
}

/**
 * Fixtures matching a team, event or tournament name, any sport and any date,
 * as fixture records. The surface's /search: a whole word from its text index,
 * a fragment from a bounded regex. Throws on an older surface without the
 * route; the caller falls back to filtering the board.
 */
export async function apiSearch(term, limit = 60) {
  const q = String(term ?? '').trim();
  if (q.length < 2) return [];
  const body = await cachedDrain(
    `search:${q.toLowerCase()}:${limit}`,
    () => call('search', { q, limit: String(limit) }),
    BOARD_TTL_MS,
  );
  const now = Date.now();
  const prices = (body.prices ?? []).map(canonicalRow);
  const liveIds = quotedLiveIds(prices, now);
  return (body.data ?? []).map((r) => fixtureFromPivot(r, r.sport, now, liveIds));
}

/**
 * Every moneyline row the surface has for a sport in the board window —
 * pregame by default, in-play with `live`. Stale in-play rows are included,
 * as they always were; callers that want only what is quoted now filter on
 * status and current_at (see quotedLiveIds).
 */
export async function apiOddsForSport(sport, { live = false } = {}) {
  const { prices } = await boardFor(sport, boardWindow());
  return prices.filter((r) => r.is_live === live);
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
  // unsettled fixtures through (the board carries unsettled fixtures), a future start is a fact worth
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
 * Every odds row of one fixture, one side of is_live, in this site's row
 * shape with the full price history — the same rows a local instance reads
 * off the collection. `currentOnly` asks for the slim form (no history) for
 * callers that read the current price and nothing else, such as the ticker.
 */
export async function apiOddsForFixture(fixtureId, _sport, { live = false, currentOnly = false } = {}) {
  if (!fixtureId) return [];
  const view = live ? 'live' : 'pre';
  const body = await cachedDrain(
    `fx:${fixtureId}:${view}:${currentOnly ? 's' : 'h'}`,
    () => call('fixture-odds', { id: fixtureId, view, ...(currentOnly ? { slim: '1' } : {}) }),
    live ? FX_LIVE_TTL_MS : BOARD_TTL_MS,
  );
  return (body.data ?? []).map(canonicalRow);
}
/**
 * One fixture by id, any sport, outside the board's window if need be. The
 * surface looks it up by id, so this no longer fans out across every sport.
 */
const LIVE_FIXTURE_TTL_MS = 3_000;

/**
 * One fixture by id. With `live`, the open page's in-play re-read: the score
 * and clock are what it is after, so the copy lives three seconds rather
 * than the board window's fifteen.
 */
export async function apiFixtureById(fixtureId, { live = false } = {}) {
  if (!fixtureId) return null;
  let body;
  try {
    body = await cachedDrain(
      `fixture:${fixtureId}${live ? ':live' : ''}`,
      () => call('fixture', { id: fixtureId }),
      live ? LIVE_FIXTURE_TTL_MS : BOARD_TTL_MS,
    );
  } catch (e) {
    if (/ 404:/.test(String(e?.message))) return null;
    throw e;
  }
  const r = body?.data;
  if (!r) return null;
  const now = Date.now();
  return fixtureFromPivot(r, r.sport, now, quotedLiveIds((body.prices ?? []).map(canonicalRow), now));
}
/** The fixtures the surface knows about for a sport, in board shape. */
export function apiFixtureIndex(sport) {
  return apiFixtures(sport);
}

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
async function buildFixtures(sport, window, keySuffix = '') {
  const { fixtures, prices } = await boardFor(sport, window, keySuffix);
  const now = Date.now();
  const liveIds = quotedLiveIds(prices, now);
  return fixtures.map((r) => fixtureFromPivot(r, sport, now, liveIds));
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
