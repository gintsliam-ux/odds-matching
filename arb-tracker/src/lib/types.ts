// Shape of a fixture as the "next to jump" board renders it. Layout-first
// contract — when the real Supabase tables are wired in, map their rows into
// this shape (or replace it with generated database.types).

export type EventStatus = 'upcoming' | 'live' | 'final' | 'cancelled';

export interface PeriodScore {
  period: number;
  home: number;
  away: number;
}

export interface League {
  id: string;
  name: string;
  /** Short code shown in the emblem badge, e.g. "EPL". */
  code: string;
  sport: string;
  /** Optional real crest URL; falls back to the code badge when absent. */
  logoUrl?: string;
  /**
   * True when the logo is a horizontal wordmark rather than a square crest
   * (the tennis tours). It needs a wider slot and a light chip behind it.
   */
  wordmark?: boolean;
}

export interface SportEvent {
  id: string;
  sport: string;
  league: League;
  /** Display name, typically "Home vs Away". */
  name: string;
  /** Extra context where the name isn't enough — tennis's tournament. */
  subtitle?: string;
  home: string;
  away: string;
  /** ISO-3166 alpha-2, lowercased — tennis players fly a flag, teams don't. */
  homeCountry?: string | null;
  awayCountry?: string | null;
  /** Live/final scores when available (null until the game has started). */
  homeScore?: number | null;
  awayScore?: number | null;
  /** Live game clock/period (from in_play). */
  period?: number | null;
  clock?: string | null;
  clockStopped?: boolean;
  /** Per-period score breakdown, ordered by period. */
  periodScores?: PeriodScore[];
  /** ISO timestamp of scheduled start. */
  startsAt: string;
  /** ISO end for multi-day events (golf tournaments span ~4 days). */
  endsAt?: string;
  /** True for outright markets (golf): a field of players, no two-sided match. */
  outright?: boolean;
  status: EventStatus;
}
