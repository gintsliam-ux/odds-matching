-- Player -> country for the flag beside a tennis player's name.
--
-- The odds feed only gives us bare player names, so this table is populated
-- out of band by scripts/resolve-player-countries.mjs (Wikidata) and joined at
-- read time. A player with no row here simply shows no flag — the UI falls
-- back to initials — so a missing or stale row degrades quietly.

create table if not exists public.tennis_player_countries (
  -- Matches tennis_events.home_team / away_team exactly, as the feed spells it.
  player_name  text primary key,
  -- ISO 3166-1 alpha-2, lowercased to suit flag CDN paths.
  country_iso2 text not null check (country_iso2 ~ '^[a-z]{2}$'),
  -- Wikidata provenance, so a wrong flag can be traced back and re-checked.
  country_qid  text,
  player_qid   text,
  -- 'sport'       — P1532, the federation they represent (preferred)
  -- 'citizenship' — P27 fallback, where no sport country is recorded
  -- 'override'    — hand-checked, from player-country-overrides.json
  source       text not null check (source in ('sport', 'citizenship', 'override')),
  resolved_at  timestamptz not null default now()
);

comment on table public.tennis_player_countries is
  'Tennis player nationality for flags. Regenerate with scripts/resolve-player-countries.mjs.';

alter table public.tennis_player_countries enable row level security;

-- The board is read with the anon key, same as the events/odds tables.
drop policy if exists "tennis_player_countries read" on public.tennis_player_countries;
create policy "tennis_player_countries read"
  on public.tennis_player_countries
  for select
  to anon, authenticated
  using (true);
