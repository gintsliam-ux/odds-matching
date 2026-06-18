// Client-side reader for the OPTIC ↔ SWIFT mappings produced by
// `npm run build-mapping`. Tables are populated server-side; UI is read-only.

import { getSupabase } from './supabase'
import { prettyLeague, prettySport } from './sports'

export interface CompetitionMapping {
  optic_sport: string
  optic_league: string
  /** Tennis only: the season_type (tournament name). '' for other sports. */
  optic_tournament: string
  swift_sport: string | null
  swift_competition: string | null
  swift_competition_id: string | null
  confidence: number
  source: 'auto' | 'manual'
  /** Human-confirmed correct. Independent of source. */
  verified: boolean
  verified_at: string | null
}

export interface EventMapping {
  optic_fixture_id: string
  swift_event_id: string | null
  confidence: number
  source: 'auto' | 'manual'
  /** First-observed SWIFT inprogress moment — null until captured. */
  swift_actual_start: string | null
}

// Internal column names are still `gutsy_*` (table was created earlier); we
// project to `swift_*` so the rest of the app uses the user-facing brand.
type CompRow = {
  optic_sport: string
  optic_league: string
  optic_tournament: string | null
  gutsy_sport: string | null
  gutsy_competition: string | null
  gutsy_competition_id: string | null
  confidence: number
  source: 'auto' | 'manual'
  verified: boolean | null
  verified_at: string | null
}

export async function fetchCompetitionMappings(): Promise<CompetitionMapping[]> {
  const out: CompetitionMapping[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from('competition_mapping')
      .select(
        'optic_sport,optic_league,optic_tournament,gutsy_sport,gutsy_competition,gutsy_competition_id,confidence,source,verified,verified_at',
      )
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as CompRow[]
    for (const r of rows) {
      // Tennis rows must carry an optic_tournament — the league alone
      // (atp/wta/itf_*) is just a bucket. Skip stale league-only rows from
      // earlier matcher runs.
      if (r.optic_sport === 'tennis' && !(r as { optic_tournament?: string }).optic_tournament) continue
      // The build script stores raw slugs (`atp_challenger`,
      // `france_-_ligue_1`); the UI joins on the prettified versions used by
      // useSportUniverse() and Fixture, so normalize on read.
      // Translate '' (the unmapped sentinel) → null so consumer checks stay simple.
      const cid = r.gutsy_competition_id || null
      out.push({
        optic_sport: prettySport(r.optic_sport),
        optic_league: prettyLeague(r.optic_league),
        optic_tournament: r.optic_tournament ?? '',
        swift_sport: r.gutsy_sport,
        swift_competition: r.gutsy_competition,
        swift_competition_id: cid,
        confidence: r.confidence ?? 0,
        source: r.source ?? 'auto',
        verified: !!r.verified,
        verified_at: r.verified_at ?? null,
      })
    }
    if (rows.length < PAGE) break
  }
  return out
}

export interface SwiftPick {
  id: string
  name: string
  sport: string | null
}

/**
 * Replaces an OPTIC tournament's SWIFT mappings with the given set. Diffs
 * against existing rows: inserts new picks (source='manual', confidence=1),
 * deletes removed picks. If `picks` is empty, all existing mappings are
 * cleared and the auto-matcher will be free to re-add on next build-mapping.
 * Use `markUnmapped` to record a sticky "no mapping" instead.
 */
