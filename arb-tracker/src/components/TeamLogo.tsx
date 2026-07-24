import { useState } from 'react';
import { teamLogoUrl } from '../lib/teamLogos';

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

/**
 * The mark beside a competitor: a club crest for teams, a national flag for
 * individuals (tennis), and an initials circle when we have neither — which is
 * also what an unresolved player gets, so a missing flag reads as deliberate.
 */
export function TeamLogo({
  name,
  size = 22,
  country,
}: {
  name: string;
  size?: number;
  /** ISO-3166 alpha-2, lowercased. Flies a flag instead of looking for a crest. */
  country?: string | null;
}) {
  const [broken, setBroken] = useState(false);

  if (broken || (!country && !name)) {
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

  // Flags are 4:3, so they letterbox inside the square slot every other mark
  // uses — keeping rows aligned whether a competitor is a club or a person.
  return (
    <img
      src={country ? `https://flagcdn.com/w80/${country}.png` : teamLogoUrl(name)}
      alt={name}
      title={name}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      className={`inline-block shrink-0 object-contain ${country ? 'rounded-[2px]' : ''}`}
      style={{ width: size, height: size }}
    />
  );
}
