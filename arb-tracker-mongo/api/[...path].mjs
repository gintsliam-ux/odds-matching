import { handleApi } from '../server/lib/routes.mjs';
import { streamTicker } from '../server/lib/sse.mjs';
import { sessionFromCookies } from '../server/lib/auth.mjs';

/** Mirrors routes.mjs: the desk is private exactly when there is a secret. */
const AUTH_CONFIGURED = Boolean(process.env.AUTH_SECRET);

/**
 * The Vercel host for the API.
 *
 * One catch-all function rather than a file per route: the route table lives in
 * `server/lib/routes.mjs` and is shared with the long-running host in
 * `server/index.mjs`, so the deployed API and the local one cannot drift apart.
 *
 * Routing note: Vercel's filesystem routing only matched ONE segment under
 * /api for this catch-all, so `/api/bets` resolved while
 * `/api/mapping/tournaments` and `/api/event/details` returned a 404 from the
 * edge without ever reaching this function. `vercel.json` now rewrites
 * `/api/(.*)` here explicitly. The rewrite preserves the original path, which
 * matters because the route table below is keyed on `url.pathname`.
 *
 * On Vercel there is no MONGO_URI — `gutsys_sport` sits on a Tailscale address
 * that public infrastructure cannot route to — so this runs on the `api` source
 * and serves odds only. Routes whose data lives in Mongo answer with an
 * `unavailable` body the client renders as a notice. See server/lib/source.mjs.
 */
export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);

  // Streams its own response, so it bypasses the {status, body} path entirely.
  // Capped just under the function's maxDuration: closing it ourselves is a
  // clean end the client reconnects from, where being killed mid-write is not.
  if (url.pathname === '/api/ticker/stream') {
    // The live feed is the desk's data arriving a second at a time; it needs
    // the same sign-in as the feed it mirrors.
    if (AUTH_CONFIGURED && !sessionFromCookies(req.headers.cookie)) {
      res.setHeader('cache-control', 'no-store');
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    return streamTicker(req, res, { maxMs: 290_000 });
  }

  try {
    const out = await handleApi({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      searchParams: url.searchParams,
      // Vercel parses JSON bodies already; fall back for anything it didn't.
      body: typeof req.body === 'string' ? JSON.parse(req.body || 'null') : (req.body ?? null),
      cookies: req.headers.cookie,
    });

    // Session cookies and anything else the route sets on the way out.
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);

    // Functions are ephemeral, so the in-process cache rarely survives between
    // invocations — this is the cache that actually does the work in
    // production. The window is generous because the upstream surface
    // publishes closing prices for matches that have already finished: it
    // changes slowly, and a stale-by-a-minute board costs nothing next to
    // making every visitor wait on a cold drain of fourteen sports.
    // Never cache an empty answer. A board that came back empty is far more
    // likely to be a blip upstream than a day with no sport on it, and caching
    // it for five minutes turns one bad fetch into five minutes of "No events
    // match these filters" for everybody.
    const body = out.body;
    const empty =
      body == null ||
      (Array.isArray(body) && body.length === 0) ||
      (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);

    /*
     * How long a stale answer may be served matters more for some routes.
     *
     * The board carries a STATUS per fixture, and that status changes the
     * moment a game starts and again when it ends. A one-hour stale window let
     * the edge keep serving a board computed before kickoff, so a game that had
     * tipped off still read as upcoming — or, worse, as Final. Prices age
     * gracefully; "Final" on a running game does not.
     *
     * So anything carrying fixture status revalidates quickly, and the
     * expensive, slow-moving reads keep the generous window that makes the
     * board affordable at all.
     */
    /*
     * Freshness has to be paid for, and the board is expensive.
     *
     * /api/events drains SIXTEEN sports upstream. Putting it on a 30s window
     * forced that work on almost every request, the big sports (soccer alone is
     * 11s and 1,099 rows) started timing out, and allEvents drops a sport that
     * fails — so the board fell from 1,883 events to 83, losing soccer, tennis,
     * basketball and ice hockey entirely. A fixture vanishing from the board is
     * also what blanks an open event page, which is how it was first noticed.
     *
     * So the window is matched to what each route costs:
     *   bets, pulse      30s   cheap, and genuinely watched changing
     *   odds, details    60s   one fixture, half a second
     *   the board       120s   sixteen sports; status is still timely enough
     *   mapping, meta   300s   a 20-second read that barely moves
     */
    /*
     * Nothing behind a sign-in may be cached at the edge: a shared cache would
     * hand one desk's answer — or a 401 — to the next person through.
     */
    if (out.headers?.['set-cookie'] || url.pathname === '/api/auth' || url.pathname === '/api/users'
        || out.status === 401 || out.status === 403 || out.status === 503) {
      res.setHeader('cache-control', 'no-store');
      res.status(out.status).json(out.body);
      return;
    }

    const CHEAP_AND_LIVE = new Set(['/api/bets', '/api/ticker', '/api/pulse']);
    const PER_FIXTURE = new Set(['/api/odds', '/api/event/details']);
    const statusful = CHEAP_AND_LIVE.has(url.pathname);
    const perFixture = PER_FIXTURE.has(url.pathname);
    /*
     * Behind a sign-in these become PRIVATE.
     *
     * The edge cache keys on the URL and does not vary on the cookie, so a
     * response stored for a signed-in desk would be handed to the next person
     * through with no session at all — the gate would hold on a cold cache and
     * leak on a warm one. `private` keeps the same window in each browser and
     * stops the shared cache storing it.
     *
     * The board does not get slower for it: the function's own in-process
     * cache (see TTL in routes.mjs) is what spares the sixteen-sport drain,
     * not the CDN.
     */
    const window = statusful
      ? [30, 60]
      : perFixture
        ? [60, 120]
        // Still generous, but an hour of stale was long enough that a mapping
        // applied on one page load was missing from the next.
        : [300, 600];
    const [fresh, stale] = window;
    res.setHeader(
      'cache-control',
      out.status === 200 && !empty
        ? AUTH_CONFIGURED
          /*
           * `private` stops the shared cache storing a signed-in response, but
           * dropping stale-while-revalidate with it was a mistake: the CDN used
           * to hand over a stale copy instantly and refresh behind, and without
           * it every expiry makes someone wait on a cold origin. The browser
           * honours SWR too, so the gate costs nothing here.
           */
          ? `private, max-age=${fresh}, stale-while-revalidate=${stale}`
          : `s-maxage=${fresh}, stale-while-revalidate=${stale}`
        : 'no-store',
    );
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error(`[api] ${req.method} ${url.pathname} failed:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
