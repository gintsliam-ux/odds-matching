import { coll } from './mongo.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';

/**
 * How one fixture is seen by all three systems.
 *
 * Optic, Swiftbet and Mybet each hold their own id, their own start time and
 * their own idea of whether the thing has finished — and they disagree often
 * enough that "which one is right" is a real question when a bet won't match or
 * a price looks stale. This gathers all three side by side, plus the mapping
 * rows that claim they are the same event.
 */

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** The league-level mapping, for context on why an event did or didn't map. */
async function competitionMapping(opticLeague) {
  if (!opticLeague) return { swift: [], mybet: [] };
  const rows = await (await coll('competitionMapping'))
    .find({ optic_league: opticLeague, gutsy_competition: { $nin: [null, ''] } })
    .project({ _id: 0, provider: 1, gutsy_competition: 1, gutsy_competition_id: 1, confidence: 1, source: 1 })
    .toArray();
  const out = { swift: [], mybet: [] };
  const seen = new Set();
  for (const r of rows) {
    if (!out[r.provider]) continue;
    // The table repeats the same competition 2-4x in places; one entry is enough.
    const key = `${r.provider}|${r.gutsy_competition_id ?? r.gutsy_competition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[r.provider].push({
      id: r.gutsy_competition_id ? String(r.gutsy_competition_id) : null,
      name: r.gutsy_competition,
      confidence: r.confidence ?? null,
      source: r.source ?? null,
    });
  }
  return out;
}

/** The Swiftbet event behind a mapping. */
async function swiftEvent(db, id) {
  const e = await db.collection('events').findOne({ _id: id });
  if (!e) return null;
  return {
    id: String(e._id),
    name: e.name ?? null,
    competition: e.competition?.name ?? null,
    competitionId: e.competition?.id ? String(e.competition.id) : null,
    sport: e.sport?.name ?? null,
    status: e.status ?? null,
    viewStatus: e.event_view_status ?? null,
    feedStatus: e.feed_status ?? null,
    finished: e.finished ?? null,
    startsAt: iso(e.start_date),
    finishedAt: iso(e.finished_at),
    marketCount: e.market_count ?? null,
    teams: (e.teams ?? []).map((t) => ({ name: t.name ?? null, side: t.team_position ?? null })),
  };
}

/** The Mybet event behind a mapping. */
async function mybetEvent(db, id) {
  const n = Number(id);
  const e = await db.collection('mybet_events').findOne({ _id: Number.isFinite(n) ? n : id });
  if (!e) return null;
  return {
    id: String(e._id),
    name: e.description ?? null,
    competition: e.league ?? null,
    competitionId: e.leagueId != null ? String(e.leagueId) : null,
    sport: e.sport ?? null,
    feedId: e.feedId != null ? String(e.feedId) : null,
    // mybet has no status field; what it has is a trail of timestamps, and
    // "when did we last see it" is the closest thing to one.
    firstSeenAt: iso(e.firstSeenAt),
    lastSeenAt: iso(e.lastSeenAt),
    lastChangedAt: iso(e.lastChangedAt),
    feedLastUpdated: iso(e.feedLastUpdated),
    outcomeAt: iso(e.outcomeAt),
    suspendAt: iso(e.suspendAt),
    teams: [
      { name: e.match?.teamA ?? null, side: 'A' },
      { name: e.match?.teamB ?? null, side: 'B' },
    ].filter((t) => t.name),
  };
}

/**
 * Every system's record of one fixture, plus the mapping rows joining them.
 * Absent mappings are reported as such — "not mapped" and "mapped to something
 * that has since disappeared" are different problems.
 */
export async function fixtureMapping(fixtureId, opticLeague) {
  const result = {
    configured: betsConfigured,
    competitions: await competitionMapping(opticLeague),
    swift: { mapped: false, link: null, event: null },
    mybet: { mapped: false, link: null, event: null },
  };
  if (!fixtureId) return result;

  const links = await (await coll('eventMapping'))
    .find({ optic_fixture_id: fixtureId })
    .project({ _id: 0 })
    .toArray();

  for (const l of links) {
    const side = result[l.provider];
    if (!side) continue;
    // `event_mapping` holds unresolved placeholders — a row for the fixture
    // carrying no event id and confidence 0. It is a record that someone tried,
    // not a mapping, and reading it as one showed a "mapped" panel with every
    // field blank while the Bets tab correctly called the same fixture
    // unmapped.
    if (!l.gutsy_event_id) continue;
    // Several rows can exist for one fixture; the most confident wins.
    if (side.link && (side.link.confidence ?? 0) >= (l.confidence ?? 0)) continue;
    side.mapped = true;
    side.link = {
      eventId: l.gutsy_event_id ? String(l.gutsy_event_id) : null,
      confidence: l.confidence ?? null,
      source: l.source ?? null,
      resolvedAt: iso(l.resolved_at),
      // Only the swift mapper records the jump it observed.
      actualStart: iso(l.swift_actual_start),
    };
  }

  if (!betsConfigured) return result;
  const db = await betsDb();
  if (!db) return result;

  await Promise.all([
    result.swift.link?.eventId
      ? swiftEvent(db, result.swift.link.eventId).then((e) => {
          result.swift.event = e;
        })
      : null,
    result.mybet.link?.eventId
      ? mybetEvent(db, result.mybet.link.eventId).then((e) => {
          result.mybet.event = e;
        })
      : null,
  ]);

  return result;
}
