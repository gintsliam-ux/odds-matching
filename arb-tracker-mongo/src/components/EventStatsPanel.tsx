import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Check, ChevronDown, Info } from 'lucide-react';
import { fetchBets, fetchPlayerStats, type Bet, type FixtureBets, type PlayerStats, type PlayerStatLine } from '../lib/db';
import { PanelNotice, SubTabs } from './EventTabs';
import { StatBetsSkeleton, StatsSkeleton } from './Skeleton';
import type { SportEvent } from '../lib/types';
import { useParam } from '../lib/urlState';
import { BRAND_LABEL, brandBadge } from '../lib/brands';
import { TeamLogo } from './TeamLogo';
import { IdChip } from './IdChip';

/**
 * The box score for one fixture, NBA and NFL only.
 *
 * `player_stats` holds what each sport is actually bet on, which is why the
 * columns differ: basketball's props ladder (points, rebounds, assists, threes
 * and the PRA combination) against gridiron's yardage and touchdown markets.
 * The server says which fields this fixture carries; this renders them in that
 * order rather than assuming a fixed set and leaving blanks where a sport has
 * no such stat.
 *
 * Only games that have been PLAYED are in the collection — there is no row for
 * an upcoming fixture — so the empty state says that plainly instead of showing
 * a table with nothing in it.
 */
const LABELS: Record<string, string> = {
  minutes: 'Min',
  points: 'Pts',
  rebounds: 'Reb',
  assists: 'Ast',
  threes: '3PM',
  pra: 'PRA',
  passing_yards: 'Pass yds',
  passing_touchdowns: 'Pass TD',
  passing_interceptions: 'INT',
  rushing_yards: 'Rush yds',
  rushing_attempts: 'Carries',
  rushing_touchdowns: 'Rush TD',
  receiving_yards: 'Rec yds',
  receptions: 'Rec',
  receiving_targets: 'Tgt',
  receiving_touchdowns: 'Rec TD',
  touchdowns: 'TD',
};

/**
 * Everyone who recorded each stat, in order, per team.
 *
 * Broken down BY STAT rather than by player, because that is the question
 * being asked: not "how did this player do" — the All view answers that — but
 * "who got the rushing yards", with both teams side by side so the two are
 * read against each other rather than looked up twice.
 *
 * Every player who recorded the stat is listed, longest first, not just the
 * leader: the second and third names are the ones that decide a props market,
 * and a view that stopped at the top one would hide exactly the depth it is
 * being consulted for.
 *
 * A stat nobody recorded is dropped rather than printed as a column of dashes:
 * most of an NFL roster has no passing yards, and a block saying so of both
 * teams is noise. A team with nobody on a stat the other team does have still
 * shows a dash, because there the absence is the information.
 */
type Scorer = { player: string | null; position: string | null; value: number };

/**
 * Minutes is not a stat, it is the opportunity to record one.
 *
 * A ranked list of who was on court longest answers nothing this view is
 * consulted for — nobody prices minutes — and it sat at the top of the
 * basketball blocks pushing points down the page. It stays in the All box
 * score, where it is the context you read the other columns against, and it
 * still orders that table server-side.
 */
const NOT_A_STAT = new Set(['minutes']);

function scorersByStat(
  teams: PlayerStats['teams'],
  fields: string[],
): { field: string; perTeam: Scorer[][] }[] {
  const out: { field: string; perTeam: Scorer[][] }[] = [];
  for (const field of fields) {
    if (NOT_A_STAT.has(field)) continue;
    const perTeam = teams.map((t) =>
      t.players
        .map((p) => ({ player: p.player, position: p.position, value: Number(p[field]) }))
        .filter((x) => Number.isFinite(x.value) && x.value > 0)
        .sort((a, b) => b.value - a.value),
    );
    if (perTeam.some((list) => list.length)) out.push({ field, perTeam });
  }
  return out;
}

const num = (v: PlayerStatLine[string]) =>
  v == null || v === '' ? <span className="text-slate-700">–</span> : String(v);

/**
 * Which bets on this fixture are about a player's stats, and how they landed.
 *
 * A bet counts when its market or selection NAMES one of the players in this
 * box score. That is exact where a vocabulary is not: matching on words like
 * "points" or "yards" also catches "Match total points handicap - PYOL" and
 * "total points 234.5", which are team markets wearing the same nouns. The
 * box score is the authority on who played, so it is the authority on what is
 * a player bet.
 */
const words = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Which player a bet is about, and whether we are sure it is him.
 *
 * The surname does the finding — books write "J. Chase" and "Ja'Marr Chase"
 * for the same man, so requiring every part would drop half of them — but a
 * surname alone does not IDENTIFY anyone, and the two failures it produces are
 * both silent:
 *
 *   Juwan Johnson      several Johnsons play; keying a played/did-not-play map
 *                      on "johnson" let another one's row overwrite his, and
 *                      his anytime-touchdown bets read VOID when he started
 *                      and caught a pass for seven yards.
 *   Marvin Harrison Jr small-sample worse — he has no box-score row at all, so
 *                      "harrison" found the only Harrison who does, Malik, and
 *                      called the bet void off a stranger's empty line.
 *
 * So a void needs the given name as well, as a whole word or as the initial
 * the book abbreviated it to ("N. Folk" confirms Nick Folk). Without that
 * confirmation the bet is still shown under the name it mentions — that part
 * was never in doubt — but `exact` is false and no void is claimed from it.
 */
/**
 * What became of a bet: the brand's own word for it, or void when the man it
 * names never took the field.
 */
/**
 * What the BRAND says about the bet. Nothing else may write this.
 *
 * It had started carrying a second, different claim: where the brand had not
 * settled yet, the box score was allowed to fill the badge in. That reads as
 * "this has been paid" when the truth is "we think this has come in" — and the
 * two are not the same thing to anyone reconciling against the book. The
 * target now has its own state below and this one answers only to `result`
 * off the bet row.
 */
