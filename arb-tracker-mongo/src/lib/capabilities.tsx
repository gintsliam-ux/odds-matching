import { useEffect, useState } from 'react';
import { fetchCapabilities, FULL_CAPABILITIES, type Capabilities } from './db';
import { CapabilitiesContext } from './capabilitiesContext';

/**
 * What the running instance can serve, fetched once.
 *
 * Deployed, this app reads the public odds surface instead of `gutsys_sport`,
 * which is only reachable from the tailnet — so bets, mapping, crests and price
 * history have no data behind them. Features check here and stay out of the way
 * rather than rendering an empty version of themselves.
 *
 * It starts optimistic: assuming the full set until the answer arrives means a
 * local run never flickers a tab away and back.
 */
export function CapabilitiesProvider({ children }: { children: React.ReactNode }) {
  const [caps, setCaps] = useState<Capabilities>(FULL_CAPABILITIES);

  useEffect(() => {
    let alive = true;
    fetchCapabilities()
      .then((c) => {
        if (alive) setCaps(c);
      })
      .catch(() => {
        /* an unreachable API is the health pill's job to report, not this one's */
      });
    return () => {
      alive = false;
    };
  }, []);

  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>;
}
