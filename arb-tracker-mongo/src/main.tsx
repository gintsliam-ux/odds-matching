import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import App from './App';
import EventView from './EventView';
import TickerPage from './pages/TickerPage';
import MappingPage from './pages/MappingPage';
import { CapabilitiesProvider } from './lib/capabilities';
import UsersPage from './pages/UsersPage';
import LoginPage from './pages/LoginPage';
import { AuthProvider } from './lib/auth';
import { useAuth } from './lib/useAuth';
import './index.css';

/**
 * Nothing renders until we know who is asking.
 *
 * `ready` is false only for the first session check, and the blank surface it
 * returns is deliberate: flashing the login form at someone who is already
 * signed in is worse than a moment of nothing.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="min-h-screen bg-surface" />;
  if (!user) return <LoginPage />;
  return <>{children}</>;
}

/** Managing users is admin-only on the server; do not route others into a 403. */
function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RequireAuth>
    <CapabilitiesProvider>
      <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<EventView />} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/ticker" element={<TickerPage />} />
        <Route path="/mapping" element={<MappingPage />} />
        <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
      </Routes>
      </BrowserRouter>
    </CapabilitiesProvider>
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