type Landed = 'won' | 'lost' | 'void' | 'pending';

/**
 * What the BOX SCORE says, which is a different question.
 *
 * `hit` is certain and `short` is not: these markets ask for at least so many,
 * so a number once reached cannot be unreached, while falling short is only
 * final at the whistle. Mid-game `short` is simply "not yet".
 */
type Target = 'hit' | 'short' | null;

const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Given names, then surname — with "Jr"/"III" set aside, which are neither. */
function nameParts(name: string): { given: string[]; surname: string } {
  const w = words(name).filter((x) => !SUFFIX.has(x));
  return { given: w.slice(0, -1), surname: w[w.length - 1] ?? '' };
}

/** Does the bet's text name THIS man and not merely his surname? */
function confirmsGiven(given: string[], hay: Set<string>): boolean {
  return given.some((g) => (g.length > 1 && hay.has(g)) || hay.has(g[0]));
}

/**
 * Which box-score column a market is asking about.
 *
 * Every market on this tab is a question about one number — "Player to Score
 * 15+ Points" asks about points, "Anytime Touchdown Scorer" about touchdowns —
 * and the box score beside it has that number. Showing it turns a list of bets
 * into a list you can settle at a glance.
 *
 * Ordered, and matched on the market's own phrasing rather than on loose
 * keywords. Two of the 23 markets the tab groups under are not player markets
 * at all — "Margin 13 Point Bands" and "Line/Total Double (-3.5 / 228.5)" get
 * here only because a team's name shares a word with somebody's surname — and
 * the word boundary on `points` is what keeps "13 Point Bands" from claiming
 * to be a points market. They show no number, which is the honest answer.
 */
const STAT_FOR_MARKET: [RegExp, string, string][] = [
  [/touchdown/i, 'touchdowns', 'TD'],
  [/passing yards/i, 'passing_yards', 'pass yds'],
  [/rushing yards/i, 'rushing_yards', 'rush yds'],
  [/receiving yards/i, 'receiving_yards', 'rec yds'],
  [/receptions/i, 'receptions', 'rec'],
  [/\bassists\b/i, 'assists', 'ast'],
  [/\brebounds\b/i, 'rebounds', 'reb'],
  [/\bpoints\b/i, 'points', 'pts'],
  [/\bthrees\b|3\s*pointers?/i, 'threes', '3PM'],
];

/** Which box-score column a market is about, without needing a player. */
function fieldFor(market: string): string | null {
  for (const [re, field] of STAT_FOR_MARKET) if (re.test(market)) return field;
  return null;
}

function statFor(market: string, player: PlayerStatLine | null): { label: string; value: number } | null {
  if (!player) return null;
  for (const [re, field, label] of STAT_FOR_MARKET) {
    if (!re.test(market)) continue;
    const v = Number(player[field]);
    return Number.isFinite(v) ? { label, value: v } : null;
  }
  return null;
}

/**
 * The order the stat families read in, and their names in full.
 *
 * The groups used to sort by total staked, which put "Player to Make 8+
 * Assists" between the 15+ and 20+ points markets purely because more money
 * went through it. Points is ONE thing the book offered at four prices, not
 * four unrelated markets, and the comparison anyone actually makes is across
 * those four — the same player is in three of them.
 *
 * Basketball first and gridiron after, which costs nothing: a fixture is one
 * or the other, so only half of this list is ever used.
 *
 * LABELS at the top of the file is the table-column set — "Pts", "Ast" —
 * which is right over a narrow numeric column and wrong as a heading.
 */
const FAMILY_ORDER = [
  'points', 'assists', 'rebounds', 'threes', 'pra',
  'touchdowns', 'passing_yards', 'rushing_yards', 'receiving_yards', 'receptions',
];

const FAMILY_LABEL: Record<string, string> = {
  points: 'Points',
  assists: 'Assists',
  rebounds: 'Rebounds',
  threes: 'Threes',
  pra: 'Points + rebounds + assists',
  touchdowns: 'Touchdowns',
  passing_yards: 'Passing yards',
  rushing_yards: 'Rushing yards',
  receiving_yards: 'Receiving yards',
  receptions: 'Receptions',
};

/** The number a market asks for — 20 from "Player to Score 20+ Points". */
const thresholdOf = (market: string): number =>
  /anytime/i.test(market) ? 1 : Number(market.match(/(\d+)\s*\+/)?.[1]) || 0;

/**
 * The market's own line, where it states one: "15+" under a Points header.
 *
 * Only where the market literally carries an "N+", so "Anytime Touchdown
 * Scorer" keeps its name. Anytime IS one or more, and `thresholdOf` treats it
 * as 1 for settling, but a header reading "1+" would describe the bet worse
 * than its own name does.
 */
function lineLabel(market: string): string {
  const m = market.match(/(\d+)\s*\+/);
  return m ? `${m[1]}+` : market;
}

/**
 * Settle one leg from the box score, where the brand will not.
 *
 * This is deliberate re-derivation and it is confined to the case that has no
 * other answer. The brand settles a TICKET: a lost multi says at least one leg
 * lost and never which, so on a finished game every leg of it reads "unknown"
 * — and on this tab that was every row, sitting next to a box score that made
 * the answer obvious. "Player to Score 20+ Points" beside "27 pts" is not a
 * judgement call.
 *
 * It only runs where the market states its own threshold ("20+ Points", "2+
 * Touchdowns", "Passing Yards 200+", and anytime-scorer, which is 1+). "First
 * Touchdown Scorer" states none — it asks who was first, not how many — so it
 * is left alone rather than guessed at from a touchdown count.
 *
 * And it never overrides the brand. A definite result from them wins; this
 * fills the silence.
 */
