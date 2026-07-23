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
  [...BOOKMAKERS, BETFAIR].map((b) => [b.id, b]),
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

// market_id -> display, in the order the grid shows them.
const MARKET_DEFS: { id: string; label: string }[] = [
  { id: 'moneyline', label: 'Head to Head' },
  { id: 'point_spread', label: 'Line' },
  { id: 'total_points', label: 'Total' },
  { id: '1st_half_moneyline', label: '1st Half — Head to Head' },
  { id: '1st_half_point_spread', label: '1st Half — Line' },
  { id: '1st_half_total_points', label: '1st Half — Total' },
];

const isTotals = (mid: string) => mid.includes('total');
const isSpread = (mid: string) => mid.includes('spread');

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
  key: string,
  label: string,
  groupRows: OddsRow[],
  team?: string,
): SelectionRow {
  const prices = BOOKMAKERS.map<PriceCell>((b) => ({
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

/**
 * Pick the main line for a spread/total: prefer a line/magnitude that has BOTH
 * sides priced, then the best-covered among those; fall back to best-covered.
 */
function pickMainLine(
  marketRows: OddsRow[],
  keyOf: (r: OddsRow) => string,
  bothSides: (rs: OddsRow[]) => boolean,
): OddsRow[] {
  const byLine = new Map<string, OddsRow[]>();
  for (const r of marketRows) {
    const k = keyOf(r);
    (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(r);
  }
  let best: OddsRow[] = [];
  let bestScore = -1;
  for (const [, rs] of byLine) {
    // Two-sided lines always outrank one-sided ones, then by book coverage.
    const score = (bothSides(rs) ? 1000 : 0) + coverage(rs);
    if (score > bestScore) {
      bestScore = score;
      best = rs;
    }
  }
  return best;
}

/**
 * Pivot a fixture's odds rows into the H2H → Line → Total (full + 1H) grid.
 * Spread/Total ladders collapse to a single best-covered "main line", and
 * every market always renders both canonical outcomes (missing side => "–").
 */
export function buildMarkets(rows: OddsRow[], home: string, away: string): MarketGroup[] {
  const groups: MarketGroup[] = [];

  for (const def of MARKET_DEFS) {
    const marketRows = rows.filter((r) => r.market_id === def.id);
    if (marketRows.length === 0) continue;

    const totals = isTotals(def.id);
    const spread = isSpread(def.id);
    let selections: SelectionRow[];

    if (totals) {
      const lineRows = pickMainLine(
        marketRows,
        (r) => `${r.line ?? ''}`,
        (rs) => rs.some((r) => isOver(r.selection)) && rs.some((r) => !isOver(r.selection)),
      );
      const L = lineRows[0]?.line ?? null;
      const suffix = L != null ? ` ${L}` : '';
      selections = [
        makeSelectionRow('over', `Over${suffix}`, lineRows.filter((r) => isOver(r.selection))),
        makeSelectionRow('under', `Under${suffix}`, lineRows.filter((r) => !isOver(r.selection))),
      ];
    } else if (spread) {
      const magRows = pickMainLine(
        marketRows,
        (r) => `${Math.abs(r.line ?? 0)}`,
        (rs) => rs.some((r) => r.selection === home) && rs.some((r) => r.selection === away),
      );
      const homeRows = magRows.filter((r) => r.selection === home);
      const awayRows = magRows.filter((r) => r.selection === away);
      const homeLine = homeRows[0]?.line ?? (awayRows[0]?.line != null ? -awayRows[0].line! : null);
      const awayLine = awayRows[0]?.line ?? (homeRows[0]?.line != null ? -homeRows[0].line! : null);
      selections = [
        makeSelectionRow(home, `${home}${homeLine != null ? ` ${signed(homeLine)}` : ''}`, homeRows, home),
        makeSelectionRow(away, `${away}${awayLine != null ? ` ${signed(awayLine)}` : ''}`, awayRows, away),
      ];
    } else {
      // Moneyline: canonical [home, away], plus any extra selection (e.g. Draw).
      const rowsFor = (sel: string) => marketRows.filter((r) => r.selection === sel);
      const extras = [...new Set(marketRows.map((r) => r.selection))].filter(
        (s) => s !== home && s !== away,
      );
      selections = [
        makeSelectionRow(home, home, rowsFor(home), home),
        ...extras.map((ex) => makeSelectionRow(ex, ex, rowsFor(ex))),
        makeSelectionRow(away, away, rowsFor(away), away),
      ];
    }

    groups.push({ key: def.id, label: def.label, selections });
  }

  return groups;
}
