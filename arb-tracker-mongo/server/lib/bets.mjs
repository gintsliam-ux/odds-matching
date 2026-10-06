import { coll } from './mongo.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';
import { eventById } from './queries.mjs';

/**
 * Bets placed on one fixture, by brand.
 *
 * Three brands, two collections, two different join keys — and the bridge
 * between the odds world and the bets world is `gutsys_sport.event_mapping`,
 * which carries one row per (optic fixture, provider):
 *
 *   Swiftbet  optic fixture -> provider "swift" -> a gutsy UUID
 *                           -> gutsy.bets.derived.legs_event_ids   (indexed)
 *   Mybet     optic fixture -> provider "mybet" -> a numeric event id
 *   Multis                  -> the same numeric id
 *                           -> gutsy.multi_bets.event_identifier   (NOT indexed)
 *
 * Mybet and Multis are the same collection, split on `transaction_licenseid`.
 */

/**
 * Bet timestamps are Sydney wall-clock with a `Z` stuck on the end.
 *
 * `gutsy.bets.bet_time` and `multi_bets.transaction_date` both store the local
 * reading rather than the instant: at 11:57 AEDT the newest rows read
 * `11:47:31Z` and `11:55:15Z`, while `multi_bets._synced_at` — written by the
 * scraper itself — correctly read `00:56:20Z`. So the clock is right and the
 * zone is a lie, and the browser then renders it in the viewer's zone and adds
 * the eleven hours a second time: a bet struck at 10:40am displayed as 21:40.
 *
 * Reinterpreted here rather than shifted by a constant, because the offset is
 * +11 in daylight saving and +10 outside it — a fixed subtraction would be an
 * hour out for half the year, which is worse than being eleven hours out all of
 * it, since nobody would notice.
 *
 * The right fix is upstream, in whatever writes these. This keeps the page
 * honest until that happens; when it is fixed, these calls come out.
 */
const BET_TZ = 'Australia/Sydney';
const TZ_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: BET_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * How far ahead of UTC the Sydney clock reads at a given instant.
 *
 * Computed on whole seconds and rounded to whole minutes, because
 * `formatToParts` has no milliseconds: comparing a second-precision reading
 * against a millisecond-precision instant folds the remainder into the offset,
 * and applying that twice moved 11:55:15.483 to 00:55:16.449. Every real zone
 * offset is a whole number of minutes.
 */
function tzOffsetMs(instantMs) {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = Object.fromEntries(
    TZ_PARTS.formatToParts(new Date(whole))
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)]),
  );
  const raw = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - whole;
  return Math.round(raw / 60_000) * 60_000;
}

/** A stored wall-clock reading -> the instant it actually happened. */
export function betInstant(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const naive = d.getTime();
  // Two passes so a timestamp inside a DST transition resolves to the offset
  // that applies at the real instant, not the naive one.
  let off = tzOffsetMs(naive);
  off = tzOffsetMs(naive - off);
  return new Date(naive - off);
}

/** Nothing before this is trusted — 2022 was anomalous and is ignored everywhere. */
const BET_CUTOFF = new Date('2023-01-01T00:00:00.000Z');

/** Cap per brand — an event page is a summary, not an export. */
const MAX_PER_BRAND = 300;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The gutsy ids this fixture maps to, per provider. */
async function mappingFor(fixtureId) {
  const rows = await (await coll('eventMapping'))
    .find({ optic_fixture_id: fixtureId })
    .project({ _id: 0, gutsy_event_id: 1, provider: 1, confidence: 1 })
    .toArray();
  const out = {};
  for (const r of rows) {
    // Several mappings can exist for one fixture; keep the most confident.
    const prev = out[r.provider];
    if (!prev || (r.confidence ?? 0) > (prev.confidence ?? 0)) out[r.provider] = r;
  }
  return out;
}

/**
 * Swiftbet legs are stored as a JSON *string*. Pull the selection text for the
 * leg that names this event, falling back to the first leg — a single's only
 * leg is the one we want, and for a multi it is the best label we have.
 */
