-- ==================================================================
-- D&C Day Works — Supabase database setup
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE / drop-then-create policies).
-- ==================================================================

-- 1) PROFILES: one row per login, holds their name + role (director / crew)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       text not null default 'crew' check (role in ('director','crew')),
  created_at timestamptz not null default now()
);

-- 2) SHEETS: one row per day works sheet. The whole form lives in `data` (jsonb).
create table if not exists public.sheets (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  creator_name text,
  project      text,
  client       text,
  sheet_no     text,
  work_date    date,
  day          text,
  grand        numeric default 0,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists sheets_created_by_idx on public.sheets(created_by);
create index if not exists sheets_work_date_idx  on public.sheets(work_date);

-- 3) Helper: is the current user a director?  (security definer avoids RLS recursion)
create or replace function public.is_director()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'director');
$$;

-- 4) Auto-create a profile whenever a new auth user is added (defaults to crew)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), 'crew')
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- 5) Row Level Security -------------------------------------------------
alter table public.profiles enable row level security;
alter table public.sheets   enable row level security;

-- Profiles: you can read your own; directors can read all. You can update your own name.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_director());

-- Allow the lead-hand ("top man") role the Site Office uses. The table may
-- predate it, so widen the CHECK constraint. 'lead_crew' is NOT a director.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add  constraint profiles_role_check check (role in ('director','crew','lead_crew'));

-- SECURITY — pin the role column so NOBODY can promote themselves.
-- RLS row-ownership does NOT restrict which columns change, so without this a
-- signed-in crew member could use the public anon key to run
--   update public.profiles set role='director' where id = auth.uid();
-- and the row-owner policy below would allow it — unlocking the WHOLE
-- directors' dashboard (pricing, quotes, invoices). Lock it at the column
-- level. You still promote directors from the Supabase SQL editor (service
-- role), which bypasses these grants.
revoke update on public.profiles from authenticated, anon;
grant  update (full_name) on public.profiles to authenticated;

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid()
              and role = (select p.role from public.profiles p where p.id = auth.uid()));

-- Sheets: everyone signed in can SEE and EDIT every sheet, so a sheet started by
-- the office OR by a crew member is the ONE shared copy both sides work on (no more
-- duplicate sheets made because the other person couldn't edit yours). The crew app
-- shows key info only, strips money/figures on open and re-applies the office's
-- pricing on save (and never touches the grand total), so a crew edit of an office
-- sheet can't expose or wipe figures. Deleting stays director-only (policy below).
drop policy if exists sheets_select on public.sheets;
create policy sheets_select on public.sheets for select
  using (auth.uid() is not null);

drop policy if exists sheets_insert on public.sheets;
create policy sheets_insert on public.sheets for insert
  with check (created_by = auth.uid());

drop policy if exists sheets_update on public.sheets;
create policy sheets_update on public.sheets for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

drop policy if exists sheets_delete on public.sheets;
create policy sheets_delete on public.sheets for delete
  using (public.is_director());

-- 6) Keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists sheets_touch on public.sheets;
create trigger sheets_touch before update on public.sheets
  for each row execute function public.touch_updated_at();

-- 7) JOBS: the shared job list crew create and everyone sees ------------
create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  client       text,
  location     text,
  created_by   uuid not null default auth.uid() references auth.users(id) on delete set null,
  creator_name text,
  created_at   timestamptz not null default now()
);
create index if not exists jobs_created_at_idx on public.jobs(created_at);

alter table public.jobs enable row level security;

-- Everyone signed in sees every job; any signed-in crew can create one.
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs for select
  using (auth.uid() is not null);

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs for insert
  with check (created_by = auth.uid());

-- Only directors can rename or delete a job.
drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs for update
  using (public.is_director()) with check (public.is_director());

drop policy if exists jobs_delete on public.jobs;
create policy jobs_delete on public.jobs for delete
  using (public.is_director());

-- 8) JOB FILES: metadata for each drawing/PDF a director drops into a job
create table if not exists public.job_files (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  name         text not null,
  path         text not null,
  mime         text,
  size         bigint,
  uploaded_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists job_files_job_idx on public.job_files(job_id);

alter table public.job_files enable row level security;

-- Everyone signed in can see the file list; only directors add/remove.
drop policy if exists job_files_select on public.job_files;
create policy job_files_select on public.job_files for select
  using (auth.uid() is not null);

drop policy if exists job_files_insert on public.job_files;
create policy job_files_insert on public.job_files for insert
  with check (public.is_director());

drop policy if exists job_files_delete on public.job_files;
create policy job_files_delete on public.job_files for delete
  using (public.is_director());

-- 9) STORAGE: a private bucket for the actual files (drawings/PDFs/photos)
insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false)
on conflict (id) do nothing;

-- Any signed-in user can READ (so crew can open drawings via signed URLs);
-- only directors can UPLOAD or DELETE the actual files.
drop policy if exists job_files_read on storage.objects;
create policy job_files_read on storage.objects for select
  using (bucket_id = 'job-files' and auth.uid() is not null);

drop policy if exists job_files_write on storage.objects;
create policy job_files_write on storage.objects for insert
  with check (bucket_id = 'job-files' and public.is_director());

drop policy if exists job_files_remove on storage.objects;
create policy job_files_remove on storage.objects for delete
  using (bucket_id = 'job-files' and public.is_director());

-- ==================================================================
-- AFTER running the above and creating your logins (Authentication → Users),
-- make yourself + Chris directors by running this with your real emails:
--
--   update public.profiles set role = 'director'
--   where id in (select id from auth.users where email in
--     ('dan@dandcgroundworks.co.uk','chris@dandcgroundworks.co.uk'));
-- ==================================================================
