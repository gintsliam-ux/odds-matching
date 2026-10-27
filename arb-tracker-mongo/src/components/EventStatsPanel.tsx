import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Info } from 'lucide-react';
import { fetchPlayerStats, type PlayerStats, type PlayerStatLine } from '../lib/db';
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

/** One block per stat: every player who recorded it, in order, by team. */
function Leaders({
  teams,
  fields,
}: {
  teams: PlayerStats['teams'];
  fields: string[];
}) {
  const blocks = useMemo(() => scorersByStat(teams, fields), [teams, fields]);
  if (!blocks.length) {
    return <p className="text-xs text-slate-500">Nobody recorded any of these stats in this game.</p>;
  }
  return (
    <div className="space-y-3">
      {blocks.map(({ field, perTeam }) => (
        <div key={field} className="overflow-hidden rounded-xl bg-surface-raised/40">
          <div className="border-b border-surface-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {LABELS[field] ?? field}
          </div>
          <div className="grid grid-cols-1 gap-px bg-surface-border sm:grid-cols-2">
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

export function EventStatsPanel({ fixtureId }: { fixtureId: string }) {
  const [data, setData] = useState<PlayerStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<'all' | 'leaders'>('all');

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
        ]}
        active={view}
        onChange={setView}
      />

      {view === 'leaders' && <Leaders teams={data.teams} fields={fields} />}

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
