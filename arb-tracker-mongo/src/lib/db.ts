import type { SportEvent } from './types';
import type { OddsRow } from './markets';

// The board reads the `gutsys_sport` Mongo database (fixtures / odds / entities)
// through this app's own API rather than talking to a database directly — Mongo
// has no browser client, and the fixture -> event derivation (league badges,
// crest + flag joins, the syn_/optic dedupe) is cheaper done once on the server
// than shipped to every tab. `server/lib/` holds that half.
//
// Every function below keeps the signature the components already call, so the
// UI is unchanged from the Supabase build.

const API = import.meta.env.VITE_API_BASE ?? '';

/**
 * Thrown when a route exists but this instance has no data behind it — a
 * deployed build reading the public odds surface has no bets or mapping tables.
 * Callers already have a catch path; this keeps them on it.
 */
export class FeatureUnavailableError extends Error {
  readonly feature: string;
  constructor(feature: string, detail?: string) {
    super(detail ?? `${feature} is not available on this instance`);
    this.name = 'FeatureUnavailableError';
    this.feature = feature;
  }
}

/** Shortest term the search will run — the rail keys its search mode off this. */
export const SEARCH_MIN_CHARS = 2;

/**
 * A GET that retries transient failures before giving up. The DB is shared with
 * the scrapers, so a heavy read can occasionally stall under write load — a
 * retry a beat later almost always succeeds, and beats blanking the whole board
 * on a single blip.
 */