export async function setCompetitionMappingsManual(args: {
  opticSportRaw: string
  opticLeagueRaw: string
  opticTournamentRaw: string
  picks: SwiftPick[]
}): Promise<void> {
  const sb = getSupabase()
  const { data: existing, error: readErr } = await sb
    .from('competition_mapping')
    .select('gutsy_competition_id')
    .eq('optic_sport', args.opticSportRaw)
    .eq('optic_league', args.opticLeagueRaw)
    .eq('optic_tournament', args.opticTournamentRaw)
  if (readErr) throw readErr

  const existingIds = new Set((existing ?? []).map((r) => r.gutsy_competition_id))
  const pickedIds = new Set(args.picks.map((p) => p.id))
  // Identify rows to delete: everything currently there but no longer picked.
  // Also delete the '' sentinel row whenever we're inserting real picks.
  const toDelete = [...existingIds].filter((id) => !pickedIds.has(id) || (id === '' && args.picks.length > 0))
  const toInsert = args.picks.filter((p) => !existingIds.has(p.id))

  for (const id of toDelete) {
    const { error } = await sb
      .from('competition_mapping')
      .delete()
      .eq('optic_sport', args.opticSportRaw)
      .eq('optic_league', args.opticLeagueRaw)
      .eq('optic_tournament', args.opticTournamentRaw)
      .eq('gutsy_competition_id', id)
    if (error) throw error
  }

  if (toInsert.length > 0) {
    const { error } = await sb.from('competition_mapping').upsert(
      toInsert.map((p) => ({
        optic_sport: args.opticSportRaw,
        optic_league: args.opticLeagueRaw,
        optic_tournament: args.opticTournamentRaw,
        gutsy_sport: p.sport,
        gutsy_competition: p.name,
        gutsy_competition_id: p.id,
        confidence: 1,
        source: 'manual',
      })),
      { onConflict: 'optic_sport,optic_league,optic_tournament,gutsy_competition_id' },
    )
    if (error) throw error
  }
}

/** Sticky "no SWIFT mapping" — wipes existing rows and writes one '' sentinel
 *  with source='manual' so build-mapping won't re-pair it. */
export async function markUnmapped(args: {
  opticSportRaw: string
  opticLeagueRaw: string
  opticTournamentRaw: string
}): Promise<void> {
  const sb = getSupabase()
  await sb
    .from('competition_mapping')
    .delete()
    .eq('optic_sport', args.opticSportRaw)
    .eq('optic_league', args.opticLeagueRaw)
    .eq('optic_tournament', args.opticTournamentRaw)
  const { error } = await sb.from('competition_mapping').insert({
    optic_sport: args.opticSportRaw,
    optic_league: args.opticLeagueRaw,
    optic_tournament: args.opticTournamentRaw,
    gutsy_competition_id: '',
    confidence: 0,
    source: 'manual',
  })
  if (error) throw error
}

/**
 * Toggle the `verified` flag on a competition mapping. Independent of source —
 * a row can be auto+verified (human confirmed the matcher was right) or
 * manual+verified (human edited then confirmed). build-mapping.mjs preserves
 * any row where verified=true OR source='manual'.
 */
export async function setCompetitionVerified(args: {
  opticSportRaw: string
  opticLeagueRaw: string
  opticTournamentRaw: string
  /** Required when there are multiple mappings — targets a single row. */
  swiftCompetitionId: string
  verified: boolean
}): Promise<void> {
  const { error } = await getSupabase()
    .from('competition_mapping')
    .update({
      verified: args.verified,
      verified_at: args.verified ? new Date().toISOString() : null,
    })
    .eq('optic_sport', args.opticSportRaw)
    .eq('optic_league', args.opticLeagueRaw)
    .eq('optic_tournament', args.opticTournamentRaw)
    .eq('gutsy_competition_id', args.swiftCompetitionId)
  if (error) throw error
}

/** Upserts a manual event mapping (or clears it when swiftEventId is null). */
export async function setEventMappingManual(args: {
  opticFixtureId: string
  swiftEventId: string | null
}): Promise<void> {
  const { error } = await getSupabase()
    .from('event_mapping')
    .upsert(
      {
        optic_fixture_id: args.opticFixtureId,
        gutsy_event_id: args.swiftEventId,
        confidence: args.swiftEventId ? 1 : 0,
        source: 'manual',
      },
      { onConflict: 'optic_fixture_id' },
    )
  if (error) throw error
}

export async function fetchEventMappings(): Promise<EventMapping[]> {
  const out: EventMapping[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from('event_mapping')
      .select('optic_fixture_id,gutsy_event_id,confidence,source,swift_actual_start')
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows =
      (data as { optic_fixture_id: string; gutsy_event_id: string | null; confidence: number; source: 'auto' | 'manual'; swift_actual_start: string | null }[]) ?? []
    for (const r of rows) {
      out.push({
        optic_fixture_id: r.optic_fixture_id,
        swift_event_id: r.gutsy_event_id,
        confidence: r.confidence ?? 0,
        source: r.source ?? 'auto',
        swift_actual_start: r.swift_actual_start ?? null,
      })
    }
    if (rows.length < PAGE) break
  }
  return out
}
