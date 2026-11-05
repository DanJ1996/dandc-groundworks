-- ==================================================================
-- D&C Site Office — CREW SUBMISSION ALERTS (phone push)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Needs office-push.sql (push_send + app_secrets +
-- push_subs) run first, same as the schedule alerts.
--
-- What it does: pings every director's phone (that has alerts on) when a
-- crew member
--   1) taps "Send / I'm finished" on their end-of-week hours, and
--   2) submits a new day works sheet (or variation), and
--   3) sends in a holiday request (tapping it opens the Holidays tab).
-- The person who did it isn't pinged (handled by push_send's actor check).
-- ==================================================================

-- 1) Let push_send target a specific page in the app (default = schedule).
--    Recreate it with an extra optional p_url param. push_on_schedule and
--    push_test keep working unchanged (they call it with fewer args).
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

-- 2) End-of-week hours submitted. The app writes data.submittedAt ONLY when
--    the crew taps "Send" (not on the as-you-type autosave), so we fire once
--    per submission, never on every keystroke.
create or replace function public.push_on_crew_hours()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n   jsonb := new.data;
  o   jsonb := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  nm  text  := coalesce(nullif(n->>'name',''),'A crew member');
begin
  if coalesce(n->>'submittedAt','') <> ''
     and coalesce(n->>'submittedAt','') is distinct from coalesce(o->>'submittedAt','') then
    perform public.push_send(
      'Hours submitted',
      nm||' sent their hours for w/c '||public.push_sched_fmt(n->>'week'),
      'hours-'||new.doc_id, null, 'office.html#overview');
  end if;
  return new;
exception when others then
  raise warning 'push_on_crew_hours failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists office_docs_crew_hours_push on public.office_docs;
create trigger office_docs_crew_hours_push
  after insert or update on public.office_docs
  for each row
  when (new.collection = 'crew_hours')
  execute function public.push_on_crew_hours();

-- 3) Day works sheet submitted. Fires once when a new sheet is filed, but
--    only when a CREW member (not a director) created it.
create or replace function public.push_on_sheet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r    text := coalesce((select role from public.profiles where id = new.created_by),'');
  nm   text := coalesce(nullif(new.creator_name,''),
                        (select full_name from public.profiles where id = new.created_by),
                        'A crew member');
  what text := case when coalesce(new.data->>'mode','') = 'variation'
                    then 'variation' else 'day works sheet' end;
  line text := coalesce(nullif(new.project,'')||E'\n','')
             ||coalesce('Sheet '||nullif(new.sheet_no,''),'')
             ||coalesce(' · '||public.push_sched_fmt(new.work_date::text),'');
begin
  if r = 'director' then return new; end if;   -- only crew submissions ping
  perform public.push_send(
    nm||' submitted a '||what,
    nullif(line,''),
    'sheet-'||new.id::text, null, 'office.html#dayworks');
  return new;
exception when others then
  raise warning 'push_on_sheet failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists sheets_push on public.sheets;
create trigger sheets_push
  after insert on public.sheets
  for each row
  execute function public.push_on_sheet();

-- 4) Holiday request sent in from the crew app. Fires once when a NEW
--    pending request lands (not when a director reopens an old one, and not
--    for directors booking their own time off, which goes in as approved).
create or replace function public.push_on_holiday_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n   jsonb := new.data;
  o   jsonb := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  nm  text  := coalesce(nullif(n->>'name',''),'A crew member');
  f   text;
  d   int   := coalesce(nullif(regexp_replace(coalesce(n->>'days',''),'[^0-9]','','g'),'')::int,1);
begin
  if coalesce(n->>'status','') = 'pending' and coalesce(o->>'status','') = '' then
    f := public.push_sched_fmt(n->>'from');
    if coalesce(n->>'to','') > coalesce(n->>'from','') then
      f := f||' – '||public.push_sched_fmt(n->>'to');
    end if;
    perform public.push_send(
      'Holiday request — '||nm,
      f||' ('||d||' day'||case when d > 1 then 's' else '' end||')'
        ||coalesce(E'\n'||nullif(n->>'note',''),'')||E'\nTap to approve or decline',
      'holreq-'||new.doc_id, null, 'office.html#crew');
  end if;
  return new;
exception when others then
  raise warning 'push_on_holiday_request failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists office_docs_holiday_request_push on public.office_docs;
create trigger office_docs_holiday_request_push
  after insert or update on public.office_docs
  for each row
  when (new.collection = 'holidays')
  execute function public.push_on_holiday_request();
