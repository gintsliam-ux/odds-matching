export interface Bookmaker {
  id: string;
  name: string;
  /** Brand colour for the logo chip. */
  color: string;
  /** Short mark shown in the logo chip when no image is set. */
  mark: string;
  /** Optional real logo image; falls back to the mark chip when absent. */
  logoUrl?: string;
}

// The core fixed-odds columns, shown for every sport in this order. `id`
// matches the canonical `sportsbook` key in the odds table (see the `books`
// reference table — e.g. `ladbrokes`, not `ladbrokes_australia`).
export const BOOKMAKERS: Bookmaker[] = [
  { id: 'pinnacle', name: 'Pinnacle', color: '#c81e1e', mark: 'PIN', logoUrl: '/logos/brands/pinnacle.png' },
  { id: 'tab', name: 'TAB', color: '#009845', mark: 'TAB', logoUrl: '/logos/brands/tab.png' },
  { id: 'sportsbet', name: 'Sportsbet', color: '#2563eb', mark: 'SP', logoUrl: '/logos/brands/sportsbet.png' },
  { id: 'bet365', name: 'Bet365', color: '#059669', mark: '365', logoUrl: '/logos/brands/bet365.png' },
  { id: 'tabtouch', name: 'TABtouch', color: '#5b2d8e', mark: 'TT', logoUrl: '/logos/brands/tabtouch.png' },
  { id: 'ladbrokes', name: 'Ladbrokes', color: '#dc2626', mark: 'LAD', logoUrl: '/logos/brands/ladbrokes.png' },
];

// Optional books that only some sports fetch — shown as a column only when the
// event actually prices them, so a sport that never fetches one has no dead
// column. Appended after the core books, in this order.
const OPTIONAL_BOOKS: Bookmaker[] = [
  { id: 'fanduel', name: 'FanDuel', color: '#1493ff', mark: 'FD', logoUrl: '/logos/brands/fanduel.png' },
];

// Golf outrights are priced by mostly-US books plus TAB — a different set from
// the core AU columns, so golf uses its own list.
const GOLF_BOOKS: Bookmaker[] = [
  { id: 'tab', name: 'TAB', color: '#009845', mark: 'TAB', logoUrl: '/logos/brands/tab.png' },
  { id: 'draftkings', name: 'DraftKings', color: '#53d337', mark: 'DK', logoUrl: '/logos/brands/draftkings.png' },
  { id: 'fanduel', name: 'FanDuel', color: '#1493ff', mark: 'FD', logoUrl: '/logos/brands/fanduel.png' },
  { id: 'betmgm', name: 'BetMGM', color: '#c8a15a', mark: 'MGM', logoUrl: '/logos/brands/betmgm.png' },
  { id: 'fanatics', name: 'Fanatics', color: '#1a1a2e', mark: 'FAN', logoUrl: '/logos/brands/fanatics.png' },
];

/**
 * Canonical key for a golf player across books that spell them differently —
 * US books write "Cameron Young", TAB writes "YOUNG Cameron". Used only as a
 * fallback now that odds carry `normalized_selection`. Lowercase, drop
 * punctuation, sort the name tokens so order and case don't matter.
 */
// Letters that don't decompose under NFD (so accent-stripping misses them).
const LETTER_FOLD: Record<string, string> = {
  ø: 'o', æ: 'ae', œ: 'oe', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', ı: 'i',
};

function playerKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics (é -> e)
    .toLowerCase()
    .replace(/[øæœðþßłđı]/g, (c) => LETTER_FOLD[c] ?? c) // ø -> o, etc.
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * A readable display name from a player's spellings across books. Prefer a
 * "First Last" variant (no all-caps token); fall back to reformatting TAB's
 * "SURNAME First" form.
 */
