import { MongoClient } from 'mongodb';

// One pooled client for the process. The NAS Mongo is reached over Tailscale,
// so a connection is expensive to establish and cheap to keep — every route
// shares this one rather than dialling per request.
const URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || 'gutsys_sport';

/**
 * Mongo is optional. A deployment that reads the public odds surface instead
 * has no MONGO_URI and must still boot — so this fails when something actually
 * asks for a collection, not at import time.
 */
export const mongoConfigured = Boolean(URI);

/**
 * The Atlas mirror of the three collections the tailnet would otherwise keep to
 * itself — see scripts/sync-to-atlas.mjs.
 *
 * `gutsys_sport` is on a Tailscale address, which Vercel cannot route to, so a
 * deployed instance has no MONGO_URI. Without this it also had no mapping, no
 * crests and no bets — the last of those not because the bets are unreachable
 * (they are on Atlas already) but because the fixture->bet join goes through
 * `event_mapping`. Mirroring that one collection is what unblocks all three.
 */
const MIRROR_URI = process.env.MIRROR_URI;
const MIRROR_DB_NAME = process.env.MIRROR_DB || 'gutsys_sport';

export const mirrorConfigured = Boolean(MIRROR_URI);

/**
 * What the mirror actually carries. Anything else must come from the NAS.
 *
 * `leagueSquads` is not a copy of anything — it is the one aggregate the
 * mapping page reads out of `fixtures`, precomputed on the tailnet. 493 KB
 * instead of the 148 MB collection it is derived from.
 */
const MIRRORED = new Set([
  'entities', 'eventMapping', 'competitionMapping', 'leagues', 'leagueSquads', 'mappingPending',
]);

const client = URI
  ? new MongoClient(URI, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 12 })
  : null;

// Atlas is shared with the scrapers, so the deployed site is a light reader.
const mirrorClient = MIRROR_URI
  ? new MongoClient(MIRROR_URI, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 6 })
  : null;

let connecting = null;
let connectingMirror = null;

/** The connected database handle. Safe to call concurrently. */
export async function db() {
  if (!client) {
    throw new Error('MONGO_URI is not set — this instance has no direct database.');
  }
  if (!connecting) connecting = client.connect();
  await connecting;
  return client.db(DB_NAME);
}

/** The mirror handle, for the collections it carries. */
export async function mirrorDb() {
  if (!mirrorClient) {
    throw new Error('MIRROR_URI is not set — this instance has no mirrored database.');
  }
  if (!connectingMirror) connectingMirror = mirrorClient.connect();
  await connectingMirror;
  return mirrorClient.db(MIRROR_DB_NAME);
}

/**
 * Every collection this app reads, named once. `gutsys_sport` carries more than
 * the board currently uses (odds_sp, event_mapping, competition_mapping,
 * tab_competitions, blend_config); they're listed here so wiring one up is a
 * route away rather than a hunt for the right string.
 */
export const COLLECTIONS = {
  fixtures: 'fixtures',
  odds: 'odds',
  entities: 'entities',
  books: 'books',
  leagues: 'leagues',
  marketRules: 'market_rules',
  /** Mirror-only: the per-league squad summary the mapping page scores against. */
  leagueSquads: 'league_squads',
  /**
   * Mirror-only: mapping writes made from a deployed instance, waiting to be
   * replayed onto the NAS. Vercel cannot reach `gutsys_sport`, so a save there
   * lands on the mirror and leaves an intent here; the hourly tailnet agent
   * drains it. See scripts/sync-to-atlas.mjs.
   */
  mappingPending: 'mapping_pending',
  // Not yet surfaced by the UI, but present in the schema:
  oddsSp: 'odds_sp',
  eventMapping: 'event_mapping',
  competitionMapping: 'competition_mapping',
  tabCompetitions: 'tab_competitions',
  blendConfig: 'blend_config',
};

/**
 * A typed-ish accessor: `await coll('odds')`. Throws on an unknown name.
 *
 * The NAS wins whenever it is reachable — it is the source of truth, and on the
 * tailnet there is no reason to read a copy. The mirror is the fallback, and
 * only for what it actually holds: asking a deployed instance for `odds` still
 * fails loudly rather than quietly returning nothing.
 */
export async function coll(name) {
  const real = COLLECTIONS[name];
  if (!real) throw new Error(`unknown collection: ${name}`);
  if (!client && mirrorClient && MIRRORED.has(name)) {
    return (await mirrorDb()).collection(real);
  }
  return (await db()).collection(real);
}

export async function closeMongo() {
  if (connecting && client) await client.close();
  if (connectingMirror && mirrorClient) await mirrorClient.close();
}
