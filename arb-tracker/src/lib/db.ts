import { supabase } from './supabase';
import type { EventStatus, League, PeriodScore, SportEvent } from './types';
import type { OddsRow } from './markets';

// The board now reads one unified schema (project aucplqygawlpijzbfvjb):
//   fixtures — one row per event, every sport (sport/category/optic_league/…)
//   odds     — one tall row per (fixture, market, selection, line, book, …)
// with entities/fixture_entities serving logos + flags. This replaces the old
// per-sport <key>_events / <key>_odds tables.

/** How far back to load finished events (the UI drops finals after 24h). */
const WINDOW_MS = 48 * 60 * 60 * 1000;

// Sport slug (fixtures.sport) -> the human label the UI filters + PERIOD_PREFIX
// key off. Anything not listed is title-cased from its slug.
const SPORT_LABEL: Record<string, string> = {
  soccer: 'Soccer',
  tennis: 'Tennis',
  baseball: 'Baseball',
  basketball: 'Basketball',
  aussierules: 'Aussie Rules',
  amfootball: 'American Football',
  rugbyleague: 'Rugby League',
  mma: 'MMA',
  golf: 'Golf',
  darts: 'Darts',
  boxing: 'Boxing',
  cricket: 'Cricket',
  icehockey: 'Ice Hockey',
};

// Sports carried by the schema that we don't surface yet.
const SKIP_SPORTS = new Set(['esports']);

// Sports whose competitors are individuals: they fly a national flag (or fall
// back to initials), never a headshot — so we don't attach the entity photo.
const PERSON_SPORTS = new Set(['tennis', 'mma', 'boxing', 'golf', 'darts']);

// Words to fully uppercase rather than title-case in league/competition names.
const ACRONYMS = new Set([
  'usa', 'uae', 'uk', 'uefa', 'conmebol', 'efl', 'mls', 'dc', 'fc', 'afl', 'aflw',
  'nrl', 'nfl', 'ncaaf', 'mlb', 'wnba', 'ufc', 'atp', 'wta', 'liv', 'pga', 'dp',
  'nrlw', 'cfl', 'kbo', 'npb', 'cpbl', 'bsn', 'lnb', 'lnbp', 'big3',
]);
const capWord = (w: string) =>
  !w ? w : ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
const capWords = (s: string) => s.split('_').map(capWord).join(' ');

const sportLabel = (s: string) => SPORT_LABEL[s] ?? capWords(s);

/**
 * A readable name from either a slug ("premier_league" -> "Premier League") or
 * an already-display string ("MODUS - Super Series"), which passes through.
 */
