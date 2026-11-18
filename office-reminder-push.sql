-- ==================================================================
-- D&C Site Office — REMINDER PHONE ALERTS (web push, app closed)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Needs office-push.sql (push_send + push_subs +
-- app_secrets) run first — the same set-up the schedule alerts use.
--
-- What it does: once a minute the database looks for reminders whose
-- date/time has come, and sends a phone notification to the person the
-- reminder belongs to (Dan's list → Dan, Chris's list → Chris), even
-- with the Site Office closed. Each reminder pings once; changing its
-- date/time arms it again.
--
-- Before this, reminders only popped up while the app was open on screen,
-- and never on an iPhone (iOS doesn't allow in-page alerts).
-- ==================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 0) push_send with the optional page link (same as office-crew-alerts.sql;
--    repeated here so this file works whether or not that one has been run).
drop function if exists public.push_send(text,text,text,uuid);
create or replace function public.push_send(
  p_title text, p_body text, p_tag text,
  p_only uuid default null, p_url text default 'office.html#schedule')
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
                                  'actor',auth.uid(),'only',p_only,'url',p_url)
  );
exception when others then
  raise warning 'push_send failed: %', sqlerrm;
end $$;
revoke all on function public.push_send(text,text,text,uuid,text) from public, anon, authenticated;

-- 1) Which reminder/time pairs have already been sent (so each pings once).
create table if not exists public.reminder_pushed (
  doc_id  text not null,
  due     text not null,
  sent_at timestamptz not null default now(),
  primary key (doc_id, due)
);
alter table public.reminder_pushed enable row level security;
revoke all on public.reminder_pushed from anon, authenticated;

-- 2) Find due reminders and ping their owner.
--    Reminder times are saved as UK local 'YYYY-MM-DDTHH:MM' text.
create or replace function public.push_due_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  text := to_char(now() at time zone 'Europe/London', 'YYYY-MM-DD"T"HH24:MI');
  r      record;
  u      record;
  n      int := 0;
  hit    int;
begin
  for r in
    select d.doc_id, d.data
      from public.office_docs d
     where d.collection = 'reminders'
       and coalesce(d.data->>'when','') <> ''
       and coalesce((d.data->>'done')::boolean, false) = false
       and left(d.data->>'when', 16) <= v_now
       -- don't fire a backlog of very old reminders the first time this runs
       and left(d.data->>'when', 16) >= to_char((now() - interval '1 day') at time zone 'Europe/London', 'YYYY-MM-DD"T"HH24:MI')
       and not exists (select 1 from public.reminder_pushed p
                        where p.doc_id = d.doc_id and p.due = d.data->>'when')
  loop
    insert into public.reminder_pushed(doc_id, due) values (r.doc_id, r.data->>'when')
      on conflict do nothing;
    hit := 0;
    -- The app files a reminder under 'chris' for anyone named Chris, else 'dan'.
    for u in
      select id from public.profiles
       where role = 'director'
         and case when coalesce(r.data->>'owner','dan') = 'chris'
                  then coalesce(full_name,'') ~* 'chris'
                  else coalesce(full_name,'') !~* 'chris' end
    loop
      perform public.push_send('Reminder', coalesce(r.data->>'text','Reminder'),
                               'rem-'||r.doc_id, u.id, 'office.html#reminders');
      hit := hit + 1;
    end loop;
    -- Couldn't tell whose it is — ping both directors rather than nobody.
    if hit = 0 then
      perform public.push_send('Reminder', coalesce(r.data->>'text','Reminder'),
                               'rem-'||r.doc_id, null, 'office.html#reminders');
    end if;
    n := n + 1;
  end loop;
  delete from public.reminder_pushed where sent_at < now() - interval '60 days';
  return n;
end $$;
revoke all on function public.push_due_reminders() from public, anon, authenticated;

-- 3) Run it every minute.
do $$ begin
  perform cron.unschedule('reminder-push');
exception when others then null;
end $$;
select cron.schedule('reminder-push', '* * * * *', $$select public.push_due_reminders()$$);
