import { coll, mongoConfigured } from './mongo.mjs';
import { apiFixtureIndex, apiOddsForFixture, apiOddsForSport } from './sportApi.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';
import { betInstant, COUNTER_ENTRY, SATELLITE_SKEW_MS, VOID_BET } from './bets.mjs';
import { fairsFor, groupKey } from './fair.mjs';

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
 * What counts as a bet this feed shows. ONE definition — used by the batch
 * query, by the change stream's server-side filter, and (exported) by the
 * pending-bets feed, so all three ask the same question.
 *
 * It was briefly two. The stream re-stated the racing rule as
 * `/^(horse|harness|greyhound)/` and the live feed filled with trifectas,
 * because the sport actually reads "Racing - Gallops" and nothing anchored at
 * the start of it matched.
 */
export const SPORT_SINGLE = {
  bets: {
    'derived.is_racing': false,
    'derived.type': 'SINGLE',
    // Swiftbet spells it in its own status rather than a bet type, but a
    // cancelled bet is no more a bet here than on the other source.
    bet_status: { $not: /^cancel/i },
  },
  multi_bets: {
    // Multis are not singles; a cancellation is not a bet. See VOID_BET.
    //
    // Each field is stated TWICE, and the pair is the whole point. The regex is
    // the rule; the `$nin` is the same rule spelled as values so the index can
    // act on it. Mongo will not push `$not` + regex down to an index scan — it
    // evaluates it on the FETCH stage, after reading the document — so with the
    // regex alone this query read 15,356 documents to return 200, every one of
    // them fetched only to be thrown away. Naming the values gets that to 292.
    //
    // Written this way round, rather than as a positive list of the sports we
    // DO want, because the two fail in opposite directions. An allow-list omits
    // whatever it has not heard of: the day a new sport is listed it is missing
    // from the feed and nothing says so. Excluding the racing values instead
    // means anything new is on the feed by default, which is the error you find
    // out about immediately. And if a new RACING label appears upstream, the
    // regex still catches it — that bet costs one wasted fetch and is filtered
    // correctly. So the list can only ever be a performance hint; it is never
    // what decides whether something is a bet.
    //
    // Both lists are every stored value its regex matches, as of 2026-10-15
    // (37 distinct sports, 12 bet types — checked, not guessed).
    bet_type: { $not: /multi|cancellation/i, $nin: ['Cancellation', 'Multi'] },
    sport_name: {
      $not: RACING,
      $nin: [
        'Greyhound Racing',
        'Harness Racing',
        // Matched by the regex, so it has always been off the ticker. Kept here
        // to say what the rule does rather than quietly change it.
        'Motor Racing',
        'Racing - Gallops',
        'Racing - Greyhounds',
        'Racing - Harness',
        'Racing - Other',
        null,
        '',
      ],
    },
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

/**
 * How many fixtures a deployed instance will fetch in full for one feed.
 *
 * Only reached for bets the cheap head-to-head drain cannot price, and only
 * one call per fixture — but it is the one cost here that grows with the feed,
 * so it is bounded rather than trusted to stay small.
 */
/*
 * Per-fixture top-ups per feed read.
 *
 * Raised from 25 because the cap was already saturated before period
 * moneylines and btts started asking for one, and a bet that loses its
 * comparison to a queue is indistinguishable from one the surface cannot
 * price. They run concurrently, so the wall cost is upstream concurrency
 * rather than the sum: 25 of them measured 1.5s.
 */
const FULL_FIXTURE_CAP = 40;

/**
 * The same budget for the settled view, which can afford far more of it.
 *
 * Every settled fixture has to be fetched one at a time — see needFull — and
 * there is no cheap drain to fall back on, so the cap IS the coverage. Forty
 * would have answered for a quarter of a week's bets and silently dropped the
 * rest. The route caches for an hour, which is what makes this affordable.
 */
const CLOSING_FIXTURE_CAP = 1500;

/**
 * And a DEADLINE, because the cap bounds requests while the function is bounded
 * in seconds.
 *
 * Fourteen days of settled singles touch 1,283 distinct fixtures, and in
 * production each one is its own HTTP request paced at eight a second — about
 * 160 seconds against a 300-second function. That fits, but only while the
 * upstream stays quick: the cap cannot tell the difference between 1,283 fast
 * requests and 1,283 slow ones, and the failure it cannot prevent is the whole
 * function timing out and the view returning NOTHING, which is strictly worse
 * than returning twelve of the fourteen days.
 *
 * So the budget is time. Four minutes against a 300-second function, which
 * leaves the bets query and the mapping their ~20 seconds and still covers the
 * ~192 seconds the window measures at (1,283 fixtures, ~1.2 requests each
 * after the sp call came off, at eight a second). Set at three minutes first,
 * which was under the real cost and would have dropped the oldest days of the
 * window every single build. It is the floor under the bad case, not the plan.
 */
const CLOSING_BUDGET_MS = 240_000;

/**
 * Concurrent lanes, which is not the same thing as the rate.
 *
 * The token bucket in sportApi decides how FAST requests leave (eight a
 * second); this decides how many are in the air at once, and the surface
 * documents sixteen. The fan-out below used to be one `Promise.all` over every
 * fixture, which with 1,283 of them opened 1,283 sockets and let the bucket
 * dribble them out — the rate was right and the in-flight count was not. A pool
 * also gives the deadline somewhere to be checked: queued work that has not
 * started yet can still be abandoned, where a promise already created cannot.
 */
const FETCH_LANES = 16;

/**
 * Phase timings, reported on the payload.
 *
 * The cold path is the whole performance story here -- warm calls answer in
 * 0.4s, a cold instance took 30s -- and it only exists in production, where
 * the odds API is reachable. So the breakdown has to come back with the data
 * rather than from a local profile.
 */
const timed = async (into, name, fn) => {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    if (into) into[name] = Date.now() - t0;
  }
};

/** How many bets the feed carries. The table is a glance, not an export. */
/*
 * Raised from 150. Even one hour of trade overflows it: the 3-day window holds
 * 2,275 qualifying sport singles (1,478 swiftbet, 797 multis+mybet), so the cap
 * is what decides how far back the feed reaches — 150 covered about 9 hours.
 *
 * The ceiling is the per-fixture price work, not this: FULL_FIXTURE_CAP bounds
 * how many fixtures get fetched whole for a handicap or period market, so more
 * bets here means proportionally more of the long tail going unpriced rather
 * than a proportionally slower build.
 */
const LIMIT = 200;

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
/**
 * The index the query above needs, declared where the query is.
 *
 * `{transaction_date: -1, sport_name: 1, bet_type: 1}` — the sort on the
 * leading key, the two `$nin` fields behind it so the scan can discard racing
 * and multis on the index keys instead of fetching 15,000 documents to return
 * 200.
 *
 * It is asked for here rather than left as something somebody typed into a
 * shell once, because the scraper re-syncs `multi_bets` wholesale: an index
 * created by hand is one `drop` away from gone, and the symptom would be the
 * ticker quietly getting slower with nothing to point at. Once per process and
 * cached, following `sso_used_tickets` in auth.mjs — `createIndex` on an index
 * that already exists is a no-op, so the steady-state cost is one cheap command
 * per cold start.
 *
 * Failure is swallowed deliberately. The index is a performance hint and the
 * regexes are the rule, so a read-only user or a build already in progress
 * should mean a slower ticker, never a broken one.
 *
 * NOT awaited, which is the part that matters. On an existing index this is one
 * cheap command, but on a missing one it is the build — 112s when it was made,
 * 210s the second time — and awaiting that would hang the first ticker request
 * for three minutes to make the next one faster. The query does not need the
 * index to be correct, only to be quick, so it is started and left to finish on
 * its own while this read goes through the slow plan.
 */
let tickerIndexed;
function ensureTickerIndex(db) {
  tickerIndexed ??= db
    .collection('multi_bets')
    .createIndex(
      { transaction_date: -1, sport_name: 1, bet_type: 1 },
      { name: 'tick_date_sport_type' },
    )
    .catch(() => {});
}

/** Mybet and Multis — one collection, split on the licence it was struck under. */
async function multiSingles(db, since) {
  ensureTickerIndex(db);
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

/* ------------------------------------------------------------- client tags */

/**
 * The risk tag the books keep against a bettor, attached to each row.
 *
 * Two stores, because the two sources number their customers differently:
 * swiftbet's `tags` is keyed on the account UUID in `id`, and `multi_tags` on
 * `user_accountID` alongside the licence, since Multis and MyBet share that
 * collection.
 *
 * `multi_bets.user_accountID` is a NUMBER and `multi_tags.user_accountID` a
 * STRING, so the lookup has to coerce — matching as-is returns nothing at all,
 * which is how this looked like missing data rather than a type mismatch.
 *
 * Tags arrive pipe-separated on the swiftbet side ("Good client|Tier 4") and
 * as one value on the other ("small", "barring order"), so both are split the
 * same way and an empty string becomes no tag rather than a blank one.
 */
const LICENCE = { multis: 'MultisComAu', mybet: 'MyBet' };

async function tagsFor(bets) {
  if (!bets.length) return;
  const db = await betsDb();
  if (!db) return;

  const swiftIds = [];
  const multiIds = [];
  for (const b of bets) {
    if (b.userId == null || b.userId === '') continue;
    if (b.brand === 'swiftbet') swiftIds.push(String(b.userId));
    else multiIds.push(String(b.userId));
  }

  const [swift, multi] = await Promise.all([
    swiftIds.length
      ? db.collection('tags')
          .find({ id: { $in: [...new Set(swiftIds)] } })
          .project({ _id: 0, id: 1, tags: 1 })
          .toArray()
          .catch(() => [])
      : [],
    multiIds.length
      ? db.collection('multi_tags')
          .find({ user_accountID: { $in: [...new Set(multiIds)] } })
          .project({ _id: 0, user_accountID: 1, tags: 1, transaction_licenseid: 1 })
          .toArray()
          .catch(() => [])
      : [],
  ]);

  const split = (v) =>
    String(v ?? '')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);

  const bySwift = new Map(swift.map((t) => [String(t.id), split(t.tags)]));
  // Keyed with the licence: the same account number exists under both.
  const byMulti = new Map(
    multi.map((t) => [`${t.transaction_licenseid}|${t.user_accountID}`, split(t.tags)]),
  );

  for (const b of bets) {
    if (b.userId == null) { b.tags = []; continue; }
    b.tags =
      b.brand === 'swiftbet'
        ? bySwift.get(String(b.userId)) ?? []
        : byMulti.get(`${LICENCE[b.brand] ?? ''}|${String(b.userId)}`) ?? [];
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
async function fixturesFor(bets, timings) {
  const ids = [...new Set(bets.map((b) => b.eventId).filter(Boolean))];
  if (!ids.length) return { byEventId: new Map(), fixtures: new Map() };

  /*
   * Start the per-sport fixture drains NOW, before the mapping lookup.
   *
   * Which sports to drain depends only on the bets, which are already in hand,
   * while the mapping query and the satellite pass are a couple of seconds of
   * Mongo that used to run entirely before the first fixture byte was asked
   * for. apiFixtureIndex is single-flight cached, so this is also the only call
   * made: the satellite pass and the filter below both join this promise
   * instead of queueing behind each other.
   */
  const drains = mongoConfigured
    ? null
    : apiSportsIn(bets).map((sport) => [sport, apiFixtureIndex(sport).catch(() => [])]);

  const maps = await timed(timings, 'mapping', async () => (await coll('eventMapping'))
    .find({ gutsy_event_id: { $in: ids } })
    .project({ _id: 0, gutsy_event_id: 1, optic_fixture_id: 1, confidence: 1 })
    .toArray());
  const byEventId = new Map();
  for (const m of maps) {
    if (!m.optic_fixture_id) continue;
    const prev = byEventId.get(String(m.gutsy_event_id));
    if (!prev || (m.confidence ?? 0) > (prev.confidence ?? 0)) byEventId.set(String(m.gutsy_event_id), m);
  }

  // Bets on a market-specific mybet event are resolved through their base
  // event before the fixture list is built — see resolveSatelliteEvents.
  await timed(timings, 'satellites', () =>
    resolveSatelliteEvents(bets, byEventId).catch(() => {}),
  );

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
  await timed(timings, 'fixtureList', () =>
    Promise.all(
      (drains ?? []).map(async ([, pending]) => {
        for (const f of await pending) {
          if (want.has(f.fixture_id)) fixtures.set(f.fixture_id, f);
        }
      }),
    ),
  );
  await timed(timings, 'nameFallback', () =>
    resolveByNameAndStart(bets, byEventId, fixtures).catch((e) =>
      console.error('[ticker] name-fallback failed:', e),
    ),
  );
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
/*
 * Exported, because the pending and settled feeds need it too and silently did
 * without. It must run BEFORE enrich on every caller — see the note at the
 * ticker's own call site.
 */
export async function classifyLeadSegments(bets) {
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
 * How far a market-specific mybet event may sit from its own match event.
 *
 * mybet mints a separate event per side market -- "First Set Winner - Alex De
 * Minaur vs Karen Khachanov" is its own id, with no teams and no league, only a
 * description -- so a bet on one has nothing the hourly matcher can map and
 * must be resolved through the base match event instead.
 *
 * That pairing used to require the two to suspend at the SAME instant, and
 * mostly they do: for this match the base and five of its six satellites all
 * sat at 04:05. "First Set Winner" sat at 04:10. Five minutes was enough for the
 * slot lookup to find no sibling carrying a league, give up, and leave the bet
 * with no fixture and therefore no prices -- while the identical bet on "Set
 * Betting" resolved fine.
 *
 * The window is SATELLITE_SKEW_MS, shared with the bets page so the two cannot
 * disagree about what counts as the same game. It was twenty minutes here,
 * which covered this case and not the worst of them — tennis satellites drift
 * up to 35 minutes. It is only safe at any width because the player names are
 * then checked against the candidate fixture; see the loop below.
 */
const SATELLITE_SLOT_SKEW_MS = SATELLITE_SKEW_MS;

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
    .find({
      $or: slots.map((e) => {
        const at = new Date(e.suspendAt).getTime();
        return {
          sport: e.sport,
          suspendAt: {
            $gte: new Date(at - SATELLITE_SLOT_SKEW_MS),
            $lte: new Date(at + SATELLITE_SLOT_SKEW_MS),
          },
        };
      }),
    })
    .project({ league: 1, sport: 1, suspendAt: 1 })
    .toArray();

  const real = (l) => l && String(l).trim() !== '-' && String(l).trim() !== '';
  const bases = siblings
    .filter((e) => real(e.league) && e.suspendAt)
    .map((e) => ({ id: String(e._id), sport: e.sport, at: new Date(e.suspendAt).getTime() }));
  if (!bases.length) return;

  const baseIds = [...new Set(bases.map((e) => e.id))];
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
        for (const f of await apiFixtureIndex(sport).catch(() => [])) {
          if (candidateFixtures.has(f.fixture_id)) teams.set(f.fixture_id, f);
        }
      }),
    );
  }

  for (const b of orphans) {
    const own = slotOf.get(Number(b.eventId));
    if (!own) continue;
    const ownAt = own.suspendAt ? new Date(own.suspendAt).getTime() : NaN;
    if (!Number.isFinite(ownAt)) continue;
    const cands = bases
      .filter((e) => e.sport === own.sport && Math.abs(e.at - ownAt) <= SATELLITE_SLOT_SKEW_MS)
      // Nearest in time first, so the closest base wins among equally-named ones.
      .sort((x, y) => Math.abs(x.at - ownAt) - Math.abs(y.at - ownAt))
      .map((e) => mapOf.get(e.id))
      .filter(Boolean);
    if (!cands.length) continue;

    /*
     * The players must agree, even when there is only one candidate.
     *
     * Under an exact slot the time WAS the evidence, so a lone candidate could
     * be taken on trust. A window is not evidence — twenty minutes of a tennis
     * day holds a dozen matches — so the name check is no longer the
     * tie-breaker it was, it is the whole test.
     */
    const want = new Set(key(b.event).split(' ').filter((t) => t.length > 2));
    const pick = cands.find((m) => {
      const f = teams.get(m.optic_fixture_id);
      if (!f) return false;
      const got = key(`${f.home_team ?? ''} ${f.away_team ?? ''} ${f.event_name ?? ''}`);
      let hit = 0;
      for (const t of want) if (got.includes(t)) hit++;
      return want.size && hit / want.size >= 0.6;
    });
    if (!pick) continue;
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
      apiSportsIn(orphans).map((sport) => apiFixtureIndex(sport).catch(() => [])),
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

/**
 * The draw, however a book writes it.
 *
 * The surface calls it "Draw". Swiftbet writes "Drawn Match", which shares no
 * whole word with it — "draw" and "drawn" are different tokens — so every draw
 * bet went unpriced on a fixture that was quoting one.
 */
const DRAW = /^(drawn? ?(match|game)?|the draw|tie)$/;

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
/*
 * DIRECTIONAL: the bet's name must be contained in the SURFACE's, never the
 * other way round.
 *
 * It used to take whichever set was smaller, which is the same test run both
 * ways — and the wrong way round it matches a player to his own team. mybet
 * writes a scorer market as "Brevyn Spann-Ford (Dallas Cowboys)" on a bet_type
 * of "Win", so the surface's "Dallas Cowboys" moneyline selection is a strict
 * subset of the bet's text and matched it: a bet struck at 67.0 was priced
 * against the team's moneyline and reported a closing fair of 1.925, a 50%
 * edge that was really a 35x price gap between two different markets.
 *
 * The case this exists for runs the other way — a book writes
 * "Krajicek, A/Mektic, N" where the surface writes the fuller "Austin Krajicek
 * // Nikola Mektic", so the BET is the subset. Requiring that direction keeps
 * the doubles and refuses the scorer.
 */
function surnameSubset(surfaceName, betName) {
  const surface = new Set(key(surfaceName).split(' ').filter((t) => t.length > 1));
  const bet = new Set(key(betName).split(' ').filter((t) => t.length > 1));
  if (!surface.size || !bet.size) return false;
  for (const t of bet) if (!surface.has(t)) return false;
  return true;
}

function sameSelection(a, b) {
  const ka = key(a); const kb = key(b);
  if (DRAW.test(ka) && DRAW.test(kb)) return true;
  const A = new Set(ka.split(' ').filter(Boolean));
  const B = new Set(kb.split(' ').filter(Boolean));
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size) >= 0.8;
}

/**
 * Which handicap market a soccer handicap bet is actually in.
 *
 * Soccer has two and they are different bets. The Asian handicap (`spread`) is
 * two-way: at -1, a one-goal win returns the stake. The European handicap
 * (`handicap_3way`) has the draw as a third outcome: at -1, a one-goal win
 * loses. So the three-way price is systematically LONGER, and comparing one
 * against the other manufactures edge that is not there — exactly the fault the
 * moneyline branch below already guards against.
 *
 * A handicap bet resolved to `spread` and nothing else, so every swiftbet
 * soccer handicap was priced against a market swiftbet does not offer. Real
 * Madrid -1.0 taken at 1.65 showed a 1.407 "close" and a 10% overlay on a
 * $1,000 stake; the two numbers are different bets.
 *
 * Told apart by the LINE, which is firmer than a brand rule and agrees with it.
 * Measured over fourteen days: `handicap_3way` carries whole lines ONLY (±1 to
 * ±6, no fractional line anywhere), while the Asian market is mostly
 * fractional. And of 57 soccer handicap bets, swiftbet's 49 are all whole while
 * mybet's and multis' 8 are all fractional — so the shape of the line and the
 * brand that struck it say the same thing.
 *
 * No fallback between them, deliberately. If the three-way is not priced on a
 * fixture — only Pinnacle and Sportsbet quote it — the bet is unjudged, which
 * is the honest answer. Falling back to the Asian close is the bug.
 */
const handicapIds = (period, line, sport) =>
  String(sport ?? '').toLowerCase() === 'soccer' && Number.isInteger(line)
    ? [`${period}handicap_3way`]
    : [`${period}spread`];

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
export function parseBetMarket(market, outcome, sport) {
  const m = String(market ?? '');
  const o = String(outcome ?? '');
  const km = key(m);
  const ko = key(o);
  if (!km && !ko) return null;

  /*
   * Both-teams-to-score, on its own, IS a market the surface prices — `btts`,
   * and its selections are literally "Yes" and "No".
   *
   * It was being thrown out twice over: once by the combo guard below, for
   * containing "both teams", and again by the non-priceable list, for
   * containing "to score". Six bets on a typical feed, every one of them
   * matchable. A COMBINED bet still has to go: "half time result and both
   * teams to score" reads "Mexico and Yes" on the outcome, so requiring the
   * outcome to be nothing but yes/no is what separates them.
   */
  /*
   * The market must BE both-teams-to-score, not merely contain it.
   *
   * Swiftbet lists "both teams to score", "both teams to score 2+ goals" and
   * "both teams to score in both halves" on the same game, all with Yes/No
   * selections — so a `contains` test called all three `btts` and put a 10.00
   * Yes (from the 2+ goals market) beside the field's 2.39. Stripping the
   * period words first keeps "half time both teams to score" working, which is
   * genuinely 1h_btts; anything with words left over is a different market and
   * falls through to the combo guard below.
   */
  const bttsCore = km
    .replace(PERIOD_WORDS, ' ')
    // PERIOD_WORDS has "half" but not "time", so "half time both teams to
    // score" kept a stray "time" and failed the equality — while "1st half
    // both teams to score", the same market, passed.
    .replace(/\b(time|full|ht|halftime)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const btts = bttsCore === 'both teams to score' && /^(yes|no)$/.test(ko);

  // Two markets in one bet — "1st quarter winner / 1st quarter total points",
  // "half time result and both teams to score". The surface prices each leg
  // separately and neither is this bet, so there is nothing honest to show.
  if (!btts && (/\//.test(m) || /\b(and|both teams)\b/.test(km))) return null;

  /*
   * Markets this board does not price. They have to be named, because several
   * read enough like a moneyline to be matched as one and then compared
   * against it: "Tri Bet (15.5)" is a three-way margin and was shown against
   * the outright winner at 1.12 for a bet struck at 19.00, and "correct score"
   * put Uruguay 6-1 at 30.00 beside a 1.038 match-winner price.
   *
   * Blank is the honest answer for these. A comparison against a market the
   * bet was not struck in is worse than no comparison at all.
   */
  if (!btts && /\b(correct score|tri bet|winning margin|margin|scorer|anytime|to score|race to|odd\/even|odd or even|double result)\b/.test(km)) {
    return null;
  }

  /*
   * The "win ..." family, which the moneyline test below cannot tell apart.
   *
   * That test matches a bare `\bwin\b`, so ANY market with the word win in it
   * became the match winner — and these are not it. Bet
   * 4229dce1-6ff6-4536-b7fc-79d7430c2cea is "win both halves" on Melbourne
   * City at 10.00, which was judged against the full-match moneyline close of
   * 3.189 and reported as beating the close by a mile. Winning both halves is
   * a far longer proposition than winning the match, so 10.00 was an ordinary
   * price and the overlay was entirely an artefact of the comparison.
   *
   * Listed separately from the markets above rather than merged into them,
   * because the reason differs: those are markets the board does not price,
   * while these are markets it prices a DIFFERENT one of under a similar name.
   * Both end blank, which is the honest answer — a 10.00 shown against 3.189
   * does not read as a mismatch, it reads as a mistake we made.
   */
  if (/\b(both halves|either half|to nil|clean sheet|wire to wire|win from behind|win by)\b/.test(km)) {
    return null;
  }

  /*
   * Period phrasings the surface has no market for.
   *
   * `/limits` carries 1h, 1q, 1inn, 1s and set markets and nothing else, so a
   * first-five-innings total has no home — and because "1st 5 innings" matches
   * none of the period patterns above it silently became the FULL-GAME total.
   * A bet on Over 3.5 in the first five innings at 1.80 was judged against the
   * nine-inning Over 3.5 close of 1.202 and reported as a 50% overlay.
   *
   * Set betting is the same shape of mistake with a different ending: there is
   * no correct-score-in-sets market, and "Edas Butvilas 2-1" carries a 1 that
   * the handicap rule below reads as a LINE, so it was priced against the -1
   * set handicap at 1.709 for a bet struck at 4.10.
   */
  if (/\b(1st 5 innings|first 5 innings|f5|1st 3 innings|first 3 innings|set betting|score betting)\b/.test(km)) {
    return null;
  }

  /*
   * Sets after the first have no market either.
   *
   * `/limits` carries `1s_*` and nothing for later sets, and "set 2 total games
   * 2way 9.5" matched none of the period patterns above — so it became the
   * FULL-MATCH total games, a different market and a different number.
   */
  if (/\b(2nd|second|3rd|third|4th|fourth|5th|fifth) set\b|\bset [2-5]\b/.test(km)) {
    return null;
  }

  /*
   * Innings after the first, likewise: `/limits` stops at `1inn_`.
   *
   * "5th Inning - Money Line | Milwaukee Brewers" matched no period pattern, so
   * it resolved to the FULL-GAME moneyline — a different bet entirely. It was
   * previously read as a handicap at line 5, the 5 coming out of "5th", which
   * at least found nothing; resolving it to the match winner would have priced
   * it confidently and wrongly.
   */
  if (/\b(2nd|second|3rd|third|4th|fourth|5th|fifth|6th|7th|8th|9th) inn(ing)?s?\b|\binn(ing)?s? [2-9]\b/.test(km)) {
    return null;
  }

  /*
   * And hockey PERIODS, which `/limits` has no market for at all.
   *
   * The period prefixes this file knows are halves, quarters, sets and the
   * first innings; "1st period result" matches none of them and so resolved to
   * the FULL-MATCH moneyline — a three-way regulation market read as the
   * two-way game line. Swiftbet's Senators v Sharks carried six of those plus
   * four "3rd period total goals" rows, every one of which would have been
   * priced against the whole game.
   */
  if (/\b(1st|first|2nd|second|3rd|third|4th|fourth) period\b|\bperiod [1-4]\b/.test(km)) {
    return null;
  }

  // Period scope. The surface carries these as a prefix on the market id, and
  // they used to be rejected outright — which threw away every first-half and
  // opening-set bet even though `1h_total` and `1s_total` were sitting there.
  /*
   * Each book writes the period its own way, and a phrasing that is not
   * recognised is worse than one that is not handled: it silently becomes the
   * FULL match. "half time result" was compared against the match winner, and
   * "inning 1 Winner" against the result of the whole game.
   */
  const period =
    /\b(1st|first) half\b|\bhalf time\b|\bhalftime\b|\bht\b|\b1h\b/.test(km) ? '1h_'
    : /\b(2nd|second) half\b|\b2h\b/.test(km) ? '2h_'
    : /\b(1st|first) quarter\b|\bquarter 1\b|\b1q\b/.test(km) ? '1q_'
    : /\b(2nd|second) quarter\b|\bquarter 2\b|\b2q\b/.test(km) ? '2q_'
    : /\b(3rd|third) quarter\b|\bquarter 3\b|\b3q\b/.test(km) ? '3q_'
    : /\b(4th|fourth) quarter\b|\bquarter 4\b|\b4q\b/.test(km) ? '4q_'
    : /\b(1st|first) set\b|\bset 1\b|\b1s\b/.test(km) ? '1s_'
    : /\b(1st|first) inn(ing)?s?\b|\binn(ing)?s? 1\b/.test(km) ? '1inn_'
    : '';

  // Named here rather than above, because a half-time BTTS is `1h_btts`.
  if (btts) {
    return { kind: 'btts', marketIds: [`${period}btts`], name: o.trim(), line: null };
  }

  /*
   * Markets the surface prices under their own id, which have to be claimed
   * BEFORE the moneyline test below gets hold of them.
   *
   * `GET /limits` publishes 23 market types and `dnb` is one of them, so draw
   * no bet has a real closing price of its own — it was being excluded
   * outright, which is honest but needlessly blind, and before that judged
   * against the three-way moneyline, which it is not: the stake comes back on
   * a draw, so the price is always shorter. There is no `1h_dnb`, so a
   * period-scoped one still has nowhere to go.
   */
  if (/\bdraw no bet\b|\bdnb\b/.test(km)) {
    return period ? null : { kind: 'moneyline', marketIds: ['dnb'], name: o.trim(), line: null };
  }

  // The line can be written on either side: "handicap -3.5" carries it in the
  // market, "Over +228.5" in the outcome. The outcome wins when both have one.
  /*
   * STANDALONE numbers only, which is the same rule `name` below already uses.
   *
   * This matched digits anywhere, so "First Team Touchdown | San Francisco
   * 49ers" came back as a handicap at line 49 — read out of "49ers". The 76ers,
   * the Adelaide 36ers and Schalke 04 all have the same problem, and a market
   * that says "handicap" with no line would then take the line from the team's
   * name.
   */
  const numIn = (t) => {
    // Brackets count as a boundary: these brands write the line as "(+1.5)" at
    // least as often as " +1.5", and requiring whitespace broke every
    // "1st Half - Handicap (-1.5) | Sturm Graz (+1.5)" into no market at all.
    const hit = String(t).match(/(?:^|[\s([])([-+]?\d+(?:\.\d+)?)(?=[)\]\s]|$)/g);
    return hit ? Number(hit[hit.length - 1].replace(/[^-+\d.]/g, '')) : null;
  };
  const line = numIn(o) ?? numIn(m);

  const side = /\bunder\b/.test(ko) ? 'under' : /\bover\b/.test(ko) ? 'over' : null;

  // A total is the only market whose outcome is a side rather than a runner.
  if (side != null && line != null) {
    /*
     * Sets are counted by their own market, `total_sets` in /limits — not by
     * the games total and not by a team total. "number of sets | Over 2.5" was
     * being sent to `team_total` with a qualifier of "number of", which could
     * only ever match nothing. No period, because a per-set games total is
     * `1s_total` and the prefix below handles it.
     */
    if (!period && /\bsets\b/.test(km)) {
      return { kind: 'total', marketIds: ['total_sets'], side, line };
    }
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
      /*
       * `2way` and `inc ot` describe the market's SHAPE, not whose total it
       * is. Left in, they read as a team name and sent the bet looking for a
       * team total: "set 1 total games 2way 9.5" and "goals 5.5 (inc ot)" both
       * priced nothing, though 1s_total at 9.5 and total at 5.5 were sitting
       * there. "Norway" survives, because \bway\b does not match inside it.
       */
      .replace(/\b(total|totals|over|under|alternate|alt|line|lines|points?|goals?|runs?|games?|sets?|score|match|the)\b/g, ' ')
      .replace(/\b(2way|3way|way|inc|incl|including|ot|overtime|reg|regulation)\b/g, ' ')
      // Standalone numbers only — the same rule `name` below already uses.
      // Stripping digits anywhere made "Adelaide 36ers" into "adelaide ers",
      // which would match no team total if the surface ever carried one.
      .replace(/(^|\s)[-+]?\d+(?:\.\d+)?(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return qualifier
      ? { kind: 'total', marketIds: [`${period}team_total`], side, line, qualifier }
      : { kind: 'total', marketIds: [`${period}total`], side, line };
  }

  // Everything else is named: a team, a player, a pair. What separates a
  // handicap from a moneyline is that the handicap carries a line.
  const name = o
    // Only numbers standing on their own are the LINE. Stripping digits
    // anywhere turned "Adelaide 36ers" into "Adelaide ers", which matched no
    // selection on the fixture — and would do the same to the 76ers or
    // Schalke 04.
    //
    // Brackets count as standing on their own: "Sturm Graz (+1.5)" otherwise
    // kept its line, and pickByName compares the bet's tokens against the
    // surface's selection, where "(+1.5)" appears in neither.
    .replace(/[([]\s*[-+]?\d+(?:\.\d+)?\s*[)\]]/g, ' ')
    .replace(/(^|\s)[-+]?\d+(?:\.\d+)?(?=\s|$)/g, ' ')
    .replace(/\b(points?|goals?|runs?|games?|sets?|yards?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /*
   * A SET handicap is not the game handicap, and the surface prices both.
   *
   * `/limits` has three: `spread` (for tennis, the game handicap), `1s_spread`
   * (1st-set games) and `set_spread` (sets). Measured on one fixture at the
   * same -1.5 line: set_spread 3.52, spread 2.25, 1s_spread 2.31 — so sending
   * a set-handicap bet to `spread` compared it against a game line 56% away.
   * Eight bets a fortnight, and one of them was the third-largest row in the
   * settled list: 1.83 taken against a "1.422 close" that belonged to another
   * market.
   *
   * Only when no period is detected: "1st set game handicap" is 1s_spread and
   * the period prefix below already resolves it.
   */
  if (!period && /\bset\b/.test(km) && /\b(handicap|lines?|spread)\b/.test(km) && line != null) {
    return { kind: 'spread', marketIds: ['set_spread'], name, line };
  }

  /*
   * A market that SAYS handicap is one — including in the PLURAL.
   *
   * "Alternate Lines - Sydney Kings | Sydney Kings -29.5" is the handicap at a
   * non-main line, and `\bline\b` does not match "lines", so every one of them
   * missed this branch and fell through to the last-resort spread below. When
   * that was removed they became unjudgeable, which is how a deliberate
   * handicap market got mistaken for a novelty.
   */
  if (/\b(handicap|lines?|spread|point spread)\b/.test(km) && line != null) {
    return { kind: 'spread', marketIds: handicapIds(period, line, sport), name, line };
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

  /*
   * There is no last-resort handicap. A number in the text is not evidence.
   *
   * This used to end with "a line in the text is the only sign it is a handicap
   * at all", and treated any leftover market carrying a number as a spread.
   * Audited over fourteen days: 396 bets took that branch and NOT ONE was a
   * handicap. They were player props and novelties — "Kyren Williams 4+
   * Receptions" at line 4, "M. Stafford 250+ Passing Yards" at line 250,
   * "player home-runs Shohei Ohtani" at line 1, "Time of First Goal - 10 mins"
   * at line -10 — and bet 6675431, First Team Touchdown on the 49ers at 1.60,
   * judged against the NFL point spread at +1.
   *
   * The big lines were merely noisy, because no spread market exists at 250.
   * The small ones are the damage: 198 of the 396 carried a line a real
   * handicap market also quotes, so they matched and were priced against a
   * market the customer never bet into.
   *
   * A market that is a handicap says so, and that branch is above. Everything
   * else goes unjudged, which is this file's standing rule: no comparison is
   * better than one against the wrong market.
   */
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
/**
 * `closing: true` reads where the market FINISHED rather than where it is.
 *
 * A settled bet cannot be judged against a current price — the market has moved
 * on and in most cases stopped existing. The close is the number everyone had
 * their say about, so it is the one that says whether the price we laid was
 * wrong. Same matching, same de-vig, different column.
 */
async function pricesFor(bets, byEventId, fixtures, timings, { closing = false } = {}) {
  const priceField = closing ? 'close_price' : 'current_price';
  const wanted = new Map(); // fixture_id -> bets needing it
  const want = new Map(); // bet -> what to look for
  for (const b of bets) {
    const m = b.eventId ? byEventId.get(String(b.eventId)) : null;
    if (!m) continue;
    const parsed = parseBetMarket(b.market, b.outcome, b.sport);
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
        // The three the fairs need on top of a price: `pair_key` is the outcome
        // group to de-vig over, `outcome_no` says which side of it the bet is
        // on, and `status` keeps a suspended price out of the average. Without
        // them in the projection every fair came back null while the price
        // columns beside them filled in normally.
        pair_key: 1, outcome_no: 1, status: 1,
        // And the close, for the settled view. Projected unconditionally rather
        // than behind the flag: it is one number, and a projection that depends
        // on a caller's option is the same trap as the three above — the fairs
        // came back null with nothing to say why.
        close_price: 1, closed_at: 1,
      })
      .toArray();
  } else {
    const onFeed = new Set(wanted.keys());
    // Reported, not swallowed. When these failed the feed answered 200 with
    // every bet present and every comparison column blank, which reads as a
    // quiet market rather than a broken fetch.
    const failures = [];
    const perSport = await timed(timings, 'oddsPerSport', () => Promise.all(
      apiSportsIn(bets).map((sport) =>
        apiOddsForSport(sport).catch((e) => {
          failures.push(`${sport}: ${String(e?.message ?? e).slice(0, 80)}`);
          return [];
        }),
      ),
    ));
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
    /*
     * A PERIOD-scoped moneyline is not on that drain either.
     *
     * It asks for `market=h2h`, which returns the FULL-MATCH moneyline only.
     * So `1s_moneyline`, `1h_moneyline` and the rest found no rows and priced
     * nothing -- while `kind === 'moneyline'` told this filter the fixture was
     * already covered and it never asked for the whole thing. A first-set
     * winner whose selection was sitting right there in `1s_moneyline` is
     * exactly the bet that went blank.
     */
    const onH2hDrain = (w) =>
      w?.kind === 'moneyline' &&
      (w.marketIds ?? []).every((id) => id === 'moneyline' || id === 'moneyline_3way');
    /*
     * Closing prices need EVERY fixture fetched, and a much larger budget.
     *
     * The filter below asks "can the cheap per-sport drain already answer for
     * this fixture", and for a settled one the answer is always no: the drain
     * covers the board window, three days back, and a bet settled a week ago is
     * outside it. So a settled moneyline — which this filter would skip as
     * already covered — got no closing price at all.
     *
     * The cap is the ticker's budget, and the ticker rebuilds every twenty
     * seconds. The settled view is cached for an hour, so it can afford to ask
     * for all of them: 150-odd fixtures at eight requests a second is twenty
     * seconds, once an hour.
     */
    const cap = closing ? CLOSING_FIXTURE_CAP : FULL_FIXTURE_CAP;
    const needFull = [...wanted.entries()]
      .filter(([, list]) => closing || list.some((b) => !onH2hDrain(want.get(b))))
      .map(([fixtureId]) => fixtureId)
      .slice(0, cap);

    const deadline = Date.now() + (closing ? CLOSING_BUDGET_MS : Infinity);
    const queue = needFull.slice();
    let dropped = 0;
    const lane = async () => {
      const out = [];
      while (queue.length) {
        // Checked here rather than before the fan-out, because this is the only
        // place that runs LATE: by the time a lane reaches the thousandth
        // fixture, minutes have passed, and abandoning what is still queued is
        // what keeps the answer inside the function's budget.
        if (Date.now() > deadline) {
          dropped += queue.length;
          queue.length = 0;
          break;
        }
        const fixtureId = queue.shift();
        const sport = fixtures.get(fixtureId)?.sport;
        if (!sport) continue;
        /*
         * `currentOnly` drops the ladder AND the settled prices, which is right
         * for the ticker and useless for a closing price: the cheap shape has
         * no `_close` columns at all. A settled fixture is asked for whole.
         */
        /*
         * `opens: false` in BOTH modes, because nothing in this file reads
         * `open_price` — the closing comparison is `close_price` through
         * `fairsFor`, and the pending page's "vs open" comes from our own brand
         * stores. See apiOddsForFixture: it is a second request per fixture,
         * which at the 1,283 fixtures behind fourteen days of settled bets was
         * 321 seconds of a 300-second function.
         *
         * Written as `!closing` first, which was wrong in the other direction:
         * the ticker's `currentOnly` used to skip that call on its own, so
         * asking for opens here would have ADDED forty requests to every
         * twenty-second ticker build to fetch a column it does not read.
         */
        const got = await apiOddsForFixture(fixtureId, sport, { currentOnly: !closing, opens: false })
          .catch(() => []);
        for (const r of got) out.push(r);
      }
      return out;
    };
    const extra = await timed(timings, 'oddsPerFixture', () =>
      Promise.all(Array.from({ length: Math.min(FETCH_LANES, queue.length) }, lane)),
    );
    if (timings) {
      timings.fullFixtures = needFull.length - dropped;
      // Surfaced even at zero: "how many fixtures did this answer actually
      // price" is the first question to ask of a thin settled view, and a
      // missing key reads as a coverage problem that is not there.
      timings.droppedFixtures = dropped;
    }
    rows = [...rows, ...extra.flat()];
  }

  const byFixture = new Map();
  for (const r of rows) {
    const list = byFixture.get(r.fixture_id) ?? [];
    list.push(r);
    byFixture.set(r.fixture_id, list);
  }

  /*
   * Outcome groups per fixture, built once.
   *
   * The fairs need the whole market — every outcome at this line, from every
   * book — where the price columns only need the bet's own selection. Indexing
   * by `pair_key` up front rather than re-scanning the fixture's rows for each
   * of up to 200 bets.
   */
  const groupsFor = (all) => {
    const m = new Map();
    for (const r of all) {
      const k = groupKey(r);
      if (!k) continue;
      const list = m.get(k) ?? [];
      list.push(r);
      m.set(k, list);
    }
    return m;
  };

  for (const [fixtureId, list] of wanted) {
    const all = byFixture.get(fixtureId) ?? [];
    const groups = groupsFor(all);
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
        const p = num(r[priceField]);
        if (p == null) continue;
        const prev = best.get(r.sportsbook);
        if (prev == null || p > prev) best.set(r.sportsbook, p);
      }
      if (best.size) b.prices = Object.fromEntries([...best.entries()].sort());

      /*
       * The fairs, off the same rows the price columns came from.
       *
       * `hits` are the bet's own selection across books, so they share an
       * outcome and a pair_key — the group they belong to is the market this
       * bet is in, and that is what gets de-vigged. See fair.mjs for why a
       * missing pair_key means no fair rather than a guessed grouping.
       */
      const group = groups.get(groupKey(hits[0]));
      if (group) {
        const f = fairsFor(group, hits[0].outcome_no, { field: priceField });
        if (f.fairPinnacle != null) b.fairPinnacle = f.fairPinnacle;
        if (f.fairBlend != null) {
          b.fairBlend = f.fairBlend;
          b.fairBooks = f.fairBooks;
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- feed */

export async function betTicker() {
  if (!betsConfigured) return { configured: false, bets: [] };
  const db = await betsDb();
  if (!db) return { configured: false, bets: [] };

  const timings = {};
  const since = new Date(Date.now() - WINDOW_MS);
  const [swift, multi] = await timed(timings, 'query', () =>
    Promise.all([
      swiftSingles(db, since).catch(() => []),
      multiSingles(db, since).catch(() => []),
    ]),
  );

  const bets = [...swift, ...multi]
    .filter((b) => b.placedAt)
    .sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)))
    .slice(0, LIMIT);

  /*
   * BEFORE enrich, and it has to stay that way.
   *
   * I moved this alongside enrich to save its quarter-second, on the reasoning
   * that it "only touches the bets". That is the reason it cannot be moved:
   * enrich also touches them and then PROJECTS them into new objects on the way
   * out, so a mutation that lands after that projection is thrown away. The
   * visible fault was a mybet bet on "First Tryscorer - Australia vs New
   * Zealand" reporting its market as "Win" — bet_type, the fallback — because
   * the pass that reads the market out of the event string had not finished
   * when the row was built. It raced, so it was wrong sometimes and right
   * others, which is worse than being wrong always.
   */
  await timed(timings, 'segments', () => classifyLeadSegments(bets).catch(() => {}));
  const { bets: enriched, pricesError } = await timed(timings, 'enrich', () =>
    enrich(bets, timings),
  );
  return {
    configured: true,
    source: mongoConfigured ? 'mongo' : 'odds-surface',
    ...(pricesError ? { pricesError } : {}),
    timings,
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
export async function enrich(bets, timings, { closing = false } = {}) {
  if (!bets.length) return { bets: [], pricesError: null };

  const { byEventId, fixtures } = await timed(timings, 'fixtures', () => fixturesFor(bets, timings));
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
  const [pricesError] = await Promise.all([
    timed(timings, 'prices', () =>
      pricesFor(bets, byEventId, fixtures, timings, { closing }).then(
        () => null,
        (e) => String(e?.message ?? e).slice(0, 200),
      ),
    ),
    // Independent of the prices, so it rides alongside rather than after. A
    // missing tag is not worth failing a row over.
    timed(timings, 'tags', () => tagsFor(bets).catch(() => {})),
  ]);

  return {
    bets: bets.map(({ leadSegment, ...b }) => ({ ...b, prices: b.prices ?? null, tags: b.tags ?? [] })),
    pricesError,
  };
}
