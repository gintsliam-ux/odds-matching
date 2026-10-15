import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import App from './App';
import EventView from './EventView';
import TickerPage from './pages/TickerPage';
import MoversPage from './pages/MoversPage';
import MappingPage from './pages/MappingPage';
import { CapabilitiesProvider } from './lib/capabilities';
import UsersPage from './pages/UsersPage';
import SearchPage from './pages/SearchPage';
import SettlementPage from './pages/SettlementPage';
import LateBetsPage from './pages/LateBetsPage';
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

/**
 * Where a `trading` role may not go: the movers page and the mapping tables.
 * It has the board, the strip across the top of it, the ticker, the search,
 * settlement and late bets — everything but those two, and prices without any
 * history behind them.
 *
 * Note where the real restriction lives. This redirect is so a trading user is
 * never shown a surface that will not load for them -- the server refuses those
 * routes outright and would do so whatever this component said. A guard that
 * only hid links would be decoration.
 */
function DeskOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role === 'trading') return <Navigate to="/search" replace />;
  return <>{children}</>;
}

/**
 * The ticker is where a trading account starts.
 *
 * On the INDEX route only, and bypassed when the navigation says `board` —
 * which is what every in-app Board link passes. Both halves matter: wrapping
 * the whole layout would catch `/event/:id` and bounce someone out of the
 * board the moment they clicked a fixture in the rail, and redirecting
 * unconditionally would make the Board link a loop back to the ticker, leaving
 * no way to reach the board at all.
 *
 * So a cold load of `/` lands on the ticker, and a deliberate click reaches the
 * board — without a second URL for it.
 */
function TickerFirst({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const wanted = (location.state as { board?: boolean } | null)?.board;
  if (user?.role === 'trading' && !wanted) return <Navigate to="/ticker" replace />;
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
          <Route index element={<TickerFirst><EventView /></TickerFirst>} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/movers" element={<DeskOnly><MoversPage /></DeskOnly>} />
        <Route path="/ticker" element={<TickerPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settlement" element={<SettlementPage />} />
        <Route path="/late-bets" element={<LateBetsPage />} />
        <Route path="/mapping" element={<DeskOnly><MappingPage /></DeskOnly>} />
        <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
      </Routes>
      </BrowserRouter>
    </CapabilitiesProvider>
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
