/**
 * Our own two brands' prices for one fixture, in the shape the grid reads.
 *
 * The event page compares the field; it could not show what WE are offering on
 * the same selections, which is the first thing anyone asks of it. Both brands
 * are already joined to a fixture by `event_mapping` — the same link the ticker
 * uses to place a bet — so the prices are reachable wherever that link exists.
 *
 * The two stores could not be less alike:
 *
 *   swiftbet    `events.markets[]`, each a free-text `name` ("head to head",
 *               "handicap +2.5") with `selections[]` of `{name, odds}`. The
 *               names are the SAME vocabulary parseBetMarket already reads off
 *               bets, so that function does the market mapping here too rather
 *               than a second implementation of it that drifts.
 *   mybet       one flat `match` object: AWin/BWin/Draw, ALine/ALineDiv,
 *               TotalOver/OverDiv. No market names at all, so it is emitted
 *               directly.
 *
 * Nothing is invented. A market we cannot place confidently is left out, and a
 * column with no price never appears at all — see OPTIONAL_BOOKS on the client,
 * which renders a book only when a row carries a price for it.
 */
import { coll, mirrorConfigured } from './mongo.mjs';
import { betsConfigured, betsDb } from './betsMongo.mjs';
import { parseBetMarket } from './ticker.mjs';

export const SWIFT_BOOK = 'swiftbet';
export const MYBET_BOOK = 'mybet';

const num = (v) => {
  const n = Number(v);
  // 0 is how both stores write "not offering this", and 1.0 is not a price.
  return Number.isFinite(n) && n > 1 ? n : null;
};

/*
 * Dates out of Mongo are BSON Dates; the client's OddsRow contract says
 * `current_at: string | null`, ISO. These rows are appended AFTER
 * serializeOdds has run on the surface's, so nothing else converts them.
 */
const iso = (v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

const norm = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter(Boolean));

/**
 * Is this selection the home side, the away side, or neither?
 *
 * Directional subset, the same rule surnameSubset learned: every word of the
 * SHORTER name must appear in the longer one. The brands abbreviate where the
 * feed does not — mybet writes "Preston (Eng)" for "Preston North End" and
 * swiftbet "Boston Celtics -2.5" for "Boston Celtics" — and a symmetric test
 * matched a player to his own team.
 */
function sideOfName(name, home, away) {
  const n = words(name);
  if (!n.size) return null;
  const fits = (team) => {
    const t = words(team);
    if (!t.size) return false;
    const [small, big] = n.size <= t.size ? [n, t] : [t, n];
    for (const w of small) if (!big.has(w)) return false;
    return true;
  };
  if (/\bdraw\b/.test(norm(name))) return 3;
  const h = fits(home);
  const a = fits(away);
  // Ambiguous is unusable: two teams whose names subset each other would put
  // the same price on both rows.
  if (h && a) return null;
  if (h) return 1;
  if (a) return 2;
  return null;
}

/** The grid's row shape. Only the fields buildMarkets actually reads. */
function row({ book, marketId, selection, outcomeNo, line, price, open, at }) {
  return {
    market_id: marketId,
    market_name: null,
    selection,
    normalized_selection: null,
    line: line ?? null,
    line_group: line == null ? null : Math.abs(line),
    /*
     * No `pair_key`. It is what fair.mjs de-vigs over, and OUR price is not a
     * competitor's opinion — blending it into the market's fair would move the
     * number we are measuring ourselves against toward ourselves. The grid
     * groups spreads by its own keyNum fallback when pair_key is absent.
     */
    pair_key: null,
    outcome_no: outcomeNo ?? null,
    is_main: true,
    sportsbook: book,
    is_lay: false,
    current_price: price,
    open_price: open ?? null,
    status: null,
    current_at: iso(at),
    open_at: null,
    close_price: null,
    closed_at: null,
    flucs: null,
  };
}

/* ------------------------------------------------------------------ swiftbet */

/*
 * A combination is not a selection, and swiftbet puts the combination in the
 * SELECTION where a bet puts it in the market.
 *
 * parseBetMarket rejects a combo by looking at the market string — "/" or the
 * word "and" — which is where a bet carries it. Swiftbet's is "Featured Same
 * Game Multis", 128 selections deep, with names like "Senators to win, Macklin
 * Celebrini to score" and "Over 5.5 goals & Over 1.5". None of those trip the
 * market test, and "Over 1.5" inside the text made them parse as team totals:
 * thirteen junk rows at 6.75, 19 and 23 on the Senators v Sharks grid.
 *
 * Comma and ampersand, not the word "and": "Bosnia and Herzegovina" is a team.
 */
const COMBO_MARKET = /same game|multi/i;
/*
 * Comma, ampersand or SLASH. The slash is swiftbet's "double result" and
 * "half time/full time": selections like "Miami RedHawks/Miami RedHawks",
 * whose market name carries neither "/" nor "and", so parseBetMarket's own
 * combo guard never sees it. The name then matches a team by subset and the
 * market's Draw routes the whole thing to moneyline_3way — a 9.00 row against
 * the field's 2.35.
 *
 * Still not the word "and": "Bosnia and Herzegovina" is a team.
 */
