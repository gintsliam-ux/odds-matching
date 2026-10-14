import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
 * never shown a surface that will not load for them -- the server refuses the
 * routes behind the board, the movers page and the mapping tables outright, and
 * would do so whatever this component said. A guard that only hid links would
 * be decoration.
 */
function TradingHome({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role === 'trading') return <Navigate to="/search" replace />;
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
        <Route path="/movers" element={<TradingHome><MoversPage /></TradingHome>} />
        <Route path="/ticker" element={<TickerPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settlement" element={<SettlementPage />} />
        <Route path="/late-bets" element={<LateBetsPage />} />
        <Route path="/mapping" element={<TradingHome><MappingPage /></TradingHome>} />
        <Route path="/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
      </Routes>
      </BrowserRouter>
    </CapabilitiesProvider>
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
