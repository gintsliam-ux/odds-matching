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
