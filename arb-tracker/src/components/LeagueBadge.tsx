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
    // Every badge is the same square so the rail stays aligned. Wordmarks are
    // dark and wide, so they get a light chip to sit on and letterbox inside it.
    const boxStyle = league.wordmark
      ? { width: size, height: size, padding: size * 0.1 }
      : { width: size, height: size };
    return (
      <span
        className={`inline-grid shrink-0 place-items-center rounded-lg ${
          league.wordmark ? 'bg-slate-100' : ''
        }`}
        style={boxStyle}
      >
        <img
          src={league.logoUrl}
          alt={league.name}
          onError={() => setBroken(true)}
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
