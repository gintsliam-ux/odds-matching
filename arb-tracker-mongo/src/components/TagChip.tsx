/**
 * The book's own risk tag on this bettor, shown under their id.
 *
 * Shared by the ticker and the pending-bets page. The colour scheme is a
 * judgement about which tags matter, and two copies of that judgement would
 * drift — a punter painted red on one page and grey on the other is worse than
 * either choice made consistently.
 *
 * Several are common on the swiftbet side ("Good client|Tier 4"), so the
 * highest-priority one shows and the rest are counted, with all of them on
 * hover.
 *
 * Colours are per the desk's own scheme, matched against the 46 tag values that
 * actually occur rather than guessed at:
 *
 *   Monitor                            yellow
 *   VIP                                green
 *   Good client / normal               blue — deeper than the sky the swiftbet
 *                                      brand chip uses, so the two do not read
 *                                      as the same thing in one row
 *   Bonus hunter                       aqua
 *   Sharp / hard                       red
 *   small                              orange
 *
 * Everything else — watch, the Tiers, no bonus, Not eligible for promos,
 * Potential bowler — stays grey. Most rows carry a tag, and a table where every
 * row shouts says nothing.
 */
const TAG_TONES: { test: RegExp; tone: string; rank: number }[] = [
  // Red first: when a punter is both sharp and small, sharp is the point.
  { test: /\bsharp\b|\bhard\b/i, tone: 'bg-rose-500/15 text-rose-300', rank: 0 },
  { test: /\bmonitor\b/i, tone: 'bg-yellow-500/15 text-yellow-300', rank: 1 },
  { test: /bonus hunter/i, tone: 'bg-cyan-500/15 text-cyan-300', rank: 2 },
  { test: /\bsmall\b/i, tone: 'bg-orange-500/15 text-orange-300', rank: 3 },
  /*
   * Above "Good client" and below every warning. A VIP who is also flagged
   * Monitor is still a Monitor row — the warning is the thing you need to see —
   * but a VIP who is also a good client is a VIP, which is the more specific of
   * the two and the one worth the colour.
   *
   * Word-anchored because the tag arrives as "vip", "VIP" and "vip (no
   * promos)", and the parenthesised half must not change what it is.
   */
  { test: /\bvip\b/i, tone: 'bg-emerald-500/15 text-emerald-300', rank: 4 },
  { test: /good client|\bnormal\b/i, tone: 'bg-blue-600/25 text-blue-300', rank: 5 },
];

const QUIET = 'bg-white/5 text-slate-500';

/**
 * A tag's colour, or none.
 *
 * "Not sharp, milks offers" is why this cannot be a plain substring match: it
 * contains "sharp" and means the opposite, so a negation is checked first. It
 * is a rare tag, and a punter wrongly painted red is the one mistake this
 * colouring must not make.
 */
const NEGATED = /\bnot\s+sharp\b/i;

function toneOf(tag: string): { tone: string; rank: number } {
  if (!NEGATED.test(tag)) {
    for (const t of TAG_TONES) if (t.test.test(tag)) return { tone: t.tone, rank: t.rank };
  }
  return { tone: QUIET, rank: 99 };
}

export function TagChip({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  // The most serious tag leads, so a row's colour is its worst news and the
  // label beside it is the tag that earned the colour.
  const ranked = [...tags].sort((a, b) => toneOf(a).rank - toneOf(b).rank);
  const [first, ...rest] = ranked;
  const { tone } = toneOf(first);
  return (
    <span
      title={tags.join(' · ')}
      className={`inline-flex max-w-full items-center gap-0.5 rounded px-1.5 py-0.5 text-xs leading-none ${tone}`}
    >
      <span className="truncate">{first}</span>
      {rest.length > 0 && <span className="shrink-0 opacity-60">+{rest.length}</span>}
    </span>
  );
}
