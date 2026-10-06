import { coll, mongoConfigured } from './mongo.mjs';
import { apiFixtures, apiOddsForFixture, apiOddsForSport } from './sportApi.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';
import { betInstant, COUNTER_ENTRY, VOID_BET } from './bets.mjs';

/**
 * The bet ticker: the latest single bets across every brand, side by side with
 * what the other books were offering on the same outcome.
 *
 * Deliberately NOT the per-fixture Bets tab turned sideways. That answers "who
 * backed this game"; this answers "what is being backed right now, anywhere" —
 * so it reads from both collections at once, spans all sports, and is ordered by
 * when the bet was struck rather than by fixture.
 *
 * Singles only. A multi's price belongs to the combination, not to any one leg,
 * so putting it in a column headed "price" beside a book's price on one outcome
 * would invite a comparison that is not real.
 */

/**
 * One sport vocabulary.
 *
 * A mapped bet takes OPTIC's slug ("amfootball"), an unmapped one keeps the
 * brand's own word ("Gridiron"), and the filter chips listed both — "Basketball
 * 32" beside "basketball 32" as if they were different sports.
 */
const SPORT_LABEL = {
  soccer: 'Soccer', football: 'Soccer',
  amfootball: 'American Football', gridiron: 'American Football',
  americanfootball: 'American Football', nfl: 'American Football',
  basketball: 'Basketball', baseball: 'Baseball', tennis: 'Tennis',
  icehockey: 'Ice Hockey', 'ice hockey': 'Ice Hockey', hockey: 'Ice Hockey',
  cricket: 'Cricket', mma: 'MMA', 'mixed martial arts': 'MMA', ufc: 'MMA',
  boxing: 'Boxing', darts: 'Darts', golf: 'Golf',
  rugbyleague: 'Rugby League', 'rugby league': 'Rugby League',
  rugbyunion: 'Rugby Union', 'rugby union': 'Rugby Union',
  aussierules: 'Aussie Rules', 'australian rules': 'Aussie Rules', afl: 'Aussie Rules',
  volleyball: 'Volleyball', esports: 'Esports', snooker: 'Snooker',
  handball: 'Handball', 'table tennis': 'Table Tennis', badminton: 'Badminton',
};
const sportLabel = (s) => {
  if (!s) return null;
  const k = String(s).toLowerCase().replace(/[^a-z ]/g, '').trim();
  return SPORT_LABEL[k] ?? SPORT_LABEL[k.replace(/ /g, '')] ?? String(s);
};

/**
 * Back from the display label to the slug the public odds surface uses.
 *
 * A deployed instance has no `fixtures` or `odds` to read: the Atlas mirror
 * deliberately carries neither (they are large and change by the second), so
 * `coll('odds')` there throws rather than quietly returning nothing. That
 * surface is per-sport, which is why the join needs the sport back.
 */
const API_SPORT = {
  Soccer: 'soccer', Tennis: 'tennis', Basketball: 'basketball', Baseball: 'baseball',
  'Ice Hockey': 'icehockey', 'American Football': 'amfootball', 'Aussie Rules': 'aussierules',
  'Rugby League': 'rugbyleague', 'Rugby Union': 'rugbyunion', Cricket: 'cricket',
  MMA: 'mma', Boxing: 'boxing', Darts: 'darts', Esports: 'esports',
  Volleyball: 'volleyball', Golf: 'golf',
};
const apiSportsIn = (bets) =>
  [...new Set(bets.map((b) => API_SPORT[b.sport]).filter(Boolean))];

/** Racing is a different product with a different board; this feed is sport. */
const RACING = /racing|gallop|greyhound|harness|trot|thoroughbred/i;

/**
 * What counts as a bet this feed shows. ONE definition, used by the batch query
 * and by the change stream's server-side filter.
 *
 * It was briefly two. The stream re-stated the racing rule as
 * `/^(horse|harness|greyhound)/` and the live feed filled with trifectas,
 * because the sport actually reads "Racing - Gallops" and nothing anchored at
 * the start of it matched.
 */
const SPORT_SINGLE = {
  bets: {
    'derived.is_racing': false,
    'derived.type': 'SINGLE',
    // Swiftbet spells it in its own status rather than a bet type, but a
    // cancelled bet is no more a bet here than on the other source.
    bet_status: { $not: /^cancel/i },
  },
  multi_bets: {
    // Multis are not singles; a cancellation is not a bet. See VOID_BET.
    bet_type: { $not: /multi|cancellation/i },
    sport_name: { $not: RACING, $nin: [null, ''] },
    bet_status: { $not: COUNTER_ENTRY },
  },
};

/**
 * The same conditions re-keyed onto a change event, so Atlas applies them
 * before anything crosses the wire. Racing is the bulk of the volume on both
 * collections; filtering it here rather than in this process is the difference
 * between receiving every bet struck and receiving the ones we display.
 */
export const streamMatch = (name) =>
  Object.fromEntries(
    Object.entries(SPORT_SINGLE[name]).map(([k, v]) => [`fullDocument.${k}`, v]),
  );

/** Period phrasings, stripped before asking whether a total names someone. */
const PERIOD_WORDS =
  /\b(1st|2nd|3rd|4th|first|second|third|fourth|half|quarter|period|inning|innings|set|1h|2h|1q|2q|3q|4q|1s)\b/g;

