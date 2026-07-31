import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchOverdueUpcomingFixtures } from '../lib/dataSource'
import { fetchEventMappingsFor } from '../lib/mappingData'
import { fetchSwiftStatuses } from '../lib/swiftStatus'
import { fetchMybetStatuses } from '../lib/mybetStatus'
import { fetchSwiftBets, type SwiftBetRow } from '../lib/swiftBets'
import { fetchMybetBets } from '../lib/mybetBets'
import type { Fixture } from '../lib/types'

export type NotificationKind =
  | 'swift_still_open'
  | 'mybet_still_open'
  | 'swift_late_bet'
  | 'mybet_late_bet'
  | 'optic_overdue_prematch'

/** One bet that landed after OPTIC went live, normalised across both books for
 *  display on the notifications page. */
export interface LateBet {
  brand: 'swift' | 'mybet'
  stake: number | null
  odds: number | null
  /** Real UTC placement time (both books store Melbourne wall-clock upstream —
   *  this is already corrected). */
  placedUtc: string | null
  /** What was backed — "market · outcome" (SwiftBet) or the selections string
   *  (mybet). */
  selection: string | null
  betType: string | null
  legCount: number
  isBonus: boolean
}

export interface Notification {
  id: string
  kind: NotificationKind
  opticFixtureId: string
  /** Present when the alert involves a mapped SWIFT event. */
  swiftEventId: string | null
  sport: string
  league: string
  home: string
  away: string
  /** Scheduled kickoff — drives the "12m late" label. */
  scheduledStart: string | null
  /** OPTIC's actual_start when the game has started, else scheduled. */
  opticActualStart: string | null
  /** Current OPTIC status. */
  opticStatus: Fixture['status']
  /** Current SWIFT status when known. */
  swiftStatus: string | null
  swiftEventName: string | null
  /** mybet: set on mybet_still_open alerts. `mybetSuspendAt` is the market
   *  close time still sitting in the future while the game is underway. */
  mybetEventId?: string | null
  mybetEventName?: string | null
  mybetSuspendAt?: string | null
  /** *_late_bet alerts: how many bets landed after OPTIC went live, their
   *  total stake, and each individual bet for display. */
  lateBetCount?: number
  lateBetStake?: number
  lateBets?: LateBet[]
}

/** Per-fixture late-bet aggregate: count + total stake + the individual bets. */
type LateAgg = {
  swift?: { count: number; stake: number; bets: LateBet[] }
  mybet?: { count: number; stake: number; bets: LateBet[] }
}

/** "market · outcome" for a SwiftBet leg; joins the picks for an SGM. */
function swiftSelection(b: SwiftBetRow): string | null {
  const ml = b.matched_leg
  if (!ml) return b.bet_type ?? null
  if (ml.selections && ml.selections.length > 1) {
    const picks = ml.selections.map((s) => s.outcome).filter(Boolean)
    if (picks.length) return picks.join(' + ')
  }
  return [ml.market, ml.outcome].filter(Boolean).join(' · ') || ml.outcome || null
}

const OVERDUE_MIN = 15
/** Poll SWIFT statuses every 10s for in-progress mapped events. */
const POLL_MS = 10_000
/** Grace before the "SwiftBet still open" alert fires. SwiftBet routinely lags
 *  OPTIC's prematch→live flip by up to a couple of minutes (normal scraper
 *  delay) and those always resolve fine, so don't alert until the game has been
 *  started for longer than this. */
const SWIFT_OPEN_GRACE_MS = 2 * 60_000

/**
 * The core alert that this project exists for: SwiftBet is still taking
 * prematch bets on a game that has already started. Triggered when OPTIC
 * (truth) reports `live` or shows an actual_start in the past while the
 * mapped SWIFT event status is still `prematch`. Every second the alert
 * fires is a second SwiftBet shouldn't be accepting market activity.
 *
 * Secondary rule kept: optic_overdue_prematch — OPTIC itself is stuck
 * `upcoming` 15+ min past kickoff (usually a scraper ingest delay).
 */
