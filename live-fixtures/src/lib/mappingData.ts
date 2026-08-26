// Client-side reader for the OPTIC ↔ bookmaker mappings produced by
// `npm run build-mapping`. Tables are populated server-side; UI is read-only.
//
// The `provider` column ('swift' | 'mybet') lets one OPTIC fixture map to more
// than one book. Every function defaults to 'swift' so existing call sites are
// unchanged; the mybet UI passes 'mybet'. The interface fields keep their
// `swift_*` names for continuity but hold whichever book `provider` selects
// (e.g. for provider='mybet', `swift_event_id` holds the mybet event id).

import { getSupabase } from './supabase'
import { prettyLeague, prettySport } from './sports'

export type Provider = 'swift' | 'mybet'

export interface CompetitionMapping {
  provider: Provider
  optic_sport: string
  optic_league: string
  /** The UNPRETTIFIED slug, exactly as stored — `aussierules_afl`. Needed to
   *  join against Fixture.rawLeague; `optic_league` above is prettified for
   *  display and matches nothing the fixture side holds. */
  optic_league_raw: string
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
  provider: Provider
  optic_fixture_id: string
  swift_event_id: string | null
  confidence: number
  source: 'auto' | 'manual'
  /** First-observed SWIFT inprogress moment — null until captured. SwiftBet
   *  only; mybet closes on the event's own `suspendAt` so this stays null. */
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

export async function fetchCompetitionMappings(provider: Provider = 'swift'): Promise<CompetitionMapping[]> {
  const out: CompetitionMapping[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from('competition_mapping')
      .select(
        'optic_sport,optic_league,optic_tournament,gutsy_sport,gutsy_competition,gutsy_competition_id,confidence,source,verified,verified_at',
      )
      .eq('provider', provider)
      // Ordered: a paged PostgREST read without one is not a stable slice —
      // rows shift between requests, so pages both repeat and DROP rows.
      .order('id', { ascending: true })
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
        provider,
        optic_sport: prettySport(r.optic_sport),
        optic_league: prettyLeague(r.optic_league),
        optic_league_raw: r.optic_league,
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
/**
 * Who decided a mapping, and therefore whether the offline matcher may revisit
 * it. 'manual' is STICKY: build-mapping preserves those rows and its
 * deleteAllAutoUnverified() pass skips them, so a wrong one survives forever.
 * 'auto' is disposable — the next matcher run wipes and re-derives it.
 *
 * A HUMAN pick (the pencil/editor) is 'manual'. A machine guess (the bulk
 * auto-map buttons) must be 'auto', even though it goes through this same
 * helper: writing those as 'manual' is how ~30 wrong rows became permanent and
 * invisible to every guard the matcher has — one book competition claiming
 * nine unrelated leagues across five countries.
 */
export type MappingSource = 'auto' | 'manual'

export async function setCompetitionMappingsManual(args: {
  opticSportRaw: string
  opticLeagueRaw: string
  opticTournamentRaw: string
  picks: SwiftPick[]
  provider?: Provider
  /** Defaults to 'manual' — the editor's case. Bulk auto-map passes 'auto'. */
  source?: MappingSource
}): Promise<void> {
  const provider = args.provider ?? 'swift'
  const sb = getSupabase()
  const { data: existing, error: readErr } = await sb
    .from('competition_mapping')
    .select('gutsy_competition_id')
    .eq('provider', provider)
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
      .eq('provider', provider)
      .eq('optic_sport', args.opticSportRaw)
      .eq('optic_league', args.opticLeagueRaw)
      .eq('optic_tournament', args.opticTournamentRaw)
      .eq('gutsy_competition_id', id)
    if (error) throw error
  }

  if (toInsert.length > 0) {
    const { error } = await sb.from('competition_mapping').upsert(
      toInsert.map((p) => ({
        provider,
        optic_sport: args.opticSportRaw,
        optic_league: args.opticLeagueRaw,
        optic_tournament: args.opticTournamentRaw,
        gutsy_sport: p.sport,
        gutsy_competition: p.name,
        gutsy_competition_id: p.id,
        confidence: 1,
        source: args.source ?? 'manual',
      })),
      { onConflict: 'provider,optic_sport,optic_league,optic_tournament,gutsy_competition_id' },
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
  provider?: Provider
}): Promise<void> {
  const provider = args.provider ?? 'swift'
  const sb = getSupabase()
  await sb
    .from('competition_mapping')
    .delete()
    .eq('provider', provider)
    .eq('optic_sport', args.opticSportRaw)
    .eq('optic_league', args.opticLeagueRaw)
    .eq('optic_tournament', args.opticTournamentRaw)
  const { error } = await sb.from('competition_mapping').insert({
    provider,
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
  provider?: Provider
}): Promise<void> {
  const { error } = await getSupabase()
    .from('competition_mapping')
    .update({
      verified: args.verified,
      verified_at: args.verified ? new Date().toISOString() : null,
    })
    .eq('provider', args.provider ?? 'swift')
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
  provider?: Provider
  /** See MappingSource — pass 'auto' from the bulk auto-map buttons. */
  source?: MappingSource
}): Promise<void> {
  const { error } = await getSupabase()
    .from('event_mapping')
    .upsert(
      {
        provider: args.provider ?? 'swift',
        optic_fixture_id: args.opticFixtureId,
        gutsy_event_id: args.swiftEventId,
        confidence: args.swiftEventId ? 1 : 0,
        source: args.source ?? 'manual',
      },
      { onConflict: 'provider,optic_fixture_id' },
    )
  if (error) throw error
}

/**
 * Event mappings for a KNOWN set of OPTIC fixtures.
 *
 * The whole-table `fetchEventMappings` below pulls 13.9k swift + 8.1k mybet
 * rows — ~22 sequential 1000-row pages before the mapping page can render, and
 * nothing aborts them when the effect re-runs. Only the drill view reads event
 * mappings, and it needs the handful of fixtures on screen, so it asks for
 * exactly those instead.
 *
 * Ids go in the URL, so they're chunked well under PostgREST's limit; chunks
 * run in parallel since there's no ordering between them.
 */
export async function fetchEventMappingsFor(
  opticFixtureIds: string[],
  provider: Provider = 'swift',
): Promise<EventMapping[]> {
  const ids = [...new Set(opticFixtureIds)].filter(Boolean)
  if (ids.length === 0) return []
  const CHUNK = 150
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const results = await Promise.all(
    chunks.map(async (slice) => {
      const { data, error } = await getSupabase()
        .from('event_mapping')
        .select('optic_fixture_id,gutsy_event_id,confidence,source,swift_actual_start')
        .eq('provider', provider)
        .in('optic_fixture_id', slice)
      if (error) throw error
      return (data as EventMappingRow[]) ?? []
    }),
  )
  return results.flat().map((r) => toEventMapping(r, provider))
}

type EventMappingRow = {
  optic_fixture_id: string
  gutsy_event_id: string | null
  confidence: number
  source: 'auto' | 'manual'
  swift_actual_start: string | null
}

function toEventMapping(r: EventMappingRow, provider: Provider): EventMapping {
  return {
    provider,
    optic_fixture_id: r.optic_fixture_id,
    swift_event_id: r.gutsy_event_id,
    confidence: r.confidence ?? 0,
    source: r.source ?? 'auto',
    swift_actual_start: r.swift_actual_start ?? null,
  }
}

// fetchEventMappings (whole-table, 32.6k rows / 33 paged requests) was removed:
// nothing called it. Callers use fetchEventMappingsFor(ids) for the fixtures
// actually on screen.