/** Words that mark a string as naming a market rather than a competition. */
const MARKETY =
  /\b(quarter|half|period|inning|set|game|total|over|under|handicap|line|spread|margin|score|winner|result|tri ?bet|double|alternate|player|points|goals|runs|first|last|anytime|odd|even|btts|draw)\b/i;

/**
 * How many fixtures a deployed instance will fetch in full for one feed.
 *
 * Only reached for bets the cheap head-to-head drain cannot price, and only
 * one call per fixture — but it is the one cost here that grows with the feed,
 * so it is bounded rather than trusted to stay small.
 */
const FULL_FIXTURE_CAP = 25;

/** How many bets the feed carries. The table is a glance, not an export. */
const LIMIT = 150;

/** Only look back this far — an empty feed beats a slow one. */
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Strip the HTML a couple of the feeds wrap their text in. */
const text = (v) =>
  v == null ? null : String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;

/* ------------------------------------------------------------------ sources */

/** Swiftbet singles. The leg carries the event; `selection_data` the market. */
async function swiftSingles(db, since) {
  const rows = await db
    .collection('bets')
    .find({ ...SPORT_SINGLE.bets, bet_time: { $gte: since } })
    .sort({ bet_time: -1 })
    .limit(LIMIT)
    .project({
      bet_time: 1, odd: 1, bet_amount: 1, legs: 1, is_bonus: 1, bet_id: 1, user_id: 1,
      bet_status: 1,
      'derived.sport': 1, 'derived.market_raw': 1, 'derived.mt': 1,
      'derived.legs_event_ids': 1, 'derived.minLegEventTime': 1,
    })
    .toArray();

  return rows.map(mapSwift);
}

/**
 * One swiftbet document -> one ticker row.
 *
 * Exported because the live stream maps a changed document with exactly this
 * function. A stream that derived its own fields would drift from the batch
 * query the moment either changed, and the drift would show as a row that
 * looks subtly different depending on whether it arrived pushed or polled.
 */
export function mapSwift(b) {
  const legs = typeof b.legs === 'string' ? safeParse(b.legs) : b.legs ?? [];
  const leg = legs[0] ?? {};
  // The market lives in selection_data.market_name. `market_type` reads like
  // a market and is not one — it calls a Draw No Bet "Match Result".
  const sd = leg.selections?.[0]?.selection_data?.[0] ?? {};
  return {
    // The document's own id. A pushed row and a polled row describe the same
    // bet, and without this the client cannot tell that and shows it twice.
    id: String(b._id),
    betId: text(b.bet_id),
    userId: text(b.user_id),
    brand: 'swiftbet',
    placedAt: iso(betInstant(b.bet_time)),
    /*
     * The LEG's time, not the derived one.
     *
     * `derived.minLegEventTime` is Sydney wall clock stamped with a Z, the same
     * fault `bet_time` carries: across 300 swiftbet bets it sits exactly +11h
     * from `leg.event_time` on 295 of them and +10h on three more, which is
     * AEDT and then AEST. Preferring it put every swiftbet start eleven hours
     * late, and sent the fixture fallback looking for a game in the wrong half
     * of the next day.
     *
     * `leg.event_time` is already true UTC and agrees with the fixture to the
     * minute. The derived value is only reached if the leg has none, and is
     * converted on the way through.
     */
    startsAt: iso(leg.event_time) ?? iso(betInstant(b.derived?.minLegEventTime)),
    sport: sportLabel(b.derived?.sport),
    tournament: text(leg.meeting_name),
    event: text(leg.event_name),
    market: text(sd.market_name ?? b.derived?.market_raw),
    outcome: stripBonus(sd.name ?? leg.selections?.[0]?.name),
    price: num(b.odd),
    stake: num(b.bet_amount),
    // Struck but refused. Kept on the feed and marked, rather than dropped:
    // a rejection is something you want to SEE happening.
    rejected: /^rejected/i.test(String(b.bet_status ?? '')),
    bonus: !!b.is_bonus || saysBonus(sd.name ?? leg.selections?.[0]?.name),
    eventId: (b.derived?.legs_event_ids ?? [])[0] ?? null,
  };
}
/** Mybet and Multis — one collection, split on the licence it was struck under. */
async function multiSingles(db, since) {
  const rows = await db
    .collection('multi_bets')
    .find({ ...SPORT_SINGLE.multi_bets, transaction_date: { $gte: since } })
    .sort({ transaction_date: -1 })
    .limit(LIMIT)
    .project({
      transaction_date: 1, price: 1, amount_bet: 1, bonus_bet: 1, bet_status: 1,
      transaction_id: 1, user_accountID: 1,
      sport_name: 1, bet_type: 1, selections: 1, event_string: 1,
      event_identifier: 1, transaction_licenseid: 1,
    })
    .toArray();

  return rows.map(mapMulti);
}

