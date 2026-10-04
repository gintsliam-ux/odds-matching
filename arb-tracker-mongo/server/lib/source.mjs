import { sportApiConfigured } from './sportApi.mjs';
import { mirrorConfigured } from './mongo.mjs';

/**
 * Where this instance reads its odds from, and therefore what it can show.
 *
 * Two deployments, two answers:
 *
 *   mongo  Running on the tailnet (a laptop, or nas01 itself). Reads
 *          `gutsys_sport` directly and can do everything — price history,
 *          crests, bets, the mapping tables.
 *
 *   api    Running anywhere else, Vercel included. `gutsys_sport` lives on a
 *          Tailscale address that public infrastructure cannot route to, so the
 *          board runs off the tunnelled `sport.gutsysapi.com` surface instead.
 *          That surface publishes prices but not the mapping tables and not
 *          per-price history, so several features have no data to render.
 *
 * The distinction is deliberately explicit rather than a silent fallback: a
 * feature that quietly renders empty is worse than one that says why it is
 * missing, and the UI reads `capabilities` to do exactly that.
 */

export const DATA_SOURCE = process.env.MONGO_URI
  ? 'mongo'
  : sportApiConfigured
    ? 'api'
    : 'none';

export const isMongo = DATA_SOURCE === 'mongo';
export const isApi = DATA_SOURCE === 'api';

/**
 * What this instance can actually serve. The client hides what is unavailable
 * instead of rendering an empty shell of it.
 */
/**
 * The three collections the Atlas mirror carries (`event_mapping`,
 * `competition_mapping`, `entities`), which is what the features below actually
 * need. A deployed instance has no route to the tailnet, so before the mirror
 * existed `isMongo` was false and mapping, crests and bets were all dark —
 * including bets, whose own rows were on Atlas the whole time and only needed
 * `event_mapping` to join through.
 */
const relational = isMongo || mirrorConfigured;

export const CAPABILITIES = {
  source: DATA_SOURCE,
  /** Board, market grid, event pages. */
  odds: DATA_SOURCE !== 'none',
  /**
   * Per-price history. The API source carries the 6h->10m snapshot ladder,
   * opening price and per-book status (via `flucs=true`), but no point-by-point
   * series and no daily 9am prices — so the hover card shows its snapshot rows
   * and draws no sparkline.
   */
  priceHistory: true,
  /** The point-by-point series behind the hover card's sparkline. */
  priceSeries: isMongo,
  /** Club crests and player flags, from the `entities` table. */
  crests: relational,
  /** Bets by brand — joins through `event_mapping`. */
  bets: relational,
  /**
   * The tournament mapping page, and the per-fixture mapping block.
   *
   * The mirror serves this READ-ONLY. It carries competition_mapping and
   * leagues outright, and `league_squads` — the one aggregate the page reads
   * out of `fixtures`, precomputed on the tailnet, 5 MB instead of 148. The
   * book-side candidates were never a problem: they come from Atlas, which a
   * deployed instance can already reach.
   *
   * Writes stay NAS-only. A mapping saved against the mirror would be reverted
   * by the next sync and never reach the source — see MIRROR_SERVES in routes.
   */
  mapping: relational,
  /**
   * Whether mappings can be SAVED, which is a stricter question than whether
   * they can be read. The mirror is a copy: a write against it would be
   * reverted by the next sync and never reach the NAS, so the routes refuse it.
   * The client needs to know that up front — offering an Apply button that the
   * server will quietly decline is worse than not offering one.
   */
  mappingWrite: isMongo,
  /** Browsing arbitrary past dates; the API surface only carries a short window. */
  history: isMongo,
  /** Feed-freshness heartbeats, which read Mongo write timestamps. */
  pulse: isMongo,
};

/** One line for the startup log, so the running mode is never a guess. */
export function describeSource() {
  if (isMongo) return 'mongo (gutsys_sport direct — full feature set)';
  if (isApi) {
    const base = process.env.SPORT_API_URL || 'https://sport.gutsysapi.com';
    return (
      `api (${base} — snapshots but no fluc series` +
      (mirrorConfigured ? '; crests, bets and read-only mapping via the Atlas mirror)' : '; no crests, bets or mapping)')
    );
  }
  return 'none (set MONGO_URI or SPORT_API_KEY)';
}
