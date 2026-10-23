import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import App from './App';
import EventView from './EventView';
/*
 * Every page but the board is its own chunk.
 *
 * All nine were imported eagerly into one 380 kB bundle (111 kB on the wire),
 * so opening the board downloaded the mapping table, the user admin, the
 * pending-bets table and four more before it could paint — none of which the
 * board can reach without a navigation. The ticker is lazy too: it is a
 * trading account's landing page, but its chunk loads in parallel with the
 * feed it then has to wait for anyway.
 *
 * LoginPage stays eager. It is the one page a cold visitor is most likely to
 * need, and making the sign-in screen wait on a second request is the opposite
 * of the point.
 */
const TickerPage = lazy(() => import('./pages/TickerPage'));
const MoversPage = lazy(() => import('./pages/MoversPage'));
const TopPricePage = lazy(() => import('./pages/TopPricePage'));
const MappingPage = lazy(() => import('./pages/MappingPage'));
import { CapabilitiesProvider } from './lib/capabilities';
const UsersPage = lazy(() => import('./pages/UsersPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const SettlementPage = lazy(() => import('./pages/SettlementPage'));
const LateBetsPage = lazy(() => import('./pages/LateBetsPage'));
const PendingBetsPage = lazy(() => import('./pages/PendingBetsPage'));
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
      {/*
        A single boundary around the table rather than one per route: every
        chunk here is a full-page view, so there is nothing to show underneath
        it while it arrives, and `null` is less jarring than a spinner that
        flashes for 40ms on a warm cache.
      */}
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<DeskOnly><App /></DeskOnly>}>
          <Route index element={<EventView />} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/movers" element={<DeskOnly><MoversPage /></DeskOnly>} />
        {/* Reads the board's odds plus our two brand stores — desk-only, like
            Movers, because a deployed instance without them has nothing to
            compare. */}
        <Route path="/top-price" element={<DeskOnly><TopPricePage /></DeskOnly>} />
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
      </Suspense>
      </BrowserRouter>
    </CapabilitiesProvider>
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
