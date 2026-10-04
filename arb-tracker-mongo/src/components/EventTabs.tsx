import type { LucideIcon } from 'lucide-react';

export type EventTab = 'markets' | 'bets' | 'details';

interface TabDef {
  key: EventTab;
  label: string;
  /** Shown as a count chip when the tab has something to report. */
  badge?: string | number | null;
}

/**
 * The three panes of an event page, under the scoreboard. Rendered as a real
 * tablist so the arrow keys move between them and screen readers announce the
 * selection — the panels are siblings below, each with `role="tabpanel"`.
 */
export function EventTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: EventTab;
  onChange: (t: EventTab) => void;
}) {
  // Left/Right wrap around the list, which is what a tablist is expected to do.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.key === active);
    onChange(tabs[(i + dir + tabs.length) % tabs.length].key);
  };

  return (
    <div
      role="tablist"
      aria-label="Event sections"
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-1 border-b border-surface-border bg-surface-raised px-3"
    >
      {tabs.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`panel-${t.key}`}
            // Only the selected tab is in the tab order; the arrows move within.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              selected
                ? 'border-emerald-400 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
            {t.badge != null && t.badge !== '' && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                  selected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-slate-500'
                }`}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface SubTab<T extends string> {
  key: T;
  label: string;
  badge?: string | number | null;
}

/**
 * The second level inside a panel — market groups, bet brands. Pills rather
 * than underlines, so it reads as subordinate to the tabs above it and the two
 * rows can never be mistaken for each other.
 */
export function SubTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: SubTab<T>[];
  active: T;
  onChange: (t: T) => void;
  label: string;
}) {
  // A single option is a statement, not a choice — don't draw a picker for it.
  if (tabs.length < 2) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.key === active);
    onChange(tabs[(i + dir + tabs.length) % tabs.length].key);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-surface-border/60 bg-surface-raised/40 px-3 py-2"
    >
      {tabs.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              selected
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
            }`}
          >
            {t.label}
            {t.badge != null && t.badge !== '' && (
              <span className="text-[10px] tabular-nums opacity-70">{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Shared empty/'nothing here' block, so the panels read consistently. */
export function PanelNotice({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <Icon size={28} className="mx-auto mb-3 text-slate-600" />
        <p className="text-sm font-medium text-slate-300">{title}</p>
        {children && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{children}</p>}
      </div>
    </div>
  );
}
