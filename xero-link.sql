-- ==================================================================
-- D&C Site Office — XERO LINK (read invoice + payment status)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Needs office-schema.sql (office_docs) + dayworks-schema.sql
-- (profiles + is_director()) run first, same as the phone alerts.
--
-- What it does: gives the two Xero edge functions a private place to keep the
-- connection (refresh token + which Xero organisation), and a private place for
-- the Xero app's Client ID / Secret / webhook key. Nothing here is readable from
-- the website — only the service-role edge functions can touch it.
-- ==================================================================

-- 1) The live Xero connection. One row. Service-role only — no policies, and
--    access is revoked from the website roles so a refresh token can never leak.
create table if not exists public.xero_tokens (
  id            int primary key default 1,
  tenant_id     text,            -- which Xero organisation is connected
  tenant_name   text,
  refresh_token text,            -- long-lived; swapped for a fresh access token as needed
  access_token  text,            -- short-lived cache (~30 min)
  expires_at    timestamptz,
  updated_at    timestamptz not null default now(),
  constraint xero_tokens_singleton check (id = 1)
);
alter table public.xero_tokens enable row level security;
revoke all on public.xero_tokens from anon, authenticated;

-- 2) The Xero app's own settings (Client ID / Secret / webhook signing key).
--    Reuses the same locked-down app_secrets table the phone alerts use.
--    (Created here too in case the alerts file wasn't run.)
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- 3) Where each office record stands in Xero. Written ONLY by the service-role
--    sync function; the website may READ it (so badges can show invoiced / paid),
--    but directors only, and nobody can write it from the browser.
create table if not exists public.xero_status (
  ref        text primary key,          -- office key, e.g. 'project:<id>' or an invoice no.
  kind       text,                      -- 'invoice'
  xero_id    text,                      -- Xero InvoiceID
  number     text,                      -- Xero invoice number
  status     text,                      -- DRAFT / SUBMITTED / AUTHORISED / PAID / VOIDED
  total      numeric,
  amount_due numeric,
  amount_paid numeric,
  paid_date  date,
  date       date,                      -- the invoice date (so the office can show newest first)
  project_id text,                      -- which of our jobs this invoice is linked to (set by a director)
  updated_at timestamptz not null default now()
);
-- Older databases won't have these columns from the create above — add if missing.
alter table public.xero_status add column if not exists project_id text;
alter table public.xero_status add column if not exists date date;
alter table public.xero_status enable row level security;
revoke all on public.xero_status from anon, authenticated;
-- The RLS policies below only filter ROWS; the base privileges must also be granted
-- or PostgREST denies the query outright (the app then shows "Not linked to Xero
-- yet"). RLS still limits things to directors via the policies.
grant select on public.xero_status to authenticated;
-- Directors may also set/clear the job link (project_id only — nothing else is writable).
grant update (project_id) on public.xero_status to authenticated;
drop policy if exists xero_status_read on public.xero_status;
create policy xero_status_read on public.xero_status for select
  using (public.is_director());
drop policy if exists xero_status_link on public.xero_status;
create policy xero_status_link on public.xero_status for update
  using (public.is_director()) with check (public.is_director());

-- 4) Convenience: directors can trigger a manual "Refresh from Xero" safely.
--    (The heavy lifting is in the edge function; this just lets the website ask.)
--    Nothing sensitive is exposed — it only pokes the sync function.
-- (No SQL needed here — the website calls the edge function directly with the
--  logged-in director's JWT, which the function checks.)
