import { useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronDown, Info } from 'lucide-react';
import { fetchBets, fetchPlayerStats, type Bet, type FixtureBets, type PlayerStats, type PlayerStatLine } from '../lib/db';
import { PanelNotice, SubTabs } from './EventTabs';

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
type Landed = 'won' | 'lost' | 'void' | 'pending';

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

function landed(bet: Bet, match: Match): Landed {
  /*
   * Void is claimed only when we know WHICH player, and the box score has him
   * recording nothing anywhere (the server's `played`, judged over his whole
   * line — the stat columns on this page would call every kicker absent).
   * An ambiguous surname falls through to the brand's own result: being unsure
   * which Johnson a bet is on is not evidence that he sat out, and "void" is
   * too confident a thing to say on a guess.
   */
  if (match?.exact && match.player.played === false) return 'void';
  const r = (bet.result ?? '').toLowerCase();
  if (/cancel|void|refund/.test(r)) return 'void';
  if (/^won\b/.test(r) || /^return @/.test(r)) return 'won';
  if (/^lost\b/.test(r) || /no return/.test(r)) return 'lost';
  // Settled but in a wording we do not know, or genuinely not settled yet.
  return 'pending';
}

const LANDED_TONE: Record<Landed, string> = {
  won: 'bg-emerald-500/15 text-emerald-300',
  lost: 'bg-rose-500/15 text-rose-300',
  void: 'bg-slate-500/15 text-slate-400',
  pending: 'bg-amber-500/15 text-amber-300',
};

/** One block per stat: every player who recorded it, in order, by team. */
function Leaders({
  teams,
  fields,
}: {
  teams: PlayerStats['teams'];
  fields: string[];
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
                <div className="px-1 pb-1 text-[11px] text-slate-500">{teams[i]?.team}</div>
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
}: {
  fixtureId: string;
  teams: PlayerStats['teams'];
}) {
  const [bets, setBets] = useState<FixtureBets | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

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

    const all: { brand: string; bet: Bet; landed: Landed }[] = [];
    for (const brand of ['swiftbet', 'mybet', 'multis'] as const) {
      for (const bet of bets[brand]?.bets ?? []) {
        const match = namesPlayer(bet, players);
        if (!match) continue;
        all.push({ brand, bet, landed: landed(bet, match) });
      }
    }

    const byMarket = new Map<string, typeof all>();
    for (const row of all) {
      const key = row.bet.market ?? row.bet.selection ?? 'Unknown market';
      byMarket.set(key, [...(byMarket.get(key) ?? []), row]);
    }
    return [...byMarket.entries()]
      .map(([market, rows]) => ({
        market,
        rows,
        stake: rows.reduce((t, r) => t + (Number(r.bet.stake) || 0), 0),
      }))
      .sort((a, b) => b.stake - a.stake);
  }, [bets, teams]);

  if (state === 'loading') {
    return <div className="h-40 animate-pulse rounded-xl bg-surface-raised/40" />;
  }
  if (state === 'error') {
    return <p className="text-xs text-slate-500">Couldn't load bets for this fixture.</p>;
  }
  if (!groups.length) {
    return (
      <p className="text-xs text-slate-500">
        No bets on this fixture name a player in the box score.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map(({ market, rows, stake }) => (
        <div key={market} className="overflow-hidden rounded-xl bg-surface-raised/40">
          <div className="flex items-baseline gap-2 border-b border-surface-border px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {market}
            </span>
            <span className="ml-auto text-[11px] text-slate-600">
              {rows.length} bet{rows.length === 1 ? '' : 's'} · ${Math.round(stake).toLocaleString()}
            </span>
          </div>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {rows.map(({ brand, bet, landed: l }) => (
                <tr key={bet.id} className="border-t border-surface-border/60 hover:bg-white/[0.02]">
                  <td className="w-16 px-3 py-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LANDED_TONE[l]}`}>
                      {l}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-slate-200">{bet.selection}</td>
                  <td className="w-20 px-2 py-1 text-right tabular-nums text-slate-400">
                    ${Math.round(Number(bet.stake) || 0).toLocaleString()}
                  </td>
                  <td className="w-14 px-2 py-1 text-right tabular-nums text-slate-300">{bet.price}</td>
                  <td className="w-16 px-2 py-1 text-right text-[10px] uppercase text-slate-600">{brand}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function EventStatsPanel({ fixtureId }: { fixtureId: string }) {
  const [data, setData] = useState<PlayerStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<'all' | 'leaders' | 'bets'>('all');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setState('loading');
    fetchPlayerStats(fixtureId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [fixtureId]);

  if (state === 'loading') {
    return (
      <div className="flex-1 space-y-4 p-4">
        {[0, 1].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-surface-raised/40" />
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <PanelNotice icon={Info} title="Couldn't load player stats">
        The box score didn't come back.
      </PanelNotice>
    );
  }
  if (!data?.teams?.length) {
    return (
      <PanelNotice icon={BarChart3} title="No player stats yet">
        Stats are published once the game has been played — there is no box score for a fixture
        that hasn't started.
      </PanelNotice>
    );
  }

  const fields = data.fields ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
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

      {view === 'leaders' && <Leaders teams={data.teams} fields={fields} />}

      {view === 'bets' && <StatBets fixtureId={fixtureId} teams={data.teams} />}

      {view === 'all' && data.teams.map((t) => (
        <div key={`${t.side}:${t.team}`} className="overflow-hidden rounded-xl bg-surface-raised/40">
          <div className="flex items-baseline gap-2 border-b border-surface-border px-3 py-2">
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