/** One multi_bets document -> one ticker row. Shared with the live stream. */
export function mapMulti(m) {
  /*
   * The event and market are run together in one string:
   *   "3rd Quarter - Tri Bet (5.5) - Los Angeles Lakers v Sacramento Kings"
   * The fixture is the last " - " segment, because team names contain
   * hyphens far less often than market names do; what precedes it is the
   * market. Splitting the other way round put "3rd Quarter" in the event.
   */
  const parts = String(m.event_string ?? '').split(' - ');
  const event = parts.length > 1 ? parts.pop().trim() : text(m.event_string);
  // What precedes the fixture is sometimes the market ("3rd Quarter - Tri Bet
  // (5.5)") and sometimes the competition ("WTA Beijing"). Carried as a
  // candidate and decided once the fixture is known — its tournament settles
  // which one this is.
  const lead = parts.length ? parts.join(' - ').trim() : null;
  return {
    id: String(m._id),
    betId: m.transaction_id != null ? String(m.transaction_id) : null,
    userId: m.user_accountID != null ? String(m.user_accountID) : null,
    brand: m.transaction_licenseid === 'MultisComAu' ? 'multis' : 'mybet',
    placedAt: iso(betInstant(m.transaction_date)),
    startsAt: null,
    sport: sportLabel(m.sport_name),
    tournament: null,
    event: text(event),
    // `bet_type` is the market ("Win", "Handicap", "Total"). The leading
    // segment is sometimes MORE specific ("3rd Quarter - Tri Bet (5.5)") and
    // sometimes just the competition ("WTA Beijing", "Argentine Liga
    // Nacional"), so it is only preferred when it actually reads like a
    // market. Comparing it with the fixture's tournament instead was no good:
    // OPTIC says "Argentina Lnb" where mybet says "Argentine Liga Nacional",
    // which share no whole word.
    // Decided later, once the event says whether this segment is a market or a
    // competition — see classifyLeadSegments.
    market: text(m.bet_type),
    leadSegment: text(lead),
    outcome: stripBonus(m.selections),
    price: num(m.price),
    stake: num(m.amount_bet),
    rejected: /^rejected/i.test(String(m.bet_status ?? '')),
    bonus: num(m.bonus_bet) ? true : saysBonus(m.selections),
    eventId: m.event_identifier != null ? String(m.event_identifier) : null,
  };
}
function safeParse(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------- the fixture, and the book */

/**
 * Resolve each bet's book event to an OPTIC fixture, for the columns the bet
 * itself cannot supply — category, the canonical tournament, the real start —
 * and to find the other books' prices.
 *
 * Unmapped bets are KEPT. A bet nobody has mapped is still a bet someone struck,
 * and dropping it would quietly make the busiest competitions look idle.
 */
async function fixturesFor(bets) {
  const ids = [...new Set(bets.map((b) => b.eventId).filter(Boolean))];
  if (!ids.length) return { byEventId: new Map(), fixtures: new Map() };

  const maps = await (await coll('eventMapping'))
    .find({ gutsy_event_id: { $in: ids } })
    .project({ _id: 0, gutsy_event_id: 1, optic_fixture_id: 1, confidence: 1 })
    .toArray();
  const byEventId = new Map();
  for (const m of maps) {
    if (!m.optic_fixture_id) continue;
    const prev = byEventId.get(String(m.gutsy_event_id));
    if (!prev || (m.confidence ?? 0) > (prev.confidence ?? 0)) byEventId.set(String(m.gutsy_event_id), m);
  }

  // Bets on a market-specific mybet event are resolved through their base
  // event before the fixture list is built — see resolveSatelliteEvents.
  await resolveSatelliteEvents(bets, byEventId).catch(() => {});

  const fixtureIds = [...new Set([...byEventId.values()].map((m) => m.optic_fixture_id))];
  const fixtures = new Map();
  if (!fixtureIds.length) {
    await resolveByNameAndStart(bets, byEventId, fixtures).catch((e) => console.error('[ticker] name-fallback failed:', e));
    return { byEventId, fixtures };
  }

  if (mongoConfigured) {
    for (const f of await (await coll('fixtures'))
      .find({ fixture_id: { $in: fixtureIds } })
      .project({
        _id: 0, fixture_id: 1, sport: 1, category: 1, tournament: 1,
        home_team: 1, away_team: 1, event_name: 1, scheduled_start: 1,
      })
      .toArray()) {
      fixtures.set(f.fixture_id, f);
    }
    await resolveByNameAndStart(bets, byEventId, fixtures).catch((e) => console.error('[ticker] name-fallback failed:', e));
    return { byEventId, fixtures };
  }

  // One call per sport present, not one per fixture: 150 bets land on ~100
  // fixtures, and 100 round trips is not something a 30-second feed can spend.
  const want = new Set(fixtureIds);
  await Promise.all(
    apiSportsIn(bets).map(async (sport) => {
      for (const f of await apiFixtures(sport).catch(() => [])) {
        if (want.has(f.fixture_id)) fixtures.set(f.fixture_id, f);
      }
    }),
  );
  await resolveByNameAndStart(bets, byEventId, fixtures).catch((e) => console.error('[ticker] name-fallback failed:', e));
  return { byEventId, fixtures };
}

/**
 * "(Bonus Cash)" is a marker on the selection, not part of it — the table shows
 * it as an icon, so it comes off the text.
 *
 * Only this suffix. Other trailing parentheses carry meaning that would be lost
 * with them: "(Sydney Roosters)" is the player's team, "(-1.5)" the line,
 * "(Refund)" something else again.
 *
 * It also FEEDS the flag rather than merely deferring to it. Across three days
 * of bets the text appears on 182 and `bonus_bet` is set on only 130 of those
 * (and on none the text misses), so stripping it while trusting the flag alone
 * would quietly leave 52 bonus bets looking like ordinary ones.
 */
const BONUS_SUFFIX = /\s*\(bonus[^)]*\)\s*$/i;
const stripBonus = (v) => {
  const t = text(v);
  if (t == null) return null;
  return text(t.replace(BONUS_SUFFIX, ''));
};
const saysBonus = (v) => BONUS_SUFFIX.test(String(v ?? ''));

