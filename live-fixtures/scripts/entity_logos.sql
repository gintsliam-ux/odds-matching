-- Logo cache for live-fixtures. Run once in the odds-library Supabase SQL editor.
-- Stores a resolved logo/headshot URL per (sport, name) so the app never has to
-- hit external sources at runtime. `logo_url` NULL means "resolved, none found"
-- (so the resolver doesn't keep re-querying it).

create table if not exists public.entity_logos (
  id          bigserial primary key,
  sport       text not null,
  name        text not null,
  logo_url    text,
  source      text,                 -- 'wikipedia' | 'thesportsdb' | 'manual' ...
  resolved_at timestamptz not null default now(),
  unique (sport, name)
);

alter table public.entity_logos enable row level security;

-- Mirrors the permissive pattern used by the other tables in this project:
-- anyone can read; the resolver (anon key) can insert/update the cache.
create policy "entity_logos read"   on public.entity_logos
  for select to anon, authenticated using (true);
create policy "entity_logos insert" on public.entity_logos
  for insert to anon, authenticated with check (true);
create policy "entity_logos update" on public.entity_logos
  for update to anon, authenticated using (true) with check (true);
