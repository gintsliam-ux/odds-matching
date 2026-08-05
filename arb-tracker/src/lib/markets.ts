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
// matches the odds table `sportsbook`.
export const BOOKMAKERS: Bookmaker[] = [
  { id: 'pinnacle', name: 'Pinnacle', color: '#c81e1e', mark: 'PIN', logoUrl: '/logos/brands/pinnacle.png' },
  { id: 'tab', name: 'TAB', color: '#009845', mark: 'TAB', logoUrl: '/logos/brands/tab.png' },
  { id: 'sportsbet', name: 'Sportsbet', color: '#2563eb', mark: 'SP', logoUrl: '/logos/brands/sportsbet.png' },
  { id: 'bet365', name: 'Bet365', color: '#059669', mark: '365', logoUrl: '/logos/brands/bet365.png' },
  { id: 'tabtouch', name: 'TABtouch', color: '#5b2d8e', mark: 'TT', logoUrl: '/logos/brands/tabtouch.png' },
  { id: 'ladbrokes_australia', name: 'Ladbrokes', color: '#dc2626', mark: 'LAD', logoUrl: '/logos/brands/ladbrokes_australia.png' },
];

// Optional books that only some sports fetch — shown as a column only when the
// event actually prices them, so a sport that never fetches one has no dead
// column. Appended after the core books, in this order.
const OPTIONAL_BOOKS: Bookmaker[] = [
  { id: 'fanduel', name: 'FanDuel', color: '#1493ff', mark: 'FD', logoUrl: '/logos/brands/fanduel.png' },
];

// Golf outrights are priced by US books, none of which overlap the core AU set,
// so golf uses its own column list. (Logos fall back to the mark chip until the
// brand images are added.)
const GOLF_BOOKS: Bookmaker[] = [
  { id: 'draftkings', name: 'DraftKings', color: '#53d337', mark: 'DK', logoUrl: '/logos/brands/draftkings.png' },
  { id: 'fanduel', name: 'FanDuel', color: '#1493ff', mark: 'FD', logoUrl: '/logos/brands/fanduel.png' },
  { id: 'betmgm', name: 'BetMGM', color: '#c8a15a', mark: 'MGM', logoUrl: '/logos/brands/betmgm.png' },
  { id: 'fanatics', name: 'Fanatics', color: '#1a1a2e', mark: 'FAN', logoUrl: '/logos/brands/fanatics.png' },
];

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

// Betfair is the exchange. Back = `betfair_exchange_australia` (is_lay false),
// lay = `betfair_exchange_australia_lay` (is_lay true, a separate sportsbook).
export const BETFAIR: Bookmaker = {
  id: 'betfair_exchange_australia',
  name: 'Betfair',
  color: '#f59e0b',
  mark: 'BF',
  logoUrl: '/logos/brands/betfair_exchange_australia.png',
};
const BETFAIR_LAY_ID = 'betfair_exchange_australia_lay';

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
  /** True for both rows of the pick-'em main line (spread/total ladders). */
  isMain?: boolean;
  /** True on the first row of each line pair, for a divider above it. */
  groupStart?: boolean;
}

export interface MarketGroup {
  key: string;
  label: string;
  selections: SelectionRow[];
}

/** One row from a `<sport>_odds` table. */
export interface OddsRow {
  market_id: string;
  selection: string;
  line: number | null;
  sportsbook: string;
  is_lay: boolean;
  current_price: number | null;
  open_price: number | null;
  status: string | null;
  flucs: Fluc[] | null;
  open_at: string | null;
  price_3h: number | null;
  price_1h: number | null;
  price_30m: number | null;
  price_10m: number | null;
  close_price: number | null;
  current_at: string | null;
  /** Melbourne-date -> 9am snapshot price. */
  daily_prices: Record<string, number> | null;
}

// market_id -> display, in the order the grid shows them. `kind` drives the
// ladder shape, since the id naming differs per sport (point_spread/run_line).
// 'outright' is a flat field of selections (golf winner), no home/away or line.
type MarketKind = 'h2h' | 'spread' | 'total' | 'outright';
interface MarketDef {
  id: string;
  label: string;
  kind: MarketKind;
}

const DEFAULT_MARKETS: MarketDef[] = [
  { id: 'moneyline', label: 'Head to Head', kind: 'h2h' },
  { id: 'point_spread', label: 'Line', kind: 'spread' },
  { id: 'total_points', label: 'Total', kind: 'total' },
  { id: '1st_half_moneyline', label: '1st Half — Head to Head', kind: 'h2h' },
  { id: '1st_half_point_spread', label: '1st Half — Line', kind: 'spread' },
  { id: '1st_half_total_points', label: '1st Half — Total', kind: 'total' },
];

