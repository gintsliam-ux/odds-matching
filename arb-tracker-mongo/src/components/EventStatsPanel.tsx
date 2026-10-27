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
 * Who led each team in each stat.
 *
 * Broken down BY STAT rather than by player, because that is the question
 * being asked: not "how did this player do" — the All view answers that — but
 * "who carried the rushing yards", with both teams side by side so the two are
 * read against each other rather than looked up twice.
 *
 * A stat nobody recorded is dropped rather than printed as a row of dashes:
 * most of an NFL roster has no passing yards, and a block saying so of both
 * teams is noise. A team with no entry on a stat other teams have still shows a
 * dash, because there the absence is the information.
 */
type Leader = { player: string | null; position: string | null; value: number } | null;

function leadersByStat(
  teams: PlayerStats['teams'],
  fields: string[],
): { field: string; perTeam: Leader[] }[] {
  const out: { field: string; perTeam: Leader[] }[] = [];
  for (const field of fields) {
    const perTeam: Leader[] = teams.map((t) => {
      let best: Leader = null;
      for (const p of t.players) {
        const v = Number(p[field]);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (!best || v > best.value) best = { player: p.player, position: p.position, value: v };
      }
      return best;
    });
    if (perTeam.some(Boolean)) out.push({ field, perTeam });
  }
  return out;
}

const num = (v: PlayerStatLine[string]) =>
  v == null || v === '' ? <span className="text-slate-700">–</span> : String(v);

/** One stat, with each team's leader in it. */
function Leaders({
  teams,
  fields,
}: {
  teams: PlayerStats['teams'];
  fields: string[];
}) {
  const rows = useMemo(() => leadersByStat(teams, fields), [teams, fields]);
  if (!rows.length) {
    return (
      <p className="text-xs text-slate-500">
        Nobody recorded any of these stats in this game.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-surface-raised/40">
      <table className="w-full border-collapse text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-28 px-3 py-1.5 text-left font-medium">Stat</th>
            {teams.map((t) => (
              <th key={`${t.side}:${t.team}`} className="px-3 py-1.5 text-left font-medium">
                {t.team}
                <span className="ml-1.5 text-[10px] normal-case text-slate-600">{t.side}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ field, perTeam }) => (
            <tr key={field} className="border-t border-surface-border/60 hover:bg-white/[0.02]">
              <td className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-slate-500">
                {LABELS[field] ?? field}
              </td>
              {perTeam.map((l, i) => (
                <td key={i} className="px-3 py-1.5">
                  {l ? (
                    <span className="flex items-baseline gap-2">
                      {/* The number first: on this view the value is what is
                          being compared across the two columns, and the name
                          answers "who" second. */}
                      <b className="tabular-nums text-slate-100">{l.value}</b>
                      <span className="truncate text-slate-300">{l.player}</span>
                      {l.position && (
                        <span className="text-[10px] text-slate-600">{l.position}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-700">–</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
