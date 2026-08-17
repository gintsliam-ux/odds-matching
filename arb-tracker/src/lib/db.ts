import { supabase } from './supabase';
import type { EventStatus, League, PeriodScore, SportEvent } from './types';
import type { OddsRow } from './markets';

// Most competitions are a pair of tables: <key>_events and <key>_odds. Tennis
// is the exception — ATP and WTA share tennis_events/tennis_odds and are told
// apart by `category`, so a config can narrow a shared table with `where`.
// `league` is the competition (AFL/NRL); `sport` is its umbrella sport.
export interface SportConfig {
  key: string;
  league: string;
  sport: string;
  eventsTable: string;
  oddsTable: string;
  /** Narrows a shared events table to just this league's rows. */
  where?: { column: string; value: string };
  /** Extra events columns this table carries, e.g. tennis's `tournament`. */
  extraColumns?: string;
  /** Column whose value becomes the event's subtitle (tournament, competition). */
  subtitleColumn?: string;
}

export const SPORTS: SportConfig[] = [
  { key: 'afl', league: 'AFL', sport: 'Aussie Rules', eventsTable: 'afl_events', oddsTable: 'afl_odds' },
  { key: 'aflw', league: 'AFLW', sport: 'Aussie Rules', eventsTable: 'aflw_events', oddsTable: 'aflw_odds' },
  { key: 'nrl', league: 'NRL', sport: 'Rugby League', eventsTable: 'nrl_events', oddsTable: 'nrl_odds' },
  { key: 'mlb', league: 'MLB', sport: 'Baseball', eventsTable: 'mlb_events', oddsTable: 'mlb_odds' },
  { key: 'wnba', league: 'WNBA', sport: 'Basketball', eventsTable: 'wnba_events', oddsTable: 'wnba_odds' },
  { key: 'ufc', league: 'UFC', sport: 'MMA', eventsTable: 'ufc_events', oddsTable: 'ufc_odds' },
  // American football shares football_events across NFL + college, split by league.
  {
    key: 'nfl',
    league: 'NFL',
    sport: 'American Football',
    eventsTable: 'football_events',
    oddsTable: 'football_odds',
    where: { column: 'league', value: 'nfl' },
  },
  {
    key: 'ncaaf',
    league: 'NCAAF',
    sport: 'American Football',
    eventsTable: 'football_events',
    oddsTable: 'football_odds',
    where: { column: 'league', value: 'ncaaf' },
  },
  // Soccer is one umbrella; the specific competition rides in the subtitle.
  {
    key: 'soccer',
    league: 'Soccer',
    sport: 'Soccer',
    eventsTable: 'soccer_events',
    oddsTable: 'soccer_odds',
    extraColumns: 'league',
    subtitleColumn: 'league',
  },
  {
    key: 'atp',
    league: 'ATP',
    sport: 'Tennis',
    eventsTable: 'tennis_events',
    oddsTable: 'tennis_odds',
    where: { column: 'category', value: 'ATP' },
    extraColumns: 'tournament',
    subtitleColumn: 'tournament',
  },
  {
    key: 'wta',
    league: 'WTA',
    sport: 'Tennis',
    eventsTable: 'tennis_events',
    oddsTable: 'tennis_odds',
    where: { column: 'category', value: 'WTA' },
    extraColumns: 'tournament',
    subtitleColumn: 'tournament',
  },
];

function configForLeagueId(leagueId: string): SportConfig | undefined {
  return SPORTS.find((s) => s.key === leagueId);
}

// Words to fully uppercase rather than title-case in league/competition names.
const ACRONYMS = new Set(['usa', 'uae', 'uk', 'uefa', 'conmebol', 'efl', 'mls', 'dc', 'fc']);
const capWord = (w: string) =>
  !w ? w : ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
const capWords = (s: string) => s.split('_').map(capWord).join(' ');

/**
 * Human-readable subtitle. Slug-style values (soccer's "england_-_premier_league")
 * become "England · Premier League"; already-readable ones (tennis tournaments)
 * pass through untouched.
 */
function prettySubtitle(raw: string): string {
  if (!raw.includes('_')) return raw;
  return raw.split('_-_').map(capWords).join(' · ');
}

