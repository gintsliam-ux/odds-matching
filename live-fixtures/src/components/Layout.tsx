import { useMemo } from 'react'
import { Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router-dom'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { useFixtures, type FeedState } from '../hooks/useFixtures'
import { useMongoPulse } from '../hooks/useMongoPulse'
import { useMappingTick } from '../hooks/useMappingTick'
import { useNow } from '../hooks/useNow'
import { useStableOrder } from '../hooks/useStableOrder'
import { useDayFixtures } from '../hooks/useDayFixtures'
import { useNotifications, type Notification } from '../hooks/useNotifications'
import { useSwiftActualStartCapture } from '../hooks/useSwiftActualStartCapture'
import { useAlertToasts } from '../hooks/useAlertToasts'
import { AlertToasts } from './AlertToasts'
import { melbToday } from '../lib/dates'
import type { Fixture } from '../lib/types'

export interface DayView {
  mode: boolean
  status: 'upcoming' | 'completed'
  date: string
  fixtures: Fixture[]
  loading: boolean
  error: string | null
}

export interface TerminalContext {
  fixtures: Fixture[]
  now: Date
  feed: FeedState
  error: string | null
  day: DayView
  notifications: Notification[]
  notificationsLoading: boolean
}

export function useTerminal(): TerminalContext {
  return useOutletContext<TerminalContext>()
}

function statusFromPath(pathname: string): 'live' | 'upcoming' | 'completed' | 'all' {
  if (pathname.startsWith('/live')) return 'live'
  if (pathname.startsWith('/upcoming')) return 'upcoming'
  if (pathname.startsWith('/completed')) return 'completed'
  return 'all'
}

export default function Layout() {
  const now = useNow(1000)
  const { fixtures: raw, feed, nextPollAt, error, lastUpdated } = useFixtures()
  const fixtures = useStableOrder(raw)
  // SWIFT (Mongo) feed health — shown next to the OpticOdds feed pulse in the
  // header. Independent poll; the two upstreams can fail separately.
  const { pulse: mongoPulse, state: mongoState } = useMongoPulse()
  // Self-trigger the mapping rebuild ~every 10 min (server-throttled) since
  // Vercel Hobby cron can only fire once a day.
  useMappingTick()

  // /upcoming and /completed browse a specific Melbourne day; fetch it here so
  // both the board and the sidebar counts share one source.
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const status = statusFromPath(pathname)
  const dayMode = status === 'upcoming' || status === 'completed'
  const dayStatus: 'upcoming' | 'completed' = status === 'completed' ? 'completed' : 'upcoming'
  const date = params.get('date') || melbToday()
  const dayData = useDayFixtures(dayMode ? date : null, dayStatus)
  const day: DayView = { mode: dayMode, status: dayStatus, date, ...dayData }

  const counts = useMemo(
    () => ({
      total: fixtures.length,
      live: fixtures.filter((f) => f.status === 'live').length,
      upcoming: fixtures.filter((f) => f.status === 'upcoming').length,
      completed: fixtures.filter((f) => f.status === 'completed').length,
    }),
    [fixtures],
  )

  // Notifications are computed once here so the Sidebar badge and the
  // /notifications page share one source (the Sidebar lives outside <Outlet>
  // so it can't read useTerminal — pass via prop instead).
  const { notifications, loading: notificationsLoading } = useNotifications(fixtures)

  // Capture SWIFT actual-start timestamps for events about to kick off — runs
  // a 5s background poll while any fixture is in the ±15 min hot window.
  useSwiftActualStartCapture(fixtures)

  // Top-right toasts for "SwiftBet still open on started event" alerts.
  // Each toast stays until the user dismisses it with the X.
  const { toasts, dismiss, dismissAll } = useAlertToasts(notifications)

  const ctx: TerminalContext = { fixtures, now, feed, error, day, notifications, notificationsLoading }

  return (
    <div className="flex min-h-full flex-col text-gray-200">
      <AlertToasts toasts={toasts} onDismiss={dismiss} onDismissAll={dismissAll} />
      <Header
        counts={counts}
        now={now}
        nextPollAt={nextPollAt}
        feed={feed}
        lastUpdated={lastUpdated}
        mongoState={mongoState}
        mongoPulse={mongoPulse}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar fixtures={fixtures} day={day} notificationCount={notifications.length} />
        <main className="min-w-0 flex-1">
          <Outlet context={ctx} />
        </main>
      </div>
    </div>
  )
}
