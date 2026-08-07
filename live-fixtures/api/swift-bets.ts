// POST /api/swift-bets — return SwiftBet bets that include this game as a leg.
//
// Two joins, tried together:
//
//  1. event_id (exact). Each entry in the `legs` JSON now carries `event_id`, the
//     SwiftBet event UUID — the same value as `gutsy.events._id`, i.e. the
//     `swift_event_id` the mapping already holds. When the caller passes it we
//     match on that directly: no name normalization, and no doubleheader
//     ambiguity. Only bets scraped since ~2026-07-01 have the field, though
//     (~1.2% of 2026 non-racing bets), so it cannot stand alone yet.
//
//  2. event_key slug (fallback). `derived.event_key` / `derived.legs_event_keys`
//     hold strings like `mlb/2026-06-16/new-york-yankees-vs-chicago-white-sox`
//     computed by the enrichment pipeline. This covers the whole history and
//     remains the join for every bet without an `event_id`.
//
// `legs` is a JSON *string*, not a BSON array, so the event_id branch is a
// substring regex rather than an $elemMatch — the indexed `bet_date` window in
// front of it keeps the scan bounded.
//
// Body:
//   { date: "YYYY-MM-DD",            // event date (gutsy.events.start_date prefix)
//     home: "New York Yankees",       // home team name
//     away: "Chicago White Sox",      // away team name
//     swiftEventId?: string,          // gutsy.events._id — enables the exact join
//     swiftActualStart?: string }     // ISO timestamp; bets with bet_time > this are flagged
//
// Response:
//   { bets: BetRow[], matchPattern: string }   // each bet carries matched_by: 'event_id' | 'slug'

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI
const MONGO_DB = process.env.MONGO_DB ?? 'gutsy'
const BETS_COLL = process.env.MONGO_BETS_COLL ?? 'bets'

let clientPromise: Promise<MongoClient> | null = null
function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) throw new Error('MONGO_URI not set')
  if (clientPromise) return clientPromise
  return (clientPromise = new MongoClient(MONGO_URI, { maxPoolSize: 4 }).connect())
}

function slug(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface LegSelection {
  market: string | null
  // Structured market type (e.g. "Total Goals Over / Under", "Match winner") —
  // used to classify the market for client-side score settlement. Display still
  // uses `market` (market_name); market_type alone mislabels some h2h cases.
  mt: string | null
  outcome: string | null
  odds: number | null
  status: string | null
}

export interface MatchedLeg extends LegSelection {
  // Every selection inside the leg that IS this game. A single/normal-multi leg
  // has exactly one; a Same Game Multi (SGM) has several (each a market/outcome
  // on the same game), and `odds` here is the SGM's combined price.
  selections: LegSelection[]
}

/**
 * Pull the leg-specific market / outcome / price for the leg that IS this game,
 * from the raw `legs` JSON (a stringified array, one entry per leg, in the same
 * order as `legs_event_keys`). For a single this is just leg 0. An SGM is one
 * leg with many selections — we return all of them so the UI can expand.
 */
/** `legs` is stored as a JSON string; parse it once per bet. */
function parseLegs(legsRaw: unknown): unknown[] | null {
  let legs: unknown
  try {
    legs = typeof legsRaw === 'string' ? JSON.parse(legsRaw) : legsRaw
  } catch {
    return null
  }
  return Array.isArray(legs) ? legs : null
}

/** Index of the leg whose `event_id` is this SWIFT event, or -1. Exact — no
 *  team-name or date fuzziness, and it separates same-teams doubleheaders. */
// ---------------------------------------------------------------------------
// Outright: joining by tournament rather than by event id.
//
// The event-id join only reaches bets whose leg carries THIS `gutsy.events._id`,
// which means: the tournament must still be a live event in gutsy.events, it
// must be mapped, and the bet must be an outright single. It therefore missed
// two whole families — every bet on a finished tournament (SwiftBet prunes the
// event, so the id resolves to nothing) and every 2-Ball/3-Ball matchup, whose
// legs point at the pairing rather than the tournament. On Wyndham 2026 that
// was 7 of 14 bets.
//
// `derived.event_tournament` survives both: it is stamped on the bet at
// enrichment and is indexed (derived_event_sport_tournament). It is a book name
// though, not OPTIC's — SwiftBet says "Rocket Mortgage Classic" where OPTIC says
// "Rocket Classic 2026" — so we read the tournaments actually present in the
// window and pick the ones that match, rather than guessing a string.
const GENERIC_TOURNAMENT_WORDS = new Set([
  'championship', 'championships', 'open', 'classic', 'invitational', 'tournament',
  'cup', 'golf', 'international', 'presented', 'by', 'the', 'of', 'and', 'tour',
])

function tourTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ') // the year lives in OPTIC's name, not the book's
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
}