/**
 * Decide what the leading segment of a mybet slip actually is.
 *
 * The slip runs the whole bet into one string and the first part is sometimes
 * the market and sometimes the competition:
 *
 *   "Hi Bat India - India vs West Indies"            market
 *   "English EFL Trophy - Doncaster vs Liverpool U21" competition
 *
 * The event itself settles it, and settles it exactly. mybet gives the match a
 * BASE event carrying the real league, and every other market on that match a
 * satellite whose league is "-" and whose description leads with the market.
 * So a segment on a base event is the competition; a segment on a satellite is
 * the market.
 *
 * This replaces guessing from vocabulary. A word list scored "3rd Quarter -
 * Tri Bet (5.5)" as a market and "Argentine Liga Nacional" as a competition
 * correctly, but had no opinion worth trusting about "Hi Bat India" — it read
 * as neither and the bet showed its market as plain "Win".
 *
 * The base event's league is also the tournament, which is worth having on a
 * bet whose event never got mapped: the competition is known even when the
 * fixture is not.
 */
async function classifyLeadSegments(bets) {
  const ids = [...new Set(
    bets.filter((b) => b.leadSegment !== undefined)
        .map((b) => Number(b.eventId))
        .filter((n) => Number.isFinite(n)),
  )];
  if (!ids.length) return;
  const db = await betsDb();
  if (!db) return;

  const evs = await db.collection('mybet_events')
    .find({ _id: { $in: ids } })
    .project({ league: 1 })
    .toArray()
    .catch(() => []);
  const leagueOf = new Map(evs.map((e) => [Number(e._id), e.league]));
  const real = (l) => l && String(l).trim() !== '-' && String(l).trim() !== '';

  for (const b of bets) {
    if (b.leadSegment === undefined) continue;
    const league = leagueOf.get(Number(b.eventId));
    if (real(league)) {
      // Base event: the segment was the competition, so the market is the bet
      // type, and the league is a tournament we can show even unmapped.
      b.tournament = b.tournament ?? text(league);
    } else if (b.leadSegment) {
      b.market = b.leadSegment;
    }
  }
}

/**
 * mybet mints a SEPARATE event id for every market on a match, and only the
 * base one carries a competition:
 *
 *   3806816  league "National Basketball Association"  description "NBA"
 *   3817494  league "-"   "Alternate Total Over - Los Angeles Lakers v …"
 *   3817308  league "-"   "1st Quarter - Line (1.5) - Los Angeles Lakers v …"
 *
 * Event mapping is driven by the competition, so the satellites are never
 * resolved and every bet struck on one shows no sport, tournament or start —
 * 29 of 36 unmapped bets on a typical feed, all of them on matches that ARE
 * mapped under their base id.
 *
 * They are tied together by sport and suspension time, which siblings share
 * exactly. The base event is the one whose league is a real competition rather
 * than "-"; where several matches suspend at the same minute, the fixture's own
 * teams settle which is which, since the satellite carries the match name and
 * the base event does not.
 */
async function resolveSatelliteEvents(bets, byEventId) {
  const orphans = bets.filter(
    (b) => b.eventId && /^\d+$/.test(String(b.eventId)) && !byEventId.has(String(b.eventId)),
  );
  if (!orphans.length) return;

  const db = await betsDb();
  if (!db) return;

  const ids = [...new Set(orphans.map((b) => Number(b.eventId)))];
  const own = await db
    .collection('mybet_events')
    .find({ _id: { $in: ids } })
    .project({ sport: 1, suspendAt: 1 })
    .toArray();
  if (!own.length) return;

  const slotOf = new Map(own.map((e) => [Number(e._id), e]));
  const slots = [...new Map(own.map((e) => [`${e.sport}|${e.suspendAt}`, e])).values()];

  const siblings = await db
    .collection('mybet_events')
    .find({ $or: slots.map((e) => ({ sport: e.sport, suspendAt: e.suspendAt })) })
    .project({ league: 1, sport: 1, suspendAt: 1 })
    .toArray();

  const real = (l) => l && String(l).trim() !== '-' && String(l).trim() !== '';
  const basesBySlot = new Map();
  for (const e of siblings) {
    if (!real(e.league)) continue;
    const k = `${e.sport}|${e.suspendAt}`;
    basesBySlot.set(k, [...(basesBySlot.get(k) ?? []), String(e._id)]);
  }
  if (!basesBySlot.size) return;

  const baseIds = [...new Set([...basesBySlot.values()].flat())];
  const maps = await (await coll('eventMapping'))
    .find({ gutsy_event_id: { $in: baseIds } })
    .project({ _id: 0, gutsy_event_id: 1, optic_fixture_id: 1, confidence: 1 })
    .toArray();
  const mapOf = new Map(maps.filter((m) => m.optic_fixture_id).map((m) => [String(m.gutsy_event_id), m]));
  if (!mapOf.size) return;

  // One fixture lookup for every candidate, so the teams can be checked. The
  // deployed instance has to do this too: without it an ambiguous slot — three
  // NBA games tipping at the same minute — would be skipped rather than
  // resolved, which is safe but needlessly empty.
  const candidateFixtures = new Set([...mapOf.values()].map((m) => m.optic_fixture_id));
  const teams = new Map();
  if (mongoConfigured) {
    for (const f of await (await coll('fixtures'))
      .find({ fixture_id: { $in: [...candidateFixtures] } })
      .project({ _id: 0, fixture_id: 1, home_team: 1, away_team: 1, event_name: 1 })
      .toArray()) {
      teams.set(f.fixture_id, f);
    }
  } else {
    await Promise.all(
      apiSportsIn(orphans).map(async (sport) => {
        for (const f of await apiFixtures(sport).catch(() => [])) {
          if (candidateFixtures.has(f.fixture_id)) teams.set(f.fixture_id, f);
        }
      }),
    );
  }

  for (const b of orphans) {
    const own = slotOf.get(Number(b.eventId));
    if (!own) continue;
    const cands = (basesBySlot.get(`${own.sport}|${own.suspendAt}`) ?? [])
      .map((id) => mapOf.get(id))
      .filter(Boolean);
    if (!cands.length) continue;

    let pick = cands[0];
    if (cands.length > 1) {
      // Several matches suspend at this minute: the teams decide.
      const want = new Set(key(b.event).split(' ').filter((t) => t.length > 2));
      pick = cands.find((m) => {
        const f = teams.get(m.optic_fixture_id);
        if (!f) return false;
        const got = key(`${f.home_team ?? ''} ${f.away_team ?? ''} ${f.event_name ?? ''}`);
        let hit = 0;
        for (const t of want) if (got.includes(t)) hit++;
        return want.size && hit / want.size >= 0.6;
      });
      if (!pick) continue;
    }
    byEventId.set(String(b.eventId), pick);
  }
}

