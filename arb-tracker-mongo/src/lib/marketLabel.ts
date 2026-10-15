/**
 * How a market reads on screen.
 *
 * Shared by the ticker's table and the bets panel on an event page: the same
 * bet should not read "head to head" in one place and "H2H" in the other.
 */
/** Lowercase inside a title, capitalised at the start of one. */
const SMALL_WORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'vs', 'v', 'inc', 'by']);

/** Already an abbreviation — "MLB", "K.", "2026" — so leave it alone. */
const ALREADY_SHOUTING = /^[A-Z0-9.+\-/]{2,}$/;

/**
 * Uppercase the first letter, looking past leading PUNCTUATION but not digits.
 *
 * Character zero is not always a letter: "(Odd/Even)" came out "(odd/Even)",
 * because uppercasing "(" achieves nothing and the "o" behind it kept the
 * lowercase it had been folded to.
 *
 * Reaching for the first letter anywhere is the obvious fix and the wrong one —
 * it turns "1st" into "1St" and "36ers" into "36Ers", which is why the digits
 * are excluded from the skip. An ordinal's letters belong lowercase.
 */
const capitalise = (w: string) =>
  w.replace(/^([^a-z0-9]*)([a-z])/, (_, lead: string, c: string) => lead + c.toUpperCase());

const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .map((w, i) => {
      if (ALREADY_SHOUTING.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // Split on the slash too, or "half time/full time" keeps a lowercase
      // "full" in the middle of an otherwise capitalised title.
      return lower.split('/').map(capitalise).join('/');
    })
    .join(' ');

/** Words that only describe the market itself, carrying no further detail. */
const MARKET_VOCAB = /^(alternate|alt|total|totals|line|lines|over|under|handicap|spread|points?|goals?|runs?|games?|sets?)$/;

/** A segment made of nothing but market words adds nothing once shortened. */
const allMarketWords = (seg: string) =>
  seg.split(/\s+/).filter(Boolean).every((w) => MARKET_VOCAB.test(w.toLowerCase()));

/**
 * How a market reads in the table.
 *
 * Each book writes the same market its own way — "head to head", "win match
 * inc overtime" — so the common ones collapse to one short label, and the rest
 * are title-cased rather than left in whatever case they arrived in.
 *
 * Alternate markets shed their line and side, which the Outcome column already
 * carries ("Total Over 22.5 games"), but keep anything that says WHOSE market
 * it is. "Alternate Total Over - Denver Nuggets" is that team's total, not the
 * match's — a different market, priced differently, and the surface carries no
 * team totals at all, so the blank row of books only makes sense once the
 * column says which it was.
 */
/** Long words with a settled short form. Applied last, to whatever survives. */
const abbreviate = (s: string) =>
  s
    .replace(/\bQuarters\b/g, 'Qtrs')
    .replace(/\bQuarter\b/g, 'Qtr')
    // Whatever "Alternate" survives the pass below is shortened here, so
    // "Alternate Winning Margin" reads "Alt Winning Margin" without needing a
    // rule of its own.
    .replace(/\bAlternate\b/g, 'Alt');

export function marketLabel(market: string | null): string {
  return abbreviate(marketLabelFor(market));
}

function marketLabelFor(market: string | null): string {
  if (!market) return '–';
  const k = market.toLowerCase();
  if (k.includes('alternate')) {
    /*
     * The short label goes WHERE THE SEGMENT IT REPLACES WAS, and only when
     * there is such a segment.
     *
     * It used to force "Alt Total" or "Alt Line" to the front and then append
     * whatever survived, which doubled up the moment the alternate segment
     * carried real detail: "Alternate Winning Margin" came out as "Alt Line -
     * Alternate Winning Margin", naming a line where there is no line. A
     * winning margin is not a handicap.
     *
     * So a segment of nothing but market words — "Alternate Total Over",
     * "Alternate Lines" — collapses to one label in its own place, because the
     * line and the side are already in the Outcome column. A segment carrying
     * anything else is kept whole and merely shortened, and the order survives:
     * "1st Quarter - Alternate Lines - Adelaide 36ers" stays in that order
     * rather than leading with the base.
     */
    const out: string[] = [];
    let replaced = false;
    for (const seg of market.split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean)) {
      if (allMarketWords(seg)) {
        if (/\balt(ernate)?\b/i.test(seg) && !replaced) {
          out.push(/total/i.test(seg) ? 'Alt Total' : 'Alt Line');
          replaced = true;
        }
        continue;
      }
      out.push(titleCase(seg));
    }
    return out.join(' - ');
  }
  if (/win[- ]draw[- ]win/.test(k)) return 'W-D-W';
  if (/^(head to head|h2h|moneyline|money line|match result)$/.test(k.trim())) return 'H2H';
  if (/\bwin match inc overtime\b/.test(k)) return 'H2H';
  return titleCase(market);
}