function targetOf(
  market: string,
  stat: { value: number } | null,
  done: boolean,
): Target {
  if (!stat) return null;
  const threshold = /anytime/i.test(market) ? 1 : Number(market.match(/(\d+)\s*\+/)?.[1]);
  if (!Number.isFinite(threshold)) return null;
  /*
   * The two directions are not symmetrical, and that is the whole of it.
   *
   * These markets ask for AT LEAST so many, and a number that has been reached
   * cannot be unreached: a man on 27 points has won the 20+ with a quarter
   * still to play, and saying "pending" about it is just refusing to read the
   * score. So a met threshold is won whether the game is over or not.
   *
   * Falling short is only a loss once there is no more game. At 19 points in
   * the third he has not lost the 20+ — he has not got there YET — so that
   * stays pending until the final whistle.
   */
  if (stat.value >= threshold) return 'hit';
  return done ? 'short' : null;
}

/**
 * Group a market's bets by player, in the order of the number itself.
 *
 * Ordered by the stat descending rather than by result, which for an "at
 * least" market puts the winners at the top anyway — 27, 23, 19, 13 — and
 * keeps a pending bet where its number says it belongs rather than banished to
 * the bottom for not being settled yet. Players with no number (no box score
 * yet) hold their place by stake, which is the only thing there is to rank
 * them by before the game.
 *
 * The line's own result is the most definite one on it. A player cannot have
 * both won and lost the same market, so a disagreement means one ticket has
 * been settled by the brand and another has not, and the settled one is the
 * answer for all of them.
 */
function byPlayer<
  T extends {
    player: string;
    team: string | null;
    side: string | null;
    brand: string;
    stat: { value: number } | null;
    target: Target;
    landed: Landed;
    bet: Bet;
  },
>(
  rows: T[],
): {
  player: string;
  team: string | null;
  side: string | null;
  /** Usually one of each; a player can be backed at both brands and in both shapes. */
  brands: string[];
  shapes: string[];
  stat: T['stat'];
  target: Target;
  landed: Landed;
  stake: number;
  rows: T[];
}[] {
  const by = new Map<string, T[]>();
  for (const r of rows) by.set(r.player, [...(by.get(r.player) ?? []), r]);
  return [...by.entries()]
    .map(([player, list]) => ({
      player,
      team: list.find((r) => r.team)?.team ?? null,
      side: list.find((r) => r.side)?.side ?? null,
      brands: [...new Set(list.map((r) => r.brand))],
      shapes: [...new Set(list.map((r) => betShape(r.bet)))],
      stat: list.find((r) => r.stat)?.stat ?? null,
      // One player, one market, one line — the target is the same for all of
      // them, so the first that has an answer answers for the group.
      target: list.find((r) => r.target)?.target ?? null,
      landed: list.reduce<Landed>(
        (best, r) => (LANDED_ORDER[r.landed] < LANDED_ORDER[best] ? r.landed : best),
        'pending',
      ),
      // Each ticket once: two legs of one multi on the same player is one stake.
      stake: [...new Map(list.map((r) => [r.bet.id, r.bet])).values()].reduce(
        (t, b) => t + (Number(b.stake) || 0),
        0,
      ),
      rows: list,
    }))
    .sort(
      (a, b) =>
        (b.stat?.value ?? -Infinity) - (a.stat?.value ?? -Infinity) ||
        b.stake - a.stake ||
        a.player.localeCompare(b.player),
    );
}

/**
 * The player a selection names, when there is no box score to check it against.
 *
 * Before the game starts there are no rows to match to, and the tab was
 * therefore empty — on the one day people are actually betting the market.
 * The selection names the man well enough on its own: "Jrue Holiday (Portland
 * Trail Blazers)", "Puka Nacua (Los Angeles Rams)". The bracket is the team,
 * which is already the group's context, so it goes.
 *
 * This is only the DISPLAY name and the grouping key. No stat is attached and
 * nothing is settled from it — there is nothing to settle against yet.
 */
const nameFromSelection = (selection: string) =>
  selection.replace(/\s*\([^)]*\)\s*$/, '').trim() || selection;

/** Winners first and losers under them; everything unsettled after both. */
const LANDED_ORDER: Record<Landed, number> = {
  won: 0, lost: 1, void: 2, pending: 3,
};

type Match = { player: PlayerStatLine; exact: boolean } | null;

function namesPlayer(bet: Bet, players: PlayerStatLine[]): Match {
  const hay = new Set(words(`${bet.market ?? ''} ${bet.selection ?? ''}`));
  const hit = players.filter((p) => {
    const { surname } = nameParts(p.player ?? '');
    return surname.length > 2 && hay.has(surname);
  });
  if (!hit.length) return null;
  const sure = hit.filter((p) => confirmsGiven(nameParts(p.player ?? '').given, hay));
  if (sure.length === 1) return { player: sure[0], exact: true };
  // Either nobody's given name is in the text, or more than one man's is.
  return { player: hit[0], exact: false };
}

function landed(bet: Bet, match: Match, done: boolean): Landed {
  /*
   * Void is claimed only when we know WHICH player, and the box score has him
   * recording nothing anywhere (the server's `played`, judged over his whole
   * line — the stat columns on this page would call every kicker absent).
   * An ambiguous surname falls through to the brand's own result: being unsure
   * which Johnson a bet is on is not evidence that he sat out, and "void" is
   * too confident a thing to say on a guess.
   */
  /*
   * Only once the game is OVER. A box score mid-game has whole rosters sitting
   * at nothing recorded yet, and they are not absent — they are second-quarter
   * substitutes who have not touched the ball. `player_status` reads "live" on
   * those rows, which is the giveaway: the stat line is still being written.
   */
  if (done && match?.exact && match.player.played === false) return 'void';
  const r = (bet.result ?? '').toLowerCase();
  if (/cancel|void|refund/.test(r)) return 'void';
  if (/^won\b/.test(r) || /^return @/.test(r)) return 'won';
  if (/^lost\b/.test(r) || /no return/.test(r)) return 'lost';
  // Settled but in a wording we do not know, or genuinely not settled yet.
  return 'pending';
}