/**
 * Does `candidate` (the book's tournament) name the same event as `optic`?
 *
 * Normally: every one of OPTIC's words must appear, and at least one of them
 * must be distinctive. "Rocket Classic" ⊂ "Rocket Mortgage Classic" passes on
 * "rocket"; "Wyndham Championship" vs "The Open Championship" fails, since
 * pairing on "championship" alone would marry unrelated events.
 *
 * Some tournaments are named entirely out of the generic words, though — "The
 * Open Championship" has no distinctive token at all. Those must match exactly,
 * because the subset rule alone would happily swallow them into "The Senior
 * Open Championship presented by Rolex".
 *
 * A distinctive token also has to be a real word: "U.S. Open" tokenises to
 * [u, s, open], and counting "u"/"s" as distinctive made it a subset of "U.S.
 * Women's Open presented by Ally", folding that event's bets in (2 of them into
 * the U.S. Open's 142 for the 2025 window — small, but wrong, and the shape of
 * the error grows with the field). Requiring 3+ characters pushes the name onto
 * the exact-match branch instead. "3M Open" lands there too and matches itself.
 */
const MIN_DISTINCTIVE_LEN = 3

function sameTournament(optic: string, candidate: string): boolean {
  const a = tourTokens(optic)
  const bTokens = tourTokens(candidate)
  const b = new Set(bTokens)
  if (!a.length || !b.size) return false
  const distinctive = (t: string) => t.length >= MIN_DISTINCTIVE_LEN && !GENERIC_TOURNAMENT_WORDS.has(t)
  if (!a.some(distinctive)) {
    return a.length === bTokens.length && a.every((t, i) => t === bTokens[i])
  }
  if (!a.every((t) => b.has(t))) return false
  return true
}

function legIndexByEventId(legs: unknown[] | null, swiftEventId: string | null): number {
  if (!legs || !swiftEventId) return -1
  return legs.findIndex((l) => (l as { event_id?: unknown } | undefined)?.event_id === swiftEventId)
}

function extractLeg(legs: unknown[] | null, index: number): MatchedLeg | null {
  if (index < 0 || !legs) return null
  const leg = legs[index] as
    | { dividend?: unknown; selections?: Array<{ fixed_odds?: unknown; status?: unknown; selection_data?: Array<{ market_name?: unknown; market_type?: unknown; name?: unknown }> }> }
    | undefined
  if (!leg) return null
  // Decimal odds are always > 1; singles store 0 in the leg dividend (the real
  // price is the bet's top-level `odd`), so treat ≤1 as missing → UI falls back.
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : null)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  // market_name is the project's source-of-truth for the market (market_type
  // mislabels some h2h/DNB cases); fall back to market_type only if absent.
  const rawSels = Array.isArray(leg.selections) ? leg.selections : []
  const selections: LegSelection[] = rawSels.map((sel) => {
    const sd = Array.isArray(sel?.selection_data) ? sel.selection_data[0] : null
    return {
      market: str(sd?.market_name) ?? str(sd?.market_type),
      mt: str(sd?.market_type),
      outcome: str(sd?.name),
      odds: num(sel?.fixed_odds),
      status: str(sel?.status),
    }
  })
  const first = selections[0] ?? { market: null, mt: null, outcome: null, odds: null, status: null }
  return {
    market: first.market,
    mt: first.mt,
    outcome: first.outcome,
    // Headline odds: the leg dividend (the SGM's combined price), else the lone
    // selection's price.
    odds: num(leg.dividend) ?? first.odds,
    status: first.status,
    selections,
  }
}

/**
 * `bet_time` in gutsy.bets is Melbourne wall-clock with a misleading `Z`
 * suffix. To compare against UTC timestamps (swift_actual_start) we strip
 * the Z and tag the wall-clock with the correct Australia/Sydney offset for
 * that date — +10 (AEST) outside DST, +11 (AEDT) during DST. Intl confirms
 * the offset round-trip.
 */
