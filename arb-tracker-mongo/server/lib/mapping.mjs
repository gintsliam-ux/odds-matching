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

/**
 * How many fixtures to sample per competition when collecting its squad.
 *
 * It is also the cap the aggregations apply, with $firstN. They used to push
 * every team name in the collection -- 175k documents' worth for mybet -- ship
 * the lot over the wire and then slice to this number in JS. Same sample,
 * since the sort is the same: the head of a sorted group is the head of what
 * pushing everything would have produced, and 1,016 groups across the two
 * feeds came back identical.
 */
const TEAM_SAMPLE = 400;

const PROVIDERS = ['swift', 'mybet'];

/**
 * Phase timings, reported on the payload.
 *
 * This endpoint is the slowest on the site and its cost is all in production,
 * where the candidate feeds are remote. Same reasoning as ticker.mjs: the
 * breakdown has to come back with the data.
 */
const timed = async (into, name, fn) => {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    if (into) into[name] = Date.now() - t0;
  }
};
const timedSync = (into, name, fn) => {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    if (into) into[name] = Date.now() - t0;
  }
};

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
          teams: { $firstN: { input: '$teams.name', n: TEAM_SAMPLE } },
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
          teamsA: { $firstN: { input: '$match.teamA', n: TEAM_SAMPLE } },
          teamsB: { $firstN: { input: '$match.teamB', n: TEAM_SAMPLE } },
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

/**
 * The same two lists, precomputed by scripts/sync-to-atlas.mjs.
 *
 * Grouping them live reads about 3 GB of documents to produce 1 MB of league
 * names -- mybet_events averages 11 KB a row and gutsy.events 38 KB, because
 * each carries its own price history -- which cost the deployed page 36s for
 * mybet alone. Which competitions a book trades changes slowly, so they are
 * built hourly instead, exactly as league_squads already is for the optic side
 * of this same page.
 *
 * Null when the collection is not there yet, so the live path below still
 * answers on a store that has never run the job.
 */
