# Live Events Terminal

A monospace, terminal-style live sports board — a responsive grid of LIVE /
UPCOMING / COMPLETED fixtures with head-to-head (moneyline) odds, live-ticking
clocks, and a stats header. **Phase 1 · OpticOdds.**

Stack matches the other workspace apps: Vite + React 19 + TypeScript +
Tailwind v4 + lucide-react.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
```

## Data source

The only source is the `live_fixtures` table (OpticOdds-scraped) in the
odds-library Supabase project. Copy `.env.example` → `.env` and set:

```
VITE_SUPABASE_URL=...        # odds-library project
VITE_SUPABASE_ANON_KEY=...
```

`src/lib/dataSource.ts` reads these `live_fixtures` columns:

| column | → `Fixture` field |
| --- | --- |
| `optic_fixture_id` | `id` |
| `sport` (`rugby_union`) | `sport` (underscores → spaces, header upper-cases) |
| `league` (`france_-_ligue_1`) | `league` → `LIGUE 1` (slug prettified) |
| `status` + `is_live` | `status` (live / upcoming / completed) |
| `scheduled_start` / `actual_start` | `startTime` — **live clocks off `actual_start`**, everything else off `scheduled_start` |
| `home_team` / `away_team` | names |
| `home_score` / `away_score` | scores (null → not started) |
| `live_h2h_*` ?? `closing_h2h_*` | H / D / A odds (live price when in-play, else closing line; draw shown only when present) |

The board fetches a relevant window — **all live games + everything scheduled
from 12h ago to 24h ahead** (`fetchFixtures`) — rather than all 600+ rows.
Tune `UPCOMING_HORIZON_H` / `RECENT_COMPLETED_H` there. `fetchFixtureById`
resolves deep links to fixtures outside that window.

## Routing

- `/` — all events (grouped LIVE / UPCOMING / COMPLETED)
- `/live` — currently-live board
- `/upcoming`, `/completed` — day-browsed (relative-day chips + calendar picker, `?date=YYYY-MM-DD`, Melbourne days)
- `/sport/:sport` — one sport, all statuses
- `/favourite/:id` — a saved custom filter (see below)
- `/fixture/:id` — full event detail page (`:id` is `optic_fixture_id`)
- `?q=` — team search (shareable)

## Favourites (custom saved filters)

The left nav's **FAVOURITES** section holds named filters that union any mix of
sports + leagues (e.g. "US Sports" = MLB / NBA / NHL / NFL). Create with the `+`,
rename/edit/delete via the pencil. Stored in `localStorage` (personal per-browser
— the app has no auth), live-synced across the UI via `src/lib/favourites.ts`.

The left nav drives status/sport via the URL. `src/components/Layout.tsx` runs
the 15s poll once and shares the fixture list + clock with every route (Outlet
context), so the detail page keeps ticking live. SPA fallback is in `vercel.json`.

## Stable ordering

`src/hooks/useStableOrder.ts` assigns each fixture a sequence number the first
time it's seen and sorts by it, so a poll updates scores/odds/clocks **in place**
without reshuffling cards — new fixtures append, removed ones drop.

## Layout

- `src/components/Layout.tsx` — header + sidebar + polling; provides fixtures (stable-ordered) to routes
- `src/components/Header.tsx` — brand, feed counts, poll countdown, UTC clock
- `src/components/Sidebar.tsx` — left nav: EVENTS + SPORTS (NavLink, live counts)
- `src/components/FixtureGrid.tsx` — grouped LIVE/UPCOMING/COMPLETED sections
- `src/components/FixtureCard.tsx` — single fixture card (3 status variants); click → detail page
- `src/components/Skeleton.tsx` — shimmer loaders (card grid + detail)
- `src/pages/Terminal.tsx` — board page: route-driven filters + league/search toolbar + grid
- `src/pages/FixtureDetailPage.tsx` — full event page: scoreline, line score, timing (UTC+MEL), H2H, spread/totals, meta
- `src/hooks/useFixtures.ts` — polls Supabase every 15s
- `src/hooks/useNow.ts` — 1s tick that drives live clocks
