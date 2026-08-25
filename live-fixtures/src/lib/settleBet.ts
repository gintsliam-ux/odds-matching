// Best-effort CLIENT-SIDE reading of a bet selection against a fixture's score.
//
// This is NOT how a bet's result is decided. A result shown to the user always
// comes from the book / DB; an unresulted leg reads Open. This has exactly two
// remaining callers, neither of which labels a bet:
//   1. the LIVE P/L projection, which needs a provisional outcome so in-play
//      exposure ticks (shown as an explicitly live estimate), and
//   2. the mis-settlement check, which compares a leg the book HAS settled
//      against the final score and flags a Won<->Lost contradiction.
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
/**
 * Words that identify a club's *type*, not the club. Matching on these is what
 * graded "Incheon United FC" as the away side of Rhode Island v Loudoun
 * United, and "Real Monarchs SLC" as Real Salt Lake.
 */
const GENERIC_TEAM_WORDS = new Set([
  'club', 'clube', 'city', 'town', 'united', 'utd', 'athletic', 'atletico', 'atlético',
  'sport', 'sports', 'sporting', 'deportivo', 'deportes', 'real', 'racing', 'rovers',
  'wanderers', 'county', 'academy', 'reserves', 'youth', 'women', 'womens', 'ladies',
  'football', 'futbol', 'fútbol', 'futebol', 'calcio', 'sociedad', 'social',
])

const teamTokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !GENERIC_TEAM_WORDS.has(w))

/** Whole-word test. `includes` matched "city" inside "Cityscape". */
const hasWord = (haystack: string, w: string) =>
  new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack)

/**
 * Which side of THIS fixture an outcome names.
 *
 * Scored against both teams with a strict winner required, rather than
 * "any shared word over three characters wins". That rule matched on club-type
 * words — united, city, real, athletic — so a leg naming a team from a
 * DIFFERENT fixture still resolved to a side here and was graded against the
 * wrong team. Measured over 300 live fixtures, 217 of them would resolve some
 * unrelated club to home or away.
 *
 * Returning null is the safe answer: the bet shows as ungraded rather than
 * confidently wrong.
 */
function teamSide(text: string, home: string, away: string): 'home' | 'away' | 'draw' | null {
  const o = text.toLowerCase()
  if (/\b(draw|tie|the draw)\b/.test(o)) return 'draw'
  // Betting vocabulary, not part of any club's name.
  const BET_WORDS = /\b(to|win|wins|winner|draw|over|under|handicap|line|team|total|both|score|half|full|time)\b/g
  const textTokens = teamTokens(o.replace(BET_WORDS, ' '))

  // Scored BOTH ways. Measuring only "how much of the team appears in the
  // text" cannot see a word the text has and the team does not — which is the
  // whole failure: "Incheon United FC" contains every distinctive word of
  // nothing, yet shares `united` with half the clubs on earth. Requiring the
  // text's own words to be covered by the team rejects it.
  const score = (name: string) => {
    const ts = teamTokens(name)
    if (!ts.length) return 0
    const teamInText = ts.filter((w) => hasWord(o, w)).length / ts.length
    if (!textTokens.length) return teamInText
    const textInTeam =
      textTokens.filter((w) => ts.some((t) => t === w || t.startsWith(w) || w.startsWith(t))).length /
      textTokens.length
    return Math.min(teamInText, textInTeam)
  }
  const h = score(home)
  const a = score(away)
  // A real naming matches most of one side and beats the other outright.
  if (h > a && h >= 0.5) return 'home'
  if (a > h && a >= 0.5) return 'away'
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
