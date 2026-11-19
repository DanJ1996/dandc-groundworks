-- ==================================================================
-- D&C Site Office — COMPANY DATES (works do, break up, back to work)
-- Paste this WHOLE file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Needs office-schema.sql run first.
--
-- Directors add these in the Site Office (Holidays tab → Company dates);
-- they already have full access through office_docs_all. This lets EVERY
-- signed-in lad READ them (never add, change or delete) so they show in
-- the field app's Dates tab. Only the 'company_dates' collection is
-- opened up — nothing else in office_docs becomes visible to crew.
-- ==================================================================
drop policy if exists office_docs_crew_read_company_dates on public.office_docs;
create policy office_docs_crew_read_company_dates on public.office_docs
  for select to authenticated
  using (collection = 'company_dates');
