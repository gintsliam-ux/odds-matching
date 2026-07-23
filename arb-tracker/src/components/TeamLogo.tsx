import { useState } from 'react';
import { teamLogoUrl } from '../lib/teamLogos';

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

/** Team crest with an initials-circle fallback if the image is missing. */
export function TeamLogo({ name, size = 22 }: { name: string; size?: number }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <span
        title={name}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/10 font-semibold text-slate-300"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {initials(name)}
      </span>
    );
  }

  return (
    <img
      src={teamLogoUrl(name)}
      alt={name}
      title={name}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      className="inline-block shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  );
}
