import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, BookOpen, CalendarDays, Check, Clock, Hourglass, LayoutGrid, Link2, Minus, Radio,
  TrendingDown, Trophy, Users as UsersIcon,
} from 'lucide-react';
import { SignOut } from '../components/SignOut';
import { useAuth } from '../lib/useAuth';
import { useCapabilities } from '../lib/capabilitiesContext';

/**
 * Contents: what each page is for and how to read it, with a link to it.
 *
 * The same idea as the Contents page on the wagering dashboards. It lists
 * only the pages the signed-in account can open, by the same gates the rail
 * and the router use (see RailLink in App.tsx and the guards in main.tsx), so
 * nobody is pointed at a page that will bounce them back to the board.
 *
 * When a page changes what it shows, change its entry here in the same commit.
 */

type Gate = 'all' | 'notSupport' | 'desk' | 'admin';

/**
 * Who each gate lets in, for the "who can see it" chips.
 *
 * There are three roles and two of them are restricted (ALLOWED_BY_ROLE in
 * server/lib/routes.mjs): support has the board and its event page, trading
 * has those plus the ticker, and everything else is admin's. 'desk' means
 * "not trading and not support", which with three roles is admin alone; it is
 * kept apart from 'admin' because the server treats them differently (an
 * allow-list for the restricted roles, a deny-list for admin-only routes) and
 * a fourth role would land on the desk side.
 */
type Role = 'admin' | 'trading' | 'support';
const ROLES: Role[] = ['admin', 'trading', 'support'];
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', trading: 'Trading', support: 'Support' };
const GATE_ROLES: Record<Gate, Role[]> = {
  all: ['admin', 'trading', 'support'],
  notSupport: ['admin', 'trading'],
  desk: ['admin'],
  admin: ['admin'],
};
// The same colours the Users page gives each role.
const ROLE_ON: Record<Role, string> = {
  admin: 'bg-emerald-500/15 text-emerald-300',
  trading: 'bg-amber-500/15 text-amber-300',
  support: 'bg-sky-500/15 text-sky-300',
};

interface Page {
  title: string;
  icon: typeof Radio;
  /** Where the card's button goes; absent for the event page, which is opened from the board. */
  path?: string;
  gate: Gate;
  /** Needs the bets data (the ticker, settlement, late and pending bets). */
  bets?: boolean;
  /** Needs the mapping tables. */
  mapping?: boolean;
  summary: string;
  points: string[];
  /** Where a role that can open the page sees less of it than an admin. */
  roleNote?: string;
}