/** Entity-table normalized key: lowercase, accents folded, non-alnum -> `_`. */
function normEntity(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** A local league badge for the majors we ship a crest for, else undefined. */
function localLeagueLogo(sport: string, cat: string, name: string): string | undefined {
  const k = normEntity(name);
  const c = normEntity(cat);
  const is = (t: string) => k === t || c === t || k.includes(t);
  if (sport === 'aussierules') return is('women') ? '/logos/leagues/aflw.png' : '/logos/leagues/afl.png';
  if (sport === 'rugbyleague' && is('nrl') && !is('women')) return '/logos/leagues/nrl.png';
  if (sport === 'baseball' && is('mlb')) return '/logos/leagues/mlb.png';
  if (sport === 'basketball' && is('wnba')) return '/logos/leagues/wnba.png';
  if (sport === 'mma' && is('ufc')) return '/logos/leagues/ufc.png';
  if (sport === 'amfootball' && is('ncaaf')) return '/logos/leagues/ncaaf.png';
  if (sport === 'amfootball' && is('nfl')) return '/logos/leagues/nfl.png';
  if (sport === 'darts' && is('modus')) return '/logos/leagues/modus.png';
  return undefined;
}

interface DerivedLeague {
  league: League;
  subtitle?: string;
}

/**
 * The badge for a fixture, built from `category` + `tournament` (never
 * `optic_league`, which is a join key that leads with the sport). `league.id`
 * stays the sport slug so markets/books resolve; `league.name` is the specific
 * competition and `league.category` its group — filters key on the PAIR, since
 * a tournament name alone isn't unique (Hamburg is both ATP and WTA). Logos
 * come from local crests for the majors, else the competition entity.
 */
function deriveLeague(
  sport: string,
  category: string | null,
  tournament: string | null,
  stage: string | null,
  compLogos: Map<string, string>,
): DerivedLeague {
  const id = sport;
  const label = sportLabel(sport);
  const cat = (category ?? '').trim();
  let tourn = (tournament ?? '').trim();
  // Tournaments often embed the country ("Australia - NRL", "West Indies -
  // Caribbean Premier League") — drop the leading category so the badge reads
  // "NRL" with the country carried separately as context.
  if (tourn && cat && tourn.toLowerCase().startsWith(`${cat.toLowerCase()} - `)) {
    tourn = tourn.slice(cat.length + 3).trim();
  }
  const name = tourn || cat || label;
  // The category is context only when it adds something beyond the name.
  const context = cat && cat !== name ? cat : undefined;
  const compLogo = (n: string) => compLogos.get(normEntity(n));
  const code = (n: string) => (n || sport).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();

  // Tennis: the tour (ATP/WTA) is the wordmark badge; the tournament is the name.
  if (sport === 'tennis') {
    // Tour categories get a wordmark badge (the tournament rides in the name);
    // other tennis categories fall back to a competition-entity logo.
    const TOUR_LOGO: Record<string, string> = { ATP: 'atp', WTA: 'wta', 'ATP Challenger': 'atp-challenger' };
    const slug = TOUR_LOGO[cat];
    return {
      league: {
        id,
        name,
        category: context,
        code: code(name),
        sport: label,
        logoUrl: slug ? `/logos/leagues/${slug}.png` : compLogo(name),
        wordmark: !!slug,
      },
      subtitle: stage || undefined,
    };
  }

  // Golf: the tour (PGA/LIV/DP World Tour) is the badge; the event carries the
  // tournament name and round separately.
  if (sport === 'golf') {
    const tour = cat || 'Golf';
    const t = tour.toLowerCase();
    const logoUrl = t.includes('liv')
      ? '/logos/leagues/golf-liv.png'
      : t.includes('pga')
        ? '/logos/leagues/golf-pga.png'
        : '/logos/leagues/golf.png';
    return { league: { id, name: tour, code: code(tour), sport: label, logoUrl } };
  }

  return {
    league: {
      id,
      name,
      category: context,
      code: code(name),
      sport: label,
      logoUrl:
        localLeagueLogo(sport, cat, name) ??
        compLogo(name) ??
        (context ? compLogo(`${cat} ${name}`) : undefined),
    },
    subtitle: stage || undefined,
  };
}

const FINAL = new Set(['final', 'completed', 'complete', 'ended', 'finished', 'result']);
const LIVE = new Set(['live', 'in_play', 'inplay', 'playing', 'started']);
const CANCELLED = new Set(['cancelled', 'canceled', 'postponed', 'abandoned', 'walkover']);

function mapStatus(raw: string | null): EventStatus {
  const t = (raw ?? '').toLowerCase();
  if (FINAL.has(t)) return 'final';
  if (LIVE.has(t)) return 'live';
  if (CANCELLED.has(t)) return 'cancelled';
  return 'upcoming';
}

interface ScoreSide {
  total?: number | null;
  periods?: Record<string, number> | null;
}
interface FixtureRow {
  fixture_id: string;
  sport: string;
  category: string | null;
  optic_league: string | null;
  tournament: string | null;
  tournament_stage: string | null;
  event_name: string | null;
  home_team: string | null;
  away_team: string | null;
  scheduled_start: string;
  actual_start: string | null;
  is_live: boolean | null;
  status: string | null;
  end_date: string | null;
  current_round: string | null;
  scores: { home?: ScoreSide | null; away?: ScoreSide | null } | null;
  in_play_data: {
    clock?: string | null;
    period?: string | number | null;
    period_number?: number | null;
    is_clock_stopped?: boolean | null;
  } | null;
}

const FIXTURE_COLUMNS =
  'fixture_id,sport,category,optic_league,tournament,tournament_stage,event_name,' +
  'home_team,away_team,scheduled_start,actual_start,is_live,status,end_date,current_round,scores,in_play_data';

/** Merge home/away period maps into an ordered per-period breakdown. */
function periodScoresFrom(scores: FixtureRow['scores']): PeriodScore[] {
  const hp = scores?.home?.periods ?? {};
  const ap = scores?.away?.periods ?? {};
  const nums = new Set<number>();
  for (const k of [...Object.keys(hp), ...Object.keys(ap)]) {
    const m = /period_(\d+)/.exec(k);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums]
    .sort((a, b) => a - b)
    .map((n) => ({ period: n, home: hp[`period_${n}`] ?? 0, away: ap[`period_${n}`] ?? 0 }));
}

/** Per-side resolved logo/flag, from the fixture_entities view. */
interface EntitySide {
  logoUrl?: string | null;
  country?: string | null;
}
type EntityMap = Map<string, { home?: EntitySide; away?: EntitySide }>;

/** All competition badges, keyed by normalized name. Empty map = no badges. */
async function fetchCompetitionLogos(
  client: NonNullable<typeof supabase>,
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from('entities')
    .select('normalized,logo_url')
    .eq('sport', 'competition');
  const out = new Map<string, string>();
  if (error || !data) return out;
  for (const r of data as { normalized: string | null; logo_url: string | null }[]) {
    if (r.normalized && r.logo_url) out.set(r.normalized, r.logo_url);
  }
  return out;
}

/** Per-fixture home/away logos + flags, resolved by the fixture_entities view. */
async function fetchFixtureEntities(
  client: NonNullable<typeof supabase>,
  ids: string[],
): Promise<EntityMap> {
  const out: EntityMap = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client
      .from('fixture_entities')
      .select('fixture_id,side,country,logo_url')
      .in('fixture_id', ids.slice(i, i + 200));
    if (error || !data) continue;
    for (const r of data as {
      fixture_id: string;
      side: string | null;
      country: string | null;
      logo_url: string | null;
    }[]) {
      const rec = out.get(r.fixture_id) ?? {};
      if (r.side === 'home') rec.home = { logoUrl: r.logo_url, country: r.country };
      else if (r.side === 'away') rec.away = { logoUrl: r.logo_url, country: r.country };
      out.set(r.fixture_id, rec);
    }
  }
  return out;
}

