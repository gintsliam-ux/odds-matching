-- Generalize the OPTIC↔bookmaker mapping tables to carry a `provider` so an
-- OPTIC fixture can map to BOTH SwiftBet and mybet at once. Run once in the
-- odds-library Supabase SQL editor (project aucplqygawlpijzbfvjb).
--
-- Safe to re-run: every step is idempotent (IF NOT EXISTS / discover-then-drop).
-- Existing rows all become provider='swift', so the SwiftBet path is unchanged.

-- 1. provider column on both tables (existing rows backfill to 'swift').
alter table public.competition_mapping
  add column if not exists provider text not null default 'swift';
alter table public.event_mapping
  add column if not exists provider text not null default 'swift';

-- 2. event_mapping: the old UNIQUE was on (optic_fixture_id) alone — that caps
--    each fixture at ONE mapping total, which would stop a fixture mapping to
--    both a SwiftBet and a mybet event. Drop it and re-key on
--    (provider, optic_fixture_id). We discover the constraint name because
--    Postgres auto-generated it.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.event_mapping'::regclass
      and contype in ('u','p')
      and conname <> 'event_mapping_pkey'          -- keep the surrogate PK
      and pg_get_constraintdef(oid) ilike '%(optic_fixture_id)%'
  loop
    execute format('alter table public.event_mapping drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists event_mapping_provider_fixture_uidx
  on public.event_mapping (provider, optic_fixture_id);

-- 3. competition_mapping: old UNIQUE was
--    (optic_sport, optic_league, optic_tournament, gutsy_competition_id).
--    Re-key with provider so both books can map the same OPTIC tournament.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.competition_mapping'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%optic_tournament%gutsy_competition_id%'
  loop
    execute format('alter table public.competition_mapping drop constraint %I', c);
  end loop;
end $$;

create unique index if not exists competition_mapping_provider_key_uidx
  on public.competition_mapping
     (provider, optic_sport, optic_league, optic_tournament, gutsy_competition_id);

-- 4. Helpful lookup indexes for the per-provider reads the app does.
create index if not exists event_mapping_provider_idx on public.event_mapping (provider);
create index if not exists competition_mapping_provider_idx on public.competition_mapping (provider);
