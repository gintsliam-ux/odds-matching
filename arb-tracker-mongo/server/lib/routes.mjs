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
import { CAPABILITIES, DATA_SOURCE, isMongo } from './source.mjs';
import { apiHealth } from './sportApi.mjs';
import { betsForFixture } from './bets.mjs';
import {
  clearTournamentMapping, saveTournamentMapping, saveTournamentMappings, tournamentMapping,
} from './mapping.mjs';
import { closeBets } from './betsMongo.mjs';
import { cached, invalidate } from './cache.mjs';
import { fetchPulse } from './pulse.mjs';
import {
  allEvents, eventById, eventDetails, eventsForDay, h2hPrices, oddsForFixture, searchEvents,
} from './queries.mjs';

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
  'GET /api/events': () => cached('board', TTL.board, allEvents),

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
  'GET /api/bets': async (url) => {
    const id = url.searchParams.get('fixtureId') ?? '';
    if (!id) return { configured: false };
    return cached(`bets:${id}`, TTL.bets, () => betsForFixture(id));
  },

  // The mapping table: every optic league beside its provider counterparts.
  // Expensive (it reads squads from three feeds), so it is cached and only
  // built when the page asks.
  'GET /api/mapping/tournaments': () => cached('mapping:tournaments', TTL.mapping, tournamentMapping),

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
    return cached(`odds:${id}`, TTL.odds, () => oddsForFixture(id, sport));
  },

  // The ticker asks about the whole board at once. A POST carries the id list
  // without blowing past URL limits, but it is also uncacheable and — behind
  // Vercel's deployment protection — refused outright. So GET is the real path:
  // no ids means "whatever is on the board", which the CDN can cache like any
  // other read. POST stays for callers that want a specific subset.
  'GET /api/h2h': async () => {
    const board = await cached('board', TTL.board, allEvents);
    return h2hPrices(board.filter((e) => !e.outright).map((e) => e.id));
  },

  'POST /api/h2h': (_url, body) => h2hPrices(body?.fixtureIds ?? []),

  'GET /api/pulse': () => cached('pulse', TTL.pulse, fetchPulse),

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
      await cached('board', TTL.board, allEvents);
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
  'GET /api/mapping/tournaments',
  // Writes land on the mirror and queue an intent the tailnet agent replays
  // onto gutsys_sport — see queueForNas in mapping.mjs. Without that queue a
  // save here would be erased by the next sync, which is why these were
  // refused until the loop was closed.
  'POST /api/mapping/tournament',
  'POST /api/mapping/tournaments/apply',
  'POST /api/mapping/tournament/clear',
  // Assembled from the board row, the mirrored mapping tables and the odds the
  // event page already holds — see apiEventDetails. Not everything the Mongo
  // path shows, but the mapping block is the point of the tab.
  'GET /api/event/details',
]);

/** Routes whose data only exists on the Mongo source, and why. */
const MONGO_ONLY = {
  'GET /api/bets': 'bets',
  'GET /api/mapping/tournaments': 'the mapping tables',
  'POST /api/mapping/tournament': 'the mapping tables',
  'POST /api/mapping/tournaments/apply': 'the mapping tables',
  'POST /api/mapping/tournament/clear': 'the mapping tables',
  'GET /api/pulse': 'feed heartbeats',
  'GET /api/meta': 'the reference tables',
  'GET /api/event/details': 'fixture detail',
};

/**
 * Run one request against the table. Returns `{ status, body }` so each host
 * only has to deal with its own transport.
 */
export async function handleApi({ method, pathname, searchParams, body }) {
  const key = `${method} ${pathname.replace(/\/$/, '') || '/'}`;

  if (key === 'GET /api/capabilities') {
    return { status: 200, body: CAPABILITIES };
  }

  const handler = ROUTES[key];
  if (!handler) return { status: 404, body: { error: 'not found' } };

  if (!isMongo && MONGO_ONLY[key] && !(mirrorConfigured && MIRROR_SERVES.has(key))) {
    // 200, not an error: the client asked a reasonable question and the honest
    // answer is "not here", which it renders as a notice rather than a failure.
    return { status: 200, body: unavailable(MONGO_ONLY[key]) };
  }

  const url = { searchParams };
  return { status: 200, body: await handler(url, body) };
}
