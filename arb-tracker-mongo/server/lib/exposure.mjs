import { coll } from './mongo.mjs';
import { betsDb } from './betsMongo.mjs';
import { betInstant } from './bets.mjs';
import { COUNTER_ENTRY } from './betVocab.mjs';

/**
 * Two things a desk wants to be told rather than go looking for: a market that
 * has not settled, and a bet that was taken after the game had started.
 *
 * Both read the bets cluster and, for the multi sources only, join through
 * `event_mapping` for a start time. The swiftbet side needs no join at all —
 * `bet_time` and `derived.minLegEventTime` sit on the same document — which is
 * why its coverage here is complete and the others' is not.
 */

/** Racing is a different product with a different desk. Matches ticker.mjs. */
const RACING = /racing|gallop|greyhound|harness|trot|thoroughbred/i;

/**
 * What "not settled yet" is called, per source. Read off the data rather than
 * assumed, because neither source says anything like "pending":
 *
 *   bets.bet_status        paid 989 · Rejected 145 · Unresulted 70 · FullyRefunded 13
 *   multi_bets.bet_status  No Return 19011 · Return @<br>Tkt… 8408 · Accepted 180
 *
 * So `Unresulted` and `Accepted` are the open ones, and everything else has had
 * its outcome applied. `fixtures.settled_at` is NOT usable for this: 2,017 of
 * 2,048 values sit exactly four hours after the start and some are thousands of
 * hours BEFORE it, so it is a derived field, not a record of settlement.
 */
const SWIFT_OPEN = 'Unresulted';
const MULTI_OPEN = ['Accepted', 'Partially Accepted'];

/** How long past the start a market may sit unsettled before it is worth saying. */
const SETTLE_GRACE_MS = 30 * 60_000;
/** How far back either view looks. */
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const LIMIT = 300;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Start times for multi/mybet bets, which carry none of their own.
 *
 * Their document has an `event_identifier` and an `event_string` and nothing
 * else about when the thing starts, so the fixture has to be found. Where it
 * cannot be, the bet is LEFT OUT rather than guessed at — the unresolvable ones
 * are dominated by golf outrights ("Open de España — Winner", struck 155 hours
 * ago and quite properly unsettled), and reporting those as late settlements
 * would be crying wolf on the whole page.
 */
async function startsByEvent(eventIds) {
  const out = new Map();
  if (!eventIds.length) return out;
  const maps = await (await coll('eventMapping'))
    .find({ gutsy_event_id: { $in: eventIds }, optic_fixture_id: { $ne: null } })
    .project({ _id: 0, gutsy_event_id: 1, optic_fixture_id: 1, confidence: 1 })
    .toArray();
  const byEvent = new Map();
  for (const m of maps) {
    const prev = byEvent.get(String(m.gutsy_event_id));
    if (!prev || (m.confidence ?? 0) > (prev.confidence ?? 0)) byEvent.set(String(m.gutsy_event_id), m);
  }
  const ids = [...new Set([...byEvent.values()].map((m) => m.optic_fixture_id))];
  if (!ids.length) return out;

  const fixtures = await (await coll('fixtures'))
    .find({ fixture_id: { $in: ids } })
    .project({
      _id: 0, fixture_id: 1, sport: 1, tournament: 1, home_team: 1, away_team: 1,
      event_name: 1, scheduled_start: 1, actual_start: 1, status: 1, is_live: 1,
    })
    .toArray();
  const byFixture = new Map(fixtures.map((f) => [f.fixture_id, f]));
  for (const [eventId, m] of byEvent) {
    const f = byFixture.get(m.optic_fixture_id);
    if (f) out.set(eventId, f);
  }
  return out;
}

/** `actual_start` is the real jump; scheduled_start is Optic's not-before slot. */
const startOf = (f) => {
  const t = new Date(f?.actual_start ?? f?.scheduled_start ?? NaN).getTime();
  return Number.isFinite(t) ? t : null;
};

const nameOf = (f) =>
  f?.event_name ?? (f?.home_team && f?.away_team ? `${f.home_team} v ${f.away_team}` : null);

