// Central brand-colour system. One colour per data source (see index.css):
//   OPTIC = orange (--optic) · SwiftBet = blue (--swift) · mybet = green (--mybet)
//
// Every badge/pill/panel/chip that represents a book should pull its classes
// from here so the whole app recolours from one place. The strings are literal
// (no interpolation) so Tailwind's static extractor keeps them.

export type Brand = 'optic' | 'swift' | 'mybet'

export const BRAND_LABEL: Record<Brand, string> = {
  optic: 'OPTIC',
  swift: 'SWIFT',
  mybet: 'MYBET',
}

/** Bordered pill: border + text + faint fill. */
export const BRAND_PILL: Record<Brand, string> = {
  optic: 'border-[color:var(--optic)]/30 text-[color:var(--optic)] bg-[color:var(--optic)]/10',
  swift: 'border-[color:var(--swift)]/30 text-[color:var(--swift)] bg-[color:var(--swift)]/10',
  mybet: 'border-[color:var(--mybet)]/30 text-[color:var(--mybet)] bg-[color:var(--mybet)]/10',
}

/** Just the brand text colour. */
export const BRAND_TEXT: Record<Brand, string> = {
  optic: 'text-[color:var(--optic)]',
  swift: 'text-[color:var(--swift)]',
  mybet: 'text-[color:var(--mybet)]',
}

/** Panel tone (flat): a thin brand-coloured top accent + barely-there tinted
 *  fill, no full outline. */
export const BRAND_TONE: Record<Brand, string> = {
  optic: 'border-t-2 border-[color:var(--optic)]/50 bg-[color:var(--optic)]/[0.04]',
  swift: 'border-t-2 border-[color:var(--swift)]/50 bg-[color:var(--swift)]/[0.04]',
  mybet: 'border-t-2 border-[color:var(--mybet)]/50 bg-[color:var(--mybet)]/[0.04]',
}

/** Chip tone (mapping table): brand border + light fill. */
export const BRAND_CHIP: Record<Brand, string> = {
  optic: 'border-[var(--optic)]/30 bg-[var(--optic)]/[0.06]',
  swift: 'border-[var(--swift)]/30 bg-[var(--swift)]/[0.06]',
  mybet: 'border-[var(--mybet)]/30 bg-[var(--mybet)]/[0.06]',
}

/** Solid dot (header pulse label, nav). */
export const BRAND_DOT: Record<Brand, string> = {
  optic: 'bg-[color:var(--optic)]',
  swift: 'bg-[color:var(--swift)]',
  mybet: 'bg-[color:var(--mybet)]',
}
