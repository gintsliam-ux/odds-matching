import { coll, mongoConfigured } from './mongo.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';
import {
  AUTO_THRESHOLD, SUGGEST_THRESHOLD, TEAM_CONFIRM,
  bestMatch, demoteCollisions, sportKey, teamOverlap,
} from './mappingMatch.mjs';

/**
 * The tournament mapping view: every optic league beside its swiftbet and mybet
 * counterpart, with a suggestion where one isn't set yet.
 *
 * Names alone only get so far — see mappingMatch.mjs. What settles the hard
 * cases is squad overlap, so this module's job is to gather the team lists each
 * feed associates with a competition and hand them to the scorer.
 */

/** How many fixtures to sample per competition when collecting its squad. */
const TEAM_SAMPLE = 400;

const PROVIDERS = ['swift', 'mybet'];

/* ------------------------------------------------------------ candidates */

/** Swiftbet competitions, with the teams seen in each. */
async function swiftCandidates(db) {
  const rows = await db
    .collection('events')
    .aggregate([
      { $sort: { start_date: -1 } },
      {
        $group: {
          _id: '$competition.id',
          name: { $first: '$competition.name' },
          sport: { $first: '$sport.name' },
          events: { $sum: 1 },
          teams: { $push: '$teams.name' },
        },
      },
      { $match: { name: { $ne: null } } },
    ])
    .toArray();
  return rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    sport: r.sport ?? null,
    events: r.events,
    teams: r.teams.flat().filter(Boolean).slice(0, TEAM_SAMPLE),
  }));
}

/**
 * Mybet leagues. `league` is the bare name and `description` the qualified one
 * ("KBO League" / "Korean KBO League"); which identifies the competition varies
 * row to row, so both are carried and both are scored.
 */
async function mybetCandidates(db) {
  const rows = await db
    .collection('mybet_events')
    .aggregate([
      { $sort: { lastSeenAt: -1 } },
      {
        $group: {
          _id: '$leagueId',
          name: { $first: '$league' },
          alt: { $first: '$description' },
          sport: { $first: '$sport' },
          events: { $sum: 1 },
          teamsA: { $push: '$match.teamA' },
          teamsB: { $push: '$match.teamB' },
        },
      },
      { $match: { name: { $ne: null } } },
    ])
    .toArray();
  return rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    alt: r.alt ?? null,
    // mybet labels sports its own way — "Gridiron" for American football,
    // "Australian Rules" for AFL — which the synonym table folds.
    sport: r.sport ?? null,
    events: r.events,
    teams: [...r.teamsA, ...r.teamsB].filter(Boolean).slice(0, TEAM_SAMPLE),
  }));
}

/* ----------------------------------------------------------- optic side */

/** The squad summary, computed live from `fixtures` on the tailnet. */
async function squadsFromFixtures() {
  const squads = await (await coll('fixtures'))
    .aggregate([
      { $match: { home_team: { $ne: null } } },
      { $sort: { scheduled_start: -1 } },
      {
        $group: {
          _id: '$optic_league',
          home: { $push: '$home_team' },
          away: { $push: '$away_team' },
          fixtures: { $sum: 1 },
          tournaments: { $addToSet: '$tournament' },
        },
      },
    ])
    .toArray();
  return new Map(
    squads.map((s) => [
      s._id,
      {
        teams: [...s.home, ...s.away].filter(Boolean).slice(0, TEAM_SAMPLE),
        fixtures: s.fixtures,
        tournamentCount: (s.tournaments ?? []).filter(Boolean).length,
      },
    ]),
  );
}

/** The same summary, precomputed and mirrored, for a deployed instance. */
async function squadsFromMirror() {
  const rows = await (await coll('leagueSquads')).find({}).toArray();
  return new Map(
    rows.map((r) => [
      r._id,
      { teams: r.teams ?? [], fixtures: r.fixtures ?? 0, tournamentCount: r.tournamentCount ?? 0 },
    ]),
  );
}

