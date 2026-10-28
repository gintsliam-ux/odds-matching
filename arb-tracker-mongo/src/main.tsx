import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
const MappingPage = lazy(() => import('./pages/MappingPage'));
import { CapabilitiesProvider } from './lib/capabilities';
const UsersPage = lazy(() => import('./pages/UsersPage'));
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
 * The pages a restricted account does not have. Everything else lands it on
 * the board, which trading and support both share with an admin.
 *
 * The board and the event page beneath it used to be guarded here too. They
 * are not any more: the one thing withheld from the role on those pages is the
 * price history, and that is taken out of the payload server-side rather than
 * by keeping it off the page. What is left behind this guard is the pages that
 * are not the board — movers (which ranks by the very history the role does
 * not get), settlement, late bets and the mapping tables.
 *
 * Note where the real restriction lives. This redirect is so a trading user is
 * never shown a surface that will not load for them -- the server refuses those
 * routes outright and would do so whatever this component said. A guard that
 * only hid links would be decoration.
 */
/** Trading and support both; admin and anything else passes. */
const RESTRICTED = new Set(['trading', 'support']);

function DeskOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // To the board, not to the ticker: the board is the page both restricted
  // roles have, and support cannot open the ticker at all.
  if (RESTRICTED.has(user?.role ?? '')) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** The ticker is trading's page, not support's. */
function NotSupport({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role === 'support') return <Navigate to="/" replace />;
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
        {/* The board, shared by every role — see DeskOnly. */}
        <Route path="/" element={<App />}>
          <Route index element={<EventView />} />
          <Route path="event/:slug/:fixtureId" element={<EventView />} />
        </Route>
        {/* Full-width: the mapping table has no use for the event rail. */}
        <Route path="/movers" element={<DeskOnly><MoversPage /></DeskOnly>} />
        <Route path="/ticker" element={<NotSupport><TickerPage /></NotSupport>} />
        {/*
          * /prices and /search are gone. That page existed because `trading`
          * had no board — it was the role's entire surface, a search box over
          * the same markets-by-bookmaker grid the event page draws. Trading
          * has the board now, nothing linked to the page any more, and a
          * second way to look at one fixture's prices is a second thing to
          * keep working.
          */}
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
