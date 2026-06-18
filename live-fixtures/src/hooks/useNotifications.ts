import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchOverdueUpcomingFixtures } from '../lib/dataSource'
import { fetchEventMappings } from '../lib/mappingData'
import { getSwiftCatalog, type SwiftEvent } from '../lib/swiftCatalog'
import { fetchSwiftStatuses } from '../lib/swiftStatus'
import type { Fixture } from '../lib/types'

export type NotificationKind =
  | 'swift_still_open'
  | 'optic_overdue_prematch'

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
  const [swiftSnapshot, setSwiftSnapshot] = useState<Map<string, SwiftEvent>>(new Map())
  const [liveStatus, setLiveStatus] = useState<Map<string, string | null>>(new Map())
  const [overdueExtras, setOverdueExtras] = useState<Fixture[]>([])
  const [loading, setLoading] = useState(true)

  // Mapping + SWIFT snapshot — refresh once a minute.
  useEffect(() => {
    let alive = true
    const load = () => {
      Promise.all([fetchEventMappings(), getSwiftCatalog()])
        .then(([events, cat]) => {
          if (!alive) return
          const m = new Map<string, string>()
          for (const e of events) if (e.swift_event_id) m.set(e.optic_fixture_id, e.swift_event_id)
          setEventMap(m)
          setSwiftSnapshot(cat.eventById)
        })
        .catch(() => {/* keep previous */})
        .finally(() => alive && setLoading(false))
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
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

  const notifications = useMemo<Notification[]>(() => {
    const out: Notification[] = []
    const nowMs = Date.now()
    const overdueCutoff = nowMs - OVERDUE_MIN * 60_000

    for (const f of allFixtures) {
      const sid = eventMap.get(f.id) ?? null
      const swiftEvent = sid ? swiftSnapshot.get(sid) : null
      const swiftStatus = sid
        ? liveStatus.has(sid)
          ? liveStatus.get(sid) ?? null
          : pollIdsSet.has(sid)
            ? null // pending first poll — don't fall back to stale snapshot
            : swiftEvent?.status ?? null
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
        swiftEventName: swiftEvent?.name ?? null,
      }

      if (sid && swiftStatus === 'prematch') {
        const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
        const actualMs = f.actualStart ? Date.parse(f.actualStart) : NaN
        const opticStarted = f.status === 'live' || (Number.isFinite(startMs) && startMs <= nowMs)
        // 2-min grace: OPTIC's actual_start (preferred) or scheduled start must
        // be at least that far in the past before we alert — SwiftBet's flip
        // lags by up to ~2 min and those are fine.
        const startedMs = Number.isFinite(actualMs) ? actualMs : startMs
        const pastGrace = Number.isFinite(startedMs) && startedMs <= nowMs - SWIFT_OPEN_GRACE_MS
        if (opticStarted && pastGrace) {
          out.push({ id: `swiftopen-${f.id}`, kind: 'swift_still_open', ...base })
        }
      }

      if (f.status === 'upcoming') {
        const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
        if (Number.isFinite(startMs) && startMs <= overdueCutoff) {
          out.push({ id: `opticovd-${f.id}`, kind: 'optic_overdue_prematch', ...base })
        }
      }
    }
    return out
  }, [allFixtures, eventMap, swiftSnapshot, liveStatus, pollIdsSet])

  return { notifications, loading }
}
