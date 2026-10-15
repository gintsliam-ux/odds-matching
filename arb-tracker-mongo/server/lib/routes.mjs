/**
 * The API surface, independent of how it is served.
 *
 * Two hosts use this table: `server/index.mjs` (a plain node:http server, for
 * local and on-NAS runs) and `api/index.mjs` (a Vercel function). Keeping the
 * routes here means the deployed API and the local one cannot drift.
 *
 * Several routes only have data on the Mongo source — bets and mapping join
 * tables that the public odds surface does not publish. Rather than 404 or
 * return a misleading empty list, they say which source is running and what it
 * cannot do; the UI reads `capabilities` and hides those features outright.
 */
import { coll, mirrorConfigured } from './mongo.mjs';
import { betTicker } from './ticker.mjs';
import { CAPABILITIES, DATA_SOURCE, isMongo } from './source.mjs';
import { marketMovers } from './movers.mjs';
import { delayedSettlements, lateBets } from './exposure.mjs';
import { apiHealth } from './sportApi.mjs';
import { betsForFixture } from './bets.mjs';
import {
  addTabCompetition, clearTournamentMapping, saveTabMapping, saveTournamentMapping,
  saveTournamentMappings, tabMapping, tournamentMapping,
} from './mapping.mjs';
import { closeBets } from './betsMongo.mjs';
import { cached, invalidate } from './cache.mjs';
import { fetchPulse } from './pulse.mjs';
import {
  cachedBoard, eventById, eventDetails, eventsForDay, h2hPrices, oddsForFixture, searchEvents,
} from './queries.mjs';
import {
  authenticate, cookieHeader, createUser, deleteUser, listUsers, sessionFromCookies, verifyHandoff,
  signSession, updateUser,
} from './auth.mjs';

/* --------------------------------------------------------------- caching */

// The board and the pulse are polled on a 60s timer by every open tab, so they
// are cached just under that. Per-fixture odds are cheap (one indexed read) but
// get hammered when you click through a list, so they get a short TTL too.
const TTL = { board: 45_000, pulse: 45_000, odds: 10_000, day: 5 * 60_000, meta: 10 * 60_000, bets: 60_000, mapping: 5 * 60_000 };

/* ---------------------------------------------------------------- routes */

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
};

/**
 * Reference tables, served whole. `gutsys_sport` carries the book roster, the
 * league list and the market rules that the UI currently hard-codes; exposing
 * them here is what lets the next table be wired up without touching the
 * transport.
 */
async function meta() {
  const [books, leagues, marketRules] = await Promise.all([
    (await coll('books')).find({}).project({ _id: 0 }).toArray(),
    (await coll('leagues')).find({ active: true }).project({ _id: 0 }).toArray(),
    (await coll('marketRules')).find({}).project({ _id: 0 }).toArray(),
  ]);
  return { books, leagues, marketRules };
}

