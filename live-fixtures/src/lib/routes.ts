/**
 * URL building and parsing for the two detail pages.
 *
 * Both used to be addressed by a bare OPTIC id — `/fixture/20260811F6448802`,
 * `/golf/317375A8D3AF43F8`. Those are unreadable in a browser history, in a
 * chat message, or in a bug report: you cannot tell a WNBA game from a Bulgarian
 * second-division one without opening it.
 *
 * So the id now travels behind a slug: `/fixture/seattle-storm-v-chicago-sky-20260811F6448802`.
 * The id is still the thing looked up — the slug is decoration and is never
 * trusted, which means a stale slug (a team renamed, a tournament re-titled)
 * still resolves, and every old bare-id link keeps working.
 */

/** OPTIC ids are 16 hex characters. Anchored to the END so a slug in front of
 *  one is stripped cleanly, and a bare id still matches. */
const ID_RE = /([0-9a-f]{16})$/i

/**
 * Pull the OPTIC id out of a route param that may or may not carry a slug.
 *
 * Returns '' when there is no id in there at all. It must NOT fall back to the
 * raw param: `/fixture/does-not-exist` would then be looked up as an id, and
 * the page sat on a loading skeleton forever instead of saying the fixture
 * isn't there.
 */
export function idFromParam(param: string | undefined): string {
  if (!param) return ''
  return ID_RE.exec(decodeURIComponent(param))?.[1] ?? ''
}

/** Lower-case, hyphenated, ASCII-folded. Accents fold rather than vanish, so
 *  "Atlético" is "atletico" and not "atltico". */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** `/fixture/seattle-storm-v-chicago-sky-20260811F6448802`, or the bare id when
 *  there are no team names to build from (an outright, a TBD fixture). */
export function fixturePath(
  id: string,
  opts: { home?: string | null; away?: string | null; tab?: string } = {},
): string {
  const names = [opts.home, opts.away].filter(Boolean).map((n) => slugify(n as string)).filter(Boolean)
  const slug = names.length === 2 ? `${names[0]}-v-${names[1]}` : names[0] ?? ''
  const seg = slug ? `${slug}-${id}` : id
  return `/fixture/${encodeURIComponent(seg)}${opts.tab && opts.tab !== 'details' ? `/${opts.tab}` : ''}`
}

/** `/golf/wyndham-championship-2026-317375A8D3AF43F8`. */
export function golfPath(id: string, opts: { tournament?: string | null; tab?: string } = {}): string {
  const slug = opts.tournament ? slugify(opts.tournament) : ''
  const seg = slug ? `${slug}-${id}` : id
  return `/golf/${encodeURIComponent(seg)}${opts.tab && opts.tab !== 'details' ? `/${opts.tab}` : ''}`
}
