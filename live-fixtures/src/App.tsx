import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import Terminal from './pages/Terminal'
import FixtureDetailPage from './pages/FixtureDetailPage'
import MappingPage from './pages/Mapping'
import GolfDetailPage from './pages/GolfDetailPage'
import NotificationsPage from './pages/NotificationsPage'
import NotFoundPage from './pages/NotFoundPage'

export default function App() {
  return (
    <ErrorBoundary>
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
            {/* A dead link used to bounce silently to the board, which reads
                as "the terminal lost my game" rather than "that URL is wrong". */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
