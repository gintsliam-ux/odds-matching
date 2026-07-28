import { useState } from 'react';
import type { Bookmaker } from '../lib/markets';

/**
 * Company logo for a bookmaker. Renders `logoUrl` when present, otherwise a
 * branded mark chip (solid brand colour + short code) so the grid always has a
 * recognisable logo. Drop real logo URLs onto the Bookmaker entries later.
 */
export function BookmakerLogo({
  brand,
  size = 22,
}: {
  brand: Bookmaker;
  size?: number;
}) {
  // Keyed to the URL so reusing this instance for a different brand doesn't
  // inherit the previous one's stale error and fall back to the mark chip.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (brand.logoUrl && failedUrl !== brand.logoUrl) {
    return (
      <img
        src={brand.logoUrl}
        alt={brand.name}
        title={brand.name}
        height={size}
        onError={() => setFailedUrl(brand.logoUrl ?? null)}
        className="inline-block rounded object-contain"
        style={{ height: size, maxWidth: size * 2.4 }}
      />
    );
  }

  return (
    <span
      title={brand.name}
      className="inline-flex items-center justify-center rounded font-bold uppercase leading-none tracking-tight text-white"
      style={{
        backgroundColor: brand.color,
        height: size,
        minWidth: size,
        padding: '0 4px',
        fontSize: size * 0.42,
      }}
    >
      {brand.mark}
    </span>
  );
}