/** Split a soccer competition slug into its country and competition names. */
function competitionParts(slug: string): { country: string; competition: string } {
  const parts = slug.split('_-_');
  return parts.length >= 2
    ? { country: capWords(parts[0]), competition: capWords(parts.slice(1).join('_-_')) }
    : { country: '', competition: capWords(slug) };
}

/**
 * The league shown on the badge. Soccer is special: `id` stays 'soccer' (so
 * markets/books still resolve), but the name and logo come from the specific
 * competition, so an EPL game shows the Premier League crest, not a generic ball.
 */
function leagueFor(cfg: SportConfig, competition?: string | null): League {
  if (cfg.key === 'soccer' && competition) {
    const { competition: name } = competitionParts(competition);
    return {
      id: 'soccer',
      name,
      code: 'SOC',
      sport: 'Soccer',
      logoUrl: `/logos/soccer/${competition}.png`,
    };
  }
  return {
    id: cfg.key,
    name: cfg.league,
    code: cfg.league,
    sport: cfg.sport,
    logoUrl: `/logos/leagues/${cfg.key}.png`,
    wordmark: cfg.sport === 'Tennis',
  };
}

const FINAL = new Set(['final', 'completed', 'complete', 'ended', 'finished', 'result']);
const LIVE = new Set(['live', 'in_play', 'inplay', 'playing', 'started']);
// Off — the game isn't happening. Must be caught here, otherwise a cancelled
// fixture whose start time has passed gets treated as live (see effectiveStatus).
const CANCELLED = new Set(['cancelled', 'canceled', 'postponed', 'abandoned', 'walkover']);

function mapStatus(raw: string | null): EventStatus {
  const t = (raw ?? '').toLowerCase();
  if (FINAL.has(t)) return 'final';
  if (LIVE.has(t)) return 'live';
  if (CANCELLED.has(t)) return 'cancelled';
  return 'upcoming';
}

interface PeriodBag {
  periods?: Record<string, number> | null;
}
const EVENT_COLUMNS =
  'fixture_id,start_date,home_team,away_team,status,home_score,away_score,scores,in_play';

interface EventRowDB {
  fixture_id: string;
  start_date: string;
  home_team: string;
  away_team: string;
  status: string | null;
  /** Optional subtitle sources: tennis's tournament, soccer's competition. */
  tournament?: string | null;
  league?: string | null;
  home_score: number | null;
  away_score: number | null;
  scores: { home?: PeriodBag | null; away?: PeriodBag | null } | null;
  in_play: {
    clock?: string | null;
    period_number?: number | null;
    period?: string | number | null;
    is_clock_stopped?: boolean | null;
  } | null;
}

/** Merge home/away period maps into an ordered per-period breakdown. */
function periodScoresFrom(scores: EventRowDB['scores']): PeriodScore[] {
  const hp = scores?.home?.periods ?? {};
  const ap = scores?.away?.periods ?? {};
  const nums = new Set<number>();
  for (const k of [...Object.keys(hp), ...Object.keys(ap)]) {
    const m = /period_(\d+)/.exec(k);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums]
    .sort((a, b) => a - b)
    .map((n) => ({ period: n, home: hp[`period_${n}`] ?? 0, away: ap[`period_${n}`] ?? 0 }));
}

/**
 * Player -> ISO country for tennis flags, keyed by the name exactly as the odds
 * feed spells it. Populated out of band by scripts/resolve-player-countries.mjs;
 * an empty map (table not migrated yet) just means no flags, never an error.
 */
async function playerCountries(
  client: NonNullable<typeof supabase>,
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from('tennis_player_countries')
    .select('player_name,country_iso2');
  if (error || !data) return new Map();
  return new Map(
    (data as { player_name: string; country_iso2: string }[]).map((r) => [
      r.player_name,
      r.country_iso2,
    ]),
  );
}