const ROUTES = {
  'GET /api/events': () => cachedBoard(),

  'GET /api/events/day': (url) => {
    const date = url.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return cached(`day:${date}`, TTL.day, () => eventsForDay(date));
  },

  'GET /api/event': (url) => {
    const id = url.searchParams.get('id') ?? '';
    return cached(`event:${id}`, TTL.board, () => eventById(id));
  },

  // Lazily loaded by the Details tab, so it is not on the board's hot path.
  'GET /api/event/details': (url) => {
    const id = url.searchParams.get('id') ?? '';
    // The API source is queried per sport; the Mongo path ignores it.
    const sport = url.searchParams.get('sport') ?? '';
    return cached(`details:${id}`, TTL.odds, () => eventDetails(id, sport));
  },

  // Bets live on a different cluster and are only read when the tab is opened.
  // The cross-sport bet feed. Cheap enough to serve live; see ticker.mjs.
  'GET /api/ticker': () => cached('ticker', TTL.bets, betTicker),

  'GET /api/bets': async (url) => {
    const id = url.searchParams.get('fixtureId') ?? '';
    if (!id) return { configured: false };
    return cached(`bets:${id}`, TTL.bets, () => betsForFixture(id));
  },

  // The mapping table: every optic league beside its provider counterparts.
  // Expensive (it reads squads from three feeds), so it is cached and only
  // built when the page asks.
  // Head-to-head prices that have moved, and who has not moved with them.
  'GET /api/movers': (url) => {
    const win = url.searchParams.get('window') ?? '6h';
    const minMove = Number(url.searchParams.get('minMove') ?? 5);
    const minBooks = Number(url.searchParams.get('minBooks') ?? 3);
    const key = `movers:${win}:${minMove}:${minBooks}`;
    return cached(key, TTL.board, () => marketMovers({
      window: win,
      minMove: Number.isFinite(minMove) ? minMove : 5,
      minBooks: Number.isFinite(minBooks) ? minBooks : 3,
    }));
  },

  'GET /api/mapping/tournaments': () => cached('mapping:tournaments', TTL.mapping, tournamentMapping),

  // The TAB scraper's own competition list. Its `optic_league` is what the
  // scraper reads to decide what to fetch, so this page fills that field —
  // see tabMapping.
  'GET /api/mapping/tab': () => cached('mapping:tab', TTL.mapping, tabMapping),

  'POST /api/mapping/tab': async (_url, body) => {
    const out = await saveTabMapping(body ?? {});
    invalidate('mapping:tab');
    return out;
  },

  // A competition the scrape has never listed, so there is no row to edit.
  'POST /api/mapping/tab/add': async (_url, body) => {
    const out = await addTabCompetition(body ?? {});
    invalidate('mapping:tab');
    return out;
  },

  'POST /api/mapping/tournament': async (_url, body) => {
    const out = await saveTournamentMapping(body ?? {});
    invalidate('mapping:tournaments');
    return out;
  },

  // Both providers in one batch — see saveTournamentMappings.
  'POST /api/mapping/tournaments/apply': async (_url, body) => {
    const out = await saveTournamentMappings(body?.items ?? []);
    invalidate('mapping:tournaments');
    return out;
  },

  'POST /api/mapping/tournament/clear': async (_url, body) => {
    const out = await clearTournamentMapping(body ?? {});
    invalidate('mapping:tournaments');
    return out;
  },

  'GET /api/search': (url) => searchEvents(url.searchParams.get('q') ?? ''),

  'GET /api/odds': (url) => {
    const id = url.searchParams.get('fixtureId') ?? '';
    // The API source needs the sport to know which pivot to pull.
    const sport = url.searchParams.get('sport') ?? '';
    // The sport belongs in the key. Without it the first caller's sport answered
    // for every later one, so a request that would have returned nothing was
    // served a warm, correct result instead — which is exactly what hid the
    // capitalisation bug above until the network tab showed the real URL.
    return cached(`odds:${id}:${sport}`, TTL.odds, () => oddsForFixture(id, sport));
  },

  // The ticker asks about the whole board at once. A POST carries the id list
  // without blowing past URL limits, but it is also uncacheable and — behind
  // Vercel's deployment protection — refused outright. So GET is the real path:
  // no ids means "whatever is on the board", which the CDN can cache like any
  // other read. POST stays for callers that want a specific subset.
  'GET /api/h2h': async () => {
    const board = await cachedBoard();
    return h2hPrices(board.filter((e) => !e.outright).map((e) => e.id));
  },

  'POST /api/h2h': (_url, body) => h2hPrices(body?.fixtureIds ?? []),

  /*
   * The one payload that must not be served stale: it reports how fresh every
   * other feed is, so an old copy of it is not slightly out of date, it is
   * wrong. Ten seconds is enough to still share one computation across a burst
   * of callers.
   */
  /*
   * Markets the book has not resulted on a game Optic says is over, and bets
   * taken after the game started. Both read the bets cluster, so both are
   * mirror-served and unavailable where the bets database is not.
   */
  'GET /api/settlement': (url) => cached(
    `settlement:${url.searchParams.get('mins') ?? ''}`,
    TTL.bets,
    () => delayedSettlements({ minMins: Number(url.searchParams.get('mins') ?? 30) }),
  ),

  'GET /api/late-bets': (url) => cached(
    `late:${url.searchParams.get('after') ?? ''}:${url.searchParams.get('hours') ?? ''}`,
    TTL.bets,
    () => lateBets({
      afterMins: Number(url.searchParams.get('after') ?? 1),
      hours: Number(url.searchParams.get('hours') ?? 24),
    }),
  ),

  'GET /api/pulse': () => cached('pulse', TTL.pulse, fetchPulse, { maxStaleMs: 10_000 }),

  'GET /api/meta': () => cached('meta', TTL.meta, meta),

  'GET /api/health': async () => {
    if (!isMongo) {
      const ok = await apiHealth();
      return { ok, source: DATA_SOURCE, upstream: process.env.SPORT_API_URL || 'https://sport.gutsysapi.com' };
    }
    const n = await (await coll('fixtures')).countDocuments({ has_odds: true }, { limit: 1 });
    return { ok: true, source: DATA_SOURCE, db: process.env.MONGO_DB || 'gutsys_sport', priceable: n > 0 };
  },
};

