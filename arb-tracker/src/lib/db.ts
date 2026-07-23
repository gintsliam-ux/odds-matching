import { supabase } from './supabase';
import type { EventStatus, League, SportEvent } from './types';
import type { OddsRow } from './markets';

// Each competition is a pair of tables: <key>_events and <key>_odds.
// `league` is the competition (AFL/NRL); `sport` is its umbrella sport.
export interface SportConfig {
  key: string;
  league: string;
  sport: string;
  eventsTable: string;
  oddsTable: string;
}

export const SPORTS: SportConfig[] = [
  { key: 'afl', league: 'AFL', sport: 'Aussie Rules', eventsTable: 'afl_events', oddsTable: 'afl_odds' },
  { key: 'nrl', league: 'NRL', sport: 'Rugby League', eventsTable: 'nrl_events', oddsTable: 'nrl_odds' },
];

function configForLeagueId(leagueId: string): SportConfig | undefined {
  return SPORTS.find((s) => s.key === leagueId);
}

function leagueFor(cfg: SportConfig): League {
  return {
    id: cfg.key,
    name: cfg.league,
    code: cfg.league,
    sport: cfg.sport,
    logoUrl: `/logos/leagues/${cfg.key}.png`,
  };
}

const FINAL = new Set(['final', 'completed', 'complete', 'ended', 'finished', 'result']);
const LIVE = new Set(['live', 'in_play', 'inplay', 'playing', 'started']);

function mapStatus(raw: string | null): EventStatus {
  const t = (raw ?? '').toLowerCase();
  if (FINAL.has(t)) return 'final';
  if (LIVE.has(t)) return 'live';
  return 'upcoming';
}

interface EventRowDB {
  fixture_id: string;
  start_date: string;
  home_team: string;
  away_team: string;
  status: string | null;
}

/** Load fixtures from every sport's `_events` table and normalise them. */
export async function fetchAllEvents(): Promise<SportEvent[]> {
  if (!supabase) return [];
  const client = supabase;
  const perSport = await Promise.all(
    SPORTS.map(async (sp) => {
      const { data, error } = await client
        .from(sp.eventsTable)
        .select('fixture_id,start_date,home_team,away_team,status')
        .order('start_date', { ascending: true });
      if (error) throw new Error(`${sp.eventsTable}: ${error.message}`);
      return (data as EventRowDB[]).map<SportEvent>((r) => ({
        id: r.fixture_id,
        sport: sp.sport,
        league: leagueFor(sp),
        name: `${r.home_team} vs ${r.away_team}`,
        home: r.home_team,
        away: r.away_team,
        startsAt: r.start_date,
        status: mapStatus(r.status),
      }));
    }),
  );
  return perSport.flat();
}

/**
 * Load the odds rows for a single fixture. PostgREST caps a response at 1000
 * rows, and a fixture's full ladder can exceed that, so page until drained.
 */
export async function fetchOdds(event: SportEvent): Promise<OddsRow[]> {
  if (!supabase) return [];
  const sp = configForLeagueId(event.league.id);
  if (!sp) return [];

  const PAGE = 1000;
  const all: OddsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(sp.oddsTable)
      .select('market_id,selection,line,sportsbook,is_lay,current_price,open_price,status')
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