/**
 * What became of one LEG of a multi, which is a weaker question than the bet.
 *
 * The brand settles the ticket, not the leg. That makes one direction certain
 * and the other not: if the ticket returned, every leg on it came in, so a won
 * ticket means a won leg. A lost ticket only means at least one leg lost, and
 * nothing says it was this one — so rather than paint it red or green, the leg
 * is marked "multi lost" and left unclaimed.
 *
 * Void still applies, because it is about the man and not the ticket: if he
 * never took the field, his leg was voided whatever the rest of the slip did.
 */
/**
 * A leg's status is its TICKET's status, because that is all the brand says.
 *
 * It settles the slip, never the leg — a returned ticket means every leg came
 * in, and a lost one means at least one did not without saying which. This
 * used to paper over that with the box score, which put "won" on a badge the
 * brand had not paid. The box score now has its own state (see Target) and
 * this reports the ticket.
 */
function legLanded(bet: Bet, match: Match, done: boolean): Landed {
  if (done && match?.exact && match.player.played === false) return 'void';
  return landed(bet, null, done);
}

const LANDED_TONE: Record<Landed, string> = {
  won: 'bg-emerald-500/15 text-emerald-300',
  lost: 'bg-rose-500/15 text-rose-300',
  void: 'bg-slate-500/15 text-slate-400',
  pending: 'bg-amber-500/15 text-amber-300',
};

const LANDED_LABEL: Record<Landed, string> = {
  won: 'won', lost: 'lost', void: 'void', pending: 'pending',
};

const LANDED_TITLE: Record<Landed, string> = {
  won: 'Settled by the brand as a winner.',
  lost: 'Settled by the brand as a loser.',
  void: 'Settled by the brand as void.',
  pending: 'Not settled by the brand yet.',
};

/**
 * Single, SGM or Multi.
 *
 * The server decides this from the legs — same game or several — so this only
 * tidies the label. See betShape in bets.mjs for why a flag was not enough.
 */
const betShape = (bet: Bet): string =>
  bet.betType === 'SGM' || bet.betType === 'Multi' || bet.betType === 'Single'
    ? bet.betType
    : (bet.legCount ?? 0) > 1
      ? 'Multi'
      : 'Single';