/**
 * Keep the two polled reads warm. Only the long-lived host calls this — a
 * serverless function has no process to keep anything warm in.
 */
export function warmCaches() {
  const tick = async () => {
    try {
      await cachedBoard();
      if (isMongo) await cached('pulse', TTL.pulse, fetchPulse);
    } catch (err) {
      console.warn('[warm] refresh failed:', err instanceof Error ? err.message : err);
    }
  };
  tick();
  setInterval(tick, 30_000).unref();
}

/** A route that needs Mongo, when Mongo is not what is running. */
function unavailable(feature) {
  return {
    error: 'unavailable',
    feature,
    source: DATA_SOURCE,
    detail:
      `This instance reads the public odds surface, which does not publish ${feature}. ` +
      'Run against gutsys_sport directly for that.',
  };
}

/**
 * Routes the Atlas mirror can serve on its own.
 *
 * The mirror carries event_mapping, competition_mapping, entities, leagues and
 * the precomputed league_squads summary — enough for bets (whose own rows are
 * already on Atlas and only needed the fixture join) and for the mapping table.
 * It deliberately does NOT carry `odds` (10.7 GB), so event details, which
 * aggregates it for the coverage block, stays NAS-only.
 *
 * Mapping writes are included: they land on the mirror (so the page updates at
 * once) and queue an intent that the hourly tailnet agent replays onto the NAS
 * before rebuilding the mirror from it.
 */
const MIRROR_SERVES = new Set([
  'GET /api/bets',
  'GET /api/ticker',
  'GET /api/settlement',
  'GET /api/late-bets',
  'GET /api/mapping/tournaments',
  // Writes land on the mirror and queue an intent the tailnet agent replays
  // onto gutsys_sport — see queueForNas in mapping.mjs. Without that queue a
  // save here would be erased by the next sync, which is why these were
  // refused until the loop was closed.
  'POST /api/mapping/tournament',
  'POST /api/mapping/tournaments/apply',
  'POST /api/mapping/tournament/clear',
  // Same loop for the TAB list: the row lands on the mirror and the agent
  // replays the optic_league onto the NAS, which is where the scraper reads it.
  'GET /api/mapping/tab',
  'POST /api/mapping/tab',
  'POST /api/mapping/tab/add',
  // Assembled from the board row, the mirrored mapping tables and the odds the
  // event page already holds — see apiEventDetails. Not everything the Mongo
  // path shows, but the mapping block is the point of the tab.
  'GET /api/event/details',
]);

/** Routes whose data only exists on the Mongo source, and why. */
const MONGO_ONLY = {
  'GET /api/bets': 'bets',
  'GET /api/ticker': 'the bet feed',
  'GET /api/settlement': 'the bet feed',
  'GET /api/late-bets': 'the bet feed',
  'GET /api/mapping/tournaments': 'the mapping tables',
  'POST /api/mapping/tournament': 'the mapping tables',
  'POST /api/mapping/tournaments/apply': 'the mapping tables',
  'POST /api/mapping/tournament/clear': 'the mapping tables',
  'GET /api/mapping/tab': 'the TAB competition list',
  'POST /api/mapping/tab': 'the TAB competition list',
  'POST /api/mapping/tab/add': 'the TAB competition list',
  'GET /api/meta': 'the reference tables',
  'GET /api/event/details': 'fixture detail',
};

/**
 * Everything behind a sign-in, with the two exceptions that cannot be.
 *
 * `/api/auth` is how you sign in (and `/api/auth/handoff` how you arrive signed
 * in from the Margin Comparison dashboard), and `/api/capabilities` is what the
 * shell reads before it knows who you are. Everything else is the desk's own data.
 */