/**
 * Last resort: find the fixture by what the bet itself says.
 *
 * Event mapping is driven by `gutsy.events`, and that collection holds finished
 * matches and outrights — of 25,075 rows only 136 are unfinished, and those are
 * all season futures. So a bet struck on a fixture several days out has no
 * event to map THROUGH, however well the matcher is working: the NFL game on
 * the 11th is simply not in there yet.
 *
 * The bet does not need it. A swiftbet leg carries the fixture's name and its
 * start time, and the start is exact rather than approximate, so a fixture at
 * the same minute whose teams agree is the fixture. Both are required: a name
 * alone would match the same teams in a different week, and a time alone would
 * match every other game in the slot.
 *
 * This resolves the display only. The mapping tables are the matcher's to
 * write, and the real repair is upstream — `gutsy.events` should carry upcoming
 * fixtures, and then nothing here would be reached.
 */
async function resolveByNameAndStart(bets, byEventId, fixtures) {
  const orphans = bets.filter(
    (b) => b.event && b.startsAt && !(b.eventId && byEventId.has(String(b.eventId))),
  );
  if (!orphans.length) return;

  const WINDOW_MIN = 90;
  const starts = orphans.map((b) => new Date(b.startsAt).getTime()).filter(Number.isFinite);
  if (!starts.length) return;
  const lo = new Date(Math.min(...starts) - WINDOW_MIN * 60_000);
  const hi = new Date(Math.max(...starts) + WINDOW_MIN * 60_000);

  let candidates = [];
  if (mongoConfigured) {
    candidates = await (await coll('fixtures'))
      .find({ scheduled_start: { $gte: lo, $lte: hi } })
      .project({ _id: 0, fixture_id: 1, sport: 1, category: 1, tournament: 1,
                 home_team: 1, away_team: 1, event_name: 1, scheduled_start: 1 })
      .limit(4000)
      .toArray()
      .catch(() => []);
  } else {
    const perSport = await Promise.all(
      apiSportsIn(orphans).map((sport) => apiFixtures(sport).catch(() => [])),
    );
    candidates = perSport.flat().filter((f) => {
      const t = new Date(f.scheduled_start).getTime();
      return t >= lo.getTime() && t <= hi.getTime();
    });
  }
  if (!candidates.length) return;

  for (const b of orphans) {
    const want = new Set(
      key(b.event).split(' ').filter((t) => t.length > 2 && !FORMAT_TOKEN.test(t)),
    );
    if (want.size < 2) continue;
    const at = new Date(b.startsAt).getTime();
    const hits = candidates.filter((f) => {
      if (Math.abs(new Date(f.scheduled_start).getTime() - at) > WINDOW_MIN * 60_000) return false;
      if (b.sport && sportLabel(f.sport) && sportLabel(f.sport) !== b.sport) return false;
      if (!sameGrade(b.event, `${f.home_team ?? ''} ${f.away_team ?? ''} ${f.event_name ?? ''}`)) return false;
      const got = key(`${f.home_team ?? ''} ${f.away_team ?? ''} ${f.event_name ?? ''}`);
      let hit = 0;
      for (const t of want) if (got.includes(t)) hit++;
      return hit / want.size >= 0.8;
    });
    // Only when it is unambiguous — two fixtures answering to the same teams at
    // the same minute means we do not actually know which was backed.
    if (hits.length !== 1) continue;
    const f = hits[0];
    byEventId.set(String(b.eventId ?? `name:${b.id}`), { optic_fixture_id: f.fixture_id, confidence: 0 });
    b.eventId = b.eventId ?? `name:${b.id}`;
    fixtures.set(f.fixture_id, f);
  }
}