function swiftSelection(bet, gutsyEventId) {
  let legs;
  try {
    legs = typeof bet.legs === 'string' ? JSON.parse(bet.legs) : bet.legs;
  } catch {
    return { selection: null, market: null, legCount: null };
  }
  if (!Array.isArray(legs) || legs.length === 0) {
    return { selection: null, market: null, legCount: 0 };
  }
  const leg = legs.find((l) => l?.event_id === gutsyEventId) ?? legs[0];
  const sel = leg?.selections?.[0];
  const data = sel?.selection_data?.[0];
  return {
    // market_name is the source of truth — market_type mislabels head-to-head
    // markets as Draw No Bet.
    market: data?.market_name ?? null,
    selection: data?.name ?? leg?.event_name ?? null,
    legCount: legs.length,
  };
}

/**
 * Settlement and cancellation records, which are not bets.
 *
 * mybet and multis write the two halves of a settled bet as separate rows that
 * point at each other — "Return @<br>Tkt 6488300" is the bet, staked and struck
 * before the jump; "Return of<br>Tkt: 6486431" is the return, stake 0, written
 * at settlement. Both carry the same event, selection and price, so a return
 * reads as a second identical bet and the fixture showed each settled bet
 * twice.
 *
 * Matched on the status, not a zero stake, which does not separate them: 65
 * counter-entries carry a non-zero amount and 13 real bets carry none.
 */
export const COUNTER_ENTRY = /^(Return of|Cancellation of)/;

/**
 * A bet that never stood. Both halves of a cancellation say so in `bet_type` —
 * the original ("Cancelled at Tkt: 6490828", +250) and its reversal
 * ("Cancellation of Tkt: 6490674", -250) — so that field removes the pair in
 * one condition, where the status alone caught only the reversal and left 46
 * cancelled bets on the feed over three days.
 */
export const VOID_BET = /cancellation/i;

/**
 * Tidy a free-text field from either source. Swiftbet selections arrive padded
 * (" Kaleb Johnson Anytime "), and the Multis settlement status is stored as a
 * fragment of HTML ("Return of<br>Tkt: 6335418") — neither belongs on screen
 * as-is, and neither should reach the DOM carrying markup.
 */
