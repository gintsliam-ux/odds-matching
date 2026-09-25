// The `entities` store, on Mongo.
//
// Both logo resolvers used to read and write `entities` through PostgREST on
// the Odds Library's Supabase project. The page reads `gutsys_sport` now, and
// the Supabase→Mongo copy of this one collection had drifted nine days behind
// (1,794 rows resolved on Supabase that Mongo had never seen), so the badges
// and flags the page rendered were stale by construction. Writing here instead
// removes the copy from the path entirely.
//
// NOTE: live-fixtures keeps its OWN resolver (live-fixtures/scripts/
// resolve-logos.mjs, on a daily cron) writing Supabase `entities`. That one is
// untouched — the two tables are fed independently now, which is what it means
// for the Odds Library to be off Supabase.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Env first, then the project's own .env — the same order the app uses. */
function config() {
  let env = {};
  try {
    env = Object.fromEntries(
      readFileSync(join(HERE, '..', '..', '.env'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch { /* no .env — env vars only */ }
  const uri = process.env.MONGO_URI || env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set (env, or odds-matching-mongo/.env)');
  return { uri, dbName: process.env.MONGO_DB || env.MONGO_DB || 'gutsys_sport' };
}

/* `gutsys_sport` is the scrapers' database and the sweep below can touch
   thousands of rows in one pass, so a run that writes is something you opt
   into. `--dry-run` reports the same counts and writes nothing. */
let dryRun = false;
export function setDryRun(on) { dryRun = !!on; }
export function isDryRun() { return dryRun; }

let client = null;
let database = null;

export async function db() {
  if (database) return database;
  const { uri, dbName } = config();
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  database = client.db(dbName);
  return database;
}

export async function close() {
  if (client) await client.close();
  client = null;
  database = null;
}

/**
 * The join key, and the one that actually matters.
 *
 * `entities` carries a unique index on (sport, normalized) and the Supabase
 * view joined on it too — but both resolvers upserted on (sport, name) and
 * never wrote `normalized`, so every row they created was invisible to the
 * join and a whole backfill script existed to repair it. Writing it here at
 * insert time is the repair.
 */
export const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/**
 * Prove we can write before spending a single Wikipedia lookup.
 *
 * A filter nothing matches costs one round trip and writes nothing, but still
 * needs the grant — so it answers the question for free, the same way the empty
 * PostgREST insert used to.
 */
export async function assertWritable() {
  const d = await db();
  if (dryRun) return;
  try {
    await d.collection('entities').updateOne(
      { _id: '__writable_probe__' },
      { $set: { ok: 1 } },
      { upsert: false },
    );
  } catch (e) {
    throw new Error(`cannot write entities — ${e.message}`);
  }
}

/** Every entity on file, optionally one namespace of them. */
export async function allEntities(sport = null) {
  const d = await db();
  return d.collection('entities')
    .find(sport ? { sport } : {})
    .project({ _id: 0, sport: 1, name: 1, logo_url: 1, country: 1, normalized: 1 })
    .toArray();
}

/** Distinct competitor names for a team sport, off `fixtures`. */
export async function competitorNames(sport) {
  const d = await db();
  const rows = await d.collection('fixtures').aggregate([
    { $match: { sport } },
    { $group: { _id: null, home: { $addToSet: '$home_team' }, away: { $addToSet: '$away_team' } } },
  ]).toArray();
  if (!rows.length) return [];
  return [...new Set([...rows[0].home, ...rows[0].away].filter(Boolean))];
}

/**
 * The golf field.
 *
 * Golf fixtures carry no competitors — the field is in the outright market, and
 * there is no `golf_outrights` collection here, so the names come from the odds
 * themselves. Both the live board and the closing record are read: a tournament
 * that has already settled is only in `odds_sp`.
 */
export async function golferNames() {
  const d = await db();
  const q = { sport: 'golf', market_id: 'outright' };
  const [live, closing] = await Promise.all([
    d.collection('odds').distinct('selection', q),
    d.collection('odds_sp').distinct('selection', q),
  ]);
  return [...new Set([...live, ...closing].filter(Boolean))];
}

/**
 * Distinct (tournament, optic_league) pairs for a sport.
 *
 * This was 800 keyset requests against PostgREST, one per distinct label,
 * because aggregates were disabled there. It is one `$group` here.
 */
export async function tournamentPairs(sport, { month = null } = {}) {
  const d = await db();
  const match = { sport, tournament: { $ne: null } };
  if (month) {
    const { year, month: m } = month;
    match.scheduled_start = {
      $gte: new Date(Date.UTC(year, m - 1, 1)),
      $lt: m === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, m, 1)),
    };
  }
  return d.collection('fixtures').aggregate([
    { $match: match },
    { $group: { _id: { tournament: '$tournament', optic_league: '$optic_league' } } },
    { $project: { _id: 0, tournament: '$_id.tournament', optic_league: '$_id.optic_league' } },
  ]).toArray();
}

/* `id` is a plain integer that the Supabase copy used as its primary key, and
   every document here still has `_id === id`. New rows keep the convention
   rather than introducing a second id shape in the same collection. */
let nextId = null;
async function allocateId(d) {
  if (nextId == null) {
    const [top] = await d.collection('entities').find({}).sort({ id: -1 }).limit(1).toArray();
    nextId = (top?.id ?? 0) + 1;
  }
  return nextId++;
}

/** Collapse (sport, name) within a batch, preferring a row that found something. */
function dedupe(rows) {
  const by = new Map();
  for (const row of rows) {
    const k = `${row.sport} ${row.name}`;
    const prev = by.get(k);
    if (!prev || (prev.logo_url == null && row.logo_url != null)) by.set(k, row);
  }
  return [...by.values()];
}

/**
 * Upsert on (sport, name), the key both resolvers have always written.
 *
 * The wrinkle is the OTHER unique key. Distinct names normalise to the same
 * thing — "Real Madrid CF" and "Real Madrid" — and (sport, normalized) is a
 * unique index, so inserting the second one fails. Where a key is already
 * owned we do not fight for it: we fill whatever the owner is missing from the
 * row that would have collided, which is the outcome actually wanted.
 *
 * Returns { inserted, updated, merged } so a run can say what it did.
 */
export async function upsertEntities(batch) {
  const rows = dedupe(batch);
  if (!rows.length) return { inserted: 0, updated: 0, merged: 0 };

  const d = await db();
  const entities = d.collection('entities');
  const stamp = new Date();
  let inserted = 0, updated = 0, merged = 0;

  /* A dry run still does the reads — the interesting number is how the batch
     SPLITS across the three outcomes, and that is only knowable by looking. */

  for (const row of rows) {
    const fields = { ...row, normalized: row.normalized ?? norm(row.name), resolved_at: stamp };

    const byName = await entities.findOne(
      { sport: row.sport, name: row.name },
      { projection: { _id: 1 } },
    );
    if (byName) {
      if (!dryRun) await entities.updateOne({ _id: byName._id }, { $set: fields });
      updated++;
      continue;
    }

    const owner = await entities.findOne(
      { sport: row.sport, normalized: fields.normalized },
      { projection: { _id: 1, logo_url: 1, country: 1 } },
    );
    if (owner) {
      const fill = {};
      if (owner.logo_url == null && fields.logo_url != null) {
        fill.logo_url = fields.logo_url;
        fill.source = fields.source ?? null;
      }
      if (owner.country == null && fields.country != null) {
        fill.country = fields.country;
        fill.country_src = fields.country_src ?? null;
      }
      if (Object.keys(fill).length && !dryRun) {
        await entities.updateOne({ _id: owner._id }, { $set: { ...fill, resolved_at: stamp } });
      }
      merged++;
      continue;
    }

    if (!dryRun) {
      const id = await allocateId(d);
      await entities.insertOne({ _id: id, id, ...fields });
    }
    inserted++;
  }

  return { inserted, updated, merged };
}
