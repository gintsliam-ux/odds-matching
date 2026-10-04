// Where the two matchers read their inputs and write their results.
//
// The matching itself — every heuristic in build-mapping.mjs and
// build-mybet-mapping.mjs — is storage-agnostic. Only the eight operations
// below ever touch a database, so swapping the backend swaps those eight and
// nothing else. That matters because there are now two places the same mapping
// has to land:
//
//   supabase   aucplqygawlpijzbfvjb — what live-fixtures renders, written by
//              the daily Vercel cron and by mapping-tick.
//   mongo      gutsys_sport on the NAS — what Sports Odds Desk and the Odds
//              Library read.
//
// Before this module there was only the Supabase half, so the Mongo
// event_mapping went stale on 2026-09-16 and every fixture created after that
// date sat unmapped behind a placeholder row. One matcher, two stores, is the
// fix — a second copy of the heuristics would just drift the other way.
//
// Semantics are defined by the Supabase implementation, because that is the one
// that was in production longest: the Mongo store matches its behaviour,
// including the parts that look odd (the pre-upsert wipe of auto rows, '' as
// the unmapped sentinel, manual/verified rows being untouchable).
//
// NOTE (2026-10-02): the Supabase project is DEAD —
// `aucplqygawlpijzbfvjb.supabase.co` is NXDOMAIN, so every write the Vercel
// cron and mapping-tick attempted since it went away has failed silently. Mongo
// is the only store that works, and is now the default. createSupabaseStore is
// kept only because it is the specification the Mongo one was derived from;
// nothing calls it.

import { MongoClient } from 'mongodb'

/** Sports the matchers never process, and whose mappings they must not delete.
 *  Golf's OPTIC side is a separate outrights price table, so the matcher can
 *  neither see it nor recreate it — wiping it would silently revert mappings
 *  made by hand in the UI. */
export const UNMANAGED_SPORTS = ['golf']

const COMP_CONFLICT = ['provider', 'optic_sport', 'optic_league', 'optic_tournament', 'gutsy_competition_id']
const EVENT_CONFLICT = ['provider', 'optic_fixture_id']

const SEP = String.fromCharCode(0)

/** Drop rows repeating a conflict key within one batch, keeping the last —
 *  which is what a second upsert would have left anyway. Postgres refuses an
 *  ON CONFLICT DO UPDATE that touches a row twice and fails the WHOLE
 *  statement; Mongo's bulkWrite would simply apply both in order. Deduping for
 *  both keeps the two stores identical. */
function dedupeOnConflict(cols, items) {
  const byKey = new Map()
  for (const it of items) byKey.set(cols.map((c) => String(it[c] ?? '')).join(SEP), it)
  return [...byKey.values()]
}

// --- supabase -------------------------------------------------------------