function text(v) {
  if (v == null) return null;
  const out = String(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

/** Result strings that mean the bet is finished and its P/L is real. */
const RESOLVED = /^(won|win|lost|loss|placed|void|refund|no return|return)/i;

/**
 * Is this bet settled?
 *
 * It matters because `pl` cannot be trusted until it is. On a finished NFL game
 * the feed had `pl = -24.03` against a leg still marked Unresulted, and `pl = 0`
 * against both a Won and a Lost bet — the settlement pass simply hadn't run.
 * Summing that field across a page produces a confident, wrong number, so an
 * unresolved bet reports no P/L at all rather than a placeholder.
 */
const isResolved = (result) => !!result && RESOLVED.test(result);

/** One row of the Bets tab, however it was stored. */
function normalise(o) {
  return {
    id: o.id,
    placedAt: o.placedAt,
    user: o.user,
    stake: num(o.stake),
    price: num(o.price),
    selection: text(o.selection),
    market: text(o.market),
    betType: text(o.betType),
    legCount: o.legCount ?? null,
    bonus: !!o.bonus,
    result: text(o.result),
    resolved: isResolved(text(o.result)),
    pl: isResolved(text(o.result)) ? num(o.pl) : null,
    em: num(o.em),
  };
}

/** Swiftbet: gutsy.bets, joined on the indexed legs_event_ids array. */
async function swiftbetFor(db, gutsyEventId) {
  const rows = await db
    .collection('bets')
    .find({ 'derived.legs_event_ids': gutsyEventId, bet_time: { $gte: BET_CUTOFF } })
    .sort({ bet_time: -1 })
    .limit(MAX_PER_BRAND)
    .toArray();

  return rows.map((b) => {
    const { selection, market, legCount } = swiftSelection(b, gutsyEventId);
    return normalise({
      id: b.bet_id ?? String(b._id),
      placedAt: iso(betInstant(b.bet_time)),
      // Never truncated: the whole point of showing a user id is being able to
      // go and look the account up.
      user: b.user_id ?? null,
      stake: b.bet_amount,
      price: b.odd,
      selection,
      market,
      betType: b.bet_type ?? b.derived?.type ?? null,
      legCount,
      bonus: !!b.is_bonus,
      // The feed's own leg result first: `enrichment.result` is this app's
      // settlement stamp and is absent on the overwhelming majority of rows
      // (129 of 134 on the fixture this was built against).
      result: b.derived?.legs_breakdown?.[0]?.result ?? b.enrichment?.result ?? null,
      pl: b.pl,
      em: b.enrichment?.emPercent,
    });
  });
}

/**
 * The market a slip names: everything before the match in its event string.
 *
 * Only on a satellite event. On the base event that leading segment is the
 * competition ("NBA - Los Angeles Lakers v Sacramento Kings"), and calling that
 * the market would be worse than the generic bet type it replaces.
 */
function marketFromSlip(row, satellites) {
  if (!satellites?.has(Number(row.event_identifier))) return null;
  const parts = String(row.event_string ?? '').split(' - ');
  if (parts.length < 2) return null;
  parts.pop();                                   // the match itself
  return parts.join(' - ').trim() || null;
}

/** The match a slip names: the last " - " segment of its event string. */
const matchName = (v) => {
  const parts = String(v ?? '').split(' - ');
  const last = parts.length > 1 ? parts[parts.length - 1] : v;
  return String(last ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\bvs\b/g, 'v').trim();
};

/**
 * Every mybet event id that is this same match.
 *
 * mybet mints a separate event id per MARKET — one for the match, then one
 * each for "Alternate Total Over", "1st Quarter - Line (1.5)", "First Set
 * Winner" and so on. Only the first carries a competition, so only the first is
 * ever mapped to a fixture, and asking for that id alone finds the bets struck
 * on the head-to-head and none of the rest. On this tennis fixture that was
 * every mybet and multis bet on the page.
 *
 * Siblings share a sport and a suspension time exactly, which is what gathers
 * them. But a slot can hold two different matches — twelve events at 05:45
 * covering both an ATP Shanghai tie and a WTA Suzhou one — so the fixture's own
 * name decides which belong here.
 *
 * Matched against each satellite's DESCRIPTION, which is where mybet writes the
 * match ("First Set Winner - Rigele Te vs Ilia Simakin"). Reading it off a bet
 * on the base event instead looked tidier and does not work: on this very
 * fixture every mybet bet sits on a satellite, so there was no bet on the base
 * event to learn the name from and nothing was gathered at all.
 */
async function siblingEventIds(db, baseId, fixtureId) {
  const base = await db.collection('mybet_events')
    .findOne({ _id: baseId }, { projection: { sport: 1, suspendAt: 1 } })
    .catch(() => null);
  if (!base?.suspendAt) return { ids: [baseId], satellites: new Set() };

  const slot = await db.collection('mybet_events')
    .find({ sport: base.sport, suspendAt: base.suspendAt })
    .project({ _id: 1, description: 1, league: 1 })
    .limit(300)
    .toArray()
    .catch(() => []);
  const satellites = slot.filter(
    (e) => Number(e._id) !== baseId && (!e.league || String(e.league).trim() === '-'),
  );
  if (!satellites.length) return { ids: [baseId], satellites: new Set() };

  const fixture = await eventById(fixtureId).catch(() => null);
  if (!fixture) return { ids: [baseId], satellites: new Set() };
  const want = new Set(
    matchName(`${fixture.home?.name ?? fixture.home ?? ''} ${fixture.away?.name ?? fixture.away ?? ''} ${fixture.name ?? ''}`)
      .split(' ')
      .filter((t) => t.length > 2),
  );
  if (!want.size) return { ids: [baseId], satellites: new Set() };

  const mine = satellites.filter((e) => {
    const got = matchName(e.description);
    if (!got) return false;
    let hit = 0;
    for (const t of want) if (got.includes(t)) hit++;
    return hit / want.size >= 0.6;
  });
  return { ids: [baseId, ...mine.map((e) => Number(e._id))], satellites: new Set(mine.map((e) => Number(e._id))) };
}

/**
 * Mybet and Multis: gutsy.multi_bets, split on the licence.
 *
 * Served by `{event_identifier: 1, transaction_date: -1}`, which answers the
 * lookup and the sort together — 28ms, and 11 index keys examined to return 11
 * rows. Before that index existed this was a 46-second scan of 5.7M documents
 * and had to be bounded to a date window around the jump; it no longer is, so
 * a bet placed months early is found like any other.
 */
async function multiBetsFor(db, eventId, fixtureId) {
  const numericId = Number(eventId);
  // 0 is the sentinel multi-leg bets carry instead of an event id; they name
  // their events only in leg description strings and cannot be joined here.
  if (!Number.isFinite(numericId) || numericId === 0) return { mybet: [], multis: [] };

  const { ids: eventIds, satellites } = await siblingEventIds(db, numericId, fixtureId);
  const rows = await db
    .collection('multi_bets')
    .find({
      event_identifier: { $in: eventIds },
      transaction_date: { $gte: BET_CUTOFF },
      bet_status: { $not: COUNTER_ENTRY },
      bet_type: { $not: VOID_BET },
    })
    .sort({ transaction_date: -1 })
    .limit(MAX_PER_BRAND * 2)
    .toArray();

  // Enrichment lives in a sidecar keyed by transaction_id (the scraper
  // re-syncs the bets wholesale, so it can't be written in place).
  const ids = rows.map((r) => r.transaction_id).filter((v) => v != null);
  const em = new Map();
  if (ids.length) {
    const enr = await db
      .collection('multi_bets_enrichment')
      .find({ transaction_id: { $in: ids } })
      .project({ _id: 0, transaction_id: 1, enrichment: 1 })
      .toArray();
    for (const e of enr) em.set(e.transaction_id, e.enrichment);
  }

  const out = { mybet: [], multis: [] };
  for (const r of rows) {
    const e = em.get(r.transaction_id);
    const bet = normalise({
      id: String(r.transaction_id ?? r._id),
      placedAt: iso(betInstant(r.transaction_date)),
      user: r.user_accountID != null ? String(r.user_accountID) : null,
      stake: r.amount_bet,
      price: r.price,
      selection: r.selections ?? null,
      /*
       * What the bet is actually ON.
       *
       * `bet_type` alone called every mybet total a "Win": the slip runs the
       * market into `event_string` ("Alternate Total Over - Charlotte Hornets -
       * Charlotte Hornets v Brooklyn Nets") and leaves bet_type generic. The
       * leading segment is the market when the event is one of mybet's
       * market-specific satellites, and the competition when it is the base
       * event — same rule the ticker uses, see classifyLeadSegments.
       */
      market: marketFromSlip(r, satellites) ?? r.bet_type ?? null,
      betType: r.transaction_multid > 0 ? 'Multi' : r.sgm_flag ? 'SGM' : 'Single',
      legCount: Array.isArray(r.legs) && r.legs.length ? r.legs.length : null,
      // A non-zero bonus_bet is what marks a bonus stake here, not a flag.
      bonus: !!r.bonus_bet,
      result: e?.result ?? r.bet_status ?? null,
      pl: r.bet_result,
      em: e?.emPercent,
    });
    const bucket = r.transaction_licenseid === 'MultisComAu' ? 'multis' : 'mybet';
    if (out[bucket].length < MAX_PER_BRAND) out[bucket].push(bet);
  }
  return out;
}

/**
 * Every brand's bets on one fixture, plus a per-brand note explaining an empty
 * list — "this fixture was never mapped to Mybet" and "nobody bet on it" look
 * identical otherwise, and they mean very different things.
 */
export async function betsForFixture(fixtureId) {
  const empty = (reason) => ({ bets: [], reason });
  const result = {
    configured: betsConfigured,
    swiftbet: empty('unmapped'),
    mybet: empty('unmapped'),
    multis: empty('unmapped'),
  };
  if (!betsConfigured || !fixtureId) {
    result.swiftbet = result.mybet = result.multis = empty('not-configured');
    return result;
  }

  const db = await betsDb();
  if (!db) return result;

  const mapping = await mappingFor(fixtureId);

  const jobs = [];
  if (mapping.swift?.gutsy_event_id) {
    jobs.push(
      swiftbetFor(db, mapping.swift.gutsy_event_id).then((bets) => {
        result.swiftbet = { bets, reason: bets.length ? null : 'none' };
      }),
    );
  }
  if (mapping.mybet?.gutsy_event_id) {
    jobs.push(
      multiBetsFor(db, mapping.mybet.gutsy_event_id, fixtureId).then(({ mybet, multis }) => {
        result.mybet = { bets: mybet, reason: mybet.length ? null : 'none' };
        result.multis = { bets: multis, reason: multis.length ? null : 'none' };
      }),
    );
  }

  await Promise.all(jobs);
  return result;
}