/**
 * What a `trading` account may read.
 *
 * The role exists to see one team's or player's prices and the bet ticker, and
 * nothing that lists the market at large: not the board, not the movers page,
 * not the mapping tables, not the bets archive.
 *
 * Enforced HERE rather than only in the client's routing, because a hidden link
 * is not a restriction — the endpoints are a cookie and a curl away. The
 * client-side redirect exists so a trading user is never shown a page that
 * would then fail to load; this is the part that decides.
 *
 * An allow-list, so a route added later is denied to trading until someone
 * decides otherwise. The opposite default would hand every new endpoint over
 * silently.
 */
const TRADING_ALLOWED = new Set([
  // The ticker, and what the page needs to render a row.
  'GET /api/ticker',
  'GET /api/meta',
  // Team/player search, the prices for one fixture, and the fixture itself.
  'GET /api/search',
  'GET /api/odds',
  'GET /api/event',
  'GET /api/event/details',
  'GET /api/health',
  // The board and the strip across the top of it, with the feed heartbeats
  // that sit above them — without the pulse the bar never leaves its skeleton.
  'GET /api/events',
  'GET /api/events/day',
  'GET /api/h2h',
  'POST /api/h2h',
  'GET /api/pulse',
  // Settlement and late bets are for everyone.
  'GET /api/settlement',
  'GET /api/late-bets',
]);

/**
 * Price history a trading account does not get: the current price only.
 *
 * Stripped from the payload rather than hidden in the client, for the same
 * reason the route list is enforced here — a column the browser is told not to
 * draw is still a column it was sent. `current_price` and the per-book status
 * survive; the ladder, the opening and closing prices and the daily series do
 * not.
 */
const HISTORY_FIELDS = [
  'flucs', 'daily_prices', 'open_price', 'open_at', 'close_price', 'closed_at',
  'price_6h', 'price_3h', 'price_1h', 'price_30m', 'price_10m',
];

function stripHistory(body) {
  if (!Array.isArray(body)) return body;
  return body.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const f of HISTORY_FIELDS) delete out[f];
    return out;
  });
}

const PUBLIC = new Set(['/api/auth', '/api/auth/handoff', '/api/capabilities']);

/** Auth is on when there is a secret to sign with. */
const AUTH_CONFIGURED = Boolean(process.env.AUTH_SECRET);

/* ------------------------------------------------------------- auth routes */

/**
 * Look at the desk as another role, on the local build only.
 *
 * `VIEW_AS=trading npm run dev` serves every request as though the signed-in
 * account held that role — the nav loses what it cannot reach, the ticker locks
 * to the over-the-odds rows, and the price grid arrives with its history
 * stripped. It exists because the trading view could not be reviewed any other
 * way without someone's password, and a restricted view nobody can see is one
 * nobody can check.
 *
 * Two deliberate limits, because this is a role override and those are worth
 * being careful with:
 *
 *   It only ever RESTRICTS. `trading` is the one value accepted, so this cannot
 *   hand anybody admin — the failure mode is a view that shows too little.
 *
 *   It is ignored unless this instance reads Mongo directly, which only the
 *   tailnet build does. Setting it in the deployed environment does nothing at
 *   all; `isApi` is checked, not an env flag that could be set by mistake.
 *
 * The COOKIE keeps the real role. Nothing is written, so unsetting the variable
 * restores the account with no trace left behind.
 */
const VIEW_AS = isMongo && process.env.VIEW_AS === 'trading' ? 'trading' : null;

/** The session as this instance should treat it. */
const whoami = (cookies) => {
  const me = sessionFromCookies(cookies);
  return me && VIEW_AS ? { ...me, role: VIEW_AS } : me;
};

async function authRoute(method, searchParams, body, cookies) {
  if (method === 'GET') {
    const me = whoami(cookies);
    if (!me) return { status: 401, body: { error: 'not signed in' } };
    // Slide the window forward, so a desk in use never expires — only a real
    // absence long enough to outrun the cookie's life signs you out.
    return { status: 200, body: { user: me }, headers: { 'set-cookie': cookieHeader(signSession(me)) } };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'GET or POST only' } };

  const b = body ?? {};
  if (b.action === 'logout') {
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': cookieHeader(null) } };
  }
  if (!b.username || !b.password) {
    return { status: 400, body: { error: 'username and password required' } };
  }
  const user = await authenticate(b.username, b.password);
  // Deliberately vague — do not say which half was wrong.
  if (!user) return { status: 401, body: { error: 'Incorrect username or password' } };
  // The cookie carries the real role; the body carries the role being viewed,
  // so the client does not believe it is an admin until its next session poll.
  return {
    status: 200,
    body: { user: VIEW_AS ? { ...user, role: VIEW_AS } : user },
    headers: { 'set-cookie': cookieHeader(signSession(user)) },
  };
}