/** One block per stat: every player who recorded it, in order, by team. */
function Leaders({
  teams,
  fields,
  event,
}: {
  teams: PlayerStats['teams'];
  fields: string[];
  /** For the crests; the box score names its teams in text only. */
  event?: SportEvent;
}) {
  const blocks = useMemo(() => scorersByStat(teams, fields), [teams, fields]);
  /*
   * Collapsed by exception, and independently — these are not an accordion.
   * Gridiron puts nine blocks on the page and you may want passing and
   * receiving open together while rushing attempts and targets are out of the
   * way, which one-at-a-time would not allow.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (field: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  if (!blocks.length) {
    return <p className="text-xs text-slate-500">Nobody recorded any of these stats in this game.</p>;
  }
  return (
    <div className="space-y-3">
      {blocks.map(({ field, perTeam }) => (
        <div key={field} className="overflow-hidden rounded-xl bg-surface-raised/40">
          <button
            type="button"
            onClick={() => toggle(field)}
            aria-expanded={!collapsed.has(field)}
            className="flex w-full items-center gap-2 border-b border-surface-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-white/[0.03] hover:text-slate-200"
          >
            <ChevronDown
              size={12}
              className={`transition-transform ${collapsed.has(field) ? '-rotate-90' : ''}`}
            />
            {LABELS[field] ?? field}
            {/* The count stays visible when the block is shut, so a collapsed
                stat still says whether anyone recorded it and how deep it
                goes. A header that collapses to nothing but its own name
                makes you open it again to find that out. */}
            <span className="ml-auto font-normal normal-case text-slate-600">
              {perTeam.map((l) => l.length).join(' · ')}
            </span>
          </button>
          <div
            className={`grid grid-cols-1 gap-px bg-surface-border sm:grid-cols-2 ${
              collapsed.has(field) ? 'hidden' : ''
            }`}
          >
            {perTeam.map((list, i) => (
              <div key={i} className="bg-surface-raised/40 p-2">
                {/* The same crest and the same type as the All view's team
                    heading — one team name should not be two sizes on two
                    tabs of the same panel. */}
                <div className="flex items-center gap-2 px-1 pb-1.5">
                  <TeamLogo
                    name={teams[i]?.team ?? ''}
                    size={18}
                    logo={teams[i]?.side === 'home' ? event?.homeLogo : event?.awayLogo}
                  />
                  <span className="text-[13px] font-semibold text-slate-200">{teams[i]?.team}</span>
                </div>
                {list.length === 0 ? (
                  <div className="px-1 text-slate-700">–</div>
                ) : (
                  <ol className="space-y-0.5">
                    {list.map((x, n) => (
                      <li
                        key={`${x.player}:${n}`}
                        className="flex items-baseline gap-2 rounded px-1 py-0.5 text-sm hover:bg-white/[0.03]"
                      >
                        {/* The number first: on this view the value is what is
                            being compared down the column and across to the
                            other team, and the name answers "who" second. */}
                        <b className="w-10 shrink-0 text-right tabular-nums text-slate-100">
                          {x.value}
                        </b>
                        <span className="truncate text-slate-300">{x.player}</span>
                        {x.position && (
                          <span className="ml-auto shrink-0 text-[10px] text-slate-600">
                            {x.position}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Player-stat bets on this fixture, grouped by the brand's own market name.
 *
 * Grouped by market rather than by player or by result, because the market is
 * the unit the book actually offered and the one it is listed under in
 * mybet/multis — so a group is "everything we took on Player points Cade
 * Cunningham", which is the exposure question.
 */
function StatBets({
  fixtureId,
  teams,
  done,
  event,
}: {
  fixtureId: string;
  teams: PlayerStats['teams'];
  /** Whether the game has finished — see `landed`, which will not call a bet
   *  void until it has. */
  done: boolean;
  /** For the crests; the box score names its teams in text only. */
  event?: SportEvent;
}) {
  const [bets, setBets] = useState<FixtureBets | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  /*
   * Collapsed by default and independently — these are not an accordion. Four
   * tickets on one player is detail you go looking for, and two players' worth
   * of it open at once is a reasonable thing to want.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchBets(fixtureId)
      .then((d) => {
        if (cancelled) return;
        setBets(d);
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [fixtureId]);

  const groups = useMemo(() => {
    if (!bets) return [];
    /*
     * Every player in the box score, as one list: a bet names a man, not a
     * team, and the same surname can appear on both.
     */
    const players = teams.flatMap((t) => t.players).filter((p) => p.player);
    /*
     * Which team each man plays for, so the line can fly his crest.
     *
     * From the box score where there is one — it is already grouped by team —
     * and from the selection's bracket where there is not: mybet writes
     * "Puka Nacua (Los Angeles Rams)", and before the game that bracket is the
     * only statement of the team anywhere on the row.
     */
    const sideOf = new Map<string, { team: string | null; side: string | null }>();
    for (const t of teams) {
      for (const pl of t.players) {
        if (pl.player) sideOf.set(pl.player, { team: t.team, side: t.side });
      }
    }
    const teamFromSelection = (sel: string) => sel.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? null;

    /*
     * Which side a team name is, so the crest can come off the event.
     *
     * The event carries the real badges — homeLogo and awayLogo, present on
     * every fixture on the board — and TeamLogo's own fallback is a local
     * /logos/teams/<slug>.png that mostly is not there, so without this the
     * line showed a grey circle of initials instead of a crest.
     *
     * The box score's `side` is used where there is one; before the game the
     * only statement of the team is the selection's bracket, so that is
     * matched against the fixture's own two names. Loose enough for "LA
     * Galaxy" against "Los Angeles Galaxy" — every word of the shorter in the
     * longer — and it only ever has two candidates to choose between.
     */
    const norm = (v: string) =>
      v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
    const sideByName = (team: string | null): string | null => {
      if (!team || !event?.home || !event?.away) return null;
      const t = new Set(norm(team));
      const fits = (other: string) => {
        const o = new Set(norm(other));
        const [small, big] = t.size <= o.size ? [t, o] : [o, t];
        for (const w of small) if (!big.has(w)) return false;
        return small.size > 0;
      };
      const h = fits(event.home);
      const a = fits(event.away);
      return h && !a ? 'home' : a && !h ? 'away' : null;
    };
    // Before the first tip there is no box score, so a bet cannot be matched to
    // a player in it. The market text still identifies a player market and the
    // selection still names the player, which is enough to list them.
    const noBox = players.length === 0;

    type Row = {
      brand: string;
      bet: Bet;
      market: string;
      selection: string;
      price: number | null;
      /** Who the bet is on — the box score's spelling where there is one. */
      player: string;
      team: string | null;
      /** 'home' or 'away', so the crest can come off the event. */
      side: string | null;
      /** What the box score says about the number this market asks for. */
      stat: { label: string; value: number } | null;
      /** Whether that number has reached the market's line — see Target. */
      target: Target;
      /** This row is one leg of a multi, not the whole ticket. */
      ofMulti: boolean;
      landed: Landed;
    };
    const all: Row[] = [];
    /*
     * mybet and multis only, and that is not an omission.
     *
     * The grouping is by the brand's own market text, and theirs is a market:
     * "Anytime Touchdown Scorer", "Player to Score 15+ Points", "Passing Yards
     * 200+" — the player is in the selection where he belongs. swiftbet writes
     * the market as "touchdowns - George Kittle", so grouping by it gives one
     * group per player per market and the grouping says nothing.
     *
     * It costs volume: across the fixtures with a box score, swiftbet has
     * 1,216 bets naming one of these players against mybet's 28 and multis'
     * six, and about half of those fixtures have nothing on this tab at all.
     * That is what the empty state below is for.
     */
    for (const brand of ['mybet', 'multis'] as const) {
      for (const bet of bets[brand]?.bets ?? []) {
        /*
         * A multi is read leg by leg, because as one row it belongs under no
         * market at all. Bet 6772218 is a Lakers moneyline AND Jrue Holiday
         * 15+ points AND Scoot Henderson 15+ points on one ticket; its
         * `selections` is all three run together with slashes and its market
         * is the same mess. Split, two of those three legs group cleanly under
         * "Player to Score 15+ Points" and the moneyline leg drops out for
         * naming nobody in the box score.
         */
        if (bet.legs?.length) {
          for (const leg of bet.legs) {
            /*
             * A leg with no market is a plain head-to-head — its market slot
             * held the competition, not a market — and its selection is a
             * TEAM. Those have no business on a player-stats tab, and left in
             * they do real damage: a team name can carry a player's surname,
             * so "Washington Commanders" matched Malik Washington and 169 of
             * these turned up as player bets that nobody had placed.
             */
            if (!leg.selection || !leg.market) continue;
            const market = leg.market;
            const match = namesPlayer({ ...bet, market, selection: leg.selection }, players);
            /*
             * No box score yet: the market still says this is a player market
             * and the selection still names the player — but nothing says the
             * player is in THIS game. A multi attached to this fixture carries
             * legs on five others, and with no box score to match against they
             * were all being listed here. The selection's bracket is the team,
             * so it has to be one of this fixture's two.
             */
            if (!match && !(noBox && fieldFor(market) && sideByName(teamFromSelection(leg.selection)))) continue;
            const stat = match ? statFor(market, match.player) : null;
            all.push({
              brand,
              bet,
              market,
              player: match?.player.player ?? nameFromSelection(leg.selection),
              team: match ? sideOf.get(match.player.player!)?.team ?? null : teamFromSelection(leg.selection),
              side:
                (match ? sideOf.get(match.player.player!)?.side : null) ??
                sideByName(match ? sideOf.get(match.player.player!)?.team ?? null : teamFromSelection(leg.selection)),
              selection: leg.selection,
              price: leg.price,
              stat,
              target: targetOf(market, stat, done),
              ofMulti: true,
              landed: legLanded(bet, match, done),
            });
          }
          continue;
        }
        const market = bet.market ?? bet.selection ?? 'Unknown market';
        const match = namesPlayer(bet, players);
        if (!match && !(noBox && fieldFor(market) && sideByName(teamFromSelection(bet.selection ?? '')))) continue;
        const stat = match ? statFor(market, match.player) : null;
        all.push({
          brand,
          bet,
          market,
          player: match?.player.player ?? nameFromSelection(bet.selection ?? ''),
          team: match ? sideOf.get(match.player.player!)?.team ?? null : teamFromSelection(bet.selection ?? ''),
          side:
            (match ? sideOf.get(match.player.player!)?.side : null) ??
            sideByName(match ? sideOf.get(match.player.player!)?.team ?? null : teamFromSelection(bet.selection ?? '')),
          selection: bet.selection ?? '',
          price: bet.price,
          stat,
          target: targetOf(market, stat, done),
          ofMulti: false,
          // The brand's own word, and only ever the brand's.
          landed: landed(bet, match, done),
        });
      }
    }

    const byMarket = new Map<string, Row[]>();
    for (const row of all) {
      byMarket.set(row.market, [...(byMarket.get(row.market) ?? []), row]);
    }
    const sorted = [...byMarket.entries()]
      .map(([market, rows]) => ({
        market,
        /*
         * One line per PLAYER, not per bet.
         *
         * Four tickets on Karl-Anthony Towns 20+ are one fact — he is on 27,
         * it has landed — repeated four times, and repeating it pushed the
         * other players off the screen. The line carries what is true of the
         * player; the tickets are underneath it for when you want them.
         */
        players: byPlayer(rows),
        /*
         * Each TICKET once, not each row. Two legs of one $10 multi land in
         * the same group, and adding both would report $20 staked on a market
         * that took ten.
         */
        stake: [...new Map(rows.map((r) => [r.bet.id, r.bet])).values()].reduce(
          (t, b) => t + (Number(b.stake) || 0),
          0,
        ),
        bets: rows.length,
      }))
      /*
       * Family first, then the line within it, so points runs 15+, 20+, 25+,
       * 30+ and then assists starts. A market whose stat we cannot name — the
       * two team markets that reach this tab on a surname collision — sorts
       * last, out of the way.
       */
      .sort((a, b) => {
        const fa = FAMILY_ORDER.indexOf(fieldFor(a.market) ?? '');
        const fb = FAMILY_ORDER.indexOf(fieldFor(b.market) ?? '');
        return (
          (fa === -1 ? Infinity : fa) - (fb === -1 ? Infinity : fb) ||
          thresholdOf(a.market) - thresholdOf(b.market) ||
          b.stake - a.stake
        );
      });

    // One header per stat, its lines underneath. Built off the sorted list, so
    // the families come out in FAMILY_ORDER and the lines inside each stay in
    // threshold order without a second sort.
    const families: {
      key: string;
      label: string;
      markets: typeof sorted;
      bets: number;
      stake: number;
    }[] = [];
    for (const g of sorted) {
      const key = fieldFor(g.market) ?? 'other';
      let into = families[families.length - 1];
      if (!into || into.key !== key) {
        into = { key, label: FAMILY_LABEL[key] ?? 'Other markets', markets: [], bets: 0, stake: 0 };
        families.push(into);
      }
      into.markets.push(g);
      into.bets += g.bets;
      into.stake += g.stake;
    }
    return families;
  }, [bets, teams, done, event]);

  if (state === 'loading') return <StatBetsSkeleton />;
  if (state === 'error') {
    return <p className="text-xs text-slate-500">Couldn't load bets for this fixture.</p>;
  }
  if (!groups.length) {
    return (
      // Named, because this tab reads two of the three brands: a fixture with
      // a hundred swiftbet player bets on it still lands here, and "no bets"
      // would be a lie about what was looked at.
      <p className="text-xs text-slate-500">
        No mybet or multis bets on this fixture name a player in the box score.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((family) => (
        <div key={family.key} className="space-y-2">
          {/* The stat, once, over every line the book offered on it. */}
          <div className="flex items-baseline gap-2">
            <h4 className="text-[13px] font-semibold text-slate-200">{family.label}</h4>
            <span className="text-[11px] text-slate-600">
              {family.bets} bet{family.bets === 1 ? '' : 's'} · ${Math.round(family.stake).toLocaleString()}
            </span>
          </div>

          {family.markets.map(({ market, players, bets, stake }) => (
            <div key={market} className="overflow-hidden rounded-xl bg-surface-raised/40">
              <div className="flex items-baseline gap-2 border-b border-surface-border px-3 py-1.5">
                <span
                  title={market}
                  className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                >
                  {lineLabel(market)}
                </span>
                <span className="ml-auto text-[11px] text-slate-600">
                  {bets} bet{bets === 1 ? '' : 's'} · ${Math.round(stake).toLocaleString()}
                </span>
              </div>

              {players.map((p) => {
                const key = `${market}:${p.player}`;
                const open = expanded.has(key);
                // A winner is the row you are looking for, so it is the one at
                // full contrast; everything else steps back.
                /*
                 * Two different claims, kept visually apart. The emerald is
                 * the BOX SCORE saying the line is beaten; the badge on the
                 * right is the BRAND saying what it paid. A bet can be hit and
                 * still pending — that is the normal state of a live game —
                 * and conflating them put "won" on money nobody had returned.
                 */
                const hit = p.target === 'hit';
                return (
                  <div key={key} className={`border-t border-surface-border/60 ${hit ? 'bg-emerald-500/[0.07]' : ''}`}>
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      aria-expanded={open}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-white/[0.03]"
                    >
                      {/*
                        * One line per player; the tickets live under it. The
                        * chevron only turns where there is more than one,
                        * because a single bet has nothing to unfold.
                        */}
                      <ChevronDown
                        size={13}
                        className={`shrink-0 transition ${p.rows.length > 1 ? '' : 'invisible'} ${
                          open ? '' : '-rotate-90'
                        } text-slate-500`}
                      />

                      {/*
                        * Who took it, in what shape, and for whom — read left
                        * to right before the name, because those three are
                        * what you are scanning the column for. A player backed
                        * at both brands or in both shapes shows both; it is
                        * rare and a single badge would be a quiet lie.
                        */}
                      {p.brands.map((b) => (
                        <span key={b} className={`${brandBadge(b)} shrink-0`}>
                          {BRAND_LABEL[b] ?? b}
                        </span>
                      ))}
                      {p.shapes.map((sh) => (
                        <span
                          key={sh}
                          title={sh === 'Single' ? 'A single bet' : `A leg of a ${sh.toLowerCase()}`}
                          className="shrink-0 rounded bg-white/5 px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-500"
                        >
                          {sh}
                        </span>
                      ))}
                      <TeamLogo
                        name={p.team ?? ''}
                        size={16}
                        logo={p.side === 'home' ? event?.homeLogo : p.side === 'away' ? event?.awayLogo : undefined}
                      />
                      <span
                        title={p.team ?? undefined}
                        className={`truncate text-sm ${hit ? 'font-semibold text-slate-50' : 'text-slate-300'}`}
                      >
                        {p.player}
                      </span>
                      {p.stat && (
                        <span
                          title={
                            hit
                              ? `${p.stat.value} ${p.stat.label} — the line is beaten. Whether it has been PAID is the badge on the right.`
                              : `${p.stat.value} ${p.stat.label} in the box score`
                          }
                          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                            hit ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/10 text-slate-300'
                          }`}
                        >
                          {hit && <Check size={11} className="shrink-0" />}
                          {p.stat.value}
                          <span className="font-normal opacity-60">{p.stat.label}</span>
                        </span>
                      )}
                      {p.rows.length > 1 && (
                        <span className="shrink-0 text-[11px] text-slate-600">{p.rows.length} bets</span>
                      )}
                      <span className="ml-auto shrink-0 tabular-nums text-xs text-slate-400">
                        ${Math.round(p.stake).toLocaleString()}
                      </span>
                      <span
                        title={LANDED_TITLE[p.landed]}
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LANDED_TONE[p.landed]}`}
                      >
                        {LANDED_LABEL[p.landed]}
                      </span>
                    </button>

                    {open && (
                      <table className="w-full border-collapse text-sm">
                        <tbody>
                          {p.rows.map(({ brand, bet, selection, price, ofMulti, landed: l }, i) => (
                            <tr key={`${bet.id}:${i}`} className="border-t border-surface-border/40">
                              <td className="w-16 py-1 pl-8 pr-2">
                                <span className={brandBadge(brand)}>{BRAND_LABEL[brand] ?? brand}</span>
                              </td>
                              {/* The bet id, because the next question after
                                  "which bets" is always "that one — show me",
                                  and the answer is a lookup in the backoffice.
                                  IdChip copies it on click. */}
                              <td className="w-24 px-2 py-1">
                                <IdChip value={bet.id} title="Bet id" />
                              </td>
                              <td className="px-2 py-1 text-slate-400">
                                {selection}
                                {/* Single, Multi or SGM — always, not only when
                                    it is a leg. A single and one leg of a
                                    four-leg SGM are very different bets and the
                                    row looked the same. */}
                                <span
                                  title={
                                    ofMulti
                                      ? `One leg of a ${bet.legCount ?? '?'}-leg ${betShape(bet)} — the stake shown is the whole ticket's`
                                      : 'A single bet'
                                  }
                                  className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-500"
                                >
                                  {betShape(bet)}
                                  {ofMulti && bet.legCount ? ` ${bet.legCount}` : ''}
                                </span>
                              </td>
                              <td className={`w-20 px-2 py-1 text-right tabular-nums ${ofMulti ? 'text-slate-600' : 'text-slate-400'}`}>
                                ${Math.round(Number(bet.stake) || 0).toLocaleString()}
                              </td>
                              <td className="w-14 px-2 py-1 text-right tabular-nums text-slate-400">
                                {price != null ? Number(price).toFixed(2) : '–'}
                              </td>
                              <td className="w-20 px-3 py-1 text-right">
                                <span
                                  title={
                                    ofMulti
                                      ? `${LANDED_TITLE[l]} This is the whole ticket's result — the brand does not settle legs.`
                                      : LANDED_TITLE[l]
                                  }
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LANDED_TONE[l]}`}
                                >
                                  {LANDED_LABEL[l]}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * How often to re-read a box score that is still being written.
 *
 * The rows themselves move about once a minute — a live NBA fixture rewrote
 * every player on it within the same second, and the next pass came a minute
 * later — so thirty seconds is comfortably inside that without asking for
 * numbers that cannot have changed. A finished game is not polled at all.
 */
/**
 * How long ago, to the second under a minute.
 *
 * There are already three `ago`s in this codebase and none of them is usable
 * here: they all round to the nearest minute, so a box score re-read thirty
 * seconds ago reads "0m", and on the one panel that refreshes itself the
 * freshness is the whole point of printing it.
 */
function ago(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const LIVE_POLL_MS = 30_000;

export function EventStatsPanel({
  fixtureId,
  event,
}: {
  fixtureId: string;
  /** The fixture as the board has it, for the score beside the box score. */
  event?: SportEvent;
}) {
  const [data, setData] = useState<PlayerStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  /*
   * In the URL, like the tab above it: "the Leaders board on this game" is a
   * thing people send each other, and it was unaddressable — every sub-tab was
   * the same link and a refresh went back to All.
   */
  const [viewParam, setView] = useParam('stats', 'all');
  const view = (['all', 'leaders', 'bets'] as const).includes(viewParam as never)
    ? (viewParam as 'all' | 'leaders' | 'bets')
    : 'all';

  const live = data?.status === 'live';
  const done = data?.status === 'completed';

  /*
   * Loaded on mount, then re-read on a timer for as long as the box score says
   * it is live — the stats tab is the one place on the page where the numbers
   * change under you and nothing else would bring them in.
   *
   * The refetch does NOT clear `data` or go back to 'loading'. Blanking a
   * table you are reading every thirty seconds, to redraw almost exactly the
   * same numbers, is worse than a stale half-second; only a change of fixture
   * shows the skeleton again.
   */
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setState('loading');

    const read = () =>
      fetchPlayerStats(fixtureId)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setState('ready');
        })
        .catch(() => !cancelled && setState((cur) => (cur === 'loading' ? 'error' : cur)));

    read();
    return () => {
      cancelled = true;
    };
  }, [fixtureId]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      fetchPlayerStats(fixtureId)
        .then((d) => setData(d))
        .catch(() => {});
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [fixtureId, live]);

  if (state === 'loading') return <StatsSkeleton />;
  if (state === 'error') {
    return (
      <PanelNotice icon={Info} title="Couldn't load player stats">
        The box score didn't come back.
      </PanelNotice>
    );
  }
  const noBoxPanel = (
    <PanelNotice icon={BarChart3} title="No box score yet">
      Player stats are published once the game is under way — there is nothing to show for a
      fixture that has not started.
    </PanelNotice>
  );

  /*
   * No box score is not an empty tab.
   *
   * This used to replace the whole panel — sub-tabs and all — with a notice,
   * which meant that on the one day people are actually betting the market
   * there was nothing here to look at. The bets exist before the game; only
   * the numbers do not. So the tabs stay, All and Leaders say why they are
   * empty, and Bets lists what has been taken.
   */
  if (!data) return noBoxPanel;
  const hasBox = data.teams.length > 0;

  const fields = data.fields ?? [];

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {/*
        * What this box score IS, and when it was last written.
        *
        * It used to repeat the score, which the match header three inches
        * above already carries — and a second scoreboard is not just noise,
        * it is a thing that can disagree with the first. What the header
        * cannot tell you is whether the numbers BELOW are final or still being
        * filled in, which changes what every one of them means. That is this
        * line's whole job, and "live" here is the stats feed's own word, not
        * the board's: it is about these rows, not about the game.
        */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-surface-border px-4 py-2 text-xs">
        {live ? (
          <span className="flex items-center gap-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300" />
            </span>
            Live
          </span>
        ) : null}
        <span className="font-medium text-slate-300">
          {live ? 'Box score, still being written' : done ? 'Final box score' : 'Box score'}
        </span>
        <span className="text-slate-600">·</span>
        <span className="text-slate-500" title={data.updatedAt ?? 'never'}>
          updated {ago(data.updatedAt)}
          {live && <span className="ml-1 text-slate-600">· re-read every 30s</span>}
        </span>
      </div>

      <SubTabs
        label="Stats view"
        tabs={[
          { key: 'all' as const, label: 'All' },
          { key: 'leaders' as const, label: 'Leaders' },
          { key: 'bets' as const, label: 'Bets' },
        ]}
        active={view}
        onChange={setView}
      />

      {view === 'leaders' && (hasBox ? <Leaders teams={data.teams} fields={fields} event={event} /> : noBoxPanel)}

      {view === 'bets' && <StatBets fixtureId={fixtureId} teams={data.teams ?? []} done={done} event={event} />}

      {view === 'all' && !hasBox && noBoxPanel}
      {view === 'all' && data.teams.map((t) => (
        <div key={`${t.side}:${t.team}`} className="overflow-hidden rounded-xl bg-surface-raised/40">
          <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
            {/* The crest the rest of the page uses for this side — the box
                score names the team in text and nowhere else. */}
            {/*
              * No `country`. TeamLogo flies a flag AHEAD of the crest, which
              * is right for a tennis player and wrong here — this panel only
              * exists for NBA and NFL, so every side is a club and a flag
              * would replace the badge that identifies it.
              */}
            <TeamLogo
              name={t.team ?? ''}
              size={18}
              logo={t.side === 'home' ? event?.homeLogo : event?.awayLogo}
            />
            <h3 className="text-[13px] font-semibold text-slate-200">{t.team}</h3>
            <span className="text-[10px] uppercase tracking-wide text-slate-600">{t.side}</span>
            <span className="ml-auto text-[11px] text-slate-600">{t.players.length} players</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Player</th>
                  <th className="w-10 px-2 py-1.5 text-left font-medium">Pos</th>
                  {fields.map((f) => (
                    <th key={f} className="w-16 px-2 py-1.5 text-right font-medium">
                      {LABELS[f] ?? f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.players.map((p) => (
                  <tr
                    key={`${p.playerId ?? p.player}`}
                    className="border-t border-surface-border/60 hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-3 py-1 text-slate-200">
                      {/* Starters carry the weight of a box score, so they are
                          sorted first and marked rather than left to be
                          inferred from the minutes column. */}
                      {p.starter && <span className="mr-1 text-amber-400" title="Started">★</span>}
                      {p.player}
                      {p.number != null && (
                        <span className="ml-1.5 text-[10px] text-slate-600">#{p.number}</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-[11px] text-slate-500">{p.position}</td>
                    {fields.map((f) => (
                      <td key={f} className="px-2 py-1 text-right tabular-nums text-slate-300">
                        {num(p[f])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {data.updatedAt && (
        <p className="text-[11px] text-slate-600">
          Last updated {new Date(data.updatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
