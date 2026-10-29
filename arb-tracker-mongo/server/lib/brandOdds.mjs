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
import { betsConfigured, betsDb, mybetDb } from './betsMongo.mjs';
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
/**
 * Words that identify no club, dropped before the names are compared.
 *
 * Two kinds, and every one of these cost a whole side of a market:
 *
 *   the club noun   "Al Ahli FC" against mybet's "Al Ahli SC (Sau)" — the
 *                   same team, disagreeing only on which generic noun the
 *                   league files it under. Neither name is a subset of the
 *                   other while fc and sc are in them.
 *   the country tag mybet suffixes a parenthesised country where two leagues
 *                   share a name: "(Sau)", "(Qat)", "(Uae)", "(Irn)". The feed
 *                   never does.
 *
 * Only the generic half goes. "Al Ahli" and "Al Ain" still do not match each
 * other after this, which is the point: it makes the test less brittle without
 * making it less specific, and sideOfName still refuses anything ambiguous.
 */
const NOISE = new Set([
  'fc', 'sc', 'cf', 'afc', 'sk', 'fk', 'ac', 'cd', 'cs', 'sv', 'club', 'kulubu', 'kulup',
  'sau', 'qat', 'uae', 'irn', 'ksa', 'eng', 'esp', 'ita', 'ger', 'fra', 'bra', 'arg',
]);