/**
 * GET /api/auth/handoff?t=<ticket>&to=/event/...: sign in from a Margin
 * Comparison ticket (see verifyHandoff), then go to the page. A bad, expired
 * or reused ticket just goes to the page without a session, where the usual
 * sign-in shows.
 */
async function handoffRoute(method, searchParams) {
  if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
  const raw = searchParams.get('to');
  // only a path on this site, never another host
  const to = raw && /^\/(?!\/)[\w\-./%?=&]*$/.test(raw) ? raw : '/';
  const user = AUTH_CONFIGURED ? await verifyHandoff(searchParams.get('t')).catch(() => null) : null;
  const headers = { location: to, 'referrer-policy': 'no-referrer' };
  if (user) headers['set-cookie'] = cookieHeader(signSession(user));
  return { status: 302, body: null, headers };
}

async function usersRoute(method, body, me) {
  if (me.role !== 'admin') return { status: 403, body: { error: 'admins only' } };
  try {
    if (method === 'GET') return { status: 200, body: { users: await listUsers() } };
    if (method === 'POST') {
      return { status: 200, body: { user: await createUser(body?.username, body?.password, body?.role) } };
    }
    if (method === 'PATCH') {
      const { id, ...patch } = body ?? {};
      return { status: 200, body: { user: await updateUser(id, patch) } };
    }
    if (method === 'DELETE') {
      await deleteUser(body?.id, me.id);
      return { status: 200, body: { ok: true } };
    }
  } catch (e) {
    return { status: 400, body: { error: String(e?.message ?? e) } };
  }
  return { status: 405, body: { error: 'unsupported method' } };
}

/**
 * Run one request against the table. Returns `{ status, body, headers? }` so
 * each host only has to deal with its own transport.
 */
export async function handleApi({ method, pathname, searchParams, body, cookies }) {
  const path = pathname.replace(/\/$/, '') || '/';
  const key = `${method} ${path}`;

  if (key === 'GET /api/capabilities') {
    /*
     * Role-aware, though the route stays public: a trading account is served
     * the current price and no history, so the UI must not offer a hover card
     * that would open onto nothing. Read from the cookie when there is one and
     * fall through to the instance's own answer when there is not.
     */
    const who = AUTH_CONFIGURED ? whoami(cookies) : null;
    const noHistory = who?.role === 'trading'
      ? { priceHistory: false, priceSeries: false }
      : null;
    return { status: 200, body: { ...CAPABILITIES, ...noHistory, auth: AUTH_CONFIGURED } };
  }

  /*
   * Fail CLOSED when there is no secret. Serving the desk's data because a
   * config value went missing is the one outcome worth refusing outright, and
   * a 503 that says why is findable where a silently public site is not.
   */
  if (!AUTH_CONFIGURED && !PUBLIC.has(path)) {
    return { status: 503, body: { error: 'auth is not configured on this instance (AUTH_SECRET is unset)' } };
  }

  if (path === '/api/auth') return authRoute(method, searchParams, body, cookies);
  if (path === '/api/auth/handoff') return handoffRoute(method, searchParams);

  const me = AUTH_CONFIGURED ? whoami(cookies) : null;
  if (AUTH_CONFIGURED && !me) return { status: 401, body: { error: 'not signed in' } };

  if (path === '/api/users') return usersRoute(method, body, me);

  const handler = ROUTES[key];
  if (!handler) return { status: 404, body: { error: 'not found' } };

  if (me?.role === 'trading' && !TRADING_ALLOWED.has(key)) {
    return { status: 403, body: { error: 'not available to this account' } };
  }

  if (!isMongo && MONGO_ONLY[key] && !(mirrorConfigured && MIRROR_SERVES.has(key))) {
    // 200, not an error: the client asked a reasonable question and the honest
    // answer is "not here", which it renders as a notice rather than a failure.
    return { status: 200, body: unavailable(MONGO_ONLY[key]) };
  }

  const url = { searchParams };
  const out = await handler(url, body);
  // The current price only — see HISTORY_FIELDS.
  if (me?.role === 'trading' && key === 'GET /api/odds') {
    return { status: 200, body: stripHistory(out) };
  }
  return { status: 200, body: out };
}