/** Load fixtures from every sport's `_events` table and normalise them. */
export async function fetchAllEvents(): Promise<SportEvent[]> {
  if (!supabase) return [];
  const client = supabase;
  const countries = await playerCountries(client);
  const perSport = await Promise.all(
    SPORTS.map(async (sp) => {
      let q = client
        .from(sp.eventsTable)
        .select(sp.extraColumns ? `${EVENT_COLUMNS},${sp.extraColumns}` : EVENT_COLUMNS);
      if (sp.where) q = q.eq(sp.where.column, sp.where.value);

      const { data, error } = await q.order('start_date', { ascending: true });
      if (error) throw new Error(`${sp.eventsTable}: ${error.message}`);
      // The column list is built at runtime, so postgrest-js can't infer the
      // row shape from it — EventRowDB is the contract instead.
      return (data as unknown as EventRowDB[]).map<SportEvent>((r) => {
        const ip = r.in_play ?? {};
        const period =
          ip.period_number ?? (ip.period != null ? Number(ip.period) : null);
        return {
          id: r.fixture_id,
          sport: sp.sport,
          league: leagueFor(sp, r.league),
          name: `${r.home_team} vs ${r.away_team}`,
          // Soccer's competition is now the badge/name, so its subtitle is just
          // the country (disambiguates e.g. Italy vs Brazil "Serie A").
          subtitle:
            sp.key === 'soccer'
              ? competitionParts(String(r.league ?? '')).country || undefined
              : (() => {
                  const raw = sp.subtitleColumn
                    ? (r as unknown as Record<string, unknown>)[sp.subtitleColumn]
                    : null;
                  return raw ? prettySubtitle(String(raw)) : undefined;
                })(),
          home: r.home_team,
          away: r.away_team,
          homeCountry: countries.get(r.home_team) ?? null,
          awayCountry: countries.get(r.away_team) ?? null,
          homeScore: r.home_score,
          awayScore: r.away_score,
          period: Number.isFinite(period) ? (period as number) : null,
          clock: ip.clock ?? null,
          clockStopped: ip.is_clock_stopped ?? false,
          periodScores: periodScoresFrom(r.scores),
          startsAt: r.start_date,
          status: mapStatus(r.status),
        };
      });
    }),
  );
  const golf = await fetchGolfEvents(client);
  return [...perSport.flat(), ...golf];
}

// Golf is outright-only: a tournament (from golf_tournaments) with a field of
// players priced to win (golf_outrights). It has no two-sided fixture, so it's
// synthesised into a SportEvent rather than read from an `_events` table.
const GOLF_TABLE = 'golf_outrights';
const TOURNAMENT_DAYS = 4; // Thu–Sun

// Each tournament carries its tour (PGA, LIV, …). The league id stays 'golf' so
// markets/books still resolve, but the name/badge come from the tour.
function golfLeague(tour: string | null): League {
  const name = (tour ?? 'Golf').toUpperCase();
  return {
    id: 'golf',
    name,
    code: name,
    sport: 'Golf',
    logoUrl: `/logos/leagues/golf-${name.toLowerCase()}.png`,
  };
}

// Every column optional — golf_tournaments' schema is still evolving, so we read
// defensively rather than pin a fixed shape (see the `select('*')` note below).
interface GolfTournamentRow {
  tournament_id?: string;
  name?: string;
  start_date?: string;
  end_date?: string | null;
  status?: string | null;
  league?: string | null;
  current_round?: string | null;
}

/** One synthetic SportEvent per golf tournament that currently has odds. */
async function fetchGolfEvents(
  client: NonNullable<typeof supabase>,
): Promise<SportEvent[]> {
  const [odds, tourneys] = await Promise.all([
    client.from(GOLF_TABLE).select('tournament_id'),
    // `select('*')` (not a fixed column list) so a dropped/renamed column just
    // yields an absent field instead of erroring the query and dropping golf
    // from the whole board.
    client.from('golf_tournaments').select('*'),
  ]);
  if (odds.error || tourneys.error || !odds.data || !tourneys.data) return [];

  const withOdds = new Set((odds.data as { tournament_id: string }[]).map((r) => r.tournament_id));
  return (tourneys.data as GolfTournamentRow[])
    .filter((t): t is GolfTournamentRow & { tournament_id: string; start_date: string } =>
      Boolean(t.tournament_id && withOdds.has(t.tournament_id) && t.start_date),
    )
    .map((t) => {
      // Prefer the real end_date; fall back to a 4-day span when it's missing.
      const endsAt =
        t.end_date ??
        new Date(
          new Date(t.start_date).getTime() + (TOURNAMENT_DAYS - 1) * 24 * 60 * 60 * 1000,
        ).toISOString();
      const name = t.name ?? 'Golf Tournament';
      return {
        id: t.tournament_id,
        sport: 'Golf',
        league: golfLeague(t.league ?? null),
        name,
        home: name,
        away: '',
        startsAt: t.start_date,
        endsAt,
        outright: true,
        round: t.current_round ?? null,
        status: mapStatus(t.status ?? null),
      };
    });
}

