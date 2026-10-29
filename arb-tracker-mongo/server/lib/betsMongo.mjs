import { MongoClient } from 'mongodb';

// The bets live on a different cluster from the odds — Atlas, not the NAS — so
// they get their own client. It is optional: with no BETS_URI the Bets tab
// simply reports that no source is connected, and the rest of the board is
// unaffected.
const URI = process.env.BETS_URI;
const DB_NAME = process.env.BETS_DB || 'gutsy';

export const betsConfigured = Boolean(URI);

// Deliberately small. This cluster is shared with the user's scrapers, and a
// read-only board has no business holding a wide pool open against it.
const client = betsConfigured
  ? new MongoClient(URI, { maxPoolSize: 4, serverSelectionTimeoutMS: 15_000 })
  : null;

let connecting = null;

/**
 * The brand's OWN market book, which is a different database on the same box.
 *
 * `gutsy.mybet_events` carries one record per event with the headline prices
 * on it. `mybet.markets` is the market book proper — every market the brand
 * opened, its selections, and the price on each — and on a single NBA fixture
 * that is 104 open markets against the three we derive from the event record.
 *
 * Same client, so it costs no second connection.
 */
export async function mybetDb() {
  if (!client) return null;
  if (!connecting) connecting = client.connect();
  await connecting;
  return client.db('mybet');
}

export async function betsDb() {
  if (!client) return null;
  if (!connecting) connecting = client.connect();
  await connecting;
  return client.db(DB_NAME);
}

export async function closeBets() {
  if (connecting && client) await client.close();
}