/** Load fixtures with odds in the live window, newest archive events pruned. */
/**
 * Retry a Supabase query on transient errors before giving up. The DB is shared
 * with the scrapers, so a heavy query can occasionally hit the statement timeout
 * under write load — a retry a beat later almost always succeeds, and beats
 * blanking the whole board on a single blip.
 */
async function withRetry<T>(
  run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  tries = 3,
): Promise<{ data: T | null; error: { message: string } | null }> {
  let res: { data: T | null; error: { message: string } | null } = { data: null, error: null };
  for (let i = 0; i < tries; i++) {
    res = await run();
    if (!res.error) return res;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return res;
}

async function fetchFixtures(
  client: NonNullable<typeof supabase>,
  since: string,
  until?: string,
): Promise<FixtureRow[]> {
  // Smaller pages keep each query light, so it's less likely to trip the
  // statement timeout under DB load (and each retry is cheaper).
  const PAGE = 500;
  const byId = new Map<string, FixtureRow>();
  type Res = PromiseLike<{ data: FixtureRow[] | null; error: { message: string } | null }>;

  // Main: fixtures with scheduled_start in [since, until) — indexed on
  // scheduled_start. `until` bounds a specific day (past-date browsing); omit it
  // for the open-ended live window.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRetry<FixtureRow[]>(() => {
      let query = client
        .from('fixtures')
        .select(FIXTURE_COLUMNS)
        .eq('has_odds', true)
        .gte('scheduled_start', since);
      if (until) query = query.lt('scheduled_start', until);
      return query.order('scheduled_start', { ascending: true }).range(from, from + PAGE - 1) as unknown as Res;
    });
    if (error) throw new Error(`fixtures: ${error.message}`);
    const rows = (data ?? []) as FixtureRow[];
    for (const r of rows) byId.set(r.fixture_id, r);
    if (rows.length < PAGE) break;
  }

  // Multi-day events (golf tournaments) still running over the window/day, keyed
  // off end_date. Scoped to sport=golf so it's a cheap partition scan — an
  // un-indexed end_date filter across all fixtures times out.
  const { data: golf } = await withRetry<FixtureRow[]>(() => {
    let query = client
      .from('fixtures')
      .select(FIXTURE_COLUMNS)
      .eq('has_odds', true)
      .eq('sport', 'golf')
      .gte('end_date', since);
    if (until) query = query.lt('scheduled_start', until);
    return query.order('scheduled_start', { ascending: true }) as unknown as Res;
  });
  if (golf) for (const r of golf) byId.set(r.fixture_id, r);

  return [...byId.values()];
}