/**
 * Words that name a FORMAT or a club's legal form rather than the side itself.
 *
 * Swiftbet writes cricket sides as "India T20" where the fixture is plain
 * "India v West Indies", and clubs with whichever prefix each feed prefers —
 * "PFC Minyor Pernik" against "FC Minyor Pernik", "Farense" against "SC
 * Farense". Counted as part of the name these drag a correct match under the
 * bar.
 *
 * "Women" is deliberately NOT in here. Dropping it would let a women's bet
 * match the men's fixture, which is the one mistake this must never make — the
 * two are played by the same clubs on the same day. It is checked for
 * agreement instead, in sameGrade.
 */
const FORMAT_TOKEN = /^(t20|t10|odi|test|xi|100|fc|pfc|afc|sc|sv|cf|ac|cd|ud|gd|ec|sd|fk|bk|sk)$/;

/**
 * Women's and men's fixtures are different fixtures.
 *
 * The same clubs meet on the same day, and the only thing separating them is a
 * word — "Manchester City Women" against the feed's "Manchester City WFC". So
 * it is required to AGREE rather than be ignored: a side that says women must
 * meet one that says women.
 */
const WOMENS = /\b(women|womens|ladies|wfc|w)\b/;
const sameGrade = (a, b) => WOMENS.test(key(a)) === WOMENS.test(key(b));

/** Normalise for comparing a bet's outcome text against a price's selection. */
const key = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * "Safiullin, Roman" and "Roman Safiullin" are the same person. Compare as word
 * SETS, so surname-first ordering stops mattering.
 *
 * Scored BOTH ways, never against the shorter side. A subset test called
 * "Los Angeles Lakers and Over +58.5" — one leg of a same-game multi — equal to
 * "Los Angeles Lakers", and the row showed the moneyline prices beside a bet
 * that was not the moneyline.
 */
/**
 * Surnames only, initials dropped.
 *
 * Doubles are the case that forces it: a book writes "Krajicek, A/Mektic, N"
 * where the surface writes "Austin Krajicek // Nikola Mektic". Every word that
 * identifies the pair is shared, but the given names and initials drag the
 * overlap score to 0.5 and the pair went unpriced.
 *
 * Used only as a fallback, and only when it picks out exactly ONE selection on
 * the fixture — see pickByName. A containment test that is allowed to match two
 * things is how a same-game-multi leg ended up priced against the moneyline.
 */