const COMBO_SELECTION = /,|&|\//;

function swiftRows(ev, { home, away, sport }) {
  const out = [];
  const at = ev?.scraped_at ?? null;
  for (const m of ev?.markets ?? []) {
    const mName = String(m?.name ?? '');
    if (!mName || COMBO_MARKET.test(mName)) continue;
    /*
     * A market with a Draw in it is the THREE-way, and parseBetMarket offers
     * both ids for a moneyline because a bet slip never says which it was.
     * Here the selections do say: swiftbet lists "head to head" (Senators 1.68,
     * two-way, including overtime) AND a regulation three-way (Senators 2.08,
     * Draw 4.00) on the same game, and taking marketIds[0] for both put two
     * different markets' prices on one row — the grid would have shown 2.08
     * against the field's two-way line.
     */
    const hasDraw = (m?.selections ?? []).some((x) => /\bdraw\b/i.test(String(x?.name ?? '')));
    for (const s of m?.selections ?? []) {
      const price = num(s?.odds);
      if (price == null) continue;
      const sName = String(s?.name ?? '');
      if (COMBO_SELECTION.test(sName)) continue;
      /*
       * The bet parser decides the market, so a market it refuses — a player
       * prop, a combo, a period nothing prices — is refused here too. That is
       * the point of reusing it: the grid and the bet feed cannot disagree
       * about what "handicap +2.5" means.
       */
      const p = parseBetMarket(mName, sName, sport);
      if (!p?.marketIds?.length) continue;
      const outcomeNo =
        p.kind === 'total' ? (p.side === 'over' ? 1 : 2)
        : p.kind === 'btts' ? (/^yes$/i.test(p.name ?? '') ? 1 : /^no$/i.test(p.name ?? '') ? 2 : null)
        : sideOfName(p.name || sName, home, away);
      if (outcomeNo == null) continue;
      const marketId = hasDraw
        ? (p.marketIds.find((id) => id.endsWith('_3way')) ?? p.marketIds[0])
        : p.marketIds[0];
      out.push(row({
        book: SWIFT_BOOK,
        marketId,
        selection: sName,
        outcomeNo,
        line: p.line ?? null,
        price,
        at,
      }));
    }
  }
  return out;
}

/* --------------------------------------------------------------------- mybet */

/**
 * The market as it stood just before mybet took it down.
 *
 * mybet does not suspend a live market, it ZEROES it: at kickoff every field in
 * `match` becomes 0 — prices, lines, the lot. 28,695 events past their start
 * time are in that state against 2,008 still priced, so for most of a match day
 * the live column would simply be blank.
 *
 * `flucs` keeps the way back: one array per field of `{v, at}`, ending in the
 * zero. Al Ahli's ALineDiv reads ...1.05 at 17:17:37Z, then 0 at 18:00:03Z —
 * and 18:00:03Z is 05:00:03 local against an outcomeAt of 05:00:00, so the zero
 * IS the kickoff. That gives both halves of what this needs: the last price
 * anyone could have taken, and the moment it stopped being available.
 *
 * Returns the last non-zero value per field plus `wentLiveAt`, the timestamp of
 * the zero that followed it — not `lastChangedAt`, which is only the last write
 * of any kind and drifts if anything changes afterwards.
 */
function beforeZero(ev) {
  const flucs = ev?.flucs;
  if (!flucs || typeof flucs !== 'object') return null;
  const vals = {};
  let wentLiveAt = null;
  for (const [field, hist] of Object.entries(flucs)) {
    if (!Array.isArray(hist) || !hist.length) continue;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (Number(hist[i]?.v) === 0) continue;
      vals[field] = Number(hist[i].v);
      // The entry after the last good one is the zero that ended it. Only the
      // price fields date the kickoff; a line can stop changing earlier.
      // Normalised before comparing: these arrive as BSON Dates, and comparing
      // a Date against a string silently picks the wrong one.
      const zero = iso(hist[i + 1]?.at);
      if (zero && /Win|Div|Draw/.test(field) && (!wentLiveAt || zero < wentLiveAt)) wentLiveAt = zero;
      break;
    }
  }
  return Object.keys(vals).length ? { vals, wentLiveAt } : null;
}