/** Each optic league with the teams its fixtures have fielded. */
async function opticLeagues() {
  // On the tailnet this is computed from `fixtures` directly. A deployed
  // instance has no `fixtures` — 148 MB of constantly-changing rows is not
  // worth mirroring to serve one aggregate — so it reads `league_squads`, the
  // same summary precomputed by scripts/sync-to-atlas.mjs. Keep the two shapes
  // identical, or the deployed page scores candidates against a different squad
  // than the local one and quietly disagrees with it.
  const [leagues, byLeague] = await Promise.all([
    (await coll('leagues')).find({ active: true }).toArray(),
    mongoConfigured ? squadsFromFixtures() : squadsFromMirror(),
  ]);

  return leagues.map((l) => ({
    opticLeague: l.optic_league,
    sport: l.sport,
    category: l.category ?? '',
    tournament: l.tournament ?? '',
    teams: byLeague.get(l.optic_league)?.teams ?? [],
    fixtures: byLeague.get(l.optic_league)?.fixtures ?? 0,
    // A tennis "league" is a tour of separate tournaments — ATP Challenger
    // spans 33 of them — so `leagues.tournament` holds one arbitrary event
    // name. Knowing the spread lets the UI label the row honestly instead of
    // calling the whole ATP Challenger tour "Sion, Switzerland".
    tournamentCount: byLeague.get(l.optic_league)?.tournamentCount ?? 0,
  }));
}

/* -------------------------------------------------------------- scoring */

/**
 * Re-rank a name-matched shortlist using squad overlap.
 *
 * A candidate that shares teams is promoted to certainty; one that shares none
 * — when both sides actually list teams — is dropped however well the name
 * reads. That is what tells Italy's Serie A from Brazil's, and what catches
 * "La Liga" landing on "LaLiga SmartBank".
 */