const PAGES: Page[] = [
  {
    title: 'Board',
    icon: LayoutGrid,
    path: '/',
    gate: 'all',
    summary: 'The landing page: every fixture, with the head-to-head price at each book.',
    points: [
      'Fixtures are grouped by sport and league in the left rail. Pick one, or use the search box to find a team or competition.',
      'Games in play show the score and the clock, and update on their own.',
      'Click a fixture to open its event page on the right.',
    ],
    roleNote: 'Trading and support see the same board as an admin.',
  },
  {
    title: 'Event page',
    icon: CalendarDays,
    gate: 'all',
    summary: 'One fixture: every market, the bets on it, and the box score. Opened by clicking a fixture on the board.',
    points: [
      'Markets: each selection across the books, best price highlighted. Filter by Moneyline, Handicap, Totals, Specials or Outright, and switch between Pre-match and In-play.',
      'The % row under a market is each book\'s margin on it. Hover a price to see how it has moved (admin accounts only).',
      'Bets: the bets our brands have taken on this fixture.',
      'Stats (NBA and NFL): the box score, and under Bets the player bets beside the stat they need. A green row has beaten its line; a grey row is a player who did not take the field, so the bet should be void.',
      'Details: which brand events and ids this fixture is joined to.',
    ],
    roleNote: 'Trading and support get the current price only: no price history, so nothing shows on hover and there are no price-movement figures.',
  },
  {
    title: 'Ticker',
    icon: Radio,
    path: '/ticker',
    gate: 'notSupport',
    bets: true,
    summary: 'Every single bet as it comes in, newest first, across all sports and brands.',
    points: [
      'Each row is one bet: who took it, the selection, the stake and the price they got.',
      'Beside it is what the other books were showing on the same outcome, so a price can be judged against the market.',
      'Player props (points, rebounds, touchdowns and so on) are priced against the other books too.',
    ],
  },
  {
    title: 'Movers',
    icon: TrendingDown,
    path: '/movers',
    gate: 'desk',
    summary: 'Head-to-head prices that have moved, and which books have not moved with them.',
    points: [
      'The move leads each row: where the market was, where it is now, and the change in implied probability.',
      'Lagging rows come first, tinted green: a book still showing the old price after the market has shortened.',
      'Click a fixture name to open its event page.',
    ],
  },
  {
    title: 'Futures',
    icon: Trophy,
    path: '/futures',
    gate: 'desk',
    summary: 'Outrights and season-long markets: premiership winners, MVPs, division winners, golf tournaments.',
    points: [
      'Pick a competition on the left. Filter by sport, or switch on "Priced by mybet or Swiftbet" to see only what our brands offer.',
      'The Markets tab has a market picker (Outright, MVP, divisions and so on) above the price grid.',
      'Books shown: TAB, TABtouch, PointsBet, Unibet, Ladbrokes, bet365, William Hill, Paddy Power, DraftKings, FanDuel and Fanatics, beside mybet and Swiftbet.',
      'A book whose prices have not changed in 7 days is left out of the grid. The Details tab lists those books and how long they have been quiet.',
      'The Bets tab shows every bet across the competition, labelled with its market.',
    ],
  },
  {
    title: 'Settlement',
    icon: Clock,
    path: '/settlement',
    gate: 'desk',
    bets: true,
    summary: 'Games that have finished but still have bets we have not resulted.',
    points: [
      'The clock counts from when the game finished, not from kick-off, so a match at half time is not listed.',
      'Set how many minutes overdue a game must be to appear (30 by default). Amber is over an hour, red over two.',
      'An empty page is the good outcome. It refreshes every minute.',
    ],
  },
  {
    title: 'Late Bets',
    icon: AlertTriangle,
    path: '/late-bets',
    gate: 'desk',
    bets: true,
    summary: 'Bets accepted after the game had already started.',
    points: [
      'We do not offer in-play betting online, so each of these is a market that should have been closed.',
      'Sorted by how late the bet was. Amber is 15 minutes or more after the start, red an hour or more.',
      'Choose how late a bet must be to count, and how many hours back to look (24 by default).',
    ],
  },
  {
    title: 'Pending Bets',
    icon: Hourglass,
    path: '/pending',
    gate: 'admin',
    bets: true,
    summary: 'Bets still open, and what the market has done to them since they were placed.',
    points: [
      'Each row compares the price the customer took with the price we show on that selection now.',
      'A firmer is a selection now shorter than the price taken: the market has moved the customer\'s way.',
      'The time shown is how long until the event starts, since a firmer nine minutes from the start is a different problem from one three days out.',
    ],
  },
  {
    title: 'Mapping',
    icon: Link2,
    path: '/mapping',
    gate: 'desk',
    mapping: true,
    summary: 'Which of our brands\' competitions are joined to which league in the odds feed.',
    points: [
      'A work queue: each league is Mapped, ready to map automatically, needs Review, Unmatched or Suspect.',
      'A suggested match shows two separate reasons to believe it: how well the names agree, and how much of the squads the two competitions share.',
      'A bet that will not match, or a price that looks stale, usually traces back to a mapping here.',
    ],
  },
  {
    title: 'Users',
    icon: UsersIcon,
    path: '/users',
    gate: 'admin',
    summary: 'Who can sign in, and what they can see.',
    points: [
      'Add an account, change its role, set a new password, or delete it.',
      'Admin sees everything. Trading has the board and the ticker. Support has the board only.',
      'Price history is kept from trading and support accounts.',
    ],
  },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-');

export default function ContentsPage() {
  const { user } = useAuth();
  const caps = useCapabilities();
  const role = user?.role ?? '';
  const allowed = (p: Page) => {
    if (p.bets && !caps.bets) return false;
    if (p.mapping && !caps.mapping) return false;
    if (p.gate === 'admin') return role === 'admin';
    if (p.gate === 'desk') return role !== 'trading' && role !== 'support';
    if (p.gate === 'notSupport') return role !== 'support';
    return true;
  };
  const pages = PAGES.filter(allowed);

  return (
    <div className="flex h-dvh flex-col bg-surface text-slate-200">
      <header className="shrink-0 border-b border-surface-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
          >
            <ArrowLeft size={14} /> Board
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-100">
              <BookOpen size={16} className="text-emerald-400" />
              Contents
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">What each page shows and how to read it</p>
          </div>
          <div className="ml-auto">
            <SignOut />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <nav className="flex flex-wrap gap-2">
          {pages.map((p) => (
            <a
              key={p.title}
              href={`#${slug(p.title)}`}
              className="rounded-lg border border-surface-border bg-white/[0.03] px-2.5 py-1 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            >
              {p.title}
            </a>
          ))}
        </nav>

        {/*
          Who can see what, in one table. Only for an admin: it is the admin
          who hands out roles, and the other two roles are only ever shown
          their own pages here.
        */}
        {role === 'admin' && (
          <section className="mt-4 max-w-2xl overflow-hidden rounded-xl border border-surface-border bg-white/[0.02]">
            <h2 className="border-b border-surface-border px-4 py-2.5 text-[13px] font-semibold text-slate-100">
              Who can see each page
            </h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-1.5 font-medium">Page</th>
                  {ROLES.map((r) => (
                    <th key={r} className="w-24 px-2 py-1.5 text-center font-medium">{ROLE_LABEL[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PAGES.map((p) => (
                  <tr key={p.title} className="border-t border-surface-border/60">
                    <td className="px-4 py-1.5">
                      <a href={`#${slug(p.title)}`} className="text-slate-200 hover:text-emerald-300">{p.title}</a>
                    </td>
                    {ROLES.map((r) => (
                      <td key={r} className="px-2 py-1.5 text-center">
                        {GATE_ROLES[p.gate].includes(r) ? (
                          <Check size={14} className="inline text-emerald-400" aria-label="can see" />
                        ) : (
                          <Minus size={14} className="inline text-slate-700" aria-label="cannot see" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-surface-border/60 px-4 py-2 text-xs text-slate-500">
              Roles are set on the Users page. Trading and support see current prices only, with no price history.
            </p>
          </section>
        )}

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {pages.map((p) => (
            <PageCard key={p.title} page={p} />
          ))}
        </div>

        <p className="mt-5 max-w-3xl text-xs leading-relaxed text-slate-500">
          Terms: a book&apos;s % on a market is its margin, the amount its prices add up to over 100. Implied
          probability is 1 divided by the price. A price that shortens has moved toward the selection; a firmer
          is a bet whose selection has shortened since it was placed.
        </p>
      </main>
    </div>
  );
}

function PageCard({ page }: { page: Page }) {
  const Icon = page.icon;
  return (
    <section
      id={slug(page.title)}
      className="flex scroll-mt-4 flex-col rounded-xl border border-surface-border bg-white/[0.02] p-5"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/25">
          <Icon size={16} className="text-emerald-300" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-slate-100">{page.title}</h2>
          <p className="text-sm text-slate-400">{page.summary}</p>
        </div>
      </div>

      <ul className="mt-3 flex-1 list-disc space-y-1.5 pl-5 text-sm text-slate-300 marker:text-slate-600">
        {page.points.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      {/* Who can open it: lit for a role that can, dimmed for one that cannot. */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="mr-0.5 text-slate-500">Who can see it</span>
        {ROLES.map((r) => {
          const on = GATE_ROLES[page.gate].includes(r);
          return (
            <span
              key={r}
              title={`${ROLE_LABEL[r]} ${on ? 'can' : 'cannot'} open ${page.title}`}
              className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${
                on ? ROLE_ON[r] : 'bg-white/[0.03] text-slate-600 line-through'
              }`}
            >
              {ROLE_LABEL[r]}
            </span>
          );
        })}
      </div>
      {page.roleNote && <p className="mt-1.5 text-xs text-slate-500">{page.roleNote}</p>}

      {page.path && (
        <div className="mt-4">
          <Link
            to={page.path}
            className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-white/[0.04] px-3 py-1.5 text-sm text-slate-200 transition hover:border-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-200"
          >
            Open {page.title}
          </Link>
        </div>
      )}
    </section>
  );
}
