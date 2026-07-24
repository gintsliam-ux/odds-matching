// Local team crests live in public/logos/teams/<slug>.png (AFL from Squiggle,
// NRL from TheSportsDB). The slug must match the download script's slugify.

export function teamSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function teamLogoUrl(name: string): string {
  return `/logos/teams/${teamSlug(name)}.png`;
}

/**
 * Short code for the scoreboard ticker. Teams key off the city/first word
 * ("Adelaide Crows" -> ADE, "Milwaukee Brewers" -> MIL); individuals off the
 * surname ("Yannick Hanfmann" -> HAN), since the first name isn't the identity.
 */
export function teamAbbr(name: string, isPerson = false): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const word = (isPerson ? words[words.length - 1] : words[0]) ?? name;
  return word.slice(0, 3).toUpperCase();
}
