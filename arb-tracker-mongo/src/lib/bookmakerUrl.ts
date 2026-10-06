/**
 * A link from a bet back to the book's own page for that event.
 *
 * mybet and multis share one shape, differing only in host:
 *
 *   https://www.mybet.com.au/odds/bask/3814812/
 *   https://www.multis.com.au/odds/bask/3814812/
 *
 * The last segment is the event id the bet already carries. The middle is the
 * book's own sport code, which exists nowhere in the data — `mybet_events`
 * stores "Basketball", not "bask" — so it has to be written down here.
 *
 * Only codes that have been CONFIRMED against a real URL belong in this map. A
 * guessed slug produces a link that looks fine and 404s, which is worse than no
 * link: a bet with no code simply renders as it did before.
 */
const MYBET_SPORT_CODE: Record<string, string> = {
  Basketball: 'bask',
  Baseball: 'base',
  Soccer: 'socc',
  Tennis: 'tenn',
  Cricket: 'cric',
  'Ice Hockey': 'nhl',
  'American Football': 'grid',
  'Aussie Rules': 'afl',
  // The books' own spellings too, so this works on anything that has not been
  // through the display vocabulary — mybet writes Gridiron and Australian Rules.
  Gridiron: 'grid',
  'Australian Rules': 'afl',
  Football: 'socc',
};

const HOST: Record<string, string> = {
  mybet: 'www.mybet.com.au',
  multis: 'www.multis.com.au',
  // swiftbet: its URL shape is not known yet.
};

/** The book's page for this event, or null when we cannot build one honestly. */
export function bookmakerUrl(
  brand: string,
  sport: string | null,
  eventId: string | null,
): string | null {
  const host = HOST[brand];
  if (!host || !eventId) return null;
  // mybet mints numeric event ids; anything else is not one of theirs.
  if (!/^\d+$/.test(eventId)) return null;
  const code = sport ? MYBET_SPORT_CODE[sport] : null;
  if (!code) return null;
  return `https://${host}/odds/${code}/${eventId}/`;
}