function playerDisplayName(variants: string[]): string {
  const isCaps = (w: string) => w.length > 1 && w === w.toUpperCase();
  const nice = variants.find((v) => !v.split(/\s+/).some(isCaps));
  if (nice) return nice;
  const toks = variants[0].split(/\s+/).filter(Boolean);
  const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const capsIdx = toks.findIndex(isCaps);
  if (capsIdx >= 0) {
    // The caps token is the surname — move it to the end and title-case.
    const surname = toks[capsIdx];
    return [...toks.filter((_, i) => i !== capsIdx), surname].map(title).join(' ');
  }
  return toks.map(title).join(' ');
}

/** Book ids that have a takeable (non-lay) price somewhere in these rows. */
function booksWithOdds(rows: OddsRow[]): Set<string> {
  const present = new Set<string>();
  for (const r of rows) {
    if (!r.is_lay && (r.current_price ?? r.open_price) != null) present.add(r.sportsbook);
  }
  return present;
}

/**
 * The book columns for one event, in display order. Core books always appear;
 * optional books only when this event prices them. Then within that set, books
 * that have no odds for this event are pushed to the far right, so the columns
 * that actually priced the game group together on the left.
 */
export function eventBooks(rows: OddsRow[], leagueId?: string): Bookmaker[] {
  const present = booksWithOdds(rows);
  // Golf uses an entirely separate (US) book set; every column is optional and
  // shown only when priced.
  const base =
    leagueId === 'golf'
      ? GOLF_BOOKS.filter((b) => present.has(b.id))
      : [...BOOKMAKERS, ...OPTIONAL_BOOKS.filter((b) => present.has(b.id))];
  const has = base.filter((b) => present.has(b.id));
  const missing = base.filter((b) => !present.has(b.id));
  return [...has, ...missing];
}

// Betfair is the exchange. Back = the `betfair` book (is_lay false), lay = the
// separate `betfair_lay` book.
export const BETFAIR: Bookmaker = {
  id: 'betfair',
  name: 'Betfair',
  color: '#f59e0b',
  mark: 'BF',
  logoUrl: '/logos/brands/betfair.png',
};
const BETFAIR_LAY_ID = 'betfair_lay';

const BY_ID: Record<string, Bookmaker> = Object.fromEntries(
  [...BOOKMAKERS, ...OPTIONAL_BOOKS, ...GOLF_BOOKS, BETFAIR].map((b) => [b.id, b]),
);

export function brandById(id: string): Bookmaker | undefined {
  return BY_ID[id];
}

/**
 * A suspended price is the last one seen before the book pulled the market —
 * still worth showing, but not takeable right now.
 */
export function isSuspended(cell: PriceCell): boolean {
  return cell.detail?.status === 'suspended';
}

/** One observed price change, as stored in the `flucs` jsonb column. */
export interface Fluc {
  p: number;
  t: string;
}

/** A price snapshot taken at a fixed point before the jump. */
export interface Snapshot {
  label: string;
  price: number;
}

/** One entry from the scraper's `daily_prices` — the 9am (Melbourne) snapshot. */
export interface DailyPrice {
  /** "YYYY-MM-DD", a Melbourne-local calendar date (the scraper's key). */
  date: string;
  price: number;
}

/** Everything the hover card shows about one book's price for one selection. */
export interface PriceDetail {
  bookId: string;
  price: number;
  open: number | null;
  openAt: string | null;
  /** Full change history, oldest first. Length 1 means it never moved. */
  flucs: Fluc[];
  /** Pre-jump snapshots that exist for this row, in time order. */
  snapshots: Snapshot[];
  /** The 9am (Melbourne) price for each day the market's been open, oldest first. */
  daily: DailyPrice[];
  updatedAt: string | null;
  status: string | null;
}

export interface PriceCell {
  bookId: string;
  price: number | null;
  /** Null when this book doesn't price the selection. */
  detail: PriceDetail | null;
}

