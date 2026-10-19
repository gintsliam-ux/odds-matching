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
import PendingBetsPage from './pages/PendingBetsPage';
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
 * A `trading` account has two pages: the ticker, and the prices for one team or
 * player. Everything else lands it on the ticker.
 *
 * The whole layout is guarded and not just its index, so `/event/:slug/:id`
 * goes the same way — the event page is reached through the board's rail, and
 * the rail lists the market at large.
 *
 * Note where the real restriction lives. This redirect is so a trading user is
 * never shown a surface that will not load for them -- the server refuses those
 * routes outright and would do so whatever this component said. A guard that
 * only hid links would be decoration.
 */
/** `/search` -> `/prices`, query and all. */
function LegacySearch() {
  const { search } = useLocation();
  return <Navigate to={`/prices${search}`} replace />;
}

function DeskOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role === 'trading') return <Navigate to="/ticker" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RequireAuth>
    <CapabilitiesProvider>
      <BrowserRouter>
      <Routes>
        <Route path="/" element={<DeskOnly><App /></DeskOnly>}>
          <Route index element={<EventView />} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/movers" element={<DeskOnly><MoversPage /></DeskOnly>} />
        {/* The two a trading account has. */}
        <Route path="/ticker" element={<TickerPage />} />
        {/*
          * `/prices` is what the page is called, in its own heading and in the
          * link that reaches it. `/search` was the name of the box on it, not
          * of the page, and is kept as a redirect so older links and anything
          * bookmarked still land — carrying the query string with them.
          */}
        <Route path="/prices" element={<SearchPage />} />
        <Route path="/search" element={<LegacySearch />} />
        <Route path="/settlement" element={<DeskOnly><SettlementPage /></DeskOnly>} />
        <Route path="/late-bets" element={<DeskOnly><LateBetsPage /></DeskOnly>} />
        {/* Our own position, bet by bet — admin only, and gated on the server too. */}
        <Route path="/pending" element={<AdminOnly><PendingBetsPage /></AdminOnly>} />
        <Route path="/mapping" element={<DeskOnly><MappingPage /></DeskOnly>} />
        <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
      </Routes>
      </BrowserRouter>
    </CapabilitiesProvider>
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