/** Enrich raw fixtures into board events (dedupe, logos, flags). */
async function toEvents(
  client: NonNullable<typeof supabase>,
  fixtures: FixtureRow[],
): Promise<SportEvent[]> {
  const deduped = dedupeFixtures(fixtures).filter((f) => !SKIP_SPORTS.has(f.sport));
  const [compLogos, entities] = await Promise.all([
    fetchCompetitionLogos(client),
    fetchFixtureEntities(client, deduped.map((f) => f.fixture_id)),
  ]);
  return deduped.map((f) => toSportEvent(f, compLogos, entities));
}

/**
 * Some events exist under both an Optic id and a `syn_` archive id, splitting
 * their odds. Keep one per (sport, name, start), preferring the Optic id.
 */
function dedupeFixtures(rows: FixtureRow[]): FixtureRow[] {
  const byKey = new Map<string, FixtureRow>();
  for (const r of rows) {
    const key = `${r.sport}|${r.event_name}|${r.scheduled_start}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
    } else if (existing.fixture_id.startsWith('syn_') && !r.fixture_id.startsWith('syn_')) {
      byKey.set(key, r); // prefer the non-archive id
    }
  }
  return [...byKey.values()];
}

function toSportEvent(
  f: FixtureRow,
  compLogos: Map<string, string>,
  entities: EntityMap,
): SportEvent {
  const { league, subtitle } = deriveLeague(
    f.sport,
    f.category,
    f.tournament,
    f.tournament_stage,
    compLogos,
  );
  const ip = f.in_play_data ?? {};
  const period = ip.period_number ?? (ip.period != null ? Number(ip.period) : null);
  const ent = entities.get(f.fixture_id);
  // Outright = a field with no two sides (a golf tournament). Golf also has
  // 2-player matchups, which DO have home/away and read as a normal H2H event.
  const outright = !f.home_team && !f.away_team;

  if (outright) {
    const name = f.event_name ?? league.name;
    return {
      id: f.fixture_id,
      sport: league.sport,
      league,
      name,
      subtitle,
      home: name,
      away: '',
      startsAt: f.scheduled_start,
      actualStart: f.actual_start,
      isLive: !!f.is_live,
      endsAt: f.end_date ?? undefined,
      outright: true,
      round: f.current_round ?? null,
      status: mapStatus(f.status),
    };
  }

  const home = f.home_team ?? '';
  const away = f.away_team ?? '';
  // Individuals fly a flag, not a photo — so suppress the entity logo for them.
  const person = PERSON_SPORTS.has(f.sport);
  return {
    id: f.fixture_id,
    sport: league.sport,
    league,
    name: f.event_name ?? `${home} vs ${away}`,
    subtitle,
    home,
    away,
    homeLogo: person ? undefined : (ent?.home?.logoUrl ?? undefined),
    awayLogo: person ? undefined : (ent?.away?.logoUrl ?? undefined),
    homeCountry: ent?.home?.country ?? null,
    awayCountry: ent?.away?.country ?? null,
    homeScore: f.scores?.home?.total ?? null,
    awayScore: f.scores?.away?.total ?? null,
    period: Number.isFinite(period) ? (period as number) : null,
    clock: ip.clock ?? null,
    clockStopped: ip.is_clock_stopped ?? false,
    periodScores: periodScoresFrom(f.scores),
    startsAt: f.scheduled_start,
    actualStart: f.actual_start,
    isLive: !!f.is_live,
    status: mapStatus(f.status),
  };
}

/** Load every priceable fixture in the live window, normalised for the board. */
export async function fetchAllEvents(): Promise<SportEvent[]> {
  if (!supabase) return [];
  const client = supabase;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  return toEvents(client, await fetchFixtures(client, since));
}

/**
 * Fixtures for one local calendar day (YYYY-MM-DD), for browsing past dates that
 * fall outside the live window. Loaded on demand and merged into the board.
 */
export async function fetchEventsForDay(dateStr: string): Promise<SportEvent[]> {
  if (!supabase) return [];
  const client = supabase;
  const start = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];
  const dayStart = start.toISOString();
  const dayEnd = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return toEvents(client, await fetchFixtures(client, dayStart, dayEnd));
}

/**
 * One fixture by id, for a link that names an event the board isn't holding —
 * anything older than the rolling window, or filtered out of it. A URL is a
 * promise that it opens what it says; the filters are a way to browse, not a
 * gate on what exists, so this deliberately ignores them (and `has_odds`).
 */
export async function fetchEventById(fixtureId: string): Promise<SportEvent | null> {
  if (!supabase || !fixtureId) return null;
  const client = supabase;
  const { data, error } = await withRetry<FixtureRow[]>(
    () =>
      client
        .from('fixtures')
        .select(FIXTURE_COLUMNS)
        .eq('fixture_id', fixtureId)
        .limit(1) as unknown as PromiseLike<{
        data: FixtureRow[] | null;
        error: { message: string } | null;
      }>,
  );
  if (error || !data?.length) return null;
  const events = await toEvents(client, data);
  return events[0] ?? null;
}

const SEARCH_LIMIT = 60;
/** Shortest term the search will run — the rail keys its search mode off this. */
export const SEARCH_MIN_CHARS = 2;
/** Fixtures older than this are the "past" half of the split. */
const SEARCH_PAST_MS = 24 * 60 * 60 * 1000;

/**
 * PostgREST parses `or=(...)` as a comma-separated list, so a term containing a
 * comma, parenthesis or quote would break the filter (and `*`/`%` are wildcards
 * the user shouldn't get to inject). Strip them rather than escaping.
 */
function searchTerm(query: string): string {
  return query.replace(/[,()*%"\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Golf outright fields: the player is in the odds selections, not the fixture. */
async function searchOutrightFixtures(
  client: NonNullable<typeof supabase>,
  pattern: string,
): Promise<FixtureRow[]> {
  const { data } = await client
    .from('odds')
    .select('fixture_id')
    .eq('market_id', 'outright')
    .ilike('selection', pattern)
    .limit(500);
  const ids = [...new Set(((data ?? []) as { fixture_id: string }[]).map((r) => r.fixture_id))];
  if (ids.length === 0) return [];
  const { data: rows } = await client
    .from('fixtures')
    .select(FIXTURE_COLUMNS)
    .in('fixture_id', ids.slice(0, 40));
  return (rows ?? []) as unknown as FixtureRow[];
}

/**
 * Team/player search over the whole fixtures archive — deliberately NOT scoped
 * to the board's sport/league/date filters, so "arsenal" finds Arsenal whatever
 * the rail is currently showing.
 *
 * Three passes, merged: upcoming matches (soonest first), past matches (most
 * recent first) and — for outright fields, where the fixture row carries no
 * competitor names at all — the golf tournaments whose `outright` selections
 * name the player. Each pass is capped, so a two-letter term can't drag the
 * whole archive down the wire.
 */
export async function searchEvents(query: string): Promise<SportEvent[]> {
  if (!supabase) return [];
  const term = searchTerm(query);
  if (term.length < SEARCH_MIN_CHARS) return [];
  const client = supabase;
  const pattern = `*${term}*`;
  const or = `home_team.ilike.${pattern},away_team.ilike.${pattern},event_name.ilike.${pattern}`;
  const cutoff = new Date(Date.now() - SEARCH_PAST_MS).toISOString();
  type Res = PromiseLike<{ data: FixtureRow[] | null; error: { message: string } | null }>;

  const [upcoming, past, outrights] = await Promise.all([
    withRetry<FixtureRow[]>(() =>
      client
        .from('fixtures')
        .select(FIXTURE_COLUMNS)
        .eq('has_odds', true)
        .or(or)
        .gte('scheduled_start', cutoff)
        .order('scheduled_start', { ascending: true })
        .limit(SEARCH_LIMIT) as unknown as Res,
    ),
    withRetry<FixtureRow[]>(() =>
      client
        .from('fixtures')
        .select(FIXTURE_COLUMNS)
        .eq('has_odds', true)
        .or(or)
        .lt('scheduled_start', cutoff)
        .order('scheduled_start', { ascending: false })
        .limit(SEARCH_LIMIT) as unknown as Res,
    ),
    searchOutrightFixtures(client, pattern).catch(() => [] as FixtureRow[]),
  ]);

  const byId = new Map<string, FixtureRow>();
  for (const r of [...(upcoming.data ?? []), ...(past.data ?? []), ...outrights]) {
    byId.set(r.fixture_id, r);
  }
  return toEvents(client, [...byId.values()]);
}

/** Best (highest) H2H decimal price for each side of a fixture. */
export interface H2HPrices {
  home: number | null;
  away: number | null;
}

/**
 * Best moneyline price per side for a batch of fixtures, for the scoreboard
 * ticker. Pulls only the pregame `moneyline` market across many fixtures at
 * once and assigns sides by `outcome_no` (1 = home, 2 = away) — no name
 * matching. In-play rows are excluded (see fetchOdds).
 */
export async function fetchH2HPrices(
  events: SportEvent[],
): Promise<Map<string, H2HPrices>> {
  const out = new Map<string, H2HPrices>();
  if (!supabase || events.length === 0) return out;
  const client = supabase;

  // Only two-sided events have a home/away moneyline; skip outrights.
  const ids = events.filter((e) => !e.outright).map((e) => e.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client
      .from('odds')
      .select('fixture_id,outcome_no,current_price,open_price')
      .eq('market_id', 'moneyline')
      .eq('is_lay', false)
      .eq('is_live', false)
      .in('fixture_id', ids.slice(i, i + 100));
    if (error || !data) continue;
    for (const r of data as {
      fixture_id: string;
      outcome_no: number | null;
      current_price: number | null;
      open_price: number | null;
    }[]) {
      const price = r.current_price ?? r.open_price;
      if (price == null) continue;
      const cur = out.get(r.fixture_id) ?? { home: null, away: null };
      if (r.outcome_no === 1) cur.home = Math.max(cur.home ?? 0, price);
      else if (r.outcome_no === 2) cur.away = Math.max(cur.away ?? 0, price);
      out.set(r.fixture_id, cur);
    }
  }
  return out;
}

/**
 * Load the odds rows for a single fixture. PostgREST caps a response at 1000
 * rows, and a fixture's full ladder can exceed that, so page until drained.
 * In-play rows (`is_live=true`) are excluded — we only price off pregame/close
 * odds (the live capture currently covers sports it shouldn't and its rows lack
 * `outcome_no`), so filter them out at the source.
 */
export async function fetchOdds(event: SportEvent): Promise<OddsRow[]> {
  if (!supabase) return [];
  const client = supabase;

  const PAGE = 1000;
  const all: OddsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRetry<OddsRow[]>(() =>
      client
        .from('odds')
        .select(
          'market_id,market_name,selection,normalized_selection,line,line_group,pair_key,outcome_no,' +
            'is_main,sportsbook,is_lay,current_price,open_price,status,flucs,open_at,' +
            'price_6h,price_3h,price_1h,price_30m,price_10m,close_price,current_at,daily_prices',
        )
        .eq('fixture_id', event.id)
        .eq('is_live', false)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1) as unknown as PromiseLike<{ data: OddsRow[] | null; error: { message: string } | null }>,
    );
    if (error) throw new Error(`odds: ${error.message}`);
    const rows = (data ?? []) as OddsRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/* ------------------------------------------------------------------- pulse */

/**
 * One heartbeat in the status bar: how long ago this source last moved.
 * `at` is null when we could not read it at all (which is its own signal).
 */
export interface Pulse {
  key: string;
  label: string;
  /** ISO timestamp of the most recent write we can see, or null. */
  at: string | null;
  /** Short qualifier shown beside the age, e.g. "44 live", "41/44". */
  detail?: string;
  /** Nothing to report rather than something wrong — renders grey, not red. */
  idle?: boolean;
  /** Minutes past which the dot turns amber, then red. */
  warn: number;
  stale: number;
}

/** Newest `updated_at` among a book's odds rows, or null. */
async function newestBookWrite(
  client: NonNullable<typeof supabase>,
  book: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('odds')
    .select('updated_at')
    .eq('sportsbook', book)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return (data[0] as { updated_at: string | null }).updated_at ?? null;
}

interface LiveRow {
  updated_at: string | null;
  scores: { home?: { total?: number | null } | null; away?: { total?: number | null } | null } | null;
}

/**
 * Freshness of the feeds the board is built from — the Optic fixture feed, the
 * two books whose prices anchor everything, and whether live scores are still
 * ticking. Four small indexed reads, so this can sit on the 60s poll.
 */
export async function fetchPulse(): Promise<Pulse[]> {
  if (!supabase) return [];
  const client = supabase;

  const [optic, tab, pinnacle, live] = await Promise.all([
    client
      .from('fixtures')
      .select('updated_at')
      .eq('source', 'optic')
      .order('updated_at', { ascending: false })
      .limit(1)
      .then(({ data, error }) =>
        error || !data?.length ? null : ((data[0] as { updated_at: string | null }).updated_at ?? null),
      ),
    newestBookWrite(client, 'tab'),
    newestBookWrite(client, 'pinnacle'),
    client
      .from('fixtures')
      .select('updated_at,scores')
      .eq('is_live', true)
      .order('updated_at', { ascending: false })
      .limit(300)
      .then(({ data, error }) => (error ? [] : ((data ?? []) as LiveRow[]))),
  ]);

  // A score only counts once it carries a number — an empty `scores` object is
  // the shape the feed writes before anything has been played.
  const scored = live.filter(
    (r) => typeof r.scores?.home?.total === 'number' || typeof r.scores?.away?.total === 'number',
  );

  return [
    { key: 'optic', label: 'Optic', at: optic, warn: 10, stale: 30 },
    { key: 'tab', label: 'TAB', at: tab, warn: 15, stale: 45 },
    { key: 'pinnacle', label: 'Pinnacle', at: pinnacle, warn: 10, stale: 30 },
    {
      key: 'live',
      label: 'Live',
      at: live[0]?.updated_at ?? null,
      detail: live.length ? `${live.length}` : undefined,
      // No live fixtures at 4am is not a fault — say so rather than alarm.
      idle: live.length === 0,
      warn: 5,
      stale: 15,
    },
    {
      key: 'scores',
      label: 'Scores',
      at: scored[0]?.updated_at ?? null,
      detail: live.length ? `${scored.length}/${live.length}` : undefined,
      idle: live.length === 0,
      warn: 10,
      stale: 30,
    },
  ];
}
