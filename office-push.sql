-- ==================================================================
-- D&C Site Office — SCHEDULE PHONE ALERTS (web push)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Needs office-schema.sql (office_docs) and
-- dayworks-schema.sql (profiles + is_director()) run first.
--
-- What it does: whenever something lands on the schedule — a new job
-- (or a job given a start date), a diary item / meeting, a site visit,
-- a quote due date, or approved time off — it pings every director's
-- phone that has alerts turned on. The person who added it isn't pinged.
-- ==================================================================

create extension if not exists pg_net;

-- 1) One row per phone / browser that has alerts switched on.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  sub        jsonb not null,
  device     text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists push_subs_own on public.push_subs;
create policy push_subs_own on public.push_subs for all
  using (user_id = auth.uid() and public.is_director())
  with check (user_id = auth.uid() and public.is_director());

-- 2) Private settings (no policies = nobody can read it from the website).
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- 3) Sends one alert to the edge function. Never blocks or breaks a save.
create or replace function public.push_send(p_title text, p_body text, p_tag text, p_only uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select value from public.app_secrets where key = 'push_url');
  v_secret text := (select value from public.app_secrets where key = 'push_secret');
begin
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',v_secret),
    body    := jsonb_build_object('title',p_title,'body',p_body,'tag',p_tag,
                                  'actor',auth.uid(),'only',p_only,'url','office.html#schedule')
  );
exception when others then
  raise warning 'push_send failed: %', sqlerrm;
end $$;
revoke all on function public.push_send(text,text,text,uuid) from public, anon, authenticated;

-- "Send me a test" button in the Site Office.
create or replace function public.push_test()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_director() then raise exception 'directors only'; end if;
  perform public.push_send('D&C Site Office','Schedule alerts are working on this phone 👍','test',auth.uid());
end $$;
revoke all on function public.push_test() from public, anon;
grant execute on function public.push_test() to authenticated;

-- 4) Work out what was just added to the schedule.
create or replace function public.push_sched_fmt(d text)
returns text language sql immutable as $$
  select case when d ~ '^\d{4}-\d{2}-\d{2}$' then to_char(d::date,'Dy DD Mon') else coalesce(d,'') end
$$;

create or replace function public.push_on_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n  jsonb := new.data;
  o  jsonb := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  f  text;
  who text := coalesce((select split_part(full_name,' ',1) from public.profiles where id = auth.uid()),'');
  by_ text := case when who <> '' then ' — added by '||who else '' end;
begin
  if new.collection = 'projects' then
    -- New job on the schedule (created with a start date, or given one)
    if coalesce(n->>'startDate','') <> '' and coalesce(o->>'startDate','') = '' then
      f := public.push_sched_fmt(n->>'startDate');
      if coalesce(n->>'endDate','') > coalesce(n->>'startDate','') then
        f := f||' – '||public.push_sched_fmt(n->>'endDate');
      end if;
      perform public.push_send('New job on the schedule',
        coalesce(n->>'name','Job')||coalesce(' · '||nullif(n->>'client',''),'')||E'\n'||f||by_,
        'job-'||new.doc_id);
    end if;
    -- Site visit booked against a job
    if coalesce(n->>'visitDate','') <> '' and coalesce(n->>'visitDate','')||coalesce(n->>'visitTime','')
       is distinct from coalesce(o->>'visitDate','')||coalesce(o->>'visitTime','') then
      perform public.push_send('Site visit booked',
        coalesce(n->>'name','Job')||E'\n'||public.push_sched_fmt(n->>'visitDate')
          ||coalesce(' '||nullif(n->>'visitTime',''),'')||coalesce(' · '||nullif(n->>'visitBy',''),'')||by_,
        'visit-p-'||new.doc_id);
    end if;

  elsif new.collection = 'events' and tg_op = 'INSERT' then
    f := public.push_sched_fmt(n->>'from');
    if coalesce(n->>'to','') > coalesce(n->>'from','') then f := f||' – '||public.push_sched_fmt(n->>'to'); end if;
    perform public.push_send('Added to the schedule',
      coalesce(n->>'title','Diary item')||coalesce(' · '||nullif(n->>'client',''),'')||E'\n'
        ||f||coalesce(' '||nullif(n->>'time',''),'')||coalesce(' · '||nullif(n->>'who',''),'')||by_,
      'event-'||new.doc_id);

  elsif new.collection = 'quotes' then
    if coalesce(n->>'visitDate','') <> '' and coalesce(n->>'visitDate','')||coalesce(n->>'visitTime','')
       is distinct from coalesce(o->>'visitDate','')||coalesce(o->>'visitTime','') then
      perform public.push_send('Site visit booked',
        coalesce(n->>'client','Enquiry')||coalesce(' · '||nullif(n->>'job',''),'')||E'\n'
          ||public.push_sched_fmt(n->>'visitDate')||coalesce(' '||nullif(n->>'visitTime',''),'')
          ||coalesce(' · '||nullif(n->>'visitBy',''),'')||by_,
        'visit-q-'||new.doc_id);
    end if;
    if coalesce(n->>'due','') <> '' and coalesce(n->>'due','') is distinct from coalesce(o->>'due','') then
      perform public.push_send('Quote due on the schedule',
        coalesce(n->>'client','Enquiry')||coalesce(' · '||nullif(n->>'job',''),'')||E'\nDue '
          ||public.push_sched_fmt(n->>'due')||by_,
        'due-'||new.doc_id);
    end if;

  elsif new.collection = 'holidays' then
    if n->>'status' = 'approved' and coalesce(o->>'status','') <> 'approved' then
      f := public.push_sched_fmt(n->>'from');
      if coalesce(n->>'to','') > coalesce(n->>'from','') then f := f||' – '||public.push_sched_fmt(n->>'to'); end if;
      perform public.push_send('Time off on the schedule',
        coalesce(n->>'name','Crew')||' off '||f||by_, 'off-'||new.doc_id);
    end if;
  end if;
  return new;
exception when others then
  raise warning 'push_on_schedule failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists office_docs_push on public.office_docs;
create trigger office_docs_push
  after insert or update on public.office_docs
  for each row
  when (new.collection in ('projects','events','quotes','holidays'))
  execute function public.push_on_schedule();

-- ==================================================================
-- 5) ONE-OFF: tell the database where the sender lives + its password.
--    Replace PASTE_HOOK_SECRET_HERE with the HOOK_SECRET you set on the
--    edge function, then run just these lines (safe to re-run).
-- ==================================================================
-- insert into public.app_secrets(key,value) values
--   ('push_url','https://dgnvfvukixxnefrqszum.supabase.co/functions/v1/schedule-notify'),
--   ('push_secret','PASTE_HOOK_SECRET_HERE')
-- on conflict (key) do update set value = excluded.value;
