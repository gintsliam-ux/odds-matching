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
};

/*
 * Swiftbet is a different, simpler shape — no sport segment at all:
 *
 *   https://swiftbet.com.au/sports/event/131d2cb3-d10e-583b-9ae5-9966db03f490
 *
 * and that id is exactly the one its bets already carry, so every sport works
 * without a code table. The two are kept apart rather than generalised: a
 * single template with an optional segment would read as though the sport code
 * were incidental to mybet, when it is the part that needs confirming per
 * sport.
 */
const swiftbetUrl = (eventId: string) => `https://swiftbet.com.au/sports/event/${eventId}`;

/** A swiftbet event id — a UUID, where mybet's are numeric. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The book's page for this event, or null when we cannot build one honestly. */
export function bookmakerUrl(
  brand: string,
  sport: string | null,
  eventId: string | null,
): string | null {
  if (!eventId) return null;
  if (brand === 'swiftbet') return UUID.test(eventId) ? swiftbetUrl(eventId) : null;

  const host = HOST[brand];
  if (!host) return null;
  // mybet mints numeric event ids; anything else is not one of theirs.
  if (!/^\d+$/.test(eventId)) return null;
  const code = sport ? MYBET_SPORT_CODE[sport] : null;
  if (!code) return null;
  return `https://${host}/odds/${code}/${eventId}/`;
}

/* ------------------------------------------------- the other books' own sites */

/**
 * Where a bookmaker lives on the web, for the logos above the price columns.
 *
 * A different question from everything above, which deep-links one of OUR
 * brands to one event. This is the competitor whose price is in that column,
 * and there is no per-event URL to build: their own id for the fixture is not
 * something the feed carries. So it is the sports page, and the click is "go
 * and look at them", not "go to this market".
 *
 * Mostly the URL here is the one the site actually SETTLES on, checked rather
 * than typed from memory, because sportsbet does not go where it looks:
 * `sportsbet.com.au/sports` redirects to the homepage, its sports page is
 * `/betting/sports`, and that itself lands on `/betting/upcoming-sports`. Using
 * the resolved address saves the hop and cannot rot the day a redirect is
 * dropped.
 *
 * TAB is the deliberate exception: its bare domain, asked for directly. The
 * resolved sports page was `/sports-betting`, but the home page is where you
 * want to land on that one.
 *
 * bet365 answers 403 to anything that is not a browser, so that one is their
 * published address rather than a confirmed response — and the tracking
 * parameters it is usually copied with (`gclid`, `gbraid`) are an ad-click id
 * belonging to whoever copied it, so they are not carried here.
 *
 * The American books — DraftKings, FanDuel, Fanatics, BetMGM — are absent on
 * purpose. Their prices appear in the grid but nobody has given an address for
 * them, and a guessed one looks fine and 404s, which is worse than no link. A
 * book with no entry simply renders as it did before.
 */
const BOOK_SITE: Record<string, string> = {
  tab: 'https://www.tab.com.au/',
  sportsbet: 'https://www.sportsbet.com.au/betting/upcoming-sports',
  pinnacle: 'https://www.pinnacle.com/en/',
  betfair: 'https://www.betfair.com.au/exchange/plus/',
  // One exchange, one site: the lay column is the same book seen from the
  // other side.
  betfair_lay: 'https://www.betfair.com.au/exchange/plus/',
  bet365: 'https://www.bet365.com.au/#/HO/',
  tabtouch: 'https://www.tabtouch.com.au/sports',
  ladbrokes: 'https://www.ladbrokes.com.au/sports',
};

/** The bookmaker's own site, or null when we have not been given one. */
export function bookmakerSite(bookKey: string | null | undefined): string | null {
  if (!bookKey) return null;
  return BOOK_SITE[String(bookKey).toLowerCase()] ?? null;
}
