// Best-effort CLIENT-SIDE settlement of a bet selection from a fixture's FINAL
// score — a fallback for when the book / DB hasn't settled a leg yet.
//
// DELIBERATELY CONSERVATIVE. Mis-settling (showing a wrong Won/Lost) is worse
// than leaving a leg pending, so we only handle full-match markets a final
// score can decide unambiguously:
//   • Match Winner / Moneyline / Head-to-Head / Win-Draw-Win
//   • Total Over/Under (match total, and team totals when the team is named)
// Everything else — any period/half/quarter/inning market, handicaps/spreads,
// props, correct score, BTTS, combos, exotics — returns null and stays pending.

export type Settlement = 'Won' | 'Lost' | 'Push'

export interface ScoreCtx {
  status: string // 'completed' | 'live' | 'upcoming'
  homeScore: number | null
  awayScore: number | null
  homeName: string
  awayName: string
}

export interface SettleSel {
  market: string | null
  mt: string | null
  outcome: string | null
}

// Any of these in the market/outcome means a final score can't decide it.
const NOT_FULL_MATCH =
  /\b(1st|2nd|3rd|4th|first|second|third|fourth|half|quarter|period|inning|set|after \d|player|both teams|correct score|odd\/even|odd or even|race to|margin|method|double chance|draw no bet|no bet|handicap|spread|run ?line|puck ?line|line\b|alternative|to score|anytime|first to|exact)\b/i

function num(s: string | null): number | null {
  const m = (s ?? '').match(/[+-]?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** Which side an outcome/market names, by matching team-name tokens. */
function teamSide(text: string, home: string, away: string): 'home' | 'away' | 'draw' | null {
  const o = text.toLowerCase()
  if (/\b(draw|tie|the draw)\b/.test(o)) return 'draw'
  const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
  const hit = (name: string) => {
    const ts = tok(name)
    return ts.length > 0 && ts.some((w) => o.includes(w))
  }
  const h = hit(home)
  const a = hit(away)
  if (h && !a) return 'home'
  if (a && !h) return 'away'
  return null
}

/**
 * Returns a settlement if (and only if) this is a full-match market a score can
 * decide; otherwise null (caller leaves the leg pending).
 *
 * By default only settles COMPLETED games (a final result). Pass
 * `{ allowLive: true }` to also evaluate a LIVE game against its current score —
 * a provisional mark-to-now used for the live-liability P/L, NOT for claiming a
 * leg has settled.
 */
export function settleFromScore(
  sel: SettleSel,
  ctx: ScoreCtx,
  opts?: { allowLive?: boolean },
): Settlement | null {
  if (ctx.status !== 'completed' && !(opts?.allowLive && ctx.status === 'live')) return null
  const hs = ctx.homeScore
  const as = ctx.awayScore
  if (hs == null || as == null) return null

  const mt = (sel.mt ?? sel.market ?? '').toLowerCase()
  const out = (sel.outcome ?? '').toLowerCase()
  const blob = `${mt} ${out}`
  if (NOT_FULL_MATCH.test(blob)) return null

  const total = hs + as
  const won = (b: boolean): Settlement => (b ? 'Won' : 'Lost')

  // --- Total Over/Under (match total, or team total when a team is named) ---
  if (/total|over\s*\/?\s*under/.test(mt) && /(over|under)/.test(out)) {
    const line = num(out) ?? num(mt)
    if (line == null) return null
    const s = teamSide(out, ctx.homeName, ctx.awayName)
    const score = s === 'home' ? hs : s === 'away' ? as : total
    if (score === line) return 'Push'
    return won(/over/.test(out) ? score > line : score < line)
  }

  // --- Match Winner / Moneyline / H2H / Win-Draw-Win / Result ---
  if (
    /match winner|money\s*line|head\s*to\s*head|moneyline|win-draw-win|1x2|match result|^result|to win/.test(mt) ||
    /\bwin\b/.test(out)
  ) {
    const s = teamSide(out, ctx.homeName, ctx.awayName)
    if (s === 'home') return won(hs > as)
    if (s === 'away') return won(as > hs)
    if (s === 'draw') return won(hs === as)
  }
  return null
}
