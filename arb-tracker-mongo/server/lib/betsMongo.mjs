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

export async function betsDb() {
  if (!client) return null;
  if (!connecting) connecting = client.connect();
  await connecting;
  return client.db(DB_NAME);
}

export async function closeBets() {
  if (connecting && client) await client.close();
}
