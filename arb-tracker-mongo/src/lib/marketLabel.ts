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

const capitalise = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

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
  s.replace(/\bQuarters\b/g, 'Qtrs').replace(/\bQuarter\b/g, 'Qtr');

export function marketLabel(market: string | null): string {
  return abbreviate(marketLabelFor(market));
}

function marketLabelFor(market: string | null): string {
  if (!market) return '–';
  const k = market.toLowerCase();
  if (k.includes('alternate')) {
    const base = k.includes('total') ? 'Alt Total' : 'Alt Line';
    const rest = market
      .split(/\s+-\s+/)
      .map((seg) => seg.trim())
      .filter((seg) => seg && !allMarketWords(seg))
      .map(titleCase);
    return [base, ...rest].join(' - ');
  }
  if (/win[- ]draw[- ]win/.test(k)) return 'W-D-W';
  if (/^(head to head|h2h|moneyline|money line|match result)$/.test(k.trim())) return 'H2H';
  if (/\bwin match inc overtime\b/.test(k)) return 'H2H';
  return titleCase(market);
}