function melbWallToUtc(raw: string | Date): Date | null {
  if (!raw) return null
  // Mongo BSON Date arrives as a Date object; normalize to an ISO string.
  const s = raw instanceof Date ? raw.toISOString() : String(raw)
  const wall = s.endsWith('Z') ? s.slice(0, -1) : s
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(wall)
  if (!m) return null
  const trial = new Date(`${wall}+10:00`)
  if (isNaN(trial.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(trial)
  const get = (t: string) => parts.find((p) => p.type === t)?.value
  if (get('year') === m[1] && get('hour') === m[4]) return trial
  return new Date(`${wall}+11:00`)
}

/** The matched leg's own event_time (epoch ms) — used to pin a bet to the
 *  correct game when the same teams play more than once in the window. */
function legEventTimeMs(legs: unknown[] | null, index: number): number | null {
  if (index < 0 || !legs) return null
  const et = (legs[index] as { event_time?: unknown } | undefined)?.event_time
  const t = typeof et === 'string' ? Date.parse(et) : NaN
  return Number.isFinite(t) ? t : null
}

// Same-teams doubleheaders/series share a date+teams slug. A bet's leg
// event_time matches OPTIC's scheduled_start, so keep only bets within this of
// the fixture's scheduled start — wide enough for reschedules, tight enough to
// separate a day-night doubleheader.
const SAME_GAME_TOLERANCE_MS = 3 * 60 * 60 * 1000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      date?: string
      home?: string
      away?: string
      swiftEventId?: string
      swiftActualStart?: string
      scheduledStart?: string
      /** OUTRIGHT: OPTIC's tournament name, e.g. "Wyndham Championship 2026". */
      tournament?: string
      /** OUTRIGHT: the BOOK's name for it, from the competition mapping. OPTIC
       *  calls LIV's Bedminster stop "New York 2026" and SwiftBet calls it "LIV
       *  Golf Invitational Bedminster" — names with nothing in common, so no
       *  amount of token matching bridges them. The mapping already knows. */
      tournamentAlias?: string
      /** OUTRIGHT: `derived.event_sport`, e.g. "Golf". Scopes the tournament scan. */
      eventSport?: string
    }
    // Guard the regex: only a well-formed UUID goes into the `legs` substring
    // match, so a hostile/garbled id can't inject pattern syntax.
    const swiftEventId =
      typeof body.swiftEventId === 'string' && /^[0-9a-f-]{36}$/i.test(body.swiftEventId)
        ? body.swiftEventId
        : null
    // OUTRIGHT MODE. A golf tournament has no two competitors, so there is no
    // home/away and no `home-vs-away` slug to match on — the event id is the
    // only join. It is also the stronger one: the slug branch exists because
    // older bets predate the leg event_id, which outrights do not.
    const tournament = typeof body.tournament === 'string' ? body.tournament.trim() : ''
    const tournamentAlias = typeof body.tournamentAlias === 'string' ? body.tournamentAlias.trim() : ''
    const eventSport = typeof body.eventSport === 'string' ? body.eventSport.trim() : ''
    // A tournament name is enough on its own: an unmapped tournament has no
    // swiftEventId, and its bets should still show.
    const outright = (!!swiftEventId || !!tournament) && (!body.home || !body.away)
    if (!body.date || (!outright && (!body.home || !body.away))) {
      res.status(400).json({
        error: 'date is required, plus home and away unless swiftEventId or tournament is given',
      })
      return
    }
    const homeSlug = slug(body.home ?? '')
    const awaySlug = slug(body.away ?? '')
    // Slug format: `<sport[-competition]>/<YYYY-MM-DD>/<home>-vs-<away>`. Match either
    // ordering of teams (some sources flip them).
    const matchPattern = new RegExp(
      `/${esc(body.date)}/(${esc(homeSlug)}-vs-${esc(awaySlug)}|${esc(awaySlug)}-vs-${esc(homeSlug)})$`,
    )

    const client = await getClient()
    const bets = client.db(MONGO_DB).collection(BETS_COLL)

    // `bet_date` is indexed; `derived.event_date_iso` isn't. So we narrow by
    // a bet-date window (1 week before to 1 day after the event date — bets
    // for a game are placed in that span) and then regex-match the slug.
    const eventDate = new Date(`${body.date}T00:00:00Z`)
    // Outrights are backed weeks out — a tournament winner market opens long
    // before the first tee — so the one-week window that suits a fixture would
    // miss most of them.
    const backDays = outright ? 90 : 7
    const loDate = new Date(eventDate.getTime() - backDays * 86_400_000).toISOString().slice(0, 10)
    const hiDate = new Date(eventDate.getTime() + 1 * 86_400_000).toISOString().slice(0, 10)
    // Either join is enough. The slug branch uses the `derived_legs_event_keys`
    // index; the event_id branch scans `legs` inside the bet_date window.
    const joins: Record<string, unknown>[] = []
    // No team names means the slug can only be "-vs-", which matches nothing
    // useful and everything badly. Event id alone in outright mode.
    if (!outright) joins.push({ 'derived.legs_event_keys': { $elemMatch: { $regex: matchPattern } } })
    // Read the tournaments this sport actually has bets on in the window, keep
    // the ones naming this tournament, and join on those exactly — an indexed
    // equality rather than a regex over a book name we'd have to guess.
    const tournamentHits = new Set<string>()
    if (outright && (tournament || tournamentAlias) && eventSport) {
      const present = (await bets.distinct('derived.event_tournament', {
        bet_date: { $gte: loDate, $lte: hiDate },
        'derived.event_sport': eventSport,
      })) as unknown[]
      const hits = present
        .filter((t): t is string => typeof t === 'string' && !!t)
        .filter((t) => (tournament && sameTournament(tournament, t)) || (tournamentAlias && sameTournament(tournamentAlias, t)))
      for (const h of hits) tournamentHits.add(h)
      if (hits.length) joins.push({ 'derived.event_tournament': { $in: hits } })
    }
    // The event-id branch is an UNANCHORED regex over every `legs` blob in the
    // window — 30s and a gateway timeout on a 90-day outright window. It is
    // also strictly weaker than the tournament join, which found 18 of
    // Wyndham's bets where this found 7. So outrights only fall back to it when
    // the tournament join came up empty.
    if (swiftEventId && (!outright || tournamentHits.size === 0)) {
      joins.push({ legs: { $regex: esc(swiftEventId) } })
    }

    const cursor = bets
      .find(
        {
          bet_date: { $gte: loDate, $lte: hiDate },
          'derived.is_racing': false,
          ...(joins.length > 1 ? { $or: joins } : joins[0]),
        },
        {
          projection: {
            _id: 1,
            bet_id: 1,
            user_id: 1,
            bet_time: 1,
            bet_amount: 1,
            bet_type: 1,
            odd: 1,
            pl: 1,
            bet_status: 1,
            is_bonus: 1,
            'derived.event_key': 1,
            'derived.legs_event_keys': 1,
            'derived.event_name': 1,
            'derived.market_category': 1,
            'derived.market_raw': 1,
            'derived.event_tournament': 1,
            'derived.sport': 1,
            'derived.type': 1,
            'derived.legs_breakdown': 1,
            legs: 1,
            'enrichment.blendFair': 1,
            'enrichment.emPercent': 1,
            'enrichment.scratched': 1,
          },
        },
      )
      .sort({ bet_time: -1 })
      .limit(200)

    const docs = await cursor.toArray()
    // 2-min grace on the recorded actual-start: bets within ~2 min of the flip
    // always check out fine (the stamp's resolution is the polling interval), so
    // only flag bets placed clearly after start.
    const AFTER_START_GRACE_MS = 2 * 60_000
    const cutoff = body.swiftActualStart ? Date.parse(body.swiftActualStart) + AFTER_START_GRACE_MS : null
    const schedMs = body.scheduledStart ? Date.parse(body.scheduledStart) : null
    const result = docs.flatMap((d) => {
      // Pinpoint which leg in a multi corresponds to this game so the UI can
      // call it out. Prefer the leg's own event_id — exact. Otherwise fall back
      // to regex-matching the slug against each leg key.
      const legKeys: string[] = d.derived?.legs_event_keys ?? []
      const parsedLegs = parseLegs(d.legs)
      const byEventId = legIndexByEventId(parsedLegs, swiftEventId)
      const matchedByEventId = byEventId >= 0
      const matchedLegIndex = matchedByEventId
        ? byEventId
        : legKeys.findIndex((k) => matchPattern.test(k))
      // An outright joined by tournament has no single leg to point at — a
      // 2-Ball's leg names the pairing, not the tournament — and that is fine:
      // the whole bet belongs to this tournament. Only the per-game branches
      // need a leg.
      const matchedByTournament =
        tournamentHits.size > 0 && tournamentHits.has(d.derived?.event_tournament ?? '')
      // The $or means a doc can come back on the slug branch alone; if it
      // matched neither leg precisely there's nothing to show for this game.
      if (matchedLegIndex < 0 && !matchedByTournament) return []
      // Disambiguate same-teams doubleheaders/series: drop the bet if its leg's
      // event_time isn't near THIS fixture's scheduled start. (Skip when we have
      // no scheduled start or no leg event_time — keep the bet rather than guess.)
      // An event_id match is already unambiguous, so it bypasses this entirely.
      // A tournament runs for days; pinning a bet to a start instant would drop
      // every round after the first.
      if (!matchedByEventId && !matchedByTournament && Number.isFinite(schedMs)) {
        const evtMs = legEventTimeMs(parsedLegs, matchedLegIndex)
        if (evtMs != null && Math.abs(evtMs - (schedMs as number)) > SAME_GAME_TOLERANCE_MS) return []
      }
      // bet_time is Melbourne wall-clock with a misleading Z; convert to a
      // real UTC moment for the after-start comparison.
      const betUtc = d.bet_time ? melbWallToUtc(d.bet_time) : null
      const placedAfterStart =
        cutoff != null && betUtc != null ? betUtc.getTime() > cutoff : false
      return [{
        id: d._id,
        bet_id: d.bet_id,
        user_id: d.user_id,
        bet_time: d.bet_time,
        bet_amount: d.bet_amount,
        bet_type: d.bet_type,
        odd: d.odd,
        pl: d.pl,
        // SwiftBet's own settlement state, added to the feed 2026-07-31 and
        // fully populated from 08-01: "paid" | "Unresulted" | "FullyRefunded" |
        // "PartiallyRefunded" | "Rejected" | "Cancelled" | "Failed" |
        // "Unsettled". Absent (not null) on anything older. Casing is
        // inconsistent upstream — "paid" is lower-case, the rest PascalCase —
        // so never compare it without normalising.
        bet_status: (d.bet_status as string | null) ?? null,
        is_bonus: !!d.is_bonus,
        sport: d.derived?.sport ?? null,
        type: d.derived?.type ?? null,
        market_category: d.derived?.market_category ?? null,
        // The book's own market label — "3-Ball", "Top 5". market_category
        // flattens a matchup to just "Golf", which reads as no market at all.
        market_raw: d.derived?.market_raw ?? null,
        // A matchup bet's event IS its pairing ("Cauley, B v Bradley, K v
        // Koepka, B") — the only readable description of what was backed when
        // there's no single leg to point at.
        event_name: d.derived?.event_name ?? null,
        event_key: d.derived?.event_key ?? null,
        legs_event_keys: legKeys,
        matched_leg_index: matchedLegIndex,
        matched_by: matchedByEventId ? 'event_id' : 'slug',
        matched_leg: extractLeg(parsedLegs, matchedLegIndex),
        // Prefer the real leg array — an event_id-matched bet may have no
        // derived.legs_event_keys at all (enrichment hasn't run on it yet).
        leg_count: parsedLegs?.length ?? legKeys.length,
        leg_breakdown: d.derived?.legs_breakdown ?? null,
        em_percent: d.enrichment?.emPercent ?? null,
        scratched: d.enrichment?.scratched ?? false,
        placed_after_start: placedAfterStart,
        // Real UTC placement moment (bet_time is Melbourne wall-clock) so the UI
        // can show the offset vs scheduled/actual start.
        placed_at_utc: betUtc ? betUtc.toISOString() : null,
      }]
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ bets: result, matchPattern: matchPattern.source, count: result.length })
  } catch (e) {
    res.status(500).json({ error: String((e as { message?: unknown })?.message ?? e) })
  }
}

export const config = { maxDuration: 30 }