async function candidatesFromStore() {
  const rows = await (await coll('competitionCandidates')).find({}).toArray().catch(() => []);
  if (!rows?.length) return null;
  const out = { swift: [], mybet: [] };
  for (const r of rows) {
    if (!out[r.provider]) continue;
    // Shaped exactly as the live functions return, `alt` included only for
    // mybet — the scorer reads both name and alt, and a stray null is not the
    // same input as an absent key.
    const c = { id: r.id, name: r.name, sport: r.sport ?? null, events: r.events, teams: r.teams ?? [] };
    if (r.alt != null) c.alt = r.alt;
    out[r.provider].push(c);
  }
  return out;
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
          home: { $firstN: { input: '$home_team', n: TEAM_SAMPLE } },
          away: { $firstN: { input: '$away_team', n: TEAM_SAMPLE } },
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

  const timings = {};
  // One read of the precomputed lists, or the two live aggregations if the job
  // has not produced them yet.
  const stored = await timed(timings, 'storedCandidates', () => candidatesFromStore());
  timings.candidateSource = stored ? 'precomputed' : 'live';
  const [leagues, existing, swift, mybet, health] = await timed(timings, 'fetch', () =>
    Promise.all([
      timed(timings, 'opticLeagues', () => opticLeagues()),
      timed(timings, 'competitionMapping', async () =>
        (await coll('competitionMapping')).find({}).toArray(),
      ),
      stored ? stored.swift : timed(timings, 'swiftCandidates', () => swiftCandidates(db)),
      stored ? stored.mybet : timed(timings, 'mybetCandidates', () => mybetCandidates(db)),
      // Built hourly rather than derived here: it needs `fixtures`, which a
      // deployed instance does not carry. Missing is fine — the page just shows
      // no health, rather than failing.
      timed(timings, 'leagueHealth', async () =>
        (await coll('leagueHealth')).find({}).toArray().catch(() => []),
      ),
    ]),
  );
  const healthBy = new Map((health ?? []).map((h) => [h._id, h]));

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

  const leagueRows = timedSync(timings, 'score', () => leagues.map((l) => {
    const h = healthBy.get(l.opticLeague);
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
    /*
     * Flag a mapping that is producing nothing.
     *
     * A wrong competition mapping looks identical to a right one on this page —
     * it has a name, a confidence, a verified tick — and silently matches none
     * of its fixtures. The only evidence is downstream, so it is surfaced here:
     * mapped, the book IS trading that competition, and not one fixture paired.
     *
     * `bookEvents > 0` is what keeps this honest. A competition the book is not
     * trading right now matches nothing for a good reason — the NBA out of
     * season is not a broken mapping — and flagging those would bury the 35
     * that are worth looking at.
     */
    for (const p of PROVIDERS) {
      const hp = h?.providers?.[p];
      if (!hp || !row.providers[p]?.currents?.length) continue;
      row.providers[p].health = {
        fixtures: h.fixtures ?? 0,
        matched: hp.matched ?? 0,
        bookEvents: hp.bookEvents ?? 0,
        suspect: (hp.matched ?? 0) === 0 && (hp.bookEvents ?? 0) > 0 && (h.fixtures ?? 0) > 0,
      };
    }
    return row;
  }));

  // Two leagues claiming one competition means at most one is right.
  timedSync(timings, 'collisions', () => {
    for (const p of PROVIDERS) demoteCollisions(rowsByProvider[p]);
  });

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
    timings,
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
            // Explicit projection, so anything added upstream has to be named
            // here too — `health` was attached correctly and silently dropped
            // on the way out until it was.
            health: l.providers[p].health ?? null,
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
/**
 * The tournament key the MATCHER will look this mapping up by.
 *
 * Stage 2 scopes a fixture's candidates with `sport|league|tournament`, and it
 * builds that key with an EMPTY tournament for every sport but tennis — only
 * tennis groups by `season_type`, because one OPTIC tennis league spans dozens
 * of separate events. Writing `leagues.tournament` here instead produced
 * `amfootball|amfootball_nfl|NFL`, which matches nothing, so every NFL fixture
 * was skipped and the mapping sat on the page looking perfectly healthy while
 * pairing zero events. 63 hand-made mappings were silently dead this way.
 */
const matcherTournamentKey = (league) =>
  (league?.sport ?? '').toLowerCase() === 'tennis' ? (league?.tournament ?? '') : '';

export async function saveTournamentMapping({ opticLeague, provider, competitionId, competitionName, sport, confidence }) {
  if (!opticLeague || !PROVIDERS.includes(provider)) throw new Error('bad mapping target');
  const league = await (await coll('leagues')).findOne({ optic_league: opticLeague });
  const now = new Date();

  const doc = {
    optic_sport: league?.sport ?? null,
    optic_league: opticLeague,
    optic_tournament: matcherTournamentKey(league),
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
  // Same intent shape as the bulk path, so the drain has one case to handle.
  await queueForNas('upsert', {
    items: [{ opticLeague, provider, competitionId: competitionId ?? null, competitionName, sport, confidence }],
  });
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
/**
 * Record a mapping write so the tailnet can replay it onto `gutsys_sport`.
 *
 * A deployed instance has no route to the NAS, so its writes land on the Atlas
 * mirror — which the page reads, so the change is visible at once — and would
 * otherwise be erased by the next sync, which rebuilds the mirror FROM the NAS.
 * The intent queued here is what closes the loop: the hourly agent drains it
 * onto the NAS *before* pushing the NAS back out, so the row exists upstream by
 * the time the rebuild runs. On the tailnet this is a no-op — the write already
 * went to the source.
 */
async function queueForNas(op, payload) {
  if (mongoConfigured) return;
  await (await coll('mappingPending')).insertOne({ op, payload, at: new Date() });
}

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
            optic_tournament: matcherTournamentKey(league),
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
  await queueForNas('upsert', { items });
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
  // A delete has to travel too, or the next sync would restore the row from the
  // NAS copy that still has it.
  await queueForNas('delete', { opticLeague, provider, competitionId: competitionId ?? null });
  return { ok: true, deleted: res.deletedCount };
}
