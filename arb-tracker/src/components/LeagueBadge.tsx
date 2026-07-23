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
  const [broken, setBroken] = useState(false);
  const showImage = league.logoUrl && !broken;

  if (showImage) {
    return (
      <img
        src={league.logoUrl}
        alt={league.name}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className="shrink-0 rounded-lg object-contain"
        style={{ width: size, height: size }}
      />
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
