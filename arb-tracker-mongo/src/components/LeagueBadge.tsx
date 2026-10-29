import { useState } from 'react';
import type { League } from '../lib/types';

// Deterministic colour per league so the emblem is stable across renders.
const PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * How much of the tile to give away as padding.
 *
 * A square tile suits a square crest and starves anything else. Measured
 * across the league logos actually on the board, the aspect ratios run from
 * 0.44 to 4.34 — the NBA's mark is 330x751, and at the old flat 14% it
 * rendered 9.5px wide by 21.6 tall inside a 30px tile: 23% of the badge,
 * beside an NHL crest filling 50%. It read as broken rather than tall.
 *
 * `object-contain` fits the long side, so for an extreme ratio the padding is
 * subtracted from the dimension that was already the binding constraint. The
 * squarer a logo is, the more it can afford; the further from square, the
 * less it can. A 0.44 mark now fills the tile's full height.
 */
const padFor = (ratio: number | null, size: number): number => {
  if (ratio == null) return size * 0.12;
  const squareness = Math.min(ratio, 1 / ratio);   // 1 is square, 0.23 is the NBA
  return size * (squareness > 0.8 ? 0.12 : squareness > 0.55 ? 0.07 : 0.02);
};

export function LeagueBadge({ league, size = 36 }: { league: League; size?: number }) {
  // Key the failure to the URL so a new league's badge isn't hidden by the
  // previous one's stale error when this instance is reused across events.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Known only once the image has loaded, so the first paint uses the middle
  // padding and settles rather than jumping from nothing.
  const [ratio, setRatio] = useState<number | null>(null);
  const showImage = league.logoUrl && failedUrl !== league.logoUrl;

  if (showImage) {
    // Every badge is the same square tile, so logos of any aspect ratio stay
    // aligned in the rail. The light chip unifies the look and keeps dark
    // wordmarks (ATP/WTA) legible on the dark rail.
    return (
      <span
        className="inline-grid shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100"
        style={{ width: size, height: size, padding: padFor(ratio, size) }}
      >
        <img
          src={league.logoUrl}
          alt={league.name}
          onError={() => setFailedUrl(league.logoUrl ?? null)}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w && h) setRatio(w / h);
          }}
          className="max-h-full max-w-full object-contain"
        />
      </span>
    );
  }

  const color = colorFor(league.id);
  return (
    <div
      className="grid shrink-0 place-items-center rounded-lg font-semibold"
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}22`,
        color,
        fontSize: size * 0.3,
      }}
      title={league.name}
    >
      {league.code}
    </div>
  );
}
