import { useEffect, useState } from 'react';
import { teamLogoUrl } from '../lib/teamLogos';
import { needsLightChip } from '../lib/logoContrast';

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
  // flagcdn is case-sensitive: /w80/JO.png is a 404 while /w80/jo.png is the
  // flag. Wikidata hands back uppercase ISO codes, so 2,039 players — two
  // thirds of everyone we had a country for — silently fell through to
  // initials. Lowercase here as well as at the source, so one bad write can
  // never take the flags out again.
  const flag = country ? `https://flagcdn.com/w80/${country.toLowerCase()}.png` : null;
  const candidates = [flag, logo || null, name ? teamLogoUrl(name) : null].filter(
    (c): c is string => Boolean(c),
  );

  // Track failed srcs (not a bare boolean) so a new event's fresh URLs aren't
  // hidden behind a stale "broken" from the previous render of this instance.
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const src = candidates.find((c) => !failed.has(c)) ?? null;

  // Some crests are drawn entirely in near-black and vanish against the dark
  // surface. Measured once per URL, off the render path, so the logo shows
  // immediately and gains its tile a beat later if it turns out to need one.
  const [chip, setChip] = useState(false);
  useEffect(() => {
    if (!src || src === flag) return setChip(false);
    let alive = true;
    needsLightChip(src).then((need) => {
      if (alive) setChip(need);
    });
    return () => {
      alive = false;
    };
  }, [src, flag]);

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
  const img = (
    <img
      src={src}
      alt={name}
      title={name}
      width={size}
      height={size}
      onError={() => setFailed((prev) => new Set(prev).add(src))}
      className={`inline-block shrink-0 object-contain ${isFlag ? 'rounded-[2px]' : ''}`}
      style={{ width: chip ? size - 4 : size, height: chip ? size - 4 : size }}
    />
  );

  if (!chip) return img;
  // A crest drawn entirely in near-black gets a light tile to sit on, so it
  // reads the way every other crest does. The tile takes the full slot and the
  // image shrinks inside it, so rows stay aligned either way.
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] bg-slate-200"
      style={{ width: size, height: size }}
    >
      {img}
    </span>
  );
}
