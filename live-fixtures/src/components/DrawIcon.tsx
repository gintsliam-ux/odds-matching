/**
 * The mark beside a draw selection.
 *
 * A draw has no competitor, so there is no crest to show. The sport's own
 * object stands in instead: a ball for soccer, a bat for cricket, a stick for
 * hockey — a soccer ball on every sport reads as wrong on a cricket match.
 *
 * Emoji rather than SVGs on purpose: no icon set we ship covers a cricket bat,
 * and these glyphs are already on every platform the board renders on. A
 * missing crest is worth an em-dash; a missing draw icon is not worth a
 * dependency.
 *
 * Ported from Arb Tracker, keyed here on `sportEmoji`'s own canonicalisation so
 * the glyph matches the one the sidebar and league badges already use.
 */
import { sportEmoji } from '../lib/sports'

export function DrawIcon({ sport, size = 18 }: { sport: string; size?: number }) {
  return (
    <span
      // The chip matches Avatar's monogram fallback, so a draw row lines up with
      // the crested rows above and below it rather than floating.
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/10 leading-none"
      style={{ width: size, height: size, fontSize: size * 0.62 }}
      title={`Draw — ${sport}`}
      role="img"
      aria-label={`Draw (${sport})`}
    >
      {sportEmoji(sport)}
    </span>
  )
}
