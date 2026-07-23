# Arb Tracker

Cross-brand arbitrage board — a Vite + React + TypeScript + Tailwind SPA,
matching the `polytracker` / `live-fixtures` conventions.

## Status

Layout-first build. The board renders off `src/lib/mockData.ts` so it stands up
without live credentials. When ready to go live, drop the anon key into `.env`
and swap the mock source for Supabase queries.

## Supabase

- Project: `qmmhejvjcpkhiqrygcta`
- URL: `https://qmmhejvjcpkhiqrygcta.supabase.co`
- Client: `src/lib/supabase.ts` (tolerates a missing key — warns instead of
  crashing so the layout keeps working).

Tables already exist in this project; the UI isn't wired to them yet.

## Dev

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
npm run typecheck
```

Set credentials in `.env` (see `.env.example`):

```
VITE_SUPABASE_URL=https://qmmhejvjcpkhiqrygcta.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

## Structure

```
src/
  App.tsx              board assembly + filter state
  components/          Header, StatCards, FiltersBar, ArbCard
  lib/
    supabase.ts        Supabase client (nullable until key is set)
    types.ts           Arb / ArbLeg contract the UI renders against
    mockData.ts        sample rows + stake/return helpers
supabase/migrations/   (empty — schema lives in the existing project)
```