function surnameSubset(a, b) {
  const A = new Set(key(a).split(' ').filter((t) => t.length > 1));
  const B = new Set(key(b).split(' ').filter((t) => t.length > 1));
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function sameSelection(a, b) {
  const A = new Set(key(a).split(' ').filter(Boolean));
  const B = new Set(key(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size) >= 0.8;
}

/**
 * The market ids a bet's market name might be asking about.
 *
 * Whole-name matches only, and nothing combined. A same-game multi reads
 * "1st quarter winner / 1st quarter total points 58.5" and used to satisfy a
 * loose /win/ test, so a parlay leg was priced against the full-match
 * moneyline. A market this cannot name confidently gets no comparison, which is
 * the honest answer — a blank column beats a wrong one.
 */
/**
 * Read a bet's market and outcome into something the odds surface can be
 * searched with: which market, at which period, on which side, at which line.
 *
 * The two vocabularies do not line up, and cannot be made to by comparing
 * strings. A book writes the whole bet into one phrase —
 *
 *   "Total Under 7.5 runs"            "Ryan Seggerman -3.5 games"
 *
 * — where the surface splits it across three fields:
 *
 *   market_id "total"  selection "Under"          line 7.5
 *   market_id "spread" selection "Ryan Seggerman" line -3.5
 *
 * so the side and the line have to be parsed out of the phrase before anything
 * can be compared. Matching on names alone priced none of these: 14 totals and
 * 10 handicaps went bare because "Total Under 7.5 runs" is not "Under".
 */
export function parseBetMarket(market, outcome) {
  const m = String(market ?? '');
  const o = String(outcome ?? '');
  const km = key(m);
  const ko = key(o);
  if (!km && !ko) return null;

  // Two markets in one bet — "1st quarter winner / 1st quarter total points",
  // "half time result and both teams to score". The surface prices each leg
  // separately and neither is this bet, so there is nothing honest to show.
  if (/\//.test(m) || /\b(and|both teams)\b/.test(km)) return null;

  // Period scope. The surface carries these as a prefix on the market id, and
  // they used to be rejected outright — which threw away every first-half and
  // opening-set bet even though `1h_total` and `1s_total` were sitting there.
  const period =
    /\b(1st|first) half\b|\b1h\b/.test(km) ? '1h_'
    : /\b(2nd|second) half\b/.test(km) ? '2h_'
    : /\b(1st|first) quarter\b/.test(km) ? '1q_'
    : /\b(2nd|second) quarter\b/.test(km) ? '2q_'
    : /\b(3rd|third) quarter\b/.test(km) ? '3q_'
    : /\b(4th|fourth) quarter\b/.test(km) ? '4q_'
    : /\b(1st|first) set\b/.test(km) ? '1s_'
    : /\b(1st|first) inn(ing)?\b/.test(km) ? '1inn_'
    : '';

  // The line can be written on either side: "handicap -3.5" carries it in the
  // market, "Over +228.5" in the outcome. The outcome wins when both have one.
  const numIn = (t) => {
    const hit = String(t).match(/[-+]?\d+(?:\.\d+)?/g);
    return hit ? Number(hit[hit.length - 1]) : null;
  };
  const line = numIn(o) ?? numIn(m);

  const side = /\bunder\b/.test(ko) ? 'under' : /\bover\b/.test(ko) ? 'over' : null;

  // A total is the only market whose outcome is a side rather than a runner.
  if (side != null && line != null) {
    /*
     * Whose total, though. "total Korea Republic goals 1.5" is that team's
     * goals; the match total at the same 1.5 is a different market and a
     * different price — 1.22 against the 1.67 actually struck. Offering the
     * match total as a stand-in put a bet 36% away from its own comparison.
     *
     * So a total that NAMES someone is only ever matched against team totals,
     * and when the surface carries none for that fixture the row stays blank.
     * Blank is the honest answer; the wrong market dressed as the right one is
     * not.
     */
    const qualifier = km
      .replace(PERIOD_WORDS, ' ')
      .replace(/\b(total|totals|over|under|alternate|alt|line|lines|points?|goals?|runs?|games?|sets?|score|match|the)\b/g, ' ')
      .replace(/[-+]?\d+(?:\.\d+)?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return qualifier
      ? { kind: 'total', marketIds: [`${period}team_total`], side, line, qualifier }
      : { kind: 'total', marketIds: [`${period}total`], side, line };
  }

  // Everything else is named: a team, a player, a pair. What separates a
  // handicap from a moneyline is that the handicap carries a line.
  const name = o
    .replace(/[-+]?\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(points?|goals?|runs?|games?|sets?|yards?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A market that SAYS handicap is one.
  if (/\b(handicap|line|spread|point spread)\b/.test(km) && line != null) {
    return { kind: 'spread', marketIds: [`${period}spread`], name, line };
  }

  /*
   * A market that says head-to-head is one, whatever digits the outcome
   * happens to contain. This has to be decided BEFORE a line is inferred:
   * swiftbet writes cricket sides as "India T20", the 20 reads as a number,
   * and a plain head-to-head bet was being hunted for as a spread at line 20 —
   * which of course priced nothing.
   */
  if (/\b(head to head|h2h|moneyline|money line|match result|result|win|winner|to win|draw)\b/.test(km)) {
    return {
      kind: 'moneyline',
      marketIds: [`${period}moneyline`, `${period}moneyline_3way`],
      name,
      line: null,
    };
  }

  // Otherwise a line in the text is the only sign it is a handicap at all.
  if (line != null && !/\btotal\b/.test(km)) {
    return { kind: 'spread', marketIds: [`${period}spread`], name, line };
  }
  return null;
}

/**
 * The same line, sign included.
 *
 * Comparing magnitudes looked defensible — the favourite is stored at -3.5 and
 * the dog at +3.5, so the sign seemed to belong to the selection rather than
 * the number. It does not. Books quote the SAME team at both ends as alternate
 * lines, and "San Jose Sharks +1.5 goals" (struck at 1.61) matched San Jose at
 * -1.5 and was shown against a field of 4.70.
 */
export const sameLine = (a, b) => a != null && b != null && Math.abs(a - b) < 0.01;

/**
 * The rows naming the thing backed.
 *
 * Tried strictly first. The loose pass only stands if it is UNAMBIGUOUS across
 * the fixture's selections — "Nacional" should find "Club Nacional" but must
 * not be allowed to choose between two clubs that both contain it.
 */
export function pickByName(rows, name) {
  const strict = rows.filter((r) => sameSelection(r.selection, name));
  if (strict.length) return strict;
  const loose = rows.filter((r) => surnameSubset(r.selection, name));
  const distinct = new Set(loose.map((r) => key(r.selection)));
  return distinct.size === 1 ? loose : [];
}

/**
 * What every book was offering on the same outcome.
 *
 * Only for markets this board actually prices — a comparison column that is
 * blank because the market is exotic looks the same as one blank because the
 * books disagree, and only one of those is interesting.
 */
async function pricesFor(bets, byEventId, fixtures) {
  const wanted = new Map(); // fixture_id -> bets needing it
  const want = new Map(); // bet -> what to look for
  for (const b of bets) {
    const m = b.eventId ? byEventId.get(String(b.eventId)) : null;
    if (!m) continue;
    const parsed = parseBetMarket(b.market, b.outcome);
    if (!parsed) continue;
    want.set(b, parsed);
    const list = wanted.get(m.optic_fixture_id) ?? [];
    list.push(b);
    wanted.set(m.optic_fixture_id, list);
  }
  if (!wanted.size) return;

  let rows;
  if (mongoConfigured) {
    rows = await (await coll('odds'))
      .find({ fixture_id: { $in: [...wanted.keys()] }, is_live: { $ne: true } })
      .project({
        _id: 0, fixture_id: 1, market_id: 1, selection: 1, line: 1,
        sportsbook: 1, is_lay: 1, current_price: 1,
      })
      .toArray();
  } else {
    const onFeed = new Set(wanted.keys());
    // Reported, not swallowed. When these failed the feed answered 200 with
    // every bet present and every comparison column blank, which reads as a
    // quiet market rather than a broken fetch.
    const failures = [];
    const perSport = await Promise.all(
      apiSportsIn(bets).map((sport) =>
        apiOddsForSport(sport).catch((e) => {
          failures.push(`${sport}: ${String(e?.message ?? e).slice(0, 80)}`);
          return [];
        }),
      ),
    );
    if (failures.length) throw new Error(`odds drain failed — ${failures.join(' | ')}`);
    rows = perSport.flat().filter((r) => onFeed.has(r.fixture_id));

    /*
     * That per-sport drain asks for head-to-head only — 0.5 MB against 28 MB
     * unfiltered across seven sports — so it carries no row a handicap or a
     * total could ever match against, and the deployed board priced none of
     * them however well they parsed.
     *
     * The fixtures that actually carry such a bet are few: 12 of them behind 33
     * bets on a typical feed. So those are fetched WHOLE, one call each, which
     * is exactly what opening the event page does. Capped, because the cost is
     * per fixture and this endpoint answers on a 30-second cache.
     */
    const needFull = [...wanted.entries()]
      .filter(([, list]) => list.some((b) => want.get(b)?.kind !== 'moneyline'))
      .map(([fixtureId]) => fixtureId)
      .slice(0, FULL_FIXTURE_CAP);

    const extra = await Promise.all(
      needFull.map((fixtureId) => {
        const sport = fixtures.get(fixtureId)?.sport;
        return sport ? apiOddsForFixture(fixtureId, sport).catch(() => []) : Promise.resolve([]);
      }),
    );
    rows = [...rows, ...extra.flat()];
  }

  const byFixture = new Map();
  for (const r of rows) {
    const list = byFixture.get(r.fixture_id) ?? [];
    list.push(r);
    byFixture.set(r.fixture_id, list);
  }

  for (const [fixtureId, list] of wanted) {
    const all = byFixture.get(fixtureId) ?? [];
    for (const b of list) {
      const w = want.get(b);
      if (!w) continue;
      /*
       * Market ids are tried IN ORDER, and the first that answers wins.
       *
       * A two-way moneyline and a three-way one are different markets: the
       * draw absorbs probability, so the three-way is systematically longer —
       * 1.833 against 1.952 on the same baseball team at the same book, and
       * 149 of 162 pairs quoted in both differ by more than 2%. Searching them
       * together and keeping the best per book meant the three-way price won
       * almost every time, which flatters the field and makes the bet look
       * worse than it was.
       */
      let hits = [];
      for (const marketId of w.marketIds) {
        const inMarket = all.filter((r) => !r.is_lay && r.market_id === marketId);
        if (!inMarket.length) continue;
        hits =
          w.kind === 'total'
            // A total's outcome is a side, not a runner: match Over to Over at
            // the same number, never by name.
            ? inMarket.filter((r) => key(r.selection) === w.side && sameLine(r.line, w.line))
            : w.kind === 'spread'
              ? pickByName(inMarket, w.name).filter((r) => sameLine(r.line, w.line))
              : pickByName(inMarket, w.name);
        if (hits.length) break;
      }
      if (!hits.length) continue;
      const best = new Map();
      for (const r of hits) {
        const p = num(r.current_price);
        if (p == null) continue;
        const prev = best.get(r.sportsbook);
        if (prev == null || p > prev) best.set(r.sportsbook, p);
      }
      if (best.size) b.prices = Object.fromEntries([...best.entries()].sort());
    }
  }
}

/* -------------------------------------------------------------------- feed */

export async function betTicker() {
  if (!betsConfigured) return { configured: false, bets: [] };
  const db = await betsDb();
  if (!db) return { configured: false, bets: [] };

  const since = new Date(Date.now() - WINDOW_MS);
  const [swift, multi] = await Promise.all([
    swiftSingles(db, since).catch(() => []),
    multiSingles(db, since).catch(() => []),
  ]);

  const bets = [...swift, ...multi]
    .filter((b) => b.placedAt)
    .sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)))
    .slice(0, LIMIT);

  await classifyLeadSegments(bets).catch(() => {});
  const { bets: enriched, pricesError } = await enrich(bets);
  return {
    configured: true,
    source: mongoConfigured ? 'mongo' : 'odds-surface',
    ...(pricesError ? { pricesError } : {}),
    bets: enriched,
  };
}

/**
 * Give raw rows their fixture, their canonical names and the other books'
 * prices. Mutates and returns them.
 *
 * Separate from the query so a bet that arrives PUSHED goes through exactly the
 * same enrichment as one that arrives in the batch — see tickerStream.mjs.
 */
export async function enrich(bets) {
  if (!bets.length) return { bets: [], pricesError: null };

  const { byEventId, fixtures } = await fixturesFor(bets);
  for (const b of bets) {
    const m = b.eventId ? byEventId.get(String(b.eventId)) : null;
    const f = m ? fixtures.get(m.optic_fixture_id) : null;
    b.fixtureId = m?.optic_fixture_id ?? null;
    if (f) {
      // The fixture is the better source for these: one canonical spelling,
      // and a category the bet never carries.
      b.sport = sportLabel(f.sport) ?? b.sport;
      b.category = f.category ?? null;
      b.tournament = f.tournament ?? b.tournament;
      b.event = f.event_name ?? (f.home_team && f.away_team ? `${f.home_team} v ${f.away_team}` : b.event);
      b.startsAt = iso(f.scheduled_start) ?? b.startsAt;
    } else {
      b.category = null;
    }
  }
  // Reported, not swallowed. A deployed instance has no `odds` to read and
  // this step threw there, but the feed still answered 200 with a plausible
  // shape, so the failure read as "no comparison prices today" from the
  // outside. Anything that degrades the feed now says so in the payload.
  const pricesError = await pricesFor(bets, byEventId, fixtures).then(
    () => null,
    (e) => String(e?.message ?? e).slice(0, 200),
  );

  return {
    bets: bets.map(({ leadSegment, ...b }) => ({ ...b, prices: b.prices ?? null })),
    pricesError,
  };
}