function applyTeamEvidence(optic, shortlist) {
  const out = [];
  for (const c of shortlist) {
    const overlap = teamOverlap(optic.teams, c.teams);
    if (overlap == null) {
      // One side has no squad on record; the name is all we have to go on.
      out.push({ ...c, overlap: null });
      continue;
    }
    if (overlap >= TEAM_CONFIRM) {
      out.push({ ...c, overlap, score: Math.min(1, Math.max(c.score, 0.9) + 0.05), confirmedBy: 'teams' });
    } else if (overlap === 0) {
      // Both feeds name their teams and none is shared — not this competition.
      continue;
    } else {
      out.push({ ...c, overlap, score: c.score * 0.9 });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ----------------------------------------------------------------- view */

const SHORTLIST = 6;

/** Trim a candidate to what the UI needs — the squad stays on the server. */
const slim = (c) =>
  c && {
    id: c.id,
    name: c.name,
    alt: c.alt ?? null,
    sport: c.sport ?? null,
    events: c.events ?? null,
    score: Number(c.score.toFixed(3)),
    overlap: c.overlap == null ? null : Number(c.overlap.toFixed(2)),
    confirmedBy: c.confirmedBy ?? null,
    contested: !!c.contested,
    contestedWith: c.contestedWith ?? 0,
  };

/**
 * The whole tournament mapping table: one row per optic league per provider,
 * carrying whatever mapping exists and whatever the matcher would propose.
 */
export async function tournamentMapping() {
  if (!betsConfigured) return { configured: false, providers: {}, leagues: [] };
  const db = await betsDb();
  if (!db) return { configured: false, providers: {}, leagues: [] };

  const [leagues, existing, swift, mybet] = await Promise.all([
    opticLeagues(),
    (await coll('competitionMapping')).find({}).toArray(),
    swiftCandidates(db),
    mybetCandidates(db),
  ]);

  const candidates = { swift, mybet };
  // One optic league maps to MANY provider competitions, not one. A tennis
  // league like `tennis_atp_challenger` spans 87 individual mybet tournaments
  // — each week's Challenger is its own competition — and mybet carries both
  // "UFC" and "UFC - Women" against the same MMA league. So this is a list per
  // (provider, league), never a single row.
  const mapped = new Map();
  // Which competitions are already spoken for, per provider — the picker puts
  // the free ones first, since a competition mapped to another league is
  // rarely the one you're looking for.
  const taken = { swift: new Set(), mybet: new Set() };
  for (const e of existing) {
    if (!e.gutsy_competition) continue; // unresolved placeholder
    const key = `${e.provider}|${e.optic_league}`;
    const list = mapped.get(key) ?? [];
    list.push(e);
    mapped.set(key, list);
    if (e.gutsy_competition_id && taken[e.provider]) {
      taken[e.provider].add(String(e.gutsy_competition_id));
    }
  }

  const rowsByProvider = { swift: [], mybet: [] };

  const leagueRows = leagues.map((l) => {
    const row = { ...l, teams: undefined, providers: {} };
    for (const p of PROVIDERS) {
      const hits = mapped.get(`${p}|${l.opticLeague}`) ?? [];
      // The same competition is often stored several times — 71 groups in
      // `competition_mapping` repeat 2-4x, because nothing stopped the matcher
      // re-inserting one it had already written. Collapse them for display and
      // say how many rows are behind each, so the redundancy is visible
      // without being noise.
      const byComp = new Map();
      for (const h of hits) {
        const key = h.gutsy_competition_id ? String(h.gutsy_competition_id) : h.gutsy_competition;
        const prev = byComp.get(key);
        if (prev) {
          prev.rows++;
          continue;
        }
        byComp.set(key, {
          id: h.gutsy_competition_id ? String(h.gutsy_competition_id) : null,
          name: h.gutsy_competition,
          confidence: h.confidence ?? null,
          source: h.source ?? null,
          verified: !!h.verified,
          rows: 1,
        });
      }
      const currents = [...byComp.values()].sort((a, b) => a.name.localeCompare(b.name));

      let suggestion = null;
      if (currents.length === 0) {
        const shortlist = bestMatch(l, candidates[p])
          .filter((c) => c.score >= SUGGEST_THRESHOLD)
          .slice(0, SHORTLIST * 2);
        const ranked = applyTeamEvidence(l, shortlist).slice(0, SHORTLIST);
        suggestion = ranked[0] ?? null;
        row.providers[p] = { currents, suggestion, alternatives: ranked.slice(1, SHORTLIST) };
        rowsByProvider[p].push(row.providers[p]);
        continue;
      }
      row.providers[p] = { currents, suggestion, alternatives: [] };
    }
    return row;
  });

  // Two leagues claiming one competition means at most one is right.
  for (const p of PROVIDERS) demoteCollisions(rowsByProvider[p]);

  const counts = {};
  for (const p of PROVIDERS) {
    let mappedN = 0, auto = 0, review = 0, none = 0;
    for (const l of leagueRows) {
      const cell = l.providers[p];
      if (cell.currents.length) mappedN++;
      else if (cell.suggestion && cell.suggestion.score >= AUTO_THRESHOLD && !cell.suggestion.contested) auto++;
      else if (cell.suggestion) review++;
      else none++;
    }
    counts[p] = { total: leagueRows.length, mapped: mappedN, auto, review, none, candidates: candidates[p].length };
  }

  return {
    configured: true,
    thresholds: { auto: AUTO_THRESHOLD, suggest: SUGGEST_THRESHOLD },
    providers: counts,
    // The full competition list per provider, for the picker behind "Edit".
    // Squads stay on the server; the picker only needs something to search.
    candidates: Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        candidates[p]
          .map((c) => ({
            id: c.id,
            name: c.name,
            alt: c.alt ?? null,
            sport: c.sport ?? null,
            // Canonical key so the picker can scope to one sport without
            // re-implementing the synonym table in the browser.
            sportKey: c.sport ? sportKey(c.sport) : null,
            events: c.events ?? 0,
            used: taken[p].has(String(c.id)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ]),
    ),
    leagues: leagueRows.map((l) => ({
      opticLeague: l.opticLeague,
      sport: l.sport,
      sportKey: sportKey(l.sport),
      category: l.category,
      tournament: l.tournament,
      fixtures: l.fixtures,
      tournamentCount: l.tournamentCount,
      providers: Object.fromEntries(
        PROVIDERS.map((p) => [
          p,
          {
            currents: l.providers[p].currents,
            suggestion: slim(l.providers[p].suggestion),
            alternatives: l.providers[p].alternatives.map(slim),
          },
        ]),
      ),
    })),
  };
}

/**
 * Add one competition to a league's mapping.
 *
 * Keyed on (provider, optic_league, competition) — NOT on (provider, league).
 * A league has many counterparts per provider, so an upsert on the pair alone
 * would silently rewrite one arbitrary row of the 87 that `tennis_atp_challenger`
 * already holds. Applying adds; removing is explicit.
 */
export async function saveTournamentMapping({ opticLeague, provider, competitionId, competitionName, sport, confidence }) {
  if (!opticLeague || !PROVIDERS.includes(provider)) throw new Error('bad mapping target');
  const league = await (await coll('leagues')).findOne({ optic_league: opticLeague });
  const now = new Date();

  const doc = {
    optic_sport: league?.sport ?? null,
    optic_league: opticLeague,
    optic_tournament: league?.tournament ?? '',
    gutsy_sport: sport ?? null,
    gutsy_competition: competitionName ?? null,
    gutsy_competition_id: competitionId ?? null,
    confidence: confidence ?? 1,
    // Anything written from this page had a human press the button, so it is
    // manual however the candidate was arrived at.
    source: 'manual',
    provider,
    resolved_at: now,
    verified: true,
    verified_at: now,
  };

  const res = await (await coll('competitionMapping')).updateOne(
    { provider, optic_league: opticLeague, gutsy_competition_id: competitionId ?? null },
    { $set: doc },
    { upsert: true },
  );
  return { ok: true, upserted: !!res.upsertedCount, modified: res.modifiedCount };
}

/**
 * Apply many mappings at once.
 *
 * The bulk button covers both providers, which is comfortably enough rows that
 * one request per mapping would be a poor way to spend the trip. One
 * `bulkWrite` of upserts also means the batch either lands or doesn't, rather
 * than leaving the table half-applied if the connection drops midway.
 */
export async function saveTournamentMappings(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: true, applied: 0 };
  if (items.length > 500) throw new Error('too many mappings in one batch');

  const leagues = await (await coll('leagues'))
    .find({ optic_league: { $in: [...new Set(items.map((i) => i.opticLeague))] } })
    .toArray();
  const byKey = new Map(leagues.map((l) => [l.optic_league, l]));
  const now = new Date();

  const ops = [];
  for (const i of items) {
    if (!i?.opticLeague || !PROVIDERS.includes(i.provider)) continue;
    const league = byKey.get(i.opticLeague);
    ops.push({
      updateOne: {
        filter: {
          provider: i.provider,
          optic_league: i.opticLeague,
          gutsy_competition_id: i.competitionId ?? null,
        },
        update: {
          $set: {
            optic_sport: league?.sport ?? null,
            optic_league: i.opticLeague,
            optic_tournament: league?.tournament ?? '',
            gutsy_sport: i.sport ?? null,
            gutsy_competition: i.competitionName ?? null,
            gutsy_competition_id: i.competitionId ?? null,
            confidence: i.confidence ?? 1,
            source: 'manual',
            provider: i.provider,
            resolved_at: now,
            verified: true,
            verified_at: now,
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length === 0) return { ok: true, applied: 0 };

  const res = await (await coll('competitionMapping')).bulkWrite(ops, { ordered: false });
  return {
    ok: true,
    applied: (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0),
    inserted: res.upsertedCount ?? 0,
    updated: res.modifiedCount ?? 0,
  };
}

/**
 * Remove one competition from a league's mapping — or, with no competition
 * named, all of them. Removing one of many must not take the rest with it.
 */
export async function clearTournamentMapping({ opticLeague, provider, competitionId }) {
  if (!opticLeague || !PROVIDERS.includes(provider)) throw new Error('bad mapping target');
  const filter = { provider, optic_league: opticLeague };
  if (competitionId !== undefined && competitionId !== null) {
    filter.gutsy_competition_id = competitionId;
  }
  const res = await (await coll('competitionMapping')).deleteMany(filter);
  return { ok: true, deleted: res.deletedCount };
}
