import { useState } from 'react'
import { leagueLogoUrl } from '../lib/leagueLogos'
import { sportEmoji } from '../lib/sports'

interface Props {
  sport: string
  league: string
  size?: number
}

/**
 * Competition crest for a fixture. Falls back to the sport emoji when we have
 * no logo for the league, and again if the CDN 404s at render time — the emoji
 * is always the same glyph the card used before, so nothing shifts.
 */
export function LeagueBadge({ sport, league, size = 16 }: Props) {
  const [broken, setBroken] = useState(false)
  const url = leagueLogoUrl(sport, league)

  if (!url || broken) {
    return (
      <span
        className="cursor-help leading-none"
        style={{ fontSize: size * 0.9 }}
        title={sport}
        aria-label={sport}
      >
        {sportEmoji(sport)}
      </span>
    )
  }

  return (
    <img
      src={url}
      alt={league}
      title={sport}
      loading="lazy"
      onError={() => setBroken(true)}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  )
}