/** Best (highest) H2H decimal price for each side of a fixture. */
export interface H2HPrices {
  home: number | null;
  away: number | null;
}

/**
 * Best moneyline price per side for a batch of fixtures, for the scoreboard
 * ticker. Unlike fetchOdds this pulls only the `moneyline` market across many
 * fixtures at once (one query per odds table), so a whole day's prices is a
 * couple of small requests rather than a full ladder per event.
 */
export async function fetchH2HPrices(
  events: SportEvent[],
): Promise<Map<string, H2HPrices>> {
  const out = new Map<string, H2HPrices>();
  if (!supabase || events.length === 0) return out;
  const client = supabase;

  // Group by odds table (tennis's ATP/WTA share one), keeping a name lookup so
  // a selection string can be resolved back to home/away.
  const byTable = new Map<string, SportEvent[]>();
  for (const e of events) {
    const sp = configForLeagueId(e.league.id);
    if (!sp) continue;
    (byTable.get(sp.oddsTable) ?? byTable.set(sp.oddsTable, []).get(sp.oddsTable)!).push(e);
  }

  await Promise.all(
    [...byTable.entries()].map(async ([table, evs]) => {
      const byId = new Map(evs.map((e) => [e.id, e]));
      const ids = evs.map((e) => e.id);
      // Chunk the id list so the `in.()` filter can't blow the URL length.
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await client
          .from(table)
          .select('fixture_id,selection,is_lay,current_price,open_price')
          .eq('market_id', 'moneyline')
          .in('fixture_id', ids.slice(i, i + 100));
        if (error || !data) continue;
        for (const r of data as {
          fixture_id: string;
          selection: string;
          is_lay: boolean;
          current_price: number | null;
          open_price: number | null;
        }[]) {
          if (r.is_lay) continue;
          const price = r.current_price ?? r.open_price;
          const ev = byId.get(r.fixture_id);
          if (price == null || !ev) continue;
          const cur = out.get(r.fixture_id) ?? { home: null, away: null };
          if (r.selection === ev.home) cur.home = Math.max(cur.home ?? 0, price);
          else if (r.selection === ev.away) cur.away = Math.max(cur.away ?? 0, price);
          out.set(r.fixture_id, cur);
        }
      }
    }),
  );
  return out;
}

/**
 * Load the odds rows for a single fixture. PostgREST caps a response at 1000
 * rows, and a fixture's full ladder can exceed that, so page until drained.
 */
export async function fetchOdds(event: SportEvent): Promise<OddsRow[]> {
  if (!supabase) return [];
  if (event.league.id === 'golf') return fetchGolfOdds(supabase, event.id);

  const sp = configForLeagueId(event.league.id);
  if (!sp) return [];

  const PAGE = 1000;
  const all: OddsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(sp.oddsTable)
      .select(
        'market_id,selection,line,sportsbook,is_lay,current_price,open_price,status,flucs,open_at,price_6h,price_3h,price_1h,price_30m,price_10m,close_price,current_at,daily_prices',
      )
      .eq('fixture_id', event.id)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${sp.oddsTable}: ${error.message}`);
    const rows = data as OddsRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** Outright rows for one golf tournament — keyed by tournament_id, no `line`. */
async function fetchGolfOdds(
  client: NonNullable<typeof supabase>,
  tournamentId: string,
): Promise<OddsRow[]> {
  const PAGE = 1000;
  const all: OddsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    // `select('*')` (not a fixed list) so a dropped/renamed price column just
    // yields an absent field rather than erroring the whole outright.
    const { data, error } = await client
      .from(GOLF_TABLE)
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${GOLF_TABLE}: ${error.message}`);
    // golf_outrights has no `line` column — the market has no handicap.
    const rows = (data as Partial<OddsRow>[]).map((r) => ({ ...r, line: null }) as OddsRow);
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
