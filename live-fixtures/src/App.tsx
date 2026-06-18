import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import Terminal from './pages/Terminal'
import FixtureDetailPage from './pages/FixtureDetailPage'
import MappingPage from './pages/Mapping'
import NotificationsPage from './pages/NotificationsPage'

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
            <Route path="favourite/:favId" element={<Terminal />} />
            <Route path="fixture/:id" element={<FixtureDetailPage />} />
            <Route path="mapping" element={<MappingPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
