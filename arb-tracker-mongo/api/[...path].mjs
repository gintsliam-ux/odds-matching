import { handleApi } from '../server/lib/routes.mjs';

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

  try {
    const out = await handleApi({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      searchParams: url.searchParams,
      // Vercel parses JSON bodies already; fall back for anything it didn't.
      body: typeof req.body === 'string' ? JSON.parse(req.body || 'null') : (req.body ?? null),
    });

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
     * Time-sensitive reads. Anything someone watches change while they sit on
     * the page: fixture status, prices, and the bet feed — the scraper lands a
     * batch every 40s or so, and the edge was serving bets nine minutes stale
     * on a one-hour stale-while-revalidate.
     *
     * Everything else here is slow-moving and expensive — the mapping table is
     * a 20-second read — so it keeps the long window that makes it affordable.
     */
    const LIVEISH = new Set(['/api/events', '/api/bets', '/api/odds', '/api/h2h', '/api/pulse']);
    const statusful = LIVEISH.has(url.pathname) || url.pathname.startsWith('/api/events/');
    res.setHeader(
      'cache-control',
      out.status === 200 && !empty
        ? statusful
          ? 's-maxage=30, stale-while-revalidate=60'
          // Still generous, but an hour of stale was long enough that a mapping
        // applied on one page load was missing from the next.
        : 's-maxage=300, stale-while-revalidate=600'
        : 'no-store',
    );
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error(`[api] ${req.method} ${url.pathname} failed:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
