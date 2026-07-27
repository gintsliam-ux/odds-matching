import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchEventMappingsFor } from '../lib/mappingData'
import { fetchSwiftStatuses } from '../lib/swiftStatus'
import type { Fixture } from '../lib/types'

/** ±15 min of scheduled kickoff is the "hot window" where transitions happen. */
const HOT_WINDOW_MIN = 15
/** Poll cadence while there are unstamped events in the hot window. */
const HOT_TICK_MS = 5_000

/**
 * Background poller that drives `/api/swift-status` for events about to kick
 * off. The endpoint stamps `event_mapping.swift_actual_start = NOW()` the
 * first time it observes SWIFT `status='inprogress'`, so polling at 5 s here
 * keeps the recorded value within ~5 s of the actual transition while any
 * user has the site open — independent of the offline scraper cadence.
 *
 * Mounted once at the Layout level. Idles cheaply (no fetches) when there
 * are no candidates in the window.
 */
export function useSwiftActualStartCapture(fixtures: Fixture[]): void {
  // optic_fixture_id → swift_event_id for mappings that still need stamping.
  const [unstampedMap, setUnstampedMap] = useState<Map<string, string>>(new Map())

  // Refresh the unstamped set every minute; the candidate list shrinks by
  // itself as the endpoint writes stamps. Scoped to the fixtures on screen. This used to read the WHOLE
  // event_mapping table (13.9k rows over ~14 sequential pages) every 60s on
  // every page — the map is only ever consulted via `fixtures` below, so the
  // rest was pure waste and kept the tab permanently busy.
  //
  // Keyed on the id STRING, not the array: `fixtures` gets a new identity on
  // each 15s board poll, which would otherwise restart the interval forever.
  const fixtureIdKey = useMemo(() => fixtures.map((f) => f.id).sort().join(','), [fixtures])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const ids = fixtureIdKey ? fixtureIdKey.split(',') : []
        const events = await fetchEventMappingsFor(ids)
        if (!alive) return
        const m = new Map<string, string>()
        for (const e of events) {
          if (e.swift_event_id && !e.swift_actual_start) m.set(e.optic_fixture_id, e.swift_event_id)
        }
        setUnstampedMap(m)
      } catch {
        /* keep previous */
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [fixtureIdKey])

  // Hot list: swift event ids for mapped fixtures whose scheduled kickoff is
  // within ±15 min of now AND that haven't been stamped yet. Recomputes on
  // every render but it's a single linear pass over `fixtures` — cheap.
  const hotIds = useMemo(() => {
    if (unstampedMap.size === 0) return [] as string[]
    const lo = Date.now() - HOT_WINDOW_MIN * 60_000
    const hi = Date.now() + HOT_WINDOW_MIN * 60_000
    const out: string[] = []
    for (const f of fixtures) {
      // Only stamp once the fixture has actually started or is close to
      // starting — outside the hot window we don't need 5 s polling.
      const sid = unstampedMap.get(f.id)
      if (!sid) continue
      const startMs = f.scheduledStart ? Date.parse(f.scheduledStart) : NaN
      if (!Number.isFinite(startMs)) continue
      if (startMs < lo || startMs > hi) continue
      out.push(sid)
    }
    return out.sort()
  }, [fixtures, unstampedMap])

  // String key so the effect only restarts when the hot set actually changes.
  const hotKey = hotIds.join(',')
  const tickingRef = useRef(false)

  useEffect(() => {
    if (hotIds.length === 0) return
    const tick = async () => {
      if (tickingRef.current) return
      tickingRef.current = true
      try {
        await fetchSwiftStatuses(hotIds) // side-effect: stamps swift_actual_start
      } catch {
        /* transient; next tick retries */
      } finally {
        tickingRef.current = false
      }
    }
    tick()
    const id = setInterval(tick, HOT_TICK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotKey])
}