export interface SelectionRow {
  key: string;
  label: string;
  /** Team name when the selection is a team (H2H/Line), for its crest. */
  team?: string;
  prices: PriceCell[];
  /** Betfair exchange back/lay; `price` is null when it doesn't cover it. */
  betfairBack: PriceCell;
  betfairLay: PriceCell;
  /** Best takeable price across fixed-odds books + Betfair back. */
  bestBookId: string | null;
  bestPrice: number | null;
  bestDetail: PriceDetail | null;
  /** True for both rows of the main line (spread/total ladders). */
  isMain?: boolean;
  /** True on the first row of each line pair, for a divider above it. */
  groupStart?: boolean;
}

export interface MarketGroup {
  key: string;
  label: string;
  selections: SelectionRow[];
}

/** One row from the unified `odds` table. */
export interface OddsRow {
  market_id: string;
  market_name: string | null;
  selection: string;
  /** home / away / draw / over / under / yes / no, or an outright slug. */
  normalized_selection: string | null;
  line: number | null;
  /** abs(line) — pairs totals (shared line) and handicaps (opposite signs). */
  line_group: number | null;
  /**
   * The handicap line signed from the home side; both rows of a two-sided
   * ladder (home -1.5 / away +1.5) share it. Groups spreads correctly, since
   * home -1.5/away +1.5 and home +1.5/away -1.5 are DIFFERENT markets that
   * abs(line) would wrongly merge.
   */
  pair_key: number | null;
  /** 1 = home / Over / Yes, 2 = away / Under / No, 3 = Draw. */
  outcome_no: number | null;
  /** Exactly one line per book per market — the main line. */
  is_main: boolean | null;
  sportsbook: string;
  is_lay: boolean;
  current_price: number | null;
  open_price: number | null;
  status: string | null;
  flucs: Fluc[] | null;
  open_at: string | null;
  price_6h: number | null;
  price_3h: number | null;
  price_1h: number | null;
  price_30m: number | null;
  price_10m: number | null;
  close_price: number | null;
  current_at: string | null;
  /** Melbourne-date -> 9am snapshot price. */
  daily_prices: Record<string, number> | null;
}

// Canonical market ids are shared across sports (spread, total, moneyline, …);
// only the labels and which markets exist differ per sport. `kind` drives the
// ladder shape. Markets with no rows are dropped, so a list can be a superset.
type MarketKind = 'h2h' | 'spread' | 'total' | 'outright' | 'flat';
interface MarketDef {
  id: string;
  label: string;
  kind: MarketKind;
}

const D = (id: string, label: string, kind: MarketKind): MarketDef => ({ id, label, kind });

// Generic team sports: H2H / Line / Total, plus halves.
const TEAM_DEFAULT: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Line', 'spread'),
  D('total', 'Total', 'total'),
  D('1h_moneyline', '1st Half — Head to Head', 'h2h'),
  D('1h_spread', '1st Half — Line', 'spread'),
  D('1h_total', '1st Half — Total', 'total'),
];

const SOCCER_MARKETS: MarketDef[] = [
  D('moneyline', 'Result', 'h2h'),
  D('spread', 'Handicap', 'spread'),
  D('total', 'Total Goals', 'total'),
  D('dnb', 'Draw No Bet', 'h2h'),
  D('double_chance', 'Double Chance', 'flat'),
  D('btts', 'Both Teams to Score', 'flat'),
  D('asian_total', 'Asian Total', 'total'),
  D('1h_moneyline', '1st Half — Result', 'h2h'),
  D('1h_spread', '1st Half — Handicap', 'spread'),
  D('1h_total', '1st Half — Total Goals', 'total'),
  D('1h_asian_total', '1st Half — Asian Total', 'total'),
];

const GRIDIRON_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Line', 'spread'),
  D('total', 'Total Points', 'total'),
  D('1h_moneyline', '1st Half — Head to Head', 'h2h'),
  D('1h_spread', '1st Half — Line', 'spread'),
  D('1h_total', '1st Half — Total Points', 'total'),
  D('1q_moneyline', '1st Quarter — Head to Head', 'h2h'),
  D('1q_spread', '1st Quarter — Line', 'spread'),
  D('1q_total', '1st Quarter — Total Points', 'total'),
];

