import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * An id, as much of it as is worth reading, with the whole thing a click away.
 *
 * It used to show three characters of everything, on the reasoning that three
 * is enough to see two rows are the same punter and a column cannot carry a
 * UUID. Half right. The two sides are not the same shape:
 *
 *   swiftbet        36-char UUIDs       1c0a3a05-110b-4195-…
 *   mybet / multis  5-digit user, 7-digit bet   33710 / 6608715
 *
 * so a blanket three characters rendered bet 6608715 as "660" — and a mybet bet
 * id is the thing you quote when you ask why a bet mapped the way it did. The
 * whole number is seven characters and fits. So short ids are shown whole and
 * only UUIDs are cut, at eight, which is where a git hash settles for the same
 * reason.
 *
 * The copy stays the primary action, so the chip is still the button. Shared
 * between the ticker and the pending-bets page rather than copied into both: a
 * second implementation of "click to copy" is a second thing to get subtly
 * different, and the id formats it has to know about are the same on both.
 */
const SHOW_WHOLE = 10;

export function IdChip({ value, title }: { value: string | null; title: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const long = value.length > SHOW_WHOLE;
  return (
    <button
      type="button"
      title={`${title}: ${value} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className="group inline-flex w-full items-center gap-0.5 rounded bg-white/5 px-1 py-0.5 font-mono text-xs leading-none text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
    >
      <span className="truncate">{long ? value.slice(0, 8) : value}</span>
      {long && <span className="shrink-0 opacity-40">…</span>}
      {copied ? (
        <Check size={9} className="ml-auto shrink-0 text-emerald-400" />
      ) : (
        <Copy size={9} className="ml-auto shrink-0 opacity-0 transition group-hover:opacity-60" />
      )}
    </button>
  );
}