async function apiGet<T>(path: string, init?: RequestInit, tries = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${API}${path}`, init);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      // A route whose data this instance cannot serve answers 200 with an
      // `unavailable` body — honest for a human reading it, but the wrong shape
      // for the caller, which is expecting a list. Turn it into a rejection so
      // the caller's existing error path handles it instead of mapping over an
      // object and taking the render down with it.
      if (body && typeof body === 'object' && body.error === 'unavailable') {
        throw new FeatureUnavailableError(body.feature ?? 'this feature', body.detail);
      }
      return body as T;
    } catch (err) {
      lastError = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const apiPost = <T>(path: string, body: unknown): Promise<T> =>
  apiGet<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Load every priceable fixture in the live window, normalised for the board. */
export const fetchAllEvents = (): Promise<SportEvent[]> =>
  apiGet<SportEvent[]>('/api/events');

/**
 * Fixtures for one local calendar day (YYYY-MM-DD), for browsing past dates that
 * fall outside the live window. Loaded on demand and merged into the board.
 */
export const fetchEventsForDay = (dateStr: string): Promise<SportEvent[]> =>
  apiGet<SportEvent[]>(`/api/events/day?date=${encodeURIComponent(dateStr)}`);

/**
 * One fixture by id, for a link that names an event the board isn't holding —
 * anything older than the rolling window, or filtered out of it. A URL is a
 * promise that it opens what it says, so the server ignores the filters here.
 */
export const fetchEventById = (fixtureId: string): Promise<SportEvent | null> =>
  fixtureId ? apiGet<SportEvent | null>(`/api/event?id=${encodeURIComponent(fixtureId)}`) : Promise.resolve(null);

/**
 * Team/player search over the whole fixtures archive — deliberately NOT scoped
 * to the board's sport/league/date filters, so "arsenal" finds Arsenal whatever
 * the rail is currently showing.
 */
export const searchEvents = (query: string): Promise<SportEvent[]> =>
  query.trim().length < SEARCH_MIN_CHARS
    ? Promise.resolve([])
    : apiGet<SportEvent[]>(`/api/search?q=${encodeURIComponent(query.trim())}`);

/** Load the odds rows for a single fixture (pregame only — in-play is excluded). */
export const fetchOdds = (event: SportEvent): Promise<OddsRow[]> =>
  // The sport rides along because the public odds surface is queried per sport;
  // the Mongo path ignores it.
  apiGet<OddsRow[]>(
    `/api/odds?fixtureId=${encodeURIComponent(event.id)}&sport=${encodeURIComponent(event.league.id)}`,
  );

/**
 * A bet still live on the book, beside what the market has done since.
 *
 * Everything the ticker shows, plus our OWN current price on the same
 * selection — which is the comparison the page exists for. `movePct` is the
 * change in implied probability from the price the customer took to the price
 * we show now, signed the way the movers page signs it: negative means the
 * price SHORTENED, which is a firmer and a position getting worse.
 */
export interface PendingBet extends TickerBet {
  /** Our current price on this selection, from the brand's own store. */
  ourNow: number | null;
  /** What we opened it at, for the bets taken after we had already moved. */
  ourOpen: number | null;
  /** When that brand event was last scraped. */
  ourAt: string | null;
  /**
   * Whose book that price is. The bet's own brand for swiftbet and mybet; for
   * a `multis` bet it reads `mybet`, because the two share one platform and one
   * event store — see the note in pending.mjs.
   */
  ourBook: 'swiftbet' | 'mybet' | null;
  /** The brand has pulled this selection — eliminated, or no longer trading. */
  ourSuspended: boolean;
  movePct: number | null;
  vsOpenPct: number | null;
  firmed: boolean;
  /**
   * Settled view only: where the market closed on this selection, de-vigged —
   * Pinnacle's close where it has one, else the blend of every book that closed
   * the whole market. `beatClose` is the customer having taken a longer price
   * than that, which is a price we should not have offered whatever the result.
   */
  closeFair?: number | null;
  closeFrom?: 'Pinnacle' | 'blend' | null;
  beatClose?: boolean;
  /**
   * Expected margin as a percentage of stake, against the closing fair, on the
   * same definition as the polytracker enrichment's `emPct`: price/fair - 1.
   * Positive means the customer had the edge, so it is the continuous form of
   * `beatClose` and can never disagree with it. `emPl` is the signed dollars.
   */
  emPct?: number | null;
  emPl?: number | null;
  /** The fair the matcher struck it against, and which market it resolved. */
  strikeFair?: number | null;
  emMethod?: string | null;
  emScore?: number | null;
  /**
   * Betfair starting price and its EM. RACING columns — no sport bet carries
   * one — so these are null on this view and the column only renders if a row
   * ever has one.
   */
  bsp?: number | null;
  bspEmPct?: number | null;
  bspEmPl?: number | null;
  /**
   * This view's own EM against the CLOSE, which the enrichment has no
   * equivalent of for sport: `blendFair` is struck near placement and its only
   * closing counterpart, `bsp`, is racing-only.
   */
  closeEmPct?: number | null;
}

export interface Pending {
  configured: boolean;
  bets: PendingBet[];
  counts: {
    open: number;
    judgeable: number;
    noOurPrice: number;
    noFieldPrice: number;
    /** Settled view: bets with no usable closing price to judge against. */
    noClose?: number;
    firmed: number;
    stake: number;
    firmedStake: number;
    /**
     * Settled view only — the window, sent by the server rather than restated
     * here. The page used to carry "the last 7 days" as literal text in two
     * places, which is a number that lies silently the moment the server's
     * constant changes.
     */
    days?: number;
    /** Oldest date actually covered (YYYY-MM-DD), which is the span we HAVE. */
    from?: string | null;
    /**
     * Fixtures priced, and fixtures abandoned to the time budget. Null on the
     * Mongo path, where the odds come from one query and no fixture costs a
     * request — so a null here means "not applicable", not "none".
     */
    fixtures?: number | null;
    dropped?: number;
    /** Window EM in dollars over every judgeable bet, and over the beats alone. */
    emPl?: number;
    beatEmPl?: number;
    /** How many judgeable rows the enrichment priced, and how many have a BSP. */
    withEm?: number;
    withBsp?: number;
  } | null;
  pricesError?: string;
}

/**
 * Open singles with our price beside the customer's, or settled ones with the
 * CLOSE beside it. Admin only; see ADMIN_ONLY.
 */
export const fetchPending = (view: 'open' | 'settled' = 'open'): Promise<Pending> =>
  apiGet<Pending>(`/api/pending${view === 'settled' ? '?view=settled' : ''}`);

/** Best (highest) H2H decimal price for each side of a fixture. */
export interface H2HPrices {
  home: number | null;
  away: number | null;
}

/**
 * Best moneyline price per side for a batch of fixtures, for the scoreboard
 * ticker. The id list goes in a POST body — a board-wide query string would
 * outrun the URL length limit.
 */
export async function fetchH2HPrices(): Promise<Map<string, H2HPrices>> {
  // A GET for the whole board rather than a POST of ids: the server already
  // knows what is on the board, the CDN can cache the answer, and deployment
  // protection refuses POSTs outright.
  //
  // It takes no parameters, which is the point: it used to be called with the
  // board's events and so waited for them, turning two independent requests
  // into a waterfall that cost the board load a second or more.
  const data = await apiGet<Record<string, H2HPrices>>('/api/h2h');
  return new Map(Object.entries(data));
}

/* ----------------------------------------------------------------- details */

/** One competitor as the fixture feed records them. */
export interface DetailCompetitor {
  name: string | null;
  side: string | null;
  id: string | null;
  country: string | null;
}

/** What we hold in `odds` for one fixture — the provenance half of the tab. */
export interface OddsCoverage {
  rows: number;
  liveRows: number;
  books: string[];
  markets: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}

/** How one provider maps this fixture, and what that provider holds for it. */
export interface ProviderEventMapping {
  mapped: boolean;
  link: {
    eventId: string | null;
    confidence: number | null;
    source: string | null;
    resolvedAt: string | null;
    /** Only the swift mapper records the jump it observed. */
    actualStart: string | null;
  } | null;
  event: {
    id: string;
    name: string | null;
    competition: string | null;
    competitionId: string | null;
    sport: string | null;
    /** Swiftbet only. */
    status?: string | null;
    viewStatus?: string | null;
    feedStatus?: string | null;
    finished?: boolean | null;
    startsAt?: string | null;
    finishedAt?: string | null;
    marketCount?: number | null;
    /** Mybet only — it has timestamps rather than a status. */
    feedId?: string | null;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
    lastChangedAt?: string | null;
    feedLastUpdated?: string | null;
    outcomeAt?: string | null;
    suspendAt?: string | null;
    teams: { name: string | null; side: string | null }[];
  } | null;
}

export interface FixtureMapping {
  configured: boolean;
  competitions: Record<'swift' | 'mybet', { id: string | null; name: string; confidence: number | null; source: string | null }[]>;
  swift: ProviderEventMapping;
  mybet: ProviderEventMapping;
}

export interface EventDetails {
  fixtureId: string;
  venue: string | null;
  location: string | null;
  country: string | null;
  season: string | null;
  seasonType: string | null;
  tier: number | null;
  broadcast: string | null;
  status: string | null;
  opticStatus: string | null;
  isLive: boolean;
  source: string | null;
  category: string | null;
  tournament: string | null;
  tournamentStage: string | null;
  opticLeague: string | null;
  opticLeagueId: string | null;
  currentRound: string | null;
  hasOdds: boolean;
  hasSp: boolean;
  competitors: DetailCompetitor[];
  /** How Swiftbet and Mybet see this same fixture. Null if the lookup failed. */
  mapping: FixtureMapping | null;
  times: {
    scheduledStart: string | null;
    actualStart: string | null;
    endDate: string | null;
    oddsOpenAt: string | null;
    oddsCloseAt: string | null;
    settledAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  coverage: OddsCoverage;
}

/**
 * The fixture fields the board has no use for, plus a summary of the odds we
 * hold. Loaded only when the Details tab is opened — 1800 board events do not
 * each need to carry a venue string.
 */
export const fetchEventDetails = (
  fixtureId: string,
  sport: string,
): Promise<EventDetails | null> =>
  fixtureId
    ? apiGet<EventDetails | null>(
        // The sport rides along for the same reason fetchOdds sends it: the
        // public odds surface is queried per sport.
        `/api/event/details?id=${encodeURIComponent(fixtureId)}&sport=${encodeURIComponent(sport)}`,
      )
    : Promise.resolve(null);

/* ------------------------------------------------------------------ ticker */

/** One single bet in the cross-sport feed, beside what the books were showing. */
export interface TickerBet {
  /** The bet document's own id — stable across a polled and a pushed copy. */
  id: string;
  /** The book's own bet reference, and who struck it. Shown truncated, copied whole. */
  betId: string | null;
  userId: string | null;
  brand: 'swiftbet' | 'mybet' | 'multis';
  placedAt: string | null;
  startsAt: string | null;
  sport: string | null;
  category: string | null;
  tournament: string | null;
  event: string | null;
  market: string | null;
  outcome: string | null;
  price: number | null;
  stake: number | null;
  bonus: boolean;
  /** Struck but refused by the book. Shown, not hidden. */
  rejected: boolean;
  fixtureId: string | null;
  /** The book's own event id, for linking back to their page. */
  eventId: string | null;
  /** Book -> best price on the same outcome; null when the market is one this
   *  board does not price, so a blank column is never mistaken for agreement. */
  prices: Record<string, number> | null;
  /**
   * The same outcome priced at 100% — the book's margin divided out across the
   * market, so these are always LONGER than anything quoted. `fairPinnacle` is
   * the reference book alone; `fairBlend` averages every book that prices the
   * whole market, over `fairBooks` of them. Null whenever the market was not
   * complete enough to divide honestly — see server/lib/fair.mjs.
   */
  fairPinnacle?: number | null;
  fairBlend?: number | null;
  fairBooks?: number;
  /**
   * The risk tag the book keeps against this bettor — "Monitor", "Good
   * client|Tier 4", "barring order". Empty when the book holds none.
   */
  tags: string[];
}

export interface TickerFeed {
  configured: boolean;
  bets: TickerBet[];
}

export const fetchTicker = (): Promise<TickerFeed> => apiGet<TickerFeed>('/api/ticker');

/**
 * Bets pushed as they are struck, off a Mongo change stream.
 *
 * `onBets` gets enriched rows, newest first — the same shape `/api/ticker`
 * returns, because the server enriches both through one function.
 *
 * `onDown` fires when the stream cannot be used at all (no source, or the
 * browser gave up reconnecting), so the caller can fall back to polling. It is
 * NOT called for an ordinary reconnect: a serverless host closes the response
 * when the function hits its duration cap, and EventSource reopens by itself.
 */
export function subscribeTicker(
  onBets: (bets: TickerBet[]) => void,
  onDown: () => void,
  onOpen?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    onDown();
    return () => {};
  }
  const es = new EventSource(`${API}/api/ticker/stream`);
  let closed = false;

  es.addEventListener('open', () => onOpen?.());
  es.addEventListener('bets', (ev) => {
    try {
      const bets = JSON.parse((ev as MessageEvent).data) as TickerBet[];
      if (Array.isArray(bets) && bets.length) onBets(bets);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  });
  // The server says so explicitly when there is no source to watch; without
  // this the browser would retry a stream that can never work.
  es.addEventListener('fatal', () => {
    closed = true;
    es.close();
    onDown();
  });
  es.addEventListener('error', () => {
    if (closed) return;
    if (es.readyState === EventSource.CLOSED) onDown();
  });

  return () => {
    closed = true;
    es.close();
  };
}

/* -------------------------------------------------------------------- bets */

/** One bet on this fixture, normalised across the three brands. */
export interface Bet {
  id: string;
  placedAt: string | null;
  /** Full account id — never truncated; the point is being able to look it up. */
  user: string | null;
  stake: number | null;
  price: number | null;
  selection: string | null;
  market: string | null;
  betType: string | null;
  legCount: number | null;
  bonus: boolean;
  result: string | null;
  /** Settled. `pl` is null until this is true — see server/lib/bets.mjs. */
  resolved: boolean;
  pl: number | null;
  /** Expected margin %, where the bet has been enriched. */
  em: number | null;
  /** The book's own event id and sport, for linking back to their page. */
  eventId?: string | null;
  sport?: string | null;
}

/** Why a brand's list is empty — "never mapped" and "nobody bet" differ. */
export type BetsReason = 'not-configured' | 'unmapped' | 'none' | null;

export interface BrandBets {
  bets: Bet[];
  reason: BetsReason;
}

export interface FixtureBets {
  configured: boolean;
  swiftbet: BrandBets;
  mybet: BrandBets;
  multis: BrandBets;
}

/**
 * Bets placed on this fixture, by brand. Lives on a different cluster from the
 * odds and is joined through `event_mapping`, so it is fetched only when the
 * Bets tab is opened.
 */
export const fetchBets = (fixtureId: string): Promise<FixtureBets> =>
  apiGet<FixtureBets>(`/api/bets?fixtureId=${encodeURIComponent(fixtureId)}`);

/* ------------------------------------------------------------ capabilities */

/**
 * What this instance can serve.
 *
 * A deployed build reads the public odds surface rather than `gutsys_sport`
 * directly, because that database is only reachable from the tailnet. The odds
 * survive the trip; the mapping tables, crests and per-price history do not. The
 * UI reads this and hides those features rather than rendering empty shells of
 * them — see server/lib/source.mjs.
 */
export interface Capabilities {
  source: 'mongo' | 'api' | 'none';
  odds: boolean;
  priceHistory: boolean;
  /** The point-by-point series behind the hover card's sparkline. */
  priceSeries: boolean;
  crests: boolean;
  bets: boolean;
  mapping: boolean;
  /** Whether mappings can be SAVED — false on a mirror-backed instance. */
  mappingWrite: boolean;
  history: boolean;
  pulse: boolean;
}

/** Assume the full feature set until told otherwise, so nothing flashes away. */
export const FULL_CAPABILITIES: Capabilities = {
  source: 'mongo', odds: true, priceHistory: true, priceSeries: true, crests: true,
  bets: true, mapping: true, mappingWrite: true, history: true, pulse: true,
};

export const fetchCapabilities = (): Promise<Capabilities> =>
  apiGet<Capabilities>('/api/capabilities');

/* ------------------------------------------------------------------ movers */

/** One book's price on a mover, and how far that book itself moved. */
export interface MoverBook {
  book: string;
  price: number;
  then: number | null;
  /** This book's own move, which marks it as having followed or not. */
  movePct: number | null;
  ageMins: number;
}

export interface Mover {
  fixtureId: string;
  name: string;
  sport: string;
  league: string | null;
  startsAt: string;
  market: string;
  selection: string;
  /** Median price across live books before and after. */
  then: number;
  now: number;
  /**
   * The move in implied PROBABILITY: (1/then - 1/now) * 100.
   *
   * A percentage of probability, not of the odds — 12.0 -> 10.0 is -16.7% of
   * the odds but only -1.67% of probability, while 1.831 -> 1.635 is -10.7% of
   * the odds and -6.55%.
   *
   * Always negative: only markets that SHORTENED are reported, because a drift
   * leaves the laggard holding the smaller price, which is no use to anyone.
   */
  movePct: number;
  books: MoverBook[];
  best: { book: string; price: number; movePct: number | null };
  /** Probability the best price gives away against the market now. */
  bestVsNowPct: number;
  /** And against where it sat BEFORE the move — the number that matters. */
  bestVsThenPct: number;
  /** The market shortened and the best price did not follow it. */
  lagging: boolean;
}

export interface Movers {
  window: string;
  thresholds: { minMove: number; minBooks: number; freshMins: number };
  counts: {
    markets: number;
    comparable: number;
    movers: number;
    lagging: number;
    staleRowsIgnored: number;
  };
  movers: Mover[];
}

export const fetchMovers = (q: {
  window?: string;
  minMove?: number;
  minBooks?: number;
} = {}): Promise<Movers> => {
  const p = new URLSearchParams();
  if (q.window) p.set('window', q.window);
  if (q.minMove != null) p.set('minMove', String(q.minMove));
  if (q.minBooks != null) p.set('minBooks', String(q.minBooks));
  const qs = p.toString();
  return apiGet<Movers>(`/api/movers${qs ? `?${qs}` : ''}`);
};

/* ----------------------------------------------------------------- mapping */

/** A provider competition proposed for an optic league. */
export interface MappingCandidate {
  id: string;
  name: string;
  /** The provider's other spelling, where it keeps one. */
  alt: string | null;
  sport: string | null;
  events: number | null;
  score: number;
  /** Share of the smaller squad the two competitions have in common. */
  overlap: number | null;
  /** 'teams' when squad overlap corroborated the name match. */
  confirmedBy: string | null;
  /** Another optic league proposes this same competition. */
  contested: boolean;
  contestedWith: number;
}

export interface MappingCurrent {
  id: string | null;
  name: string;
  confidence: number | null;
  source: string | null;
  verified: boolean;
  /** How many rows store this same mapping — >1 means redundant duplicates. */
  rows: number;
}

export interface MappingCell {
  /**
   * Every provider competition mapped to this league. One optic league maps to
   * MANY — `tennis_atp_challenger` spans 87 individual mybet tournaments, and
   * mybet carries both "UFC" and "UFC - Women" against the same MMA league.
   */
  currents: MappingCurrent[];
  suggestion: MappingCandidate | null;
  alternatives: MappingCandidate[];
  /** Evidence the mapping is working — null when there is nothing to judge on. */
  health: MappingHealth | null;
}

/**
 * Whether a mapping is actually producing event matches.
 *
 * A wrong competition mapping is indistinguishable from a right one here — same
 * name, same confidence, same verified tick — and quietly pairs none of its
 * fixtures. `suspect` is the downstream evidence: the book IS trading this
 * competition, and not one fixture matched.
 */
export interface MappingHealth {
  /** Optic fixtures in the window (−14d…+7d). */
  fixtures: number;
  /** How many paired to a book event. */
  matched: number;
  /** Events the book is trading in the mapped competition over the same window. */
  bookEvents: number;
  suspect: boolean;
}

export interface MappingLeague {
  opticLeague: string;
  sport: string;
  sportKey: string;
  category: string;
  tournament: string;
  /** Distinct tournaments the league's fixtures span; >1 means it is a tour. */
  tournamentCount: number;
  fixtures: number;
  providers: Record<'swift' | 'mybet', MappingCell>;
}

export interface MappingCounts {
  total: number;
  mapped: number;
  auto: number;
  review: number;
  none: number;
  candidates: number;
}

/** A provider competition as the Edit picker lists it. */
export interface MappingOption {
  id: string;
  name: string;
  alt: string | null;
  sport: string | null;
  /** Canonical sport key, for scoping the picker to one sport. */
  sportKey: string | null;
  events: number;
  /** Already mapped to some optic league. */
  used: boolean;
}

export interface TournamentMapping {
  configured: boolean;
  thresholds?: { auto: number; suggest: number };
  providers: Record<string, MappingCounts>;
  /** Every competition each provider knows, for picking one by hand. */
  candidates?: Record<'swift' | 'mybet', MappingOption[]>;
  leagues: MappingLeague[];
}

/**
 * The mapping table. Pass `fresh` after a write.
 *
 * This response is CDN-cached for five minutes, which is right for opening the
 * page — it is a 20-second read — and wrong immediately after saving: the
 * reload came back from cache without the change, so a successful Apply looked
 * like it had done nothing. A nonce makes the post-write reload a cache miss
 * while leaving the ordinary load cheap.
 */
export const fetchTournamentMapping = (fresh = false): Promise<TournamentMapping> =>
  apiGet<TournamentMapping>(
    `/api/mapping/tournaments${fresh ? `?t=${Date.now()}` : ''}`,
  );

export const saveTournamentMapping = (body: {
  opticLeague: string;
  provider: string;
  competitionId: string | null;
  competitionName: string;
  sport: string | null;
  confidence: number;
}): Promise<{ ok: boolean }> => apiPost('/api/mapping/tournament', body);

/** One mapping in a batch apply. */
export interface TournamentMappingItem {
  opticLeague: string;
  provider: string;
  competitionId: string | null;
  competitionName: string;
  sport: string | null;
  confidence: number;
}

/**
 * Apply many mappings in one request, across both providers. Written as a
 * single bulk upsert server-side, so the batch lands or doesn't.
 */
export const saveTournamentMappings = (
  items: TournamentMappingItem[],
): Promise<{ ok: boolean; applied: number; inserted: number; updated: number }> =>
  apiPost('/api/mapping/tournaments/apply', { items });

/** Remove one mapped competition, or all of them when `competitionId` is omitted. */
/* ------------------------------------------------------------- tab mapping */

/**
 * One TAB competition, and which optic league it feeds.
 *
 * A different shape from the tables above, on purpose. There one optic league
 * maps to many book competitions; here the mapping lives ON the TAB row as its
 * `opticLeague`, because that is the field the scraper reads to decide what to
 * fetch. A row with no `opticLeague` is a competition TAB offers that nobody is
 * capturing — and filling it is all that is needed, no scraper change.
 */
export interface TabCompetitionRow {
  /** Numeric for the seeded rows, an ObjectId hex string for scraped ones. */
  id: number | string;
  sport: string | null;
  tabSport: string | null;
  tabComp: string | null;
  opticLeague: string | null;
  confirmed: boolean;
  active: boolean;
  fixtures: number;
  lastSeen: string | null;
  suggestion: { opticLeague: string; name: string; score: number } | null;
  alternatives: { opticLeague: string; name: string; score: number }[];
}

export interface TabMapping {
  configured: boolean;
  thresholds: { auto: number; suggest: number };
  counts: { total: number; mapped: number; unmapped: number; suggested: number; auto: number };
  leagues: { opticLeague: string; sport: string; category: string; tournament: string }[];
  rows: TabCompetitionRow[];
}

export const fetchTabMapping = (): Promise<TabMapping> => apiGet<TabMapping>('/api/mapping/tab');

/** Point one TAB competition at a league, or pass null to clear it. */
export const saveTabMapping = (body: {
  id: number | string;
  opticLeague: string | null;
}): Promise<{ ok: boolean; id: number | string; opticLeague: string | null }> =>
  apiPost('/api/mapping/tab', body);

/**
 * Add a competition the scrape has never listed.
 *
 * Paste a TAB url and the sport and competition name come out of its path; or
 * give them directly. Nothing can verify the competition exists from here —
 * TAB blocks datacentre addresses — so the scrape is the verdict: a wrong name
 * never matches and the row stays at 0 fixtures, never seen.
 */
export const addTabCompetition = (body: {
  url?: string;
  tabSport?: string;
  tabComp?: string;
  sport?: string;
  opticLeague?: string | null;
}): Promise<{ ok: boolean; id: number | string; existed: boolean; mapped: boolean }> =>
  apiPost('/api/mapping/tab/add', body);

export const clearTournamentMapping = (body: {
  opticLeague: string;
  provider: string;
  competitionId?: string | null;
}): Promise<{ ok: boolean }> => apiPost('/api/mapping/tournament/clear', body);

/* ------------------------------------------------------------------- pulse */

/**
 * One heartbeat in the status bar: how long ago this source last moved.
 * `at` is null when we could not read it at all (which is its own signal).
 */
export interface Pulse {
  key: string;
  label: string;
  /** ISO timestamp of the most recent write we can see, or null. */
  at: string | null;
  /** Short qualifier shown beside the age, e.g. "44 live", "41/44". */
  detail?: string;
  /** Nothing to report rather than something wrong — renders grey, not red. */
  idle?: boolean;
  /** Minutes past which the dot turns amber, then red. */
  warn: number;
  stale: number;
}

/**
 * Freshness of the feeds the board is built from — the Optic fixture feed, the
 * two books whose prices anchor everything, and whether live scores are still
 * ticking. Scoped server-side to the fixtures about to jump, so it can sit on
 * the 60s poll (see server/lib/pulse.mjs).
 */
export const fetchPulse = (): Promise<Pulse[]> => apiGet<Pulse[]>('/api/pulse');

/* -------------------------------------------------------------- reference */

/** A row of the `books` reference table. */
export interface BookRow {
  book_key: string;
  display_name: string | null;
  region: string | null;
  is_exchange: boolean | null;
  active: boolean | null;
  aliases: string[] | null;
}

/** A row of the `leagues` reference table. */
export interface LeagueRow {
  optic_league: string;
  sport: string;
  category: string | null;
  tournament: string | null;
  active: boolean | null;
}

/** A row of the `market_rules` reference table. */
export interface MarketRuleRow {
  market_id: string;
  outcome_mode: string | null;
  note: string | null;
  ovr_base: number | null;
}

export interface Meta {
  books: BookRow[];
  leagues: LeagueRow[];
  marketRules: MarketRuleRow[];
}

/**
 * The reference tables `gutsys_sport` carries alongside the board. The UI ships
 * its own book order and market labels (the DB has no display order, and golf
 * prices a different column set), so nothing renders off this yet — it's the
 * hook for the tables that come next.
 */
export const fetchMeta = (): Promise<Meta> => apiGet<Meta>('/api/meta');

/* ------------------------------------------------- settlement & late bets */

export interface OpenBet {
  source: string;
  betId: string | null;
  userId: string | null;
  placedAt: string | null;
  stake: number | null;
  price: number | null;
  market: string | null;
  outcome: string | null;
}

export interface SettlementEvent {
  key: string;
  fixtureId: string | null;
  name: string | null;
  sport: string | null;
  tournament: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Minutes since Optic called the game finished. */
  waitingMins: number;
  stake: number;
  bets: OpenBet[];
}

export interface Settlement {
  configured: boolean;
  thresholds?: { minMins: number; windowHours: number };
  counts?: {
    events: number; bets: number; stake: number;
    openTotal: number; unjudgeable: number;
  };
  events: SettlementEvent[];
}

export interface LateBet {
  source: string;
  betId: string | null;
  userId: string | null;
  fixtureId: string | null;
  event: string | null;
  sport: string | null;
  market: string | null;
  outcome: string | null;
  placedAt: string | null;
  startedAt: string | null;
  afterMins: number;
  stake: number | null;
  price: number | null;
  settled: boolean;
  /** Optic still has it in play, so the market may be open right now. */
  stillLive: boolean | null;
}

export interface LateBets {
  configured: boolean;
  thresholds?: { afterMins: number; hours: number };
  counts?: {
    late: number; comparable: number; stake: number;
    stillLive: number; events: number;
  };
  bets: LateBet[];
}

export const fetchSettlement = (mins: number): Promise<Settlement> =>
  apiGet<Settlement>(`/api/settlement?mins=${mins}`);

export const fetchLateBets = ({ after, hours }: { after: number; hours: number }): Promise<LateBets> =>
  apiGet<LateBets>(`/api/late-bets?after=${after}&hours=${hours}`);
