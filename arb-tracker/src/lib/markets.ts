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

// Fixed-odds bookmaker columns. `id` matches the odds table `sportsbook`.
export const BOOKMAKERS: Bookmaker[] = [
  { id: 'bet365', name: 'Bet365', color: '#059669', mark: '365', logoUrl: '/logos/brands/bet365.png' },
  { id: 'sportsbet', name: 'Sportsbet', color: '#2563eb', mark: 'SP', logoUrl: '/logos/brands/sportsbet.png' },
  { id: 'ladbrokes_australia', name: 'Ladbrokes', color: '#dc2626', mark: 'LAD', logoUrl: '/logos/brands/ladbrokes_australia.png' },
  { id: 'pinnacle', name: 'Pinnacle', color: '#c81e1e', mark: 'PIN', logoUrl: '/logos/brands/pinnacle.png' },
];

const FANDUEL: Bookmaker = {
  id: 'fanduel',
  name: 'FanDuel',
  color: '#1493ff',
  mark: 'FD',
  logoUrl: '/logos/brands/fanduel.png',
};

// Columns are per-league so a brand that never prices a competition doesn't
// leave a dead column behind (FanDuel prices MLB, not the AU footy codes).
const LEAGUE_BOOKS: Record<string, Bookmaker[]> = {
  mlb: [...BOOKMAKERS, FANDUEL],
};

export function booksFor(leagueId: string): Bookmaker[] {
  return LEAGUE_BOOKS[leagueId] ?? BOOKMAKERS;
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
  [...BOOKMAKERS, FANDUEL, BETFAIR].map((b) => [b.id, b]),
);

export function brandById(id: string): Bookmaker | undefined {
  return BY_ID[id];
}

export interface PriceCell {
  bookId: string;
  price: number | null;
}

export interface SelectionRow {
  key: string;
  label: string;
  /** Team name when the selection is a team (H2H/Line), for its crest. */
  team?: string;
  prices: PriceCell[];
  /** Betfair exchange back/lay, null when the exchange doesn't cover it. */
  betfairBack: number | null;
  betfairLay: number | null;
  /** Best takeable price across fixed-odds books + Betfair back. */
  bestBookId: string | null;
  bestPrice: number | null;
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
}

// market_id -> display, in the order the grid shows them. `kind` drives the
// ladder shape, since the id naming differs per sport (point_spread/run_line).
type MarketKind = 'h2h' | 'spread' | 'total';
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

const LEAGUE_MARKETS: Record<string, MarketDef[]> = {
  mlb: MLB_MARKETS,
};

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function priceOf(rows: OddsRow[], bookId: string, isLay: boolean): number | null {
  for (const r of rows) {
    if (r.sportsbook === bookId && r.is_lay === isLay) {
      const p = r.current_price ?? r.open_price;
      if (p != null) return p;
    }
  }
  return null;
}

/** Betfair lay: the dedicated `_lay` sportsbook, or legacy is_lay rows. */
function betfairLayOf(rows: OddsRow[]): number | null {
  for (const r of rows) {
    if (r.sportsbook === BETFAIR_LAY_ID || (r.sportsbook === BETFAIR.id && r.is_lay)) {
      const p = r.current_price ?? r.open_price;
      if (p != null) return p;
    }
  }
  return null;
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
  const prices = books.map<PriceCell>((b) => ({
    bookId: b.id,
    price: priceOf(groupRows, b.id, false),
  }));
  const betfairBack = priceOf(groupRows, BETFAIR.id, false);
  const betfairLay = betfairLayOf(groupRows);

  let bestBookId: string | null = null;
  let bestPrice: number | null = null;
  const consider = (id: string, price: number | null) => {
    if (price != null && (bestPrice == null || price > bestPrice)) {
      bestPrice = price;
      bestBookId = id;
    }
  };
  for (const cell of prices) consider(cell.bookId, cell.price);
  consider(BETFAIR.id, betfairBack);

  return { key, label, team, prices, betfairBack, betfairLay, bestBookId, bestPrice };
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
export function buildMarkets(
  rows: OddsRow[],
  home: string,
  away: string,
  leagueId: string,
): MarketGroup[] {
  const groups: MarketGroup[] = [];
  const books = booksFor(leagueId);

  for (const def of LEAGUE_MARKETS[leagueId] ?? DEFAULT_MARKETS) {
    const marketRows = rows.filter((r) => r.market_id === def.id);
    if (marketRows.length === 0) continue;

    let selections: SelectionRow[];

    if (def.kind === 'total') {
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
      // Moneyline: canonical [home, away], plus any extra selection (e.g. Draw).
      const rowsFor = (sel: string) => marketRows.filter((r) => r.selection === sel);
      const extras = [...new Set(marketRows.map((r) => r.selection))].filter(
        (s) => s !== home && s !== away,
      );
      selections = [
        makeSelectionRow(books, home, home, rowsFor(home), home),
        ...extras.map((ex) => makeSelectionRow(books, ex, ex, rowsFor(ex))),
        makeSelectionRow(books, away, away, rowsFor(away), away),
      ];
    }

    groups.push({ key: def.id, label: def.label, selections });
  }

  return groups;
}
