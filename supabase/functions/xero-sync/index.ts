// D&C Site Office — Xero sync (Supabase Edge Function "xero-sync").
// Pulls the sales invoices (ACCREC) out of the connected Xero organisation and
// records each one's status — DRAFT / AUTHORISED (sent) / PAID — into xero_status,
// so the Site Office can show invoiced (green) / paid against every job without
// anyone ticking a box. Called on demand by the "Refresh from Xero" button.
//
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, XERO_CLIENT_ID, XERO_CLIENT_SECRET set.
// Deploy with "Verify JWT" turned ON — only a logged-in director may trigger it.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) ?? "";
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

// Give us a valid access token, refreshing it from the stored refresh token if the
// cached one has expired. Keeps the fresh refresh token (Xero rotates it each time).
async function accessToken(db: ReturnType<typeof admin>) {
  const { data: t } = await db.from("xero_tokens").select("*").eq("id", 1).maybeSingle();
  if (!t || !t.refresh_token) throw new Error("not-connected");
  if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() - 60_000 > Date.now()) {
    return { token: t.access_token, tenant: t.tenant_id as string };
  }
  const basic = btoa(`${env("XERO_CLIENT_ID")}:${env("XERO_CLIENT_SECRET")}`);
  // Hard 10s timeout so a slow/unreachable Xero can never hang the whole function
  // (a hang would be killed by the platform and surface as a blank "sync failed").
  const r = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
    signal: AbortSignal.timeout(10_000),
  }).then((x) => x.json()).catch(() => ({}));
  if (!r.access_token) throw new Error("refresh-failed");
  await db.from("xero_tokens").update({
    refresh_token: r.refresh_token ?? t.refresh_token,
    access_token: r.access_token,
    expires_at: new Date(Date.now() + (r.expires_in ?? 1800) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
  return { token: r.access_token as string, tenant: t.tenant_id as string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
  const db = admin();

  // Only a logged-in director may sync. The user's JWT arrives in Authorization.
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return json({ error: "not-signed-in" }, 401);
  const { data: prof } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  if (prof?.role !== "director") return json({ error: "directors-only" }, 403);

  // "Not connected" / "needs reconnecting" are normal states, not errors — return
  // 200 so the Site Office can read them and show "Connect to Xero" cleanly.
  let at;
  try {
    at = await accessToken(db);
  } catch (e) {
    return json({ connected: false, reason: (e as Error).message });
  }

  // Pull sales invoices (newest first). One page of 100 is plenty for a small firm;
  // paginate if it ever grows past that.
  const api = (path: string) =>
    fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      headers: {
        authorization: `Bearer ${at.token}`,
        "xero-tenant-id": at.tenant,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000), // never hang on a slow Xero page
    }).then((r) => r.json()).catch(() => null); // never let a non-JSON/timeout Xero reply crash the sync

  // The whole Xero ledger is thousands of invoices (incl. supplier bills), so we
  // DON'T page through it all. We ask Xero for SALES invoices only (ACCREC),
  // NEWEST first, which is a handful of pages and always reaches the current work.
  // Xero's where/order ARE accepted here — the values just have to be URL-encoded.
  const where = encodeURIComponent('Type=="ACCREC"');
  const order = encodeURIComponent("Date DESC");
  const allInvoices: Array<Record<string, unknown>> = [];
  let firstError: string | null = null;
  for (let page = 1; page <= 4; page++) {   // 4 pages = up to 400 most-recent sales invoices
    const res = await api(`Invoices?where=${where}&order=${order}&page=${page}`);
    if (!res || !Array.isArray(res.Invoices)) {
      if (page === 1) firstError = res?.Message || res?.Detail || "no invoices returned";
      break;
    }
    allInvoices.push(...res.Invoices);
    if (res.Invoices.length < 100) break; // reached the end of the sales invoices
  }
  if (!allInvoices.length) {
    return json({ connected: true, synced: 0, fetched: 0, xero_error: firstError || "no invoices returned" });
  }
  // Xero's JSON API returns dates in the legacy "/Date(1714521600000+0000)/"
  // format (ms since epoch), NOT ISO — parse it to a YYYY-MM-DD, else null.
  const xdate = (v: unknown): string | null => {
    if (!v) return null;
    const m = /\/Date\((\d+)/.exec(String(v));
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  // Skip deleted/voided — not real money owed/paid. DRAFT / SUBMITTED / AUTHORISED
  // / PAID all kept. Build ONE batch and save it in a single round-trip: hundreds
  // of one-by-one upserts would be slow enough to time the whole function out.
  const invoices = allInvoices.filter((i: { Type?: string; Status?: string }) =>
    i.Type === "ACCREC" && i.Status !== "DELETED" && i.Status !== "VOIDED");
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const inv of invoices) {
    // Key each row by its UNIQUE invoice number so two invoices can never collide
    // in the batch (a shared Reference text could, which would drop the save).
    const ref = String(inv.InvoiceNumber || inv.InvoiceID);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const paidDate = (inv.Payments && inv.Payments.length)
      ? inv.Payments.map((p: { Date: string }) => xdate(p.Date)).filter(Boolean).sort().pop() ?? null
      : null;
    rows.push({
      ref,
      kind: "invoice",
      xero_id: inv.InvoiceID,
      number: inv.InvoiceNumber || "",
      contact: (inv.Contact && inv.Contact.Name) || "",
      status: inv.Status || "",
      date: xdate(inv.DateString || inv.Date),
      total: inv.Total ?? 0,
      amount_due: inv.AmountDue ?? 0,
      amount_paid: inv.AmountPaid ?? 0,
      paid_date: paidDate,
      updated_at: new Date().toISOString(),
    });
  }
  const { error: upErr } = await db.from("xero_status").upsert(rows, { onConflict: "ref" });
  // Surface a save problem (e.g. a missing column / stale schema cache) instead of
  // silently reporting success — the office can then show the real reason.
  if (upErr) return json({ connected: true, synced: 0, fetched: allInvoices.length, xero_error: "save failed: " + (upErr.message || upErr.code || "unknown") });
  return json({ connected: true, synced: rows.length, fetched: allInvoices.length });
  } catch (e) {
    // Never 500 — hand the real message back so the office can show what broke.
    return json({ connected: true, synced: 0, fetched: 0, xero_error: "crash: " + ((e as Error)?.message || String(e)) });
  }
});
