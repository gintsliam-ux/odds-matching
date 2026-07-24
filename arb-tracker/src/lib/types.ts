// Shape of a fixture as the "next to jump" board renders it. Layout-first
// contract — when the real Supabase tables are wired in, map their rows into
// this shape (or replace it with generated database.types).

export type EventStatus = 'upcoming' | 'live' | 'final';

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
}

export interface SportEvent {
  id: string;
  sport: string;
  league: League;
  /** Display name, typically "Home vs Away". */
  name: string;
  home: string;
  away: string;
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
  status: EventStatus;
}
