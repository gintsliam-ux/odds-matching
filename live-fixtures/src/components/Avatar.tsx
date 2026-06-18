import { useState } from 'react'

interface Props {
  name: string
  /** Real logo/headshot URL when the feed has one; falls back to a monogram. */
  logoUrl?: string | null
  /** Optional secondary URL to try if `logoUrl` 404s — used so ESPN-first
   *  resolution can degrade to a cached Wikipedia URL before going to monogram. */
  fallbackLogoUrl?: string | null
  size?: number
}

/** Team/player marker: shows the logo/headshot if a URL is provided (with a
 *  graceful fallback), otherwise a deterministic colored monogram of the name. */
export function Avatar({ name, logoUrl, fallbackLogoUrl, size = 20 }: Props) {
  const [stage, setStage] = useState<0 | 1 | 2>(0) // 0=primary, 1=fallback, 2=monogram
  const h = hue(name)

  const current = stage === 0 ? logoUrl : stage === 1 ? fallbackLogoUrl : null
  if (current) {
    return (
      <img
        key={current}
        src={current}
        alt={name}
        loading="lazy"
        onError={() => setStage((s) => ((s + 1) as 0 | 1 | 2))}
        className="shrink-0 rounded-full bg-black/30 object-contain"
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `hsl(${h} 36% 22%)`,
        color: `hsl(${h} 70% 78%)`,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}
