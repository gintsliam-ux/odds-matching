/**
 * A tiny TTL cache with single-flight.
 *
 * The competition scan for a sport groups every one of its fixtures — 63k for
 * soccer — and the library asks for it on every sidebar open. The per-fixture
 * odds read is cheap but gets hammered when you click down a month's list.
 * Without this, every open tab pays full freight and concurrent refreshes pile
 * up on the same connection pool; with it they share one in-flight promise and
 * a warm result.
 *
 * Stale-while-revalidate: once a value is older than its TTL the next caller is
 * served the stale copy and a refresh kicks off behind them, so a slow query
 * never blocks a request after the first one.
 */
const entries = new Map();

export function cached(key, ttlMs, produce) {
  let e = entries.get(key);
  if (!e) {
    e = { value: undefined, at: 0, inflight: null };
    entries.set(key, e);
  }

  const fresh = e.value !== undefined && Date.now() - e.at < ttlMs;
  if (fresh) return Promise.resolve(e.value);

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

  // Serve stale immediately if we have anything; otherwise wait for the first fill.
  return e.value !== undefined ? Promise.resolve(e.value) : e.inflight;
}

export function invalidate(key) {
  entries.delete(key);
}