function mybetRows(ev, { home, away }) {
  const live = ev?.match && Number(ev.match.AWin) === 0 && Number(ev.match.BWin) === 0;
  const prior = live ? beforeZero(ev) : null;
  /*
   * Read through the pre-kickoff snapshot when the market has been zeroed, so
   * every field — price AND line — comes from the same moment. Taking the price
   * from history and the line from `match` would pair a real price with a line
   * of 0.
   */
  const m = prior ? { ...ev.match, ...prior.vals } : ev?.match;
  if (!m) return [];
  const open = ev?.opening ?? {};
  // When it was last available, not when the row was written.
  const at = prior?.wentLiveAt ?? ev?.lastChangedAt ?? ev?.lastSeenAt ?? null;
  const out = [];

  /*
   * A and B are NOT home and away. Boston Celtics v New York Knicks arrives
   * with teamA "New York Knicks", so every side here is decided by NAME.
   */
  const sideA = sideOfName(m.teamA, home, away);
  const sideB = sideOfName(m.teamB, home, away);
  const draw = num(m.Draw);
  const threeWay = draw != null;
  const h2hId = threeWay ? 'moneyline_3way' : 'moneyline';

  /*
   * No price, no row. `num` already rejects the 0 both stores write for "not
   * offering", and a row carrying null would be a column's worth of blank
   * cells on a market we are not in — mybet event 3832228 (Necaxa v Juárez)
   * was last seen a fortnight ago with every price zeroed, and produced
   * exactly that.
   */
  const add = (o) => { if (o.price != null) out.push(row({ book: MYBET_BOOK, at, ...o })); };

  if (sideA) add({ marketId: h2hId, selection: m.teamA, outcomeNo: sideA, price: num(m.AWin), open: num(open.AWin), line: null });
  if (sideB) add({ marketId: h2hId, selection: m.teamB, outcomeNo: sideB, price: num(m.BWin), open: num(open.BWin), line: null });
  if (threeWay) add({ marketId: h2hId, selection: 'Draw', outcomeNo: 3, price: draw, open: num(open.Draw), line: null });

  // The match total. One line, two sides, no ambiguity.
  const over = num(m.OverDiv);
  const under = num(m.UnderDiv);
  const oLine = Number(m.TotalOver);
  const uLine = Number(m.TotalUnder);
  if (over != null && Number.isFinite(oLine)) add({ marketId: 'total', selection: `Over ${oLine}`, outcomeNo: 1, line: oLine, price: over, open: num(open.OverDiv) });
  if (under != null && Number.isFinite(uLine)) add({ marketId: 'total', selection: `Under ${uLine}`, outcomeNo: 2, line: uLine, price: under, open: num(open.UnderDiv) });

  /*
   * The handicap, ONLY when the two lines disagree in sign.
   *
   * Basketball arrives unambiguous — ALine 2, BLine -2 — and is the handicap
   * as anyone would read it. Soccer arrives as ALine 0.5 AND BLine 0.5, both
   * positive, which cannot both be true of one two-sided market and gives no
   * way to tell which side is giving the start. A guess there would put our
   * price on the wrong row of a ladder, so those are left out rather than
   * placed wrongly.
   */
  const aL = Number(m.ALine);
  const bL = Number(m.BLine);
  const signsDisagree = Number.isFinite(aL) && Number.isFinite(bL) && aL * bL < 0;
  if (signsDisagree) {
    const aP = num(m.ALineDiv);
    const bP = num(m.BLineDiv);
    if (sideA && aP != null) add({ marketId: 'spread', selection: `${m.teamA} ${aL > 0 ? '+' : ''}${aL}`, outcomeNo: sideA, line: aL, price: aP, open: num(open.ALineDiv) });
    if (sideB && bP != null) add({ marketId: 'spread', selection: `${m.teamB} ${bL > 0 ? '+' : ''}${bL}`, outcomeNo: sideB, line: bL, price: bP, open: num(open.BLineDiv) });
  }
  return out;
}

/* ---------------------------------------------------------------------- join */

/**
 * Prices from both brands for one fixture, or [] when nothing is mapped.
 *
 * Never throws: a brand store that is unreachable costs its column, not the
 * page. The mapping read needs `event_mapping`, which a deployed instance has
 * only through the mirror.
 */
export async function brandOddsFor(fixtureId, { home, away, sport } = {}) {
  if (!fixtureId || !betsConfigured) return [];
  try {
    const links = await (await coll('eventMapping'))
      .find({ optic_fixture_id: fixtureId, gutsy_event_id: { $ne: null } })
      .project({ _id: 0, provider: 1, gutsy_event_id: 1 })
      .toArray();
    if (!links.length) return [];

    const swiftId = links.find((l) => l.provider === 'swift')?.gutsy_event_id ?? null;
    const mybetId = links.find((l) => l.provider === 'mybet')?.gutsy_event_id ?? null;
    const db = await betsDb();
    if (!db) return [];

    const [swiftEv, mybetEv] = await Promise.all([
      swiftId ? db.collection('events').findOne({ _id: String(swiftId) }).catch(() => null) : null,
      mybetId ? db.collection('mybet_events').findOne({ _id: Number(mybetId) }).catch(() => null) : null,
    ]);

    return [
      ...(swiftEv ? swiftRows(swiftEv, { home, away, sport }) : []),
      ...(mybetEv ? mybetRows(mybetEv, { home, away }) : []),
    ];
  } catch {
    return [];
  }
}

/** Whether this instance can read the brand stores at all. */
export const brandOddsConfigured = () => betsConfigured && (mirrorConfigured || true);
