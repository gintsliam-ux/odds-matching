import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import Terminal from './pages/Terminal'
import FixtureDetailPage from './pages/FixtureDetailPage'
import MappingPage from './pages/Mapping'
import GolfDetailPage from './pages/GolfDetailPage'
import NotificationsPage from './pages/NotificationsPage'
import NotFoundPage from './pages/NotFoundPage'
import UsersPage from './pages/UsersPage'
import LoginPage from './pages/LoginPage'
import { AuthProvider } from './components/AuthProvider'
import { useAuth } from './lib/authContext'

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ErrorBoundary>
  )
}

/**
 * Nothing renders until the session is known.
 *
 * The router sits INSIDE the gate so an unauthenticated visitor never mounts
 * Layout — which is what starts the fixture polling, the notification sweep and
 * the mapping tick. A signed-out browser should be quiet, not just blank.
 */
function Gate() {
  const { user, loading } = useAuth()
  if (loading) return <div className="min-h-screen bg-[var(--bg)]" />
  if (!user) return <LoginPage />
  return (
    <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Terminal />} />
            <Route path="live" element={<Terminal />} />
            <Route path="upcoming" element={<Terminal />} />
            <Route path="completed" element={<Terminal />} />
            <Route path="sport/:sport" element={<Terminal />} />
            <Route path="sport/:sport/:league" element={<Terminal />} />
            <Route path="favourite/:favId" element={<Terminal />} />
            {/* `:id` may carry a slug — "seattle-storm-v-chicago-sky-<id>" —
                and the optional `:tab` makes a tab linkable. Both are parsed
                defensively, so the bare-id links that existed before still
                resolve. */}
            <Route path="fixture/:id" element={<FixtureDetailPage />} />
            <Route path="fixture/:id/:tab" element={<FixtureDetailPage />} />
            <Route path="mapping" element={<MappingPage />} />
            <Route path="mapping/:sport" element={<MappingPage />} />
            <Route path="mapping/:sport/:league" element={<MappingPage />} />
            {/* Golf has no fixture, so it can't live under /fixture/:id. */}
            <Route path="golf/:tournamentId" element={<GolfDetailPage />} />
            <Route path="golf/:tournamentId/:tab" element={<GolfDetailPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="users" element={<UsersPage />} />
            {/* A dead link used to bounce silently to the board, which reads
                as "the terminal lost my game" rather than "that URL is wrong". */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
    </BrowserRouter>
  )
}
