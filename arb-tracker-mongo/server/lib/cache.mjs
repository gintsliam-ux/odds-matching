/**
 * A tiny TTL cache with single-flight.
 *
 * The board query is ~1.5s against the NAS and the pulse aggregation ~10s, and
 * the UI polls both on a 60s timer. Without this, every open tab pays full
 * freight and concurrent refreshes pile up on the same connection pool. With it
 * they share one in-flight promise and a warm result.
 *
 * Stale-while-revalidate: once a value is older than its TTL the next caller is
 * served the stale copy and a refresh kicks off behind them, so a slow query
 * never blocks a request after the first one.
 */
const entries = new Map();

/**
 * @param {string} key
 * @param {number} ttlMs How long a value is served without a refresh.
 * @param {() => Promise<any>} produce
 * @param {{maxStaleMs?: number}} [opts] How old a value may be and still be
 *   handed back while the refresh runs. Unbounded by default, which is right
 *   for anything whose meaning does not decay — but see the pulse.
 */
export function cached(key, ttlMs, produce, { maxStaleMs = Infinity } = {}) {
  let e = entries.get(key);
  if (!e) {
    e = { value: undefined, at: 0, inflight: null };
    entries.set(key, e);
  }

  const age = e.value !== undefined ? Date.now() - e.at : Infinity;
  if (age < ttlMs) return Promise.resolve(e.value);

  if (!e.inflight) {
    e.inflight = Promise.resolve()
      .then(produce)
      .then((v) => {
        e.value = v;
        e.at = Date.now();
        return v;
      })
      .finally(() => {
        e.inflight = null;
      });
    // A refresh that fails must not become an unhandled rejection when every
    // caller was served a stale value instead of awaiting it.
    e.inflight.catch(() => {});
  }

  /*
   * Serve stale immediately, unless the caller said how stale is too stale.
   *
   * Unbounded staleness is what made the pulse bar lie. An instance that
   * computed a pulse and then sat idle handed that same reading back on its
   * next request, so the bar reported Optic 47 minutes and Live 104 minutes
   * while every feed was seconds old, then snapped back to 30s on the next
   * poll because a different instance answered. For a payload whose entire
   * content is "how fresh is this", being served an hour-old copy of the
   * answer is worse than waiting for a new one.
   */
  if (age > maxStaleMs) return e.inflight;
  return e.value !== undefined ? Promise.resolve(e.value) : e.inflight;
}

export function invalidate(key) {
  entries.delete(key);
}
