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

-- Crew day-works MATERIALS dropdown. Same idea as above: a locked-down function
-- returns ONLY the material DESCRIPTION from the rate card (Materials category),
-- never the unit cost/rate. Directors load the full rate card for themselves and
-- so always get a costed version; crew only ever receive names.
create or replace function public.crew_materials()
returns table (desc text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct trim(data->>'desc') as desc
  from public.office_docs
  where collection = 'rates'
    and lower(coalesce(data->>'cat','')) like 'material%'
    and coalesce(trim(data->>'desc'),'') <> ''
    and auth.uid() is not null
  order by 1
$$;

revoke all on function public.crew_materials() from public;
grant execute on function public.crew_materials() to authenticated;

-- Crew day-works PLANT dropdown. Same rule as materials: ONLY the plant
-- DESCRIPTION from the rate card (Plant category) — never the rate.
create or replace function public.crew_plant()
returns table (name text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct trim(data->>'desc') as name
  from public.office_docs
  where collection = 'rates'
    and lower(coalesce(data->>'cat','')) like 'plant%'
    and coalesce(trim(data->>'desc'),'') <> ''
    and auth.uid() is not null
  order by 1
$$;

revoke all on function public.crew_plant() from public;
grant execute on function public.crew_plant() to authenticated;

-- ==================================================================
-- 5) CREW HOLIDAY REQUESTS  +  LEAD-HAND ("top man") PRIVATE NOTES
--    Both live in office_docs, keyed doc_id = '<their-user-id>__<id>'
--    so the SAME own-rows rule scopes each row to its owner.
--      * holidays        — EVERY crew member can request time off; it
--                          shows live in the directors' Crew tab, who
--                          approve/decline (directors have full access
--                          via office_docs_all above).
--      * lead_reminders  — the lead hand's OWN private reminders.
--    (materials / plant_faults / site_diary are reserved for the next
--     lead-hand perks — listed here so this policy covers them already.)
--
--    This REPLACES the crew_hours-only policy with one that covers all
--    of these owner-scoped collections at once. Safe to re-run.
-- ==================================================================
drop policy if exists office_docs_crew_hours on public.office_docs;
drop policy if exists office_docs_crew_own on public.office_docs;
create policy office_docs_crew_own on public.office_docs for all to authenticated
  using (collection in ('crew_hours','holidays','lead_reminders','materials','plant_faults','site_diary')
         and split_part(doc_id, '__', 1) = auth.uid()::text)
  with check (collection in ('crew_hours','holidays','lead_reminders','materials','plant_faults','site_diary')
         and split_part(doc_id, '__', 1) = auth.uid()::text);

-- Mark the lead hand so the app unlocks his extra tabs. The app ALSO
-- recognises his login email as a fallback, so his Lead perks work even
-- before you run this line — but setting the role is the tidy way.
-- 'lead_crew' is NOT a director: is_director() still only matches
-- role='director', so he gets no access to pricing, quotes or invoices.
update public.profiles set role = 'lead_crew'
  where id = (select id from auth.users where lower(email) = 'matt@dandcgroundworks.co.uk');