export function createSupabaseStore({ url, key, fetchRetry }) {
  const REST = `${url}/rest/v1`
  const HDR = { apikey: key, Authorization: `Bearer ${key}` }

  /**
   * Page a table, seeking on a unique key rather than OFFSET.
   *
   * OFFSET pagination collapses on this database — Postgres walks every skipped
   * row, so the deeper the page the longer the scan until it exceeds the
   * statement timeout, and the matcher pages whole tables. Seeking reads an
   * index range whatever the depth. `keyCol` must be UNIQUE and match the sort.
   */
  async function getAll(pathAndQuery, keyCol = 'id') {
    const size = 1000
    const out = []
    let last = null
    for (;;) {
      const sep = pathAndQuery.includes('?') ? '&' : '?'
      const seek = last == null ? '' : `&${keyCol}=gt.${encodeURIComponent(last)}`
      const r = await fetchRetry(`${REST}/${pathAndQuery}${sep}order=${keyCol}.asc&limit=${size}${seek}`, { headers: HDR })
      if (!r.ok) throw new Error(`read ${pathAndQuery} -> ${r.status}: ${await r.text()}`)
      const rows = await r.json()
      out.push(...rows)
      if (rows.length < size) return out
      last = rows[rows.length - 1][keyCol]
    }
  }

  async function upsert(path, conflict, itemsRaw) {
    const items = dedupeOnConflict(conflict, itemsRaw)
    const CHUNK = 500
    for (let i = 0; i < items.length; i += CHUNK) {
      const r = await fetchRetry(`${REST}/${path}?on_conflict=${conflict.join(',')}`, {
        method: 'POST',
        headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(items.slice(i, i + CHUNK)),
      })
      if (!r.ok) throw new Error(`upsert ${path} -> ${r.status}: ${await r.text()}`)
    }
  }

  return {
    name: 'supabase',

    async loadFixtures(horizonISO) {
      return (
        await getAll(
          'fixtures?select=fixture_id,optic_fixture_id:fixture_id,sport,league:optic_league,season_type,home_team,away_team,scheduled_start' +
            `&source=eq.optic&scheduled_start=gte.${horizonISO}`,
          // Seek on the REAL column: order=/gt. resolve against the table, so
          // the aliased name 400s with "column does not exist".
          'fixture_id',
        )
      ).filter((r) => r.optic_fixture_id)
    },

    loadCompetitionMappings(provider) {
      return getAll(
        `competition_mapping?provider=eq.${provider}` +
          '&select=id,optic_sport,optic_league,optic_tournament,gutsy_competition_id,source,verified',
      )
    },

    loadEventMappings(provider) {
      return getAll(`event_mapping?provider=eq.${provider}&select=id,optic_fixture_id,source`)
    },

    async deleteAutoUnverifiedCompetitions(provider) {
      const qs =
        `provider=eq.${provider}&source=eq.auto&verified=eq.false` +
        `&optic_sport=not.in.(${UNMANAGED_SPORTS.join(',')})`
      const r = await fetchRetry(`${REST}/competition_mapping?${qs}`, { method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' } })
      if (!r.ok) throw new Error(`delete auto unverified -> ${r.status}: ${await r.text()}`)
    },

    upsertCompetitions(rows) {
      return upsert('competition_mapping', COMP_CONFLICT, rows)
    },

    upsertEvents(rows) {
      return upsert('event_mapping', EVENT_CONFLICT, rows)
    },

    async deleteOtherAutoCompetitions({ provider, optic_sport, optic_league, optic_tournament, keepCid }) {
      const del = new URLSearchParams({
        provider: `eq.${provider}`, optic_sport: `eq.${optic_sport}`, optic_league: `eq.${optic_league}`,
        optic_tournament: `eq.${optic_tournament}`, source: 'eq.auto', gutsy_competition_id: `neq.${keepCid}`,
      })
      await fetchRetry(`${REST}/competition_mapping?${del}`, { method: 'DELETE', headers: { ...HDR, Prefer: 'return=minimal' } })
    },

    async verifyAutoCompetitions({ provider, optic_sport, optic_league, optic_tournament, stamp }) {
      const q = new URLSearchParams({
        provider: `eq.${provider}`, optic_sport: `eq.${optic_sport}`, optic_league: `eq.${optic_league}`,
        optic_tournament: `eq.${optic_tournament}`, source: 'eq.auto',
      })
      await fetchRetry(`${REST}/competition_mapping?${q}`, {
        method: 'PATCH',
        headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ verified: true, verified_at: stamp }),
      })
    },

    async close() {},
  }
}

// --- mongo ----------------------------------------------------------------

/** Columns carrying timestamps. The matchers build rows for PostgREST and so
 *  pass ISO strings; Mongo's copies of these tables hold BSON dates, and a
 *  string where the rest of the collection has a date breaks range queries
 *  silently rather than loudly. Coerced on the way in. */
const DATE_FIELDS = ['resolved_at', 'verified_at', 'swift_actual_start']

function toMongoRow(row, now) {
  const out = { ...row, resolved_at: row.resolved_at ?? now }
  for (const f of DATE_FIELDS) {
    const v = out[f]
    if (typeof v === 'string') out[f] = new Date(v)
  }
  return out
}