/** The two queries share their window, their racing rule and their projections. */
async function openBets(db, since) {
  const [swift, multi] = await Promise.all([
    db.collection('bets')
      .find({
        'derived.is_racing': false,
        'derived.type': 'SINGLE',
        bet_status: SWIFT_OPEN,
        bet_time: { $gte: since },
      })
      .project({
        _id: 0, bet_id: 1, user_id: 1, bet_time: 1, bet_amount: 1, odd: 1,
        'derived.sport': 1, 'derived.market_raw': 1, 'derived.minLegEventTime': 1,
        'derived.legs_event_ids': 1, legs: 1,
      })
      .toArray()
      .catch(() => []),
    db.collection('multi_bets')
      .find({
        bet_type: { $not: /multi|cancellation/i },
        sport_name: { $not: RACING, $nin: [null, ''] },
        bet_status: { $in: MULTI_OPEN },
        transaction_date: { $gte: since },
      })
      .project({
        _id: 0, transaction_id: 1, user_accountID: 1, transaction_date: 1,
        amount_bet: 1, price: 1, event_identifier: 1, event_string: 1,
        sport_name: 1, bet_type: 1, selections: 1, transaction_licenseid: 1,
      })
      .toArray()
      .catch(() => []),
  ]);
  return { swift, multi };
}

/**
 * The first leg of a swiftbet bet, with `legs` parsed if it arrived as a string.
 *
 * It routinely does, and forgetting that is why the first run of this showed
 * every swiftbet row as "(no name)" with a UUID where the event should be.
 */
const firstLeg = (b) => {
  const legs = typeof b.legs === 'string' ? safeParse(b.legs) : b.legs ?? [];
  return legs[0] ?? {};
};

const legName = (b) => {
  const leg = firstLeg(b);
  return leg.event_name ?? leg.selections?.[0]?.name ?? null;
};

const safeParse = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * When a swiftbet bet's event started, in real UTC.
 *
 * `leg.event_time` is already true UTC; `derived.minLegEventTime` is Sydney
 * wall clock stamped with a Z, the same fault bet_time carries — see the note
 * in ticker.mapSwift, which measured it at exactly +11h on 295 of 300 bets and
 * +10h on three more. So the leg is preferred and the derived value is only
 * reached as a fallback, converted on the way through. Taking the derived one
 * raw would place every bet eleven hours before its own event and make the
 * whole page read as late.
 */
const swiftStart = (b) => {
  const leg = firstLeg(b);
  const fromLeg = leg.event_time ? new Date(leg.event_time).getTime() : NaN;
  if (Number.isFinite(fromLeg)) return fromLeg;
  const derived = betInstant(b.derived?.minLegEventTime)?.getTime();
  return Number.isFinite(derived) ? derived : null;
};

const legSport = (b) => b.derived?.sport ?? null;
const legTournament = (b) => firstLeg(b).meeting_name ?? null;
const legMarket = (b) =>
  firstLeg(b).selections?.[0]?.selection_data?.[0]?.market_name ?? b.derived?.market_raw ?? null;
const legOutcome = (b) =>
  firstLeg(b).selections?.[0]?.selection_data?.[0]?.name
  ?? firstLeg(b).selections?.[0]?.name
  ?? null;

/**
 * Markets still open past the whistle: a bet whose event started more than
 * SETTLE_GRACE_MS ago and which the book has not resulted.
 *
 * Grouped by event, because that is the unit someone acts on — one unsettled
 * tennis match is one job, not nine.
 */
