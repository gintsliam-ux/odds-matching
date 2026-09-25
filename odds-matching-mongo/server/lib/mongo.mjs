import { MongoClient } from 'mongodb';

/* One pooled client for the process. The NAS Mongo is reached over Tailscale,
   so a connection is expensive to establish and cheap to keep — every route
   shares this one rather than dialling per request. */
const URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || 'gutsys_sport';

if (!URI) {
  throw new Error('MONGO_URI is not set — copy .env.example to .env and fill it in.');
}

const client = new MongoClient(URI, {
  serverSelectionTimeoutMS: 10_000,
  maxPoolSize: 12,
});

let connecting = null;

/** The connected database handle. Safe to call concurrently. */
export async function db() {
  if (!connecting) connecting = client.connect();
  await connecting;
  return client.db(DB_NAME);
}

/* Every collection this page reads, named once. `gutsys_sport` carries more
   than the library uses (event_mapping, competition_mapping, tab_competitions,
   books, market_rules, blend_config); they're listed so wiring one up is a
   route away rather than a hunt for the right string. */
export const COLLECTIONS = {
  fixtures: 'fixtures',
  odds: 'odds',
  oddsSp: 'odds_sp',
  entities: 'entities',
  leagues: 'leagues',
  // Present in the schema, not yet read by the page:
  books: 'books',
  marketRules: 'market_rules',
  blendConfig: 'blend_config',
  eventMapping: 'event_mapping',
  competitionMapping: 'competition_mapping',
  tabCompetitions: 'tab_competitions',
};

/** A named accessor: `await coll('oddsSp')`. Throws on an unknown name. */
export async function coll(name) {
  const real = COLLECTIONS[name];
  if (!real) throw new Error(`unknown collection: ${name}`);
  return (await db()).collection(real);
}

export async function closeMongo() {
  if (connecting) await client.close();
}