export function useNotifications(fixtures: Fixture[]): {
  notifications: Notification[]
  loading: boolean
} {
  const [eventMap, setEventMap] = useState<Map<string, string>>(new Map())
  /** id → live name, from the same poll that fetches status. Replaces the old
   *  /public snapshot, which no longer carries events at all. */
  const [swiftNames, setSwiftNames] = useState<Map<string, string | null>>(new Map())
  const [liveStatus, setLiveStatus] = useState<Map<string, string | null>>(new Map())
  const [overdueExtras, setOverdueExtras] = useState<Fixture[]>([])
  const [loading, setLoading] = useState(true)
  // mybet parallel state: optic→mybet id map, snapshot (suspendAt fallback),
  // and a live open/suspend map polled for started fixtures.
  const [mybetMap, setMybetMap] = useState<Map<string, string>>(new Map())
  const [mybetLive, setMybetLive] = useState<
    Map<string, { open: boolean; suspendAt: string | null; name: string | null }>
  >(new Map())
  // Late bets: fixtures where a bet landed AFTER OPTIC went live, per brand.
  const [lateBets, setLateBets] = useState<Map<string, LateAgg>>(new Map())

  // The catalogues used to be polled here once a minute for their eventById
  // snapshots. They no longer carry events at all — names and suspend times now
  // come from the live status polls below, which are per-fixture and current.
  // Keeping the call would have been two API requests a minute for two maps
  // that are always empty.
  useEffect(() => {
    setLoading(false)
  }, [])

  // Overdue upcoming OPTIC fixtures — single PostgREST call, every minute.
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchOverdueUpcomingFixtures({ staleMinutes: OVERDUE_MIN, maxAgeHours: 48 })
        .then((rows) => alive && setOverdueExtras(rows))
        .catch(() => {/* keep previous */})
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Memoised so its reference is stable across renders when neither source
  // changed — otherwise the notifications array below would be a new ref
  // every Layout tick and downstream consumers (NotificationsPage, the toast
  // hook) would constantly re-render with identical content, which read as
  // a flicker.
  const allFixtures = useMemo<Fixture[]>(() => {
    if (overdueExtras.length === 0) return fixtures
    const seen = new Set(fixtures.map((f) => f.id))
    return [...fixtures, ...overdueExtras.filter((f) => !seen.has(f.id))]
  }, [fixtures, overdueExtras])

  // Event mappings for the fixtures this hook actually inspects. Both maps are
  // only ever read as `eventMap.get(f.id)` over `allFixtures`, so a whole-table
  // read was pure waste — it pulled 13.9k swift + 8.1k mybet rows across ~22
  // sequential pages EVERY 60s on EVERY page, which is what kept the tab busy
  // enough that the page never went idle.
  //
  // Keyed on the id string so the 15s board poll (new array identity, same
  // ids) doesn't restart the interval.
  const mappedIdKey = useMemo(() => allFixtures.map((f) => f.id).sort().join(','), [allFixtures])
  useEffect(() => {
    let alive = true
    const load = () => {
      const ids = mappedIdKey ? mappedIdKey.split(',') : []
      Promise.all([fetchEventMappingsFor(ids, 'swift'), fetchEventMappingsFor(ids, 'mybet')])
        .then(([events, mybetEvents]) => {
          if (!alive) return
          const m = new Map<string, string>()
          for (const e of events) if (e.swift_event_id) m.set(e.optic_fixture_id, e.swift_event_id)
          setEventMap(m)
          const mm = new Map<string, string>()
          for (const e of mybetEvents) if (e.swift_event_id) mm.set(e.optic_fixture_id, e.swift_event_id)
          setMybetMap(mm)
        })
        .catch(() => {/* keep previous */})
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [mappedIdKey])

  // SWIFT ids we need fresh statuses for: any mapped fixture where OPTIC
  // says the game has started (live, or upcoming-but-late). Polled every
  // POLL_MS — each tick records actual-start stamps as a side-effect.
  const pollIds = useMemo(() => {
    const lateCutoff = Date.now()
    const out: string[] = []
    for (const f of allFixtures) {
      const sid = eventMap.get(f.id)
      if (!sid) continue
      const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
      const opticStarted = f.status === 'live' || (Number.isFinite(startMs) && startMs <= lateCutoff)
      if (opticStarted) out.push(sid)
    }
    return out.sort()
  }, [allFixtures, eventMap])

  const pollKey = pollIds.join(',')
  const pollingRef = useRef(false)

  useEffect(() => {
    if (pollIds.length === 0) return
    const tick = async () => {
      if (pollingRef.current) return
      pollingRef.current = true
      try {
        const rows = await fetchSwiftStatuses(pollIds)
        // Merge into the previous map rather than replacing — replacing
        // dropped entries for sids no longer in the poll set, and the next
        // render fell back to stale snapshot statuses, briefly re-firing
        // alerts ("flick off") before the next poll caught up.
        setLiveStatus((prev) => {
          const next = new Map(prev)
          for (const r of rows) next.set(r.id, r.status)
          return next
        })
        setSwiftNames((prev) => {
          const next = new Map(prev)
          for (const r of rows) next.set(r.id, r.name ?? null)
          return next
        })
      } catch {/* keep previous */}
      finally { pollingRef.current = false }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey])

  // sids we currently intend to poll — for these, prefer "unknown" over the
  // static snapshot until the live status arrives. The snapshot is built once
  // a day and goes stale within minutes for active events, so a brief render
  // with snapshot=`prematch` fired the alert spuriously before the first
  // /api/swift-status tick (~200 ms) returned the real `inprogress` — visible
  // as the SWIFT row flickering off and back on after page load.
  const pollIdsSet = useMemo(() => new Set(pollIds), [pollKey])

  // mybet: same idea — poll live suspend/open for started fixtures so an
  // extended market is caught, not just the (possibly stale) snapshot suspendAt.
  const mybetPollIds = useMemo(() => {
    const lateCutoff = Date.now()
    const out: string[] = []
    for (const f of allFixtures) {
      const mid = mybetMap.get(f.id)
      if (!mid) continue
      const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
      if (f.status === 'live' || (Number.isFinite(startMs) && startMs <= lateCutoff)) out.push(mid)
    }
    return out.sort()
  }, [allFixtures, mybetMap])

  const mybetPollKey = mybetPollIds.join(',')
  const mybetPollingRef = useRef(false)
  useEffect(() => {
    if (mybetPollIds.length === 0) return
    const tick = async () => {
      if (mybetPollingRef.current) return
      mybetPollingRef.current = true
      try {
        const rows = await fetchMybetStatuses(mybetPollIds)
        setMybetLive((prev) => {
          const next = new Map(prev)
          for (const r of rows) next.set(r.id, { open: r.open, suspendAt: r.suspendAt, name: r.name ?? null })
          return next
        })
      } catch {/* keep previous */}
      finally { mybetPollingRef.current = false }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mybetPollKey])

  // Late-bet detection: for fixtures where OPTIC is LIVE and a book is mapped,
  // fetch that game's bets and flag any placed after OPTIC went live. Slower
  // cadence than the status poll (bets are a heavier Mongo read) and capped, to
  // stay gentle on the shared DB.
  const liveMapped = useMemo(() => {
    const out: Fixture[] = []
    for (const f of allFixtures) {
      if (f.status !== 'live') continue
      if (!eventMap.has(f.id) && !mybetMap.has(f.id)) continue
      out.push(f)
      if (out.length >= 20) break
    }
    return out
  }, [allFixtures, eventMap, mybetMap])
  const liveMappedKey = liveMapped.map((f) => f.id).sort().join(',')
  const lateBetsRef = useRef(false)
  useEffect(() => {
    if (liveMapped.length === 0) {
      setLateBets(new Map())
      return
    }
    let alive = true
    const tick = async () => {
      if (lateBetsRef.current) return
      lateBetsRef.current = true
      try {
        const next = new Map<string, LateAgg>()
        for (const f of liveMapped) {
          // OPTIC's live moment: its recorded actual_start, else scheduled.
          const liveAt = f.actualStart ?? f.scheduledStart ?? null
          const date = (f.scheduledStart ?? f.startTime ?? '').slice(0, 10)
          const entry: LateAgg = {}
          const sid = eventMap.get(f.id)
          if (sid && date) {
            try {
              const bets = await fetchSwiftBets({ date, home: f.homeName, away: f.awayName, swiftEventId: sid, swiftActualStart: liveAt, scheduledStart: f.scheduledStart })
              const late = bets.filter((b) => b.placed_after_start)
              if (late.length) {
                entry.swift = {
                  count: late.length,
                  stake: late.reduce((s, b) => s + (b.bet_amount ?? 0), 0),
                  bets: late
                    .map((b): LateBet => ({
                      brand: 'swift',
                      stake: b.bet_amount,
                      odds: b.matched_leg?.odds ?? b.odd,
                      placedUtc: b.placed_at_utc,
                      selection: swiftSelection(b),
                      betType: b.type,
                      legCount: b.leg_count,
                      isBonus: b.is_bonus,
                    }))
                    .sort((a, z) => (Date.parse(z.placedUtc ?? '') || 0) - (Date.parse(a.placedUtc ?? '') || 0)),
                }
              }
            } catch {/* skip this fixture's swift bets */}
          }
          const mid = mybetMap.get(f.id)
          if (mid) {
            try {
              const suspendAt = mybetLive.get(mid)?.suspendAt ?? null
              const mbets = await fetchMybetBets({ eventId: mid, suspendAt, home: f.homeName, away: f.awayName, liveAt })
              const late = mbets.filter((b) => b.placed_after_live)
              if (late.length) {
                entry.mybet = {
                  count: late.length,
                  stake: late.reduce((s, b) => s + (b.amount_bet ?? 0), 0),
                  bets: late
                    .map((b): LateBet => ({
                      brand: 'mybet',
                      stake: b.amount_bet,
                      odds: b.price,
                      placedUtc: b.transaction_date,
                      selection: b.selections,
                      betType: b.bet_type,
                      legCount: b.leg_count,
                      isBonus: b.is_bonus,
                    }))
                    .sort((a, z) => (Date.parse(z.placedUtc ?? '') || 0) - (Date.parse(a.placedUtc ?? '') || 0)),
                }
              }
            } catch {/* skip this fixture's mybet bets */}
          }
          if (entry.swift || entry.mybet) next.set(f.id, entry)
        }
        if (alive) setLateBets(next)
      } finally {
        lateBetsRef.current = false
      }
    }
    tick()
    const id = setInterval(tick, 45_000)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMappedKey])

  const notifications = useMemo<Notification[]>(() => {
    const out: Notification[] = []
    const nowMs = Date.now()
    const overdueCutoff = nowMs - OVERDUE_MIN * 60_000

    for (const f of allFixtures) {
      const sid = eventMap.get(f.id) ?? null
      const swiftEventName = sid ? swiftNames.get(sid) ?? null : null
      const swiftStatus = sid
        ? liveStatus.has(sid)
          ? liveStatus.get(sid) ?? null
          : pollIdsSet.has(sid)
            ? null // pending first poll — don't fall back to stale snapshot
            : null
        : null

      const base = {
        opticFixtureId: f.id,
        swiftEventId: sid,
        sport: f.sport,
        league: f.league,
        home: f.homeName,
        away: f.awayName,
        scheduledStart: f.scheduledStart,
        opticActualStart: f.actualStart,
        opticStatus: f.status,
        swiftStatus,
        swiftEventName,
      }

      // The trigger is OPTIC turning LIVE (the truth signal) — not merely the
      // scheduled kickoff passing, which can lag OPTIC or fire on a delayed
      // game that never actually started. A 2-min grace on the recorded start
      // absorbs the normal ~2-min book lag so we don't alert on the transition.
      const opticLive = f.status === 'live'
      const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
      const actualMs = f.actualStart ? Date.parse(f.actualStart) : NaN
      const startedMs = Number.isFinite(actualMs) ? actualMs : startMs
      const pastGrace = !Number.isFinite(startedMs) || startedMs <= nowMs - SWIFT_OPEN_GRACE_MS

      // SwiftBet still open = OPTIC live while the mapped SWIFT event is still prematch.
      if (sid && swiftStatus === 'prematch' && opticLive && pastGrace) {
        out.push({ id: `swiftopen-${f.id}`, kind: 'swift_still_open', ...base })
      }

      // mybet still open = OPTIC live while the mybet market hasn't hit its close
      // (suspend) time. Prefer the live poll's open flag; fall back to the
      // snapshot suspendAt before the first tick lands.
      const mid = mybetMap.get(f.id) ?? null
      if (mid) {
        const live = mybetLive.get(mid)
        const suspendAt = live?.suspendAt ?? null
        const mybetOpen = live ? live.open : suspendAt ? Date.parse(suspendAt) > nowMs : false
        if (mybetOpen && opticLive && pastGrace) {
          out.push({
            id: `mybetopen-${f.id}`,
            kind: 'mybet_still_open',
            ...base,
            mybetEventId: mid,
            mybetEventName: live?.name ?? null,
            mybetSuspendAt: suspendAt,
          })
        }
      }

      // Late bets: a bet landed after OPTIC went live. One alert per brand.
      const late = lateBets.get(f.id)
      if (late?.swift) {
        out.push({ id: `swiftlate-${f.id}`, kind: 'swift_late_bet', ...base, lateBetCount: late.swift.count, lateBetStake: late.swift.stake, lateBets: late.swift.bets })
      }
      if (late?.mybet) {
        out.push({
          id: `mybetlate-${f.id}`,
          kind: 'mybet_late_bet',
          ...base,
          mybetEventId: mid,
          mybetEventName: mid ? mybetLive.get(mid)?.name ?? null : null,
          lateBetCount: late.mybet.count,
          lateBetStake: late.mybet.stake,
          lateBets: late.mybet.bets,
        })
      }

      if (f.status === 'upcoming') {
        const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
        if (Number.isFinite(startMs) && startMs <= overdueCutoff) {
          out.push({ id: `opticovd-${f.id}`, kind: 'optic_overdue_prematch', ...base })
        }
      }
    }
    return out
  }, [allFixtures, eventMap, swiftNames, liveStatus, pollIdsSet, mybetMap, mybetLive, lateBets])

  return { notifications, loading }
}