export async function delayedSettlements({ minMins = 30 } = {}) {
  const db = await betsDb();
  if (!db) return { configured: false, events: [] };
  const now = Date.now();
  const grace = Math.max(0, minMins) * 60_000;
  const { swift, multi } = await openBets(db, new Date(now - WINDOW_MS));

  /*
   * Both sources resolve the same way, through `event_mapping.gutsy_event_id`.
   * swiftbet gets there via `derived.legs_event_ids` — which ARE gutsy event
   * ids, not fixture ids, and 24 of 30 of them map.
   */
  const eventIds = [
    ...multi.map((m) => String(m.event_identifier)),
    ...swift.flatMap((b) => (b.derived?.legs_event_ids ?? []).map(String)),
  ].filter(Boolean);
  const fixtures = await startsByEvent([...new Set(eventIds)]);

  const groups = new Map();
  let unjudgeable = 0;

  const consider = (fixture, bet) => {
    if (!fixture) { unjudgeable++; return; }
    /*
     * Finished, and finished a while ago. Both conditions matter.
     *
     * Measuring 30 minutes from the START instead flagged a football match
     * forty-one minutes in as a settlement problem, which is simply a game in
     * progress: it listed Melbourne Victory v FC Seoul with nine unsettled bets
     * at half time. Optic's `completed` is the only honest "it is over".
     *
     * `updated_at` stands in for "when it finished", because nothing records
     * that. It holds up: on completed-but-unsettled fixtures the last write sat
     * 79 to 149 minutes back while kick-off was three to four hours back, so it
     * tracks the end of the game rather than the start. It is a proxy, and if
     * Optic ever starts touching finished rows again this becomes too quiet.
     */
    if (fixture.status !== 'completed') return;
    const doneAt = new Date(fixture.updated_at ?? NaN).getTime();
    if (!Number.isFinite(doneAt) || now - doneAt < grace) return;

    const key = fixture.fixture_id;
    const g = groups.get(key) ?? {
      key,
      fixtureId: fixture.fixture_id,
      name: nameOf(fixture),
      sport: fixture.sport ?? null,
      tournament: fixture.tournament ?? null,
      startedAt: iso(fixture.actual_start ?? fixture.scheduled_start),
      finishedAt: iso(fixture.updated_at),
      bets: [],
      stake: 0,
    };
    g.bets.push(bet);
    g.stake += bet.stake ?? 0;
    groups.set(key, g);
  };

  for (const b of swift) {
    const fixture = (b.derived?.legs_event_ids ?? [])
      .map((id) => fixtures.get(String(id)))
      .find(Boolean) ?? null;
    consider(fixture, {
      source: 'swiftbet',
      betId: b.bet_id != null ? String(b.bet_id) : null,
      userId: b.user_id != null ? String(b.user_id) : null,
      placedAt: iso(betInstant(b.bet_time)),
      stake: num(b.bet_amount),
      price: num(b.odd),
      market: legMarket(b),
      outcome: legOutcome(b),
    });
  }

  for (const m of multi) {
    consider(fixtures.get(String(m.event_identifier)) ?? null, {
      source: m.transaction_licenseid === 'MultisComAu' ? 'multis' : 'mybet',
      betId: m.transaction_id != null ? String(m.transaction_id) : null,
      userId: m.user_accountID != null ? String(m.user_accountID) : null,
      placedAt: iso(betInstant(m.transaction_date)),
      stake: num(m.amount_bet),
      price: num(m.price),
      market: m.bet_type ?? null,
      outcome: m.selections ?? null,
    });
  }

  const events = [...groups.values()]
    .map((g) => ({
      ...g,
      waitingMins: Math.round((now - new Date(g.finishedAt).getTime()) / 60_000),
      bets: g.bets.sort((a, b) => (b.stake ?? 0) - (a.stake ?? 0)),
    }))
    // Longest wait first: the one most overdue is the one to chase.
    .sort((a, b) => b.waitingMins - a.waitingMins)
    .slice(0, LIMIT);

  return {
    configured: true,
    thresholds: { minMins: grace / 60_000, windowHours: WINDOW_MS / 3_600_000 },
    counts: {
      events: events.length,
      bets: events.reduce((n, e) => n + e.bets.length, 0),
      stake: Math.round(events.reduce((n, e) => n + e.stake, 0)),
      /*
       * Honesty about coverage. `openTotal` is every unsettled bet in the
       * window; most are on games not yet played and are meant to be open. Of
       * the rest, `unjudgeable` could not be tied to a fixture at all — mostly
       * golf outrights, which have no fixture and are properly unsettled for
       * days — so they are left out rather than guessed at.
       */
      openTotal: swift.length + multi.length,
      unjudgeable,
    },
    events,
  };
}

/**
 * Bets struck after the game was under way.
 *
 * Worth a page of its own here because these books do not offer online in-play
 * betting: a bet accepted twenty minutes after kick-off is a market that should
 * have been suspended and was not. The two NFL examples that prompted this were
 * $5,000 at +185 minutes and $400 at +207.
 *
 * `afterMins` is the floor. A little lateness is a clock disagreeing with a
 * feed; a lot of it is a market left open.
 */