const BASKETBALL_MARKETS: MarketDef[] = GRIDIRON_MARKETS;
const AUSSIE_MARKETS: MarketDef[] = GRIDIRON_MARKETS;

const RUGBY_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Line', 'spread'),
  D('total', 'Total Points', 'total'),
  D('1h_moneyline', '1st Half — Head to Head', 'h2h'),
  D('1h_spread', '1st Half — Line', 'spread'),
  D('1h_total', '1st Half — Total Points', 'total'),
];

const HOCKEY_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Puck Line', 'spread'),
  D('total', 'Total', 'total'),
  D('1p_moneyline', '1st Period — Head to Head', 'h2h'),
  D('1p_spread', '1st Period — Puck Line', 'spread'),
  D('1p_total', '1st Period — Total', 'total'),
];

// Baseball prices a run line; its half markets are the first five innings and
// there are dedicated first-inning markets.
const MLB_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Run Line', 'spread'),
  D('total', 'Total Runs', 'total'),
  D('1h_moneyline', 'First 5 Innings — Head to Head', 'h2h'),
  D('1h_spread', 'First 5 Innings — Run Line', 'spread'),
  D('1h_total', 'First 5 Innings — Total Runs', 'total'),
  D('1inn_moneyline', '1st Inning — Head to Head', 'h2h'),
  D('1inn_spread', '1st Inning — Run Line', 'spread'),
  D('1inn_total', '1st Inning — Total Runs', 'total'),
];

// Tennis handicaps come in two flavours (games and sets); the short-form market
// is the opening set rather than a half.
const TENNIS_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Game Handicap', 'spread'),
  D('set_spread', 'Set Handicap', 'spread'),
  D('total', 'Total Games', 'total'),
  D('total_sets', 'Total Sets', 'total'),
  D('1s_moneyline', '1st Set — Head to Head', 'h2h'),
  D('1s_spread', '1st Set — Game Handicap', 'spread'),
  D('1s_total', '1st Set — Total Games', 'total'),
];

// A combat sport: who wins, and the rounds line.
const COMBAT_MARKETS: MarketDef[] = [
  D('moneyline', 'Winner', 'h2h'),
  D('total', 'Total Rounds', 'total'),
];

const DARTS_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Handicap', 'spread'),
  D('total', 'Total Legs', 'total'),
];

const CRICKET_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('spread', 'Handicap', 'spread'),
  D('total', 'Total Runs', 'total'),
];

// Golf comes in two fixture shapes: a tournament (the `outright` field of
// players) and 2-player matchups (a `moneyline` H2H). Empty markets drop out,
// so each fixture shows only the one it has.
const GOLF_MARKETS: MarketDef[] = [
  D('moneyline', 'Head to Head', 'h2h'),
  D('outright', 'Outright', 'outright'),
];

// Keyed by the sport slug (which is `league.id`).
const LEAGUE_MARKETS: Record<string, MarketDef[]> = {
  soccer: SOCCER_MARKETS,
  amfootball: GRIDIRON_MARKETS,
  basketball: BASKETBALL_MARKETS,
  aussierules: AUSSIE_MARKETS,
  rugbyleague: RUGBY_MARKETS,
  icehockey: HOCKEY_MARKETS,
  baseball: MLB_MARKETS,
  tennis: TENNIS_MARKETS,
  mma: COMBAT_MARKETS,
  boxing: COMBAT_MARKETS,
  darts: DARTS_MARKETS,
  cricket: CRICKET_MARKETS,
  golf: GOLF_MARKETS,
};

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

const priceOfRow = (r: OddsRow) => r.current_price ?? r.open_price;

/** Which side a row is on: 1 home/over, 2 away/under, 3 draw. */
function sideOf(r: OddsRow): number | null {
  if (r.outcome_no === 1 || r.outcome_no === 2 || r.outcome_no === 3) return r.outcome_no;
  const n = r.normalized_selection;
  if (n === 'home' || n === 'over' || n === 'yes') return 1;
  if (n === 'away' || n === 'under' || n === 'no') return 2;
  if (n === 'draw') return 3;
  return null;
}
const isOverRow = (r: OddsRow) => sideOf(r) === 1;