export function createMongoStore({ uri, db = 'gutsys_sport', dryRun = false }) {
  const client = new MongoClient(uri, { maxPoolSize: 5 })
  let database = null
  const planned = { competitions: 0, events: 0, deletedAuto: 0, verified: 0 }
  // A dry run that only prints totals cannot answer "would MY fixture map?",
  // which is the question worth asking before writing 30k rows. Kept only for
  // dry runs, where the rows are the output rather than a side effect.
  const pending = dryRun ? { competitions: [], events: [] } : null

  async function conn() {
    if (!database) {
      await client.connect()
      database = client.db(db)
    }
    return database
  }

  /**
   * Reserve `n` ids for the operations in a batch that turn out to be inserts.
   *
   * These tables carry a numeric `id` mirroring `_id`, inherited from the
   * Postgres side where it is the primary key — the app reads `id`, so an
   * ObjectId here would be a different shape from every existing row. An upsert
   * cannot know in advance which operations insert, so one id is reserved per
   * operation and the unused ones simply leave gaps. Gaps are free; collisions
   * are not.
   */
  async function reserveIds(coll, n) {
    const d = await conn()
    // `$type: 'number'` is load-bearing. BSON orders by TYPE before value, and
    // ObjectId sorts above every number — so a plain `sort({_id: -1})` on a
    // collection holding even one ObjectId returns that, not the largest id.
    // `typeof` then rejects it, the counter restarts at 1, and the first few
    // hundred inserts collide with the oldest rows in the table. That is not
    // hypothetical: it is how the first run of this store failed, after its
    // delete step had already run.
    const top = await d
      .collection(coll)
      .find({ _id: { $type: 'number' } }, { projection: { _id: 1 } })
      .sort({ _id: -1 })
      .limit(1)
      .next()
    const start = (typeof top?._id === 'number' ? top._id : 0) + 1
    return Array.from({ length: n }, (_, i) => start + i)
  }

  async function upsertMany(coll, conflict, rowsRaw) {
    const rows = dedupeOnConflict(conflict, rowsRaw)
    if (!rows.length) return
    const bucket = coll === 'competition_mapping' ? 'competitions' : 'events'
    if (dryRun) {
      planned[bucket] += rows.length
      pending[bucket].push(...rows)
      return
    }
    const d = await conn()
    const ids = await reserveIds(coll, rows.length)
    const now = new Date()
    const ops = rows.map((row, i) => {
      const filter = Object.fromEntries(conflict.map((c) => [c, row[c] ?? '']))
      const doc = toMongoRow(row, now)
      // The conflict key lives in the filter; repeating it in $set makes Mongo
      // reject the update as a conflicting path on insert.
      for (const c of conflict) delete doc[c]
      delete doc.id
      delete doc._id
      return {
        updateOne: { filter, update: { $set: doc, $setOnInsert: { _id: ids[i], id: ids[i] } }, upsert: true },
      }
    })
    const CHUNK = 500
    for (let i = 0; i < ops.length; i += CHUNK) {
      await d.collection(coll).bulkWrite(ops.slice(i, i + CHUNK), { ordered: false })
    }
  }

  return {
    name: dryRun ? 'mongo (dry run)' : 'mongo',
    planned,
    pending,

    async loadFixtures(horizonISO) {
      const d = await conn()
      const rows = await d
        .collection('fixtures')
        .find(
          { source: 'optic', scheduled_start: { $gte: new Date(horizonISO) } },
          { projection: { _id: 0, fixture_id: 1, sport: 1, optic_league: 1, season_type: 1, home_team: 1, away_team: 1, scheduled_start: 1 } },
        )
        .toArray()
      // Aliased to the names the matchers already use, so nothing downstream
      // can tell the two stores apart.
      return rows
        .filter((r) => r.fixture_id)
        .map((r) => ({
          fixture_id: r.fixture_id,
          optic_fixture_id: r.fixture_id,
          sport: r.sport,
          league: r.optic_league,
          season_type: r.season_type,
          home_team: r.home_team,
          away_team: r.away_team,
          scheduled_start: r.scheduled_start instanceof Date ? r.scheduled_start.toISOString() : r.scheduled_start,
        }))
    },

    async loadCompetitionMappings(provider) {
      const d = await conn()
      return d
        .collection('competition_mapping')
        .find(
          { provider },
          { projection: { _id: 0, id: 1, optic_sport: 1, optic_league: 1, optic_tournament: 1, gutsy_competition_id: 1, source: 1, verified: 1 } },
        )
        .toArray()
    },

    async loadEventMappings(provider) {
      const d = await conn()
      return d
        .collection('event_mapping')
        .find({ provider }, { projection: { _id: 0, id: 1, optic_fixture_id: 1, source: 1 } })
        .toArray()
    },

    async deleteAutoUnverifiedCompetitions(provider) {
      const d = await conn()
      // `verified: {$ne: true}` rather than Postgres's literal `= false`: Mongo
      // rows predating the column simply lack it, and those are exactly the
      // stale auto rows this wipe exists to clear. `source: 'auto'` is what
      // keeps every hand-made mapping safe.
      const filter = { provider, source: 'auto', verified: { $ne: true }, optic_sport: { $nin: UNMANAGED_SPORTS } }
      if (dryRun) {
        planned.deletedAuto += await d.collection('competition_mapping').countDocuments(filter)
        return
      }
      await d.collection('competition_mapping').deleteMany(filter)
    },

    upsertCompetitions(rows) {
      return upsertMany('competition_mapping', COMP_CONFLICT, rows)
    },

    upsertEvents(rows) {
      return upsertMany('event_mapping', EVENT_CONFLICT, rows)
    },

    async deleteOtherAutoCompetitions({ provider, optic_sport, optic_league, optic_tournament, keepCid }) {
      if (dryRun) return
      const d = await conn()
      await d.collection('competition_mapping').deleteMany({
        provider, optic_sport, optic_league, optic_tournament, source: 'auto',
        gutsy_competition_id: { $ne: keepCid },
      })
    },

    async verifyAutoCompetitions({ provider, optic_sport, optic_league, optic_tournament, stamp }) {
      if (dryRun) {
        planned.verified++
        return
      }
      const d = await conn()
      await d.collection('competition_mapping').updateMany(
        { provider, optic_sport, optic_league, optic_tournament, source: 'auto' },
        { $set: { verified: true, verified_at: new Date(stamp) } },
      )
    },

    async close() {
      await client.close().catch(() => {})
    },
  }
}