const words = (s) => {
  const all = norm(s).split(/[^a-z0-9]+/).filter(Boolean);
  const kept = all.filter((w) => !NOISE.has(w));
  // Never strip a name down to nothing: a club genuinely called "FC" would
  // then match everything.
  return new Set(kept.length ? kept : all);
};

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
function row({ book, marketId, selection, outcomeNo, line, price, open, at, flucs }) {
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
    /*
     * The ladder, where the brand keeps one.
     *
     * swiftbet records a `price_history` on every selection — `{odds, ts}`,
     * median five points and up to a hundred and thirty — and it was being
     * dropped on the floor: our rows carried a price and nothing behind it, so
     * the grid's hover card had nothing to draw for the one book whose moves
     * are ours. The shape the card wants is `{p, t}`, which is all this is.
     *
     * It travels with the rest of HISTORY_FIELDS, so the roles that are served
     * the current price and no history keep getting exactly that.
     */
    flucs: flucs ?? [],
    status: null,
    current_at: iso(at),
    open_at: null,
    close_price: null,
    closed_at: null,
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

/**
 * Where a drawn result belongs, which is not the same answer for every sport.
 *
 * A Draw in the selections used to send the whole market to `moneyline_3way`.
 * That is right for hockey and wrong for soccer, and the two failures look
 * nothing alike:
 *
 *   Hockey    swiftbet prices "head to head" (two-way, including overtime)
 *             AND a regulation three-way on the same game. They are different
 *             markets with different prices — Senators 1.68 against 2.08 — and
 *             filing both under `moneyline` put the regulation price on the
 *             field's overtime row.
 *   Soccer    there is only ONE match winner and it has a draw in it. The
 *             field files it under `moneyline`; we filed it under
 *             `moneyline_3way`, which for soccer is not even a market the grid
 *             defines — so our prices were dropped from the page entirely.
 *             Cricket's Test match winner is the same shape: TAB quotes South
 *             Africa / Draw / Australia under plain `moneyline`, and our
 *             three prices sat in a group of their own that the grid then hid
 *             for having only one book in it.
 *
 * So the question is not "is there a draw" but "can this sport end drawn in
 * normal time". Where it can, the drawable market IS the moneyline. Where it
 * cannot, a draw means someone is pricing regulation time separately.
 */
const DRAW_IS_A_RESULT = new Set([
  'soccer', 'cricket', 'rugbyleague', 'rugbyunion', 'aussierules', 'australianrules', 'handball',
]);

/** Sport arrives as either the surface slug or the display label. */
const sportKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** The id for a head-to-head, given whether it carries a draw. */
const threeWayApplies = (sport, hasDraw) => hasDraw && !DRAW_IS_A_RESULT.has(sportKey(sport));

/**
 * Where a TWO-way price set belongs on a sport that can be drawn.
 *
 * It is not the moneyline. On a Sheffield Shield match — a first-class game
 * that can and often does end drawn — mybet quoted South Australia 1.80 and
 * Western Australia 1.94 and no draw at all: no `Draw` in `flucs`, none in
 * `opening`, just the always-present field sitting at zero. Two prices
 * covering a three-way result is a Draw No Bet, and the stake comes back if
 * it is drawn.
 *
 * Filed as `moneyline` it landed on the same row as TAB's actual Match Winner
 * (2.10, with the draw at 7.00) and the grid compared the two. A draw-no-bet
 * price is always the shorter of the pair — it is the same bet with one
 * outcome refunded — so ours read as far under the market when it was not the
 * same market.
 *
 * Only soccer and cricket, because they are the only two whose grids define a
 * `dnb` market to put it in. Rugby and Aussie Rules can be drawn too, but a
 * draw there is rare enough that books quote two ways and mean it, and there
 * is no draw-no-bet column on those pages to move the row into.
 */
const DNB_SPORTS = new Set(['soccer', 'cricket']);

function swiftRows(ev, { home, away, sport }) {
  const out = [];
  const at = ev?.scraped_at ?? null;
  for (const m of ev?.markets ?? []) {
    const mName = String(m?.name ?? '');
    if (!mName || COMBO_MARKET.test(mName)) continue;
    // Whether a draw makes this the three-way depends on the sport — see
    // DRAW_IS_A_RESULT. parseBetMarket offers both ids because a bet slip
    // never says which of the two it was; here the sport and the draw do.

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
      const marketId = threeWayApplies(sport, hasDraw)
        ? (p.marketIds.find((id) => id.endsWith('_3way')) ?? p.marketIds[0])
        : p.marketIds[0];
      /*
       * Oldest first and only real prices. The card plots them in order and a
       * zero would drag the axis to the floor.
       */
      const ladder = (s?.price_history ?? [])
        .map((h) => ({ p: num(h?.odds), t: iso(h?.ts) }))
        .filter((h) => h.p != null && h.t)
        .sort((a, b) => new Date(a.t) - new Date(b.t));
      out.push(row({
        book: SWIFT_BOOK,
        marketId,
        selection: sName,
        outcomeNo,
        line: p.line ?? null,
        price,
        // The first price it was ever seen at, which is what "vs open" means.
        open: ladder[0]?.p ?? null,
        at,
        flucs: ladder,
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

function mybetRows(ev, { home, away, sport }) {
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
  /*
   * Which of mybet's two teams is home, decided as a PAIRING.
   *
   * Each side was resolved on its own, and that fails two ways on real names.
   * It dropped a side whenever the strings disagreed — "LA Galaxy" for "Los
   * Angeles Galaxy", "Lok. Plovdiv" for "Lokomotiv Plovdiv", "Rizespor" for
   * "Çaykur Rize Spor Kulübü" — leaving a three-way market showing a draw and
   * one team, or on the worst of them the draw alone: twenty-three of sixty
   * mapped soccer and cricket fixtures. And once the generic club words were
   * stripped it started doing something worse, putting BOTH teams on the same
   * row: "Los Angeles FC" reduces to {los, angeles}, which is a subset of
   * "Los Angeles Galaxy", so both of them matched home and the home price was
   * written twice.
   *
   * Scoring the pairing fixes both. There are only two ways round, and an
   * exact name beats a merely-compatible one, so Los Angeles FC takes the home
   * row it matches exactly and the Galaxy takes the other by arithmetic. It is
   * sound because `event_mapping` has already decided these are the same game:
   * one home, one away, teamA and teamB, so naming either names the other.
   *
   * A tie means neither ordering has evidence — "PSG"/"Lyon" against "Paris
   * Saint-Germain FC"/"Olympique Lyonnais" matches nothing either way — and
   * both sides are dropped. No price is better than a price on the wrong team.
   */
  const fit = (name, team) => {
    const n = words(name);
    const t = words(team);
    if (!n.size || !t.size) return 0;
    const [small, big] = n.size <= t.size ? [n, t] : [t, n];
    for (const w of small) if (!big.has(w)) return 0;
    return n.size === t.size ? 2 : 1;   // exact beats compatible
  };
  const straight = fit(m.teamA, home) + fit(m.teamB, away);
  const crossed = fit(m.teamA, away) + fit(m.teamB, home);
  const sideA = straight > crossed ? 1 : crossed > straight ? 2 : null;
  const sideB = sideA === null ? null : sideA === 1 ? 2 : 1;

  const draw = num(m.Draw);
  const threeWay = draw != null;
  const h2hId = threeWayApplies(sport, threeWay)
    ? 'moneyline_3way'
    : !threeWay && DNB_SPORTS.has(sportKey(sport))
      ? 'dnb'
      : 'moneyline';

  /*
   * No price, no row. `num` already rejects the 0 both stores write for "not
   * offering", and a row carrying null would be a column's worth of blank
   * cells on a market we are not in — mybet event 3832228 (Necaxa v Juárez)
   * was last seen a fortnight ago with every price zeroed, and produced
   * exactly that.
   */
  /*
   * The ladder for one field of the slip.
   *
   * `flucs` on the event record is keyed by exactly the fields these rows are
   * built from — AWin and BWin for the head to head, OverDiv and UnderDiv for
   * the total, ALineDiv and BLineDiv for the handicap — so each row can be
   * handed its own history without matching anything up. 24,815 events carry
   * one, and it is already on Atlas, which `price_ticks` is not.
   *
   * `num` drops the zeroes, which matters here more than anywhere: mybet does
   * not suspend a market, it zeroes it, so every ladder ends in a 0 that would
   * otherwise drag the sparkline to the floor at kickoff.
   */
  const ladder = (field) =>
    (ev?.flucs?.[field] ?? [])
      .map((f) => ({ p: num(f?.v), t: iso(f?.at) }))
      .filter((f) => f.p != null && f.t)
      .sort((a, b) => new Date(a.t) - new Date(b.t));

  const add = (o) => { if (o.price != null) out.push(row({ book: MYBET_BOOK, at, ...o })); };

  if (sideA) add({ marketId: h2hId, selection: m.teamA, outcomeNo: sideA, price: num(m.AWin), open: num(open.AWin), line: null, flucs: ladder('AWin') });
  if (sideB) add({ marketId: h2hId, selection: m.teamB, outcomeNo: sideB, price: num(m.BWin), open: num(open.BWin), line: null, flucs: ladder('BWin') });
  if (threeWay) add({ marketId: h2hId, selection: 'Draw', outcomeNo: 3, price: draw, open: num(open.Draw), line: null, flucs: ladder('Draw') });

  // The match total. One line, two sides, no ambiguity.
  const over = num(m.OverDiv);
  const under = num(m.UnderDiv);
  const oLine = Number(m.TotalOver);
  const uLine = Number(m.TotalUnder);
  if (over != null && Number.isFinite(oLine)) add({ marketId: 'total', selection: `Over ${oLine}`, outcomeNo: 1, line: oLine, price: over, open: num(open.OverDiv), flucs: ladder('OverDiv') });
  if (under != null && Number.isFinite(uLine)) add({ marketId: 'total', selection: `Under ${uLine}`, outcomeNo: 2, line: uLine, price: under, open: num(open.UnderDiv), flucs: ladder('UnderDiv') });

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
    if (sideA && aP != null) add({ marketId: 'spread', selection: `${m.teamA} ${aL > 0 ? '+' : ''}${aL}`, outcomeNo: sideA, line: aL, price: aP, open: num(open.ALineDiv), flucs: ladder('ALineDiv') });
    if (sideB && bP != null) add({ marketId: 'spread', selection: `${m.teamB} ${bL > 0 ? '+' : ''}${bL}`, outcomeNo: sideB, line: bL, price: bP, open: num(open.BLineDiv), flucs: ladder('BLineDiv') });
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

/* ------------------------------------------------- mybet's own market book */

/**
 * The markets mybet opened that the event record never mentions.
 *
 * `gutsy.mybet_events` carries one row per event with the headline prices on
 * it — a head to head, a line, a total — and that is what this file has been
 * reading. `mybet.markets` is the book proper: on one NBA fixture, 104 open
 * markets against those three. The rest were simply invisible here.
 *
 * Joined on `generationwebEventId`, which holds the same id `event_mapping`
 * already gives us for the fixture.
 *
 * Only the markets this grid has a column for. The brand's vocabulary runs to
 * 88 types and most of them have nowhere to go — race-to, tribet, odd/even,
 * line/total doubles, team totals — and inventing a column for each is a
 * different job from showing the ones we can already draw.
 */
const MYBET_MARKET = {
  'head-to-head': 'moneyline',
  'win-draw-win': 'moneyline_3way',
  'draw-no-bet': 'dnb',
  'double-chance': 'double_chance',
  'both-teams-score': 'btts',
  'alt-line-home': 'spread',
  'alt-line-away': 'spread',
  'alt-total-over': 'total',
  'alt-total-under': 'total',
};

/**
 * The period a market belongs to, from `segment` rather than from its name.
 *
 * `segment` is structured — "regulation_time/half_2/quarter_4" — where the
 * name is prose and inconsistent ("60 Minutes - Head to Head", "1st Period -
 * ..."). Only the periods the grid defines a market for are returned; a 3rd
 * quarter line has nowhere to be drawn, so it is skipped rather than
 * flattened into the full-match column, which would be worse than absent.
 */
function periodPrefix(segment) {
  const seg = String(segment ?? '').trim();
  if (!seg || seg === 'regulation_time') return '';
  if (/\/quarter_1$/.test(seg)) return '1q_';
  if (/\/period_1$/.test(seg)) return '1p_';
  if (/\/innings_1$/.test(seg)) return '1inn_';
  if (/\/set_1$/.test(seg)) return '1s_';
  if (/\/half_1$/.test(seg)) return '1h_';
  return null;
}

/** The handicap or total a selection is at, where it carries one. */
function lineOf(sel) {
  // "total@203.5" on totals, "-25.50" on handicaps, and the name as a backstop.
  const key = String(sel?.key ?? '');
  const at = key.includes('@') ? key.split('@').pop() : key;
  const fromKey = Number(at);
  if (Number.isFinite(fromKey) && at !== '') return fromKey;
  const m = String(sel?.name ?? '').match(/(-?\d+(?:\.\d+)?)\s*$/);
  return m ? Number(m[1]) : null;
}

/** HOME/AWAY/DRAW and OVER/UNDER, in the grid's outcome numbering. */
function outcomeOfRole(role, sel, home, away) {
  const r = String(role ?? '');
  if (r.endsWith('_HOME')) return 1;
  if (r.endsWith('_AWAY')) return 2;
  if (r.endsWith('_DRAW') || r.endsWith('_TIE')) return 3;
  if (r.endsWith('_OVER')) return 1;
  if (r.endsWith('_UNDER')) return 2;
  // Alternate lines carry SELECTION_ROLE_GENERIC and say it in the name.
  const n = String(sel?.name ?? '');
  if (/^over\b/i.test(n)) return 1;
  if (/^under\b/i.test(n)) return 2;
  return sideOfName(n, home, away);
}

async function mybetMarketRows(eventId, { home, away, sport }) {
  const db = await mybetDb();
  if (!db || eventId == null) return [];
  const docs = await db.collection('markets')
    .find({ generationwebEventId: String(eventId) })
    .project({ _id: 0, name: 1, market_type_code: 1, segment: 1, selections: 1, updated_at: 1 })
    .limit(400)
    .toArray()
    .catch(() => []);

  const out = [];
  for (const d of docs) {
    const base = MYBET_MARKET[d.market_type_code];
    if (!base) continue;
    const prefix = periodPrefix(d.segment);
    if (prefix === null) continue;
    /*
     * A drawable sport's three-way IS its moneyline — see DRAW_IS_A_RESULT —
     * so win-draw-win lands in the same column the two-way would.
     */
    const id =
      base === 'moneyline_3way' && DRAW_IS_A_RESULT.has(sportKey(sport))
        ? `${prefix}moneyline`
        : `${prefix}${base}`;
    const alt = d.market_type_code.startsWith('alt-');
    for (const sel of d.selections ?? []) {
      const fixed = sel?.products?.FixedWin ?? {};
      const price = num(fixed.price);
      if (price == null) continue;
      const outcomeNo = outcomeOfRole(sel.role, sel, home, away);
      if (outcomeNo == null) continue;
      out.push(row({
        book: MYBET_BOOK,
        marketId: id,
        selection: sel.name ?? null,
        outcomeNo,
        // Only the alternates state a line; the main ones do not carry it
        // anywhere, which is why those keep coming from the event record.
        line: alt ? lineOf(sel) : null,
        price,
        open: num(fixed.opening_price),
        at: d.updated_at ?? null,
      }));
    }
  }
  return out;
}

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

    const [swiftEv, mybetEv, book] = await Promise.all([
      swiftId ? db.collection('events').findOne({ _id: String(swiftId) }).catch(() => null) : null,
      mybetId ? db.collection('mybet_events').findOne({ _id: Number(mybetId) }).catch(() => null) : null,
      mybetId ? mybetMarketRows(mybetId, { home, away, sport }).catch(() => []) : [],
    ]);

    const fromEvent = mybetEv ? mybetRows(mybetEv, { home, away, sport }) : [];
    /*
     * The event record wins where both describe the same thing.
     *
     * It is the one with the main line on it — the market book states a
     * handicap only on its ALTERNATES, so a main spread or total read from
     * there would arrive with no line and land in the wrong place. So the
     * event record keeps the markets it covers and the book supplies the ones
     * it does not: the alternates, and the halves and quarters.
     */
    const covered = new Set(fromEvent.map((r) => `${r.market_id}|${r.outcome_no}|${r.line ?? ''}`));
    const extra = book.filter((r) => !covered.has(`${r.market_id}|${r.outcome_no}|${r.line ?? ''}`));

    return [
      ...(swiftEv ? swiftRows(swiftEv, { home, away, sport }) : []),
      ...fromEvent,
      ...extra,
    ];
  } catch {
    return [];
  }
}

/** Whether this instance can read the brand stores at all. */
export const brandOddsConfigured = () => betsConfigured && (mirrorConfigured || true);
