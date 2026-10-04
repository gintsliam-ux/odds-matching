/**
 * The mark beside a draw selection.
 *
 * A draw has no competitor, so there is no crest to show — the slot used to
 * carry a soccer ball whatever the sport, which reads as wrong on a cricket
 * match. The sport's own object stands in instead: a ball for soccer, a bat for
 * cricket, a stick for hockey.
 *
 * These are emoji rather than SVGs on purpose. No icon set we ship covers a
 * cricket bat, and the glyphs are already on every platform we render on — a
 * missing crest is worth an em-dash, a missing draw icon is not worth a
 * dependency.
 */

/** Keyed on the display sport (SPORT_LABEL in db.ts), lowercased. */
const SPORT_GLYPH: Record<string, string> = {
  soccer: '⚽',
  cricket: '🏏',
  'rugby league': '🏉',
  'rugby union': '🏉',
  'aussie rules': '🏉',
  'ice hockey': '🏒',
  baseball: '⚾',
  basketball: '🏀',
  'american football': '🏈',
  tennis: '🎾',
  boxing: '🥊',
  mma: '🥊',
  darts: '🎯',
  golf: '⛳',
  volleyball: '🏐',
  handball: '🤾',
  snooker: '🎱',
  'table tennis': '🏓',
  badminton: '🏸',
  motorsport: '🏎️',
  esports: '🎮',
};

/** A handshake for anything unlisted — still says "neither side" at a glance. */
const FALLBACK = '🤝';

export function DrawIcon({ sport, size = 18 }: { sport: string; size?: number }) {
  const glyph = SPORT_GLYPH[sport.trim().toLowerCase()] ?? FALLBACK;
  return (
    <span
      // The chip matches TeamLogo's initials fallback, so a draw row lines up
      // with the crested rows above and below it rather than floating.
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/10 leading-none"
      style={{ width: size, height: size, fontSize: size * 0.62 }}
      title={`Draw — ${sport}`}
      role="img"
      aria-label={`Draw (${sport})`}
    >
      {glyph}
    </span>
  );
}
