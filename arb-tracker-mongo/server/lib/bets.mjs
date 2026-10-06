import { coll } from './mongo.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';

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
 * Mybet and Multis: gutsy.multi_bets, split on the licence.
 *
 * Served by `{event_identifier: 1, transaction_date: -1}`, which answers the
 * lookup and the sort together — 28ms, and 11 index keys examined to return 11
 * rows. Before that index existed this was a 46-second scan of 5.7M documents
 * and had to be bounded to a date window around the jump; it no longer is, so
 * a bet placed months early is found like any other.
 */
async function multiBetsFor(db, eventId) {
  const numericId = Number(eventId);
  // 0 is the sentinel multi-leg bets carry instead of an event id; they name
  // their events only in leg description strings and cannot be joined here.
  if (!Number.isFinite(numericId) || numericId === 0) return { mybet: [], multis: [] };

  const rows = await db
    .collection('multi_bets')
    .find({ event_identifier: numericId, transaction_date: { $gte: BET_CUTOFF } })
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
      market: r.bet_type ?? null,
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
      multiBetsFor(db, mapping.mybet.gutsy_event_id).then(({ mybet, multis }) => {
        result.mybet = { bets: mybet, reason: mybet.length ? null : 'none' };
        result.multis = { bets: multis, reason: multis.length ? null : 'none' };
      }),
    );
  }

  await Promise.all(jobs);
  return result;
}