// Baseball prices a run line rather than a spread, and its `1st_half_*` feed
// markets are the first five innings.
const MLB_MARKETS: MarketDef[] = [
  { id: 'moneyline', label: 'Head to Head', kind: 'h2h' },
  { id: 'run_line', label: 'Run Line', kind: 'spread' },
  { id: 'total_runs', label: 'Total Runs', kind: 'total' },
  { id: '1st_half_moneyline', label: 'First 5 Innings — Head to Head', kind: 'h2h' },
  { id: '1st_half_run_line', label: 'First 5 Innings — Run Line', kind: 'spread' },
  { id: '1st_half_total_runs', label: 'First 5 Innings — Total Runs', kind: 'total' },
];

// Tennis handicaps come in two flavours (games and sets) and the short-form
// market is the opening set rather than a half.
const TENNIS_MARKETS: MarketDef[] = [
  { id: 'moneyline', label: 'Head to Head', kind: 'h2h' },
  { id: 'game_spread', label: 'Game Handicap', kind: 'spread' },
  { id: 'set_handicap', label: 'Set Handicap', kind: 'spread' },
  { id: 'total_games', label: 'Total Games', kind: 'total' },
  { id: '1st_set_moneyline', label: '1st Set — Head to Head', kind: 'h2h' },
  { id: '1st_set_game_spread', label: '1st Set — Game Handicap', kind: 'spread' },
  { id: '1st_set_total_games', label: '1st Set — Total Games', kind: 'total' },
];

// Soccer: 3-way result (the Draw rides through the h2h builder as an extra),
// asian handicap, and goals lines.
const SOCCER_MARKETS: MarketDef[] = [
  { id: 'moneyline', label: 'Result', kind: 'h2h' },
  { id: 'asian_handicap', label: 'Handicap', kind: 'spread' },
  { id: 'total_goals', label: 'Total Goals', kind: 'total' },
  { id: '1st_half_moneyline', label: '1st Half — Result', kind: 'h2h' },
  { id: '1st_half_asian_handicap', label: '1st Half — Handicap', kind: 'spread' },
  { id: '1st_half_total_goals', label: '1st Half — Total Goals', kind: 'total' },
];

// A UFC fight: who wins, and the rounds line.
const UFC_MARKETS: MarketDef[] = [
  { id: 'moneyline', label: 'Winner', kind: 'h2h' },
  { id: 'total_rounds', label: 'Total Rounds', kind: 'total' },
];

// Golf: a single outright market — the field of players priced to win.
const GOLF_MARKETS: MarketDef[] = [{ id: 'winner', label: 'Outright', kind: 'outright' }];

const LEAGUE_MARKETS: Record<string, MarketDef[]> = {
  mlb: MLB_MARKETS,
  atp: TENNIS_MARKETS,
  wta: TENNIS_MARKETS,
  soccer: SOCCER_MARKETS,
  ufc: UFC_MARKETS,
  golf: GOLF_MARKETS,
  // nfl / ncaaf / wnba use DEFAULT_MARKETS (h2h / point_spread / total_points).
};

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

const priceOfRow = (r: OddsRow) => r.current_price ?? r.open_price;

/** Lift a row into the hover card's view of it. */
function detailFrom(r: OddsRow, price: number): PriceDetail {
  const snapshots: Snapshot[] = [];
  const add = (label: string, p: number | null) => {
    if (p != null) snapshots.push({ label, price: p });
  };
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

function cellOf(rows: OddsRow[], bookId: string, isLay: boolean): PriceCell {
  for (const r of rows) {
    if (r.sportsbook === bookId && r.is_lay === isLay) {
      const p = priceOfRow(r);
      if (p != null) return { bookId, price: p, detail: detailFrom(r, p) };
    }
  }
  return emptyCell(bookId);
}

/** Betfair lay: the dedicated `_lay` sportsbook, or legacy is_lay rows. */
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

  return {
    key,
    label,
    team,
    prices,
    betfairBack,
    betfairLay,
    bestBookId,
    bestPrice,
    bestDetail,
  };
}

const isOver = (sel: string) => sel.toLowerCase() === 'over';

// How many lines to show either side of the pick-'em main line.
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
 * The "pick 'em" main line: the line/magnitude where BOTH sides price closest
 * to ~1.90 (evens). Falls back to the best-covered line when no line has both
 * sides priced.
 */