export async function lateBets({ afterMins = 1, hours = 24 } = {}) {
  const db = await betsDb();
  if (!db) return { configured: false, bets: [] };
  const now = Date.now();
  const since = new Date(now - Math.min(Math.max(hours, 1), 72) * 3_600_000);
  const floor = Math.max(0, afterMins) * 60_000;

  const [swift, multi] = await Promise.all([
    db.collection('bets')
      .find({
        'derived.is_racing': false,
        'derived.type': 'SINGLE',
        bet_status: { $not: /^(cancel|rejected)/i },
        bet_time: { $gte: since },
      })
      .project({
        _id: 0, bet_id: 1, user_id: 1, bet_time: 1, bet_amount: 1, odd: 1, bet_status: 1,
        'derived.sport': 1, 'derived.market_raw': 1, 'derived.minLegEventTime': 1,
        'derived.legs_event_ids': 1, legs: 1,
      })
      .toArray()
      .catch(() => []),
    db.collection('multi_bets')
      .find({
        bet_type: { $not: /multi|cancellation/i },
        sport_name: { $not: RACING, $nin: [null, ''] },
        bet_status: { $not: COUNTER_ENTRY },
        transaction_date: { $gte: since },
      })
      .project({
        _id: 0, transaction_id: 1, user_accountID: 1, transaction_date: 1, bet_status: 1,
        amount_bet: 1, price: 1, event_identifier: 1, event_string: 1,
        sport_name: 1, bet_type: 1, selections: 1, transaction_licenseid: 1,
      })
      .toArray()
      .catch(() => []),
  ]);

  const starts = await startsByEvent([...new Set(multi.map((m) => String(m.event_identifier)).filter(Boolean))]);
  const out = [];
  let checked = 0;

  for (const b of swift) {
    const start = swiftStart(b);
    const placed = betInstant(b.bet_time)?.getTime() ?? null;
    if (start == null || placed == null) continue;
    checked++;
    const after = placed - start;
    if (after < floor) continue;
    out.push({
      source: 'swiftbet',
      betId: b.bet_id != null ? String(b.bet_id) : null,
      userId: b.user_id != null ? String(b.user_id) : null,
      fixtureId: null,
      event: legName(b),
      sport: legSport(b),
      market: legMarket(b),
      outcome: legOutcome(b),
      placedAt: iso(new Date(placed)),
      startedAt: iso(new Date(start)),
      afterMins: Math.round(after / 60_000),
      stake: num(b.bet_amount),
      price: num(b.odd),
      settled: !/^unresulted$/i.test(String(b.bet_status ?? '')),
      stillLive: null,
    });
  }

  for (const m of multi) {
    const f = starts.get(String(m.event_identifier));
    const start = startOf(f);
    const placed = betInstant(m.transaction_date)?.getTime() ?? null;
    if (start == null || placed == null) continue;
    checked++;
    const after = placed - start;
    if (after < floor) continue;
    out.push({
      source: m.transaction_licenseid === 'MultisComAu' ? 'multis' : 'mybet',
      betId: m.transaction_id != null ? String(m.transaction_id) : null,
      userId: m.user_accountID != null ? String(m.user_accountID) : null,
      fixtureId: f.fixture_id,
      event: nameOf(f),
      sport: f.sport ?? m.sport_name ?? null,
      market: m.bet_type ?? null,
      outcome: m.selections ?? null,
      placedAt: iso(new Date(placed)),
      startedAt: iso(new Date(start)),
      afterMins: Math.round(after / 60_000),
      stake: num(m.amount_bet),
      price: num(m.price),
      settled: !MULTI_OPEN.includes(String(m.bet_status ?? '')),
      // The pointed case: Optic has it in play and the book took the bet anyway.
      stillLive: Boolean(f.is_live || f.status === 'live'),
    });
  }

  out.sort((a, b) => b.afterMins - a.afterMins);
  const shown = out.slice(0, LIMIT);
  return {
    configured: true,
    thresholds: { afterMins: floor / 60_000, hours: (now - since.getTime()) / 3_600_000 },
    counts: {
      late: out.length,
      // The denominator matters: "84 late" means nothing without "of 280 whose
      // start time we could establish at all".
      comparable: checked,
      stake: Math.round(out.reduce((n, b) => n + (b.stake ?? 0), 0)),
      stillLive: out.filter((b) => b.stillLive).length,
      events: new Set(out.map((b) => b.fixtureId ?? b.event)).size,
    },
    bets: shown,
  };
}
