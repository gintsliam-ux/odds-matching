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

export function LeagueBadge({ league, size = 36 }: { league: League; size?: number }) {
  // Key the failure to the URL so a new league's badge isn't hidden by the
  // previous one's stale error when this instance is reused across events.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = league.logoUrl && failedUrl !== league.logoUrl;

  if (showImage) {
    // Every badge is the same square tile with the same padding, so logos of any
    // aspect ratio (square crests, wide wordmarks, sparse icons) all render at a
    // consistent size and stay aligned in the rail. The light chip both unifies
    // the look and keeps dark wordmarks (ATP/WTA) legible on the dark rail.
    return (
      <span
        className="inline-grid shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100"
        style={{ width: size, height: size, padding: size * 0.14 }}
      >
        <img
          src={league.logoUrl}
          alt={league.name}
          onError={() => setFailedUrl(league.logoUrl ?? null)}
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
