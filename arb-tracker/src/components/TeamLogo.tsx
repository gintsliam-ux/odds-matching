import { useState } from 'react';
import { teamLogoUrl } from '../lib/teamLogos';

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

/**
 * The mark beside a competitor: a national flag for individuals when we know
 * their country, otherwise a resolved crest/photo (from the entities view),
 * then a local crest, and finally an initials circle. Candidates are tried in
 * order — each 404 falls through to the next, so a missing image degrades
 * gracefully rather than showing a broken tile.
 */
export function TeamLogo({
  name,
  size = 22,
  country,
  logo,
}: {
  name: string;
  size?: number;
  /** ISO-3166 alpha-2, lowercased. Flies a flag ahead of any crest. */
  country?: string | null;
  /** Resolved crest/photo URL from the entities view, if any. */
  logo?: string | null;
}) {
  const flag = country ? `https://flagcdn.com/w80/${country}.png` : null;
  const candidates = [flag, logo || null, name ? teamLogoUrl(name) : null].filter(
    (c): c is string => Boolean(c),
  );

  // Track failed srcs (not a bare boolean) so a new event's fresh URLs aren't
  // hidden behind a stale "broken" from the previous render of this instance.
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const src = candidates.find((c) => !failed.has(c)) ?? null;

  if (!src) {
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
  const isFlag = src === flag;
  return (
    <img
      src={src}
      alt={name}
      title={name}
      width={size}
      height={size}
      onError={() => setFailed((prev) => new Set(prev).add(src))}
      className={`inline-block shrink-0 object-contain ${isFlag ? 'rounded-[2px]' : ''}`}
      style={{ width: size, height: size }}
    />
  );
}
