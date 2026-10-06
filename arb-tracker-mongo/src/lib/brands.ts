/**
 * One palette for the three bet brands, so a badge means the same thing
 * wherever it appears — the ticker's table, the Latest strip, the brand filter,
 * and the bets panel on an event page.
 *
 * Multis is yellow rather than amber deliberately: amber already means "longer
 * than any book we hold" on the price column and "bonus" on the stake, and a
 * brand badge in the same tone would read as one of those.
 */
export type BetBrand = 'swiftbet' | 'mybet' | 'multis';

export const BRAND_TONE: Record<string, string> = {
  swiftbet: 'bg-sky-500/15 text-sky-300',
  mybet: 'bg-emerald-500/15 text-emerald-300',
  multis: 'bg-yellow-500/15 text-yellow-300',
};

export const BRAND_LABEL: Record<string, string> = {
  swiftbet: 'Swiftbet',
  mybet: 'Mybet',
  multis: 'Multis',
};

/** The badge's own classes, tone included. */
export const brandBadge = (brand: string) =>
  `rounded px-1.5 py-0.5 text-[10px] font-medium ${BRAND_TONE[brand] ?? 'bg-white/10 text-slate-300'}`;