function pickEmLine(
  marketRows: OddsRow[],
  keyNum: (r: OddsRow) => number,
  isSideA: (r: OddsRow) => boolean,
): number | null {
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
      // Distance of both outcomes from evens — smallest wins.
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

/**
 * Pivot a fixture's odds rows into the H2H → Line → Total (full + 1H) grid.
 * H2H shows both teams; Spread/Total show the pick-'em main line plus five
 * lines either side, each with both outcomes (missing side => "–").
 */
export interface BuiltMarkets {
  groups: MarketGroup[];
  /** Book columns in display order (no-odds books pushed to the far right). */
  books: Bookmaker[];
}

export function buildMarkets(
  rows: OddsRow[],
  home: string,
  away: string,
  leagueId: string,
): BuiltMarkets {
  const groups: MarketGroup[] = [];
  const books = eventBooks(rows, leagueId);

  for (const def of LEAGUE_MARKETS[leagueId] ?? DEFAULT_MARKETS) {
    const marketRows = rows.filter((r) => r.market_id === def.id);
    if (marketRows.length === 0) continue;

    let selections: SelectionRow[];

    if (def.kind === 'outright') {
      // A flat field: one row per selection (player), shortest price first.
      const names = [...new Set(marketRows.map((r) => r.selection))];
      selections = names
        .map((name) =>
          makeSelectionRow(
            books,
            name,
            name,
            marketRows.filter((r) => r.selection === name),
          ),
        )
        .sort((a, b) => (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity));
    } else if (def.kind === 'total') {
      const isSideA = (r: OddsRow) => isOver(r.selection);
      const main = pickEmLine(marketRows, (r) => r.line ?? NaN, isSideA);
      const lines = [...new Set(marketRows.map((r) => r.line).filter((l): l is number => l != null))];
      selections = ladderWindow(lines, main, LADDER_RADIUS)
        .sort((a, b) => Math.abs(a) - Math.abs(b))
        .flatMap((L) => {
        const over = marketRows.filter((r) => r.line === L && isOver(r.selection));
        const under = marketRows.filter((r) => r.line === L && !isOver(r.selection));
        const isMain = L === main;
        return [
          { ...makeSelectionRow(books, `over_${L}`, `Over ${L}`, over), isMain, groupStart: true },
          { ...makeSelectionRow(books, `under_${L}`, `Under ${L}`, under), isMain },
        ];
      });
    } else if (def.kind === 'spread') {
      // Key by the home-perspective handicap so home −X pairs with away +X
      // (and stays separate from home +X). Away rows key on their negated line.
      const isSideA = (r: OddsRow) => r.selection === home;
      const keyNum = (r: OddsRow) =>
        r.selection === home ? (r.line ?? 0) : -(r.line ?? 0);
      const main = pickEmLine(marketRows, keyNum, isSideA);
      const keys = [...new Set(marketRows.map(keyNum))];
      selections = ladderWindow(keys, main, LADDER_RADIUS)
        .sort((a, b) => Math.abs(a) - Math.abs(b))
        .flatMap((K) => {
        const hr = marketRows.filter((r) => r.selection === home && (r.line ?? 0) === K);
        const ar = marketRows.filter((r) => r.selection === away && (r.line ?? 0) === -K);
        const isMain = K === main;
        return [
          {
            ...makeSelectionRow(books, `${home}_${K}`, `${home} ${signed(K)}`, hr, home),
            isMain,
            groupStart: true,
          },
          {
            ...makeSelectionRow(books, `${away}_${K}`, `${away} ${signed(-K)}`, ar, away),
            isMain,
          },
        ];
      });
    } else {
      // Moneyline: canonical [home, away], plus any extra outcome (e.g. Draw).
      // Guard against feeds that mislabel a goalscorer market as moneyline
      // (TAB does this) — those selections read "Name (TEAM)", which aren't H2H
      // outcomes and would otherwise pollute the grid with a row per player.
      const isPlayer = (s: string) => /\([A-Za-z]{2,4}\)\s*$/.test(s);
      const rowsFor = (sel: string) => marketRows.filter((r) => r.selection === sel);
      const extras = [...new Set(marketRows.map((r) => r.selection))].filter(
        (s) => s !== home && s !== away && !isPlayer(s),
      );
      selections = [
        makeSelectionRow(books, home, home, rowsFor(home), home),
        ...extras.map((ex) => makeSelectionRow(books, ex, ex, rowsFor(ex))),
        makeSelectionRow(books, away, away, rowsFor(away), away),
      ];
    }

    groups.push({ key: def.id, label: def.label, selections });
  }

  return { groups, books };
}