/** Lift a row into the hover card's view of it. */
function detailFrom(r: OddsRow, price: number): PriceDetail {
  const snapshots: Snapshot[] = [];
  const add = (label: string, p: number | null) => {
    if (p != null) snapshots.push({ label, price: p });
  };
  add('6h', r.price_6h);
  add('3h', r.price_3h);
  add('1h', r.price_1h);
  add('30m', r.price_30m);
  add('10m', r.price_10m);
  add('Close', r.close_price);

  const daily: DailyPrice[] = Object.entries(r.daily_prices ?? {})
    .map(([date, p]) => ({ date, price: Number(p) }))
    .filter((d) => Number.isFinite(d.price))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    bookId: r.sportsbook,
    price,
    open: r.open_price,
    openAt: r.open_at,
    flucs: (r.flucs ?? []).filter((f) => f && typeof f.p === 'number' && f.t),
    snapshots,
    daily,
    updatedAt: r.current_at,
    status: r.status,
  };
}

function emptyCell(bookId: string): PriceCell {
  return { bookId, price: null, detail: null };
}

/** The cell for one book on a set of rows (pregame only — see fetchOdds). */
function cellOf(rows: OddsRow[], bookId: string, isLay: boolean): PriceCell {
  for (const r of rows) {
    if (r.sportsbook !== bookId || r.is_lay !== isLay) continue;
    const p = priceOfRow(r);
    if (p != null) return { bookId, price: p, detail: detailFrom(r, p) };
  }
  return emptyCell(bookId);
}

/** Betfair lay: the dedicated `betfair_lay` book, or legacy is_lay rows. */
function betfairLayCell(rows: OddsRow[]): PriceCell {
  for (const r of rows) {
    if (r.sportsbook === BETFAIR_LAY_ID || (r.sportsbook === BETFAIR.id && r.is_lay)) {
      const p = priceOfRow(r);
      if (p != null) return { bookId: BETFAIR.id, price: p, detail: detailFrom(r, p) };
    }
  }
  return emptyCell(BETFAIR.id);
}

/** Distinct books (fixed + Betfair back) that actually price a set of rows. */
function coverage(rows: OddsRow[]): number {
  const books = new Set<string>();
  for (const r of rows) {
    if (!r.is_lay && (r.current_price ?? r.open_price) != null) books.add(r.sportsbook);
  }
  return books.size;
}

function makeSelectionRow(
  books: Bookmaker[],
  key: string,
  label: string,
  groupRows: OddsRow[],
  team?: string,
): SelectionRow {
  const prices = books.map<PriceCell>((b) => cellOf(groupRows, b.id, false));
  const betfairBack = cellOf(groupRows, BETFAIR.id, false);
  const betfairLay = betfairLayCell(groupRows);

  let bestBookId: string | null = null;
  let bestPrice: number | null = null;
  let bestDetail: PriceDetail | null = null;
  // Best means takeable, so a suspended price can't win it — even when it is
  // the top number on the row. Every price suspended => no best at all.
  const consider = (cell: PriceCell) => {
    if (isSuspended(cell)) return;
    if (cell.price != null && (bestPrice == null || cell.price > bestPrice)) {
      bestPrice = cell.price;
      bestBookId = cell.bookId;
      bestDetail = cell.detail;
    }
  };
  for (const cell of prices) consider(cell);
  consider(betfairBack);

  return { key, label, team, prices, betfairBack, betfairLay, bestBookId, bestPrice, bestDetail };
}

// How many lines to show either side of the main line.
const LADDER_RADIUS = 5;

/** Mean of the takeable (non-lay) prices in a set of rows, or null. */
function meanPrice(rows: OddsRow[]): number | null {
  const ps: number[] = [];
  for (const r of rows) {
    if (r.is_lay) continue;
    const p = r.current_price ?? r.open_price;
    if (p != null) ps.push(p);
  }
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}

