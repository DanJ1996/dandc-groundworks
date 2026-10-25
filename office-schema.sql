-- ==================================================================
-- D&C Site Office — Supabase setup (directors-only dashboard)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Requires dayworks-schema.sql to have been run first
-- (it provides profiles + public.is_director()).
-- ==================================================================

-- 1) One generic store for the whole dashboard. The app keeps each
--    record as a JSON "document" inside a named collection, exactly
--    like the design expects (employees, projects, quotes, invoices,
--    rates, timesheets).
create table if not exists public.office_docs (
  collection text not null,
  doc_id     text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, doc_id)
);

alter table public.office_docs enable row level security;

-- Directors only — the whole Site Office is theirs. Crew use the field app.
drop policy if exists office_docs_all on public.office_docs;
create policy office_docs_all on public.office_docs for all
  using (public.is_director()) with check (public.is_director());

-- 2) Live updates so both directors see changes instantly.
do $$ begin
  alter publication supabase_realtime add table public.office_docs;
exception when duplicate_object then null; end $$;

-- 3) Private bucket for the documents directors attach to projects
--    (drawings, specs, tenders, quotes — PDF/PNG/JPG, up to 20 MB).
insert into storage.buckets (id, name, public)
values ('office-files', 'office-files', false)
on conflict (id) do nothing;

drop policy if exists office_files_read on storage.objects;
create policy office_files_read on storage.objects for select
  using (bucket_id = 'office-files' and public.is_director());

drop policy if exists office_files_write on storage.objects;
create policy office_files_write on storage.objects for insert
  with check (bucket_id = 'office-files' and public.is_director());

drop policy if exists office_files_remove on storage.objects;
create policy office_files_remove on storage.objects for delete
  using (bucket_id = 'office-files' and public.is_director());

-- ==================================================================
-- 4) CREW SELF-SERVICE
--    Each lad gets their own page in the Site Office. They can enter
--    ONLY their own weekly hours, and read the project list so they
--    can tag hours to a job. Directors still see everything (above).
--    Crew hours live in office_docs under collection 'crew_hours',
--    keyed doc_id = '<their-user-id>__<week>' so the policy can scope
--    each row to its owner. These rows show up live in the directors'
--    Timesheets tab.
-- ==================================================================

-- A lad can read/write ONLY rows that belong to them.
drop policy if exists office_docs_crew_hours on public.office_docs;
create policy office_docs_crew_hours on public.office_docs for all
  using (collection = 'crew_hours' and split_part(doc_id, '__', 1) = auth.uid()::text)
  with check (collection = 'crew_hours' and split_part(doc_id, '__', 1) = auth.uid()::text);

-- Crew need the ADDRESS of live jobs (to tag their hours / day works). They must
-- NEVER get prices, rates, markup, tender value, client or notes.
--
-- IMPORTANT: a row-level policy cannot hide individual JSON keys — it returns the
-- WHOLE project record. So the old `office_docs_crew_read_projects` policy leaked
-- every priced line, the markup % and the agreed tender for live jobs to any
-- signed-in crew member (invisible on screen, but present in the raw download).
-- We REMOVE that policy and instead expose ONLY name/site/status through a
-- locked-down function. No pricing ever leaves the server.
drop policy if exists office_docs_crew_read_projects on public.office_docs;

-- SECURITY DEFINER runs as the owner (bypasses RLS) but SELECTs only the three
-- safe columns, so rates/markup/tender/client/notes/docs can never be returned.
create or replace function public.crew_live_projects()
returns table (name text, site text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select data->>'name'   as name,
         data->>'site'   as site,
         data->>'status' as status
  from public.office_docs
  where collection = 'projects'
    and coalesce(data->>'status','') = 'Live'
    and auth.uid() is not null
$$;

revoke all on function public.crew_live_projects() from public;
grant execute on function public.crew_live_projects() to authenticated;
