import { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { fetchBets, type Bet, type BrandBets, type FixtureBets } from '../lib/db';
import { PanelNotice, SubTabs } from './EventTabs';

export type BetBrand = 'swiftbet' | 'mybet' | 'multis';

const BRANDS: { key: BetBrand; label: string }[] = [
  { key: 'swiftbet', label: 'Swiftbet' },
  { key: 'mybet', label: 'Mybet' },
  { key: 'multis', label: 'Multis' },
];

const money = (n: number | null) =>
  n == null ? '–' : n.toLocaleString(undefined, { style: 'currency', currency: 'AUD', maximumFractionDigits: 2 });

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '–';

/** Settled results carry a sign; anything still running is neutral. */
const WON = /^(won|win|return|paid|placed)/i;
const LOST = /^(lost|loss|no return|no-return)/i;

function ResultChip({ result }: { result: string | null }) {
  if (!result) return <span className="text-slate-600">–</span>;
  const tone = WON.test(result)
    ? 'bg-emerald-500/10 text-emerald-400'
    : LOST.test(result)
      ? 'bg-rose-500/10 text-rose-400'
      : 'bg-white/5 text-slate-400';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`} title={result}>
      {result}
    </span>
  );
}

function BetRow({ bet }: { bet: Bet }) {
  const plTone = bet.pl == null ? 'text-slate-600' : bet.pl > 0 ? 'text-emerald-400' : bet.pl < 0 ? 'text-rose-400' : 'text-slate-400';
  return (
    <tr className="border-b border-surface-border/60 last:border-0 hover:bg-white/[0.03]">
      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{when(bet.placedAt)}</td>
      <td className="max-w-[260px] px-3 py-2">
        <div className="truncate text-slate-200" title={bet.selection ?? undefined}>
          {bet.selection ?? '–'}
        </div>
        {bet.market && (
          <div className="truncate text-[11px] text-slate-500" title={bet.market}>
            {bet.market}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className="text-slate-400">{bet.betType ?? '–'}</span>
        {bet.legCount != null && bet.legCount > 1 && (
          <span className="ml-1.5 rounded bg-white/5 px-1 py-0.5 text-[10px] text-slate-500">
            {bet.legCount} legs
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-200">
        {money(bet.stake)}
        {bet.bonus && (
          <span className="ml-1.5 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-400">
            bonus
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-200">
        {bet.price != null ? bet.price.toFixed(2) : '–'}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
        {bet.em == null ? (
          <span className="text-slate-600">–</span>
        ) : (
          <span className={bet.em > 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {bet.em > 0 ? '+' : ''}
            {bet.em.toFixed(1)}%
          </span>
        )}
      </td>
      <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${plTone}`}>
        {money(bet.pl)}
      </td>
      <td className="px-3 py-2"><ResultChip result={bet.result} /></td>
      {/* The account id is shown whole — a truncated id can't be looked up. */}
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-500" title={bet.user ?? undefined}>
        {bet.user ?? '–'}
      </td>
    </tr>
  );
}

function BrandTable({ data, label }: { data: BrandBets; label: string }) {
  if (data.bets.length === 0) {
    const notice =
      data.reason === 'not-configured'
        ? 'No bets database is configured for this board.'
        : data.reason === 'unmapped'
          ? `This fixture has no ${label} event mapped to it, so there is nothing to look up. Mapping is per fixture and per brand — an unmapped event is not the same as an event nobody bet on.`
          : `No ${label} bets were placed on this fixture.`;
    return (
      <PanelNotice icon={Receipt} title={data.reason === 'unmapped' ? `Not mapped to ${label}` : `No ${label} bets`}>
        {notice}
      </PanelNotice>
    );
  }

  const staked = data.bets.reduce((a, b) => a + (b.stake ?? 0), 0);
  // Only settled bets carry a real P/L, so only they are totalled — and the
  // count is shown beside it, because "P/L across 7 of 134 bets" and "P/L" are
  // very different claims.
  const settled = data.bets.filter((b) => b.resolved && b.pl != null);
  const pl = settled.reduce((a, b) => a + (b.pl ?? 0), 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-surface-border/60 px-3 py-2 text-[11px] text-slate-500">
        <span>
          <b className="text-slate-300">{data.bets.length}</b> bets
        </span>
        <span>
          staked <b className="text-slate-300">{money(staked)}</b>
        </span>
        {settled.length > 0 ? (
          <span>
            P/L{' '}
            <b className={pl > 0 ? 'text-emerald-400' : pl < 0 ? 'text-rose-400' : 'text-slate-300'}>
              {money(pl)}
            </b>
            <span className="ml-1 text-slate-600">
              across {settled.length} settled
            </span>
          </span>
        ) : (
          <span className="text-slate-600">none settled yet</span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-500">
            {['Placed', 'Selection', 'Type', 'Stake', 'Price', 'EM', 'P/L', 'Result', 'Account'].map((h, i) => (
              <th
                key={h}
                className={`sticky top-0 z-10 bg-surface-raised px-3 py-2 font-medium ${
                  i >= 3 && i <= 6 ? 'text-right' : 'text-left'
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.bets.map((b) => (
            <BetRow key={b.id} bet={b} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bets placed on this fixture, by brand. Swiftbet comes from `gutsy.bets`;
 * Mybet and Multis share `gutsy.multi_bets`, split on the licence. All three
 * are reached through `event_mapping`, which is why a fixture can legitimately
 * have bets under one brand and nothing under another.
 */
export function BetsPanel({ fixtureId }: { fixtureId: string }) {
  const [brand, setBrand] = useState<BetBrand>('swiftbet');
  const [data, setData] = useState<FixtureBets | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchBets(fixtureId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [fixtureId]);

  if (state === 'loading') {
    return (
      <div className="flex-1 space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-surface-raised/40" />
        ))}
      </div>
    );
  }
  if (state === 'error' || !data) {
    return (
      <PanelNotice icon={Receipt} title="Couldn't load bets">
        The bets cluster didn't answer. It's a separate database from the odds, so the rest of
        this page is unaffected.
      </PanelNotice>
    );
  }
  if (!data.configured) {
    return (
      <PanelNotice icon={Receipt} title="No bets source connected">
        Set <code>BETS_URI</code> to the cluster holding <code>gutsy.bets</code> and{' '}
        <code>gutsy.multi_bets</code>, and this tab fills in.
      </PanelNotice>
    );
  }

  return (
    <>
      <SubTabs
        label="Bet brands"
        tabs={BRANDS.map((b) => ({
          key: b.key,
          label: b.label,
          badge: data[b.key].bets.length || null,
        }))}
        active={brand}
        onChange={setBrand}
      />
      <BrandTable data={data[brand]} label={BRANDS.find((b) => b.key === brand)!.label} />
    </>
  );
}