// Pick 'em is the line where each outcome pays ~evens.
const PICKEM_TARGET = 1.9;

/**
 * The main line for a ladder. The scraper marks it per book (`is_main`), so the
 * consensus is the modal `is_main` key. Falls back to the pick-'em line (both
 * sides closest to ~1.90), then the best-covered line.
 */
function mainLine(
  marketRows: OddsRow[],
  keyNum: (r: OddsRow) => number,
  isSideA: (r: OddsRow) => boolean,
): number | null {
  // Consensus of the scraper's own main-line flag: the modal is_main key.
  const mainCounts = new Map<number, number>();
  for (const r of marketRows) {
    if (!r.is_main) continue;
    const k = keyNum(r);
    if (Number.isFinite(k)) mainCounts.set(k, (mainCounts.get(k) ?? 0) + 1);
  }
  let flagged: number | null = null;
  let flaggedN = -1;
  for (const [k, n] of mainCounts) {
    if (n > flaggedN) {
      flaggedN = n;
      flagged = k;
    }
  }
  if (flagged != null) return flagged;

  // Fallback: the line where both outcomes price closest to evens.
  const groups = new Map<number, OddsRow[]>();
  for (const r of marketRows) {
    const k = keyNum(r);
    if (!Number.isFinite(k)) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  let best: number | null = null;
  let bestScore = Infinity;
  let fallback: number | null = null;
  let fbCov = -1;
  for (const [k, rs] of groups) {
    const cov = coverage(rs);
    if (cov > fbCov) {
      fbCov = cov;
      fallback = k;
    }
    const a = meanPrice(rs.filter(isSideA));
    const b = meanPrice(rs.filter((r) => !isSideA(r)));
    if (a != null && b != null) {
      const score = Math.abs(a - PICKEM_TARGET) + Math.abs(b - PICKEM_TARGET);
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
  }
  return best ?? fallback;
}

/** The main line plus up to `radius` lines either side, in value order. */
function ladderWindow(values: number[], main: number | null, radius: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (main == null) return sorted.slice(0, radius * 2 + 1);
  const i = sorted.indexOf(main);
  if (i < 0) return sorted.slice(0, radius * 2 + 1);
  return sorted.slice(Math.max(0, i - radius), i + radius + 1);
}

/** Title-case a flat outcome label ("yes" -> "Yes", "1X" stays "1X"). */
function prettyOutcome(sel: string): string {
  if (/^[0-9A-Z]+$/.test(sel)) return sel; // 1X / 12 / X2
  return sel.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface BuiltMarkets {
  groups: MarketGroup[];
  /** Book columns in display order (no-odds books pushed to the far right). */
  books: Bookmaker[];
}

/**
 * Pivot a fixture's odds rows into the per-market grid. Sides are keyed on the
 * canonical `outcome_no` / `normalized_selection` rather than by matching the
 * selection string to a team name.
 */
export function buildMarkets(
  rows: OddsRow[],
  home: string,
  away: string,
  leagueId: string,
): BuiltMarkets {
  const groups: MarketGroup[] = [];
  const books = eventBooks(rows, leagueId);

  for (const def of LEAGUE_MARKETS[leagueId] ?? TEAM_DEFAULT) {
    const marketRows = rows.filter((r) => r.market_id === def.id);
    if (marketRows.length === 0) continue;

    let selections: SelectionRow[];

    if (def.kind === 'outright') {
      // A flat field, one row per player, shortest price first. Merge a player's
      // spellings across books with playerKey — NOT normalized_selection, which
      // isn't cross-book stable for outrights (TAB writes "scheffler_scottie",
      // US books "scottie_scheffler", and accents get dropped inconsistently).
      const byPlayer = new Map<string, OddsRow[]>();
      for (const r of marketRows) {
        const key = playerKey(r.selection);
        (byPlayer.get(key) ?? byPlayer.set(key, []).get(key)!).push(r);
      }
      selections = [...byPlayer.values()]
        .map((rs) => {
          const name = playerDisplayName([...new Set(rs.map((r) => r.selection))]);
          return makeSelectionRow(books, name, name, rs);
        })
        .sort((a, b) => (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity));
    } else if (def.kind === 'flat') {
      // Named outcomes (Yes/No, 1X/12/X2), ordered by outcome_no.
      const order = new Map<string, number>();
      for (const r of marketRows) {
        const k = r.normalized_selection || r.selection;
        if (!order.has(k)) order.set(k, r.outcome_no ?? 99);
      }
      selections = [...order.keys()]
        .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
        .map((k) => {
          const rs = marketRows.filter((r) => (r.normalized_selection || r.selection) === k);
          return makeSelectionRow(books, k, prettyOutcome(rs[0].selection), rs);
        });
    } else if (def.kind === 'total') {
      const main = mainLine(marketRows, (r) => r.line ?? NaN, isOverRow);
      const lines = [...new Set(marketRows.map((r) => r.line).filter((l): l is number => l != null))];
      selections = ladderWindow(lines, main, LADDER_RADIUS)
        .sort((a, b) => Math.abs(a) - Math.abs(b))
        .flatMap((L) => {
          const over = marketRows.filter((r) => r.line === L && isOverRow(r));
          const under = marketRows.filter((r) => r.line === L && !isOverRow(r));
          const isMain = L === main;
          return [
            { ...makeSelectionRow(books, `over_${L}`, `Over ${L}`, over), isMain, groupStart: true },
            { ...makeSelectionRow(books, `under_${L}`, `Under ${L}`, under), isMain },
          ];
        });
    } else if (def.kind === 'spread') {
      // Group on pair_key — the home-signed handicap that both rows of a pair
      // share. home -1.5/away +1.5 and home +1.5/away -1.5 are different markets
      // (different pair_key), which abs(line) would wrongly merge. Fall back to
      // computing it from the home line when pair_key is absent.
      const keyNum = (r: OddsRow) =>
        r.pair_key ?? (sideOf(r) === 1 ? (r.line ?? 0) : -(r.line ?? 0));
      const isSideA = (r: OddsRow) => sideOf(r) === 1;
      const main = mainLine(marketRows, keyNum, isSideA);
      const keys = [...new Set(marketRows.map(keyNum))];
      selections = ladderWindow(keys, main, LADDER_RADIUS)
        .sort((a, b) => Math.abs(a) - Math.abs(b))
        .flatMap((K) => {
          const hr = marketRows.filter((r) => sideOf(r) === 1 && keyNum(r) === K);
          const ar = marketRows.filter((r) => sideOf(r) === 2 && keyNum(r) === K);
          // Label from each side's actual signed line (home line = K).
          const hLine = hr[0]?.line ?? K;
          const aLine = ar[0]?.line ?? -K;
          const isMain = K === main;
          return [
            {
              ...makeSelectionRow(books, `${home}_${K}`, `${home} ${signed(hLine)}`, hr, home),
              isMain,
              groupStart: true,
            },
            {
              ...makeSelectionRow(books, `${away}_${K}`, `${away} ${signed(aLine)}`, ar, away),
              isMain,
            },
          ];
        });
    } else {
      // H2H / DNB: canonical home (oc1), away (oc2), plus Draw (oc3) in between.
      const homeRows = marketRows.filter((r) => sideOf(r) === 1);
      const awayRows = marketRows.filter((r) => sideOf(r) === 2);
      const drawRows = marketRows.filter((r) => sideOf(r) === 3);
      selections = [makeSelectionRow(books, home, home, homeRows, home)];
      if (drawRows.length) selections.push(makeSelectionRow(books, 'Draw', 'Draw', drawRows));
      selections.push(makeSelectionRow(books, away, away, awayRows, away));
    }

    groups.push({ key: def.id, label: def.label, selections });
  }

  return { groups, books };
}
