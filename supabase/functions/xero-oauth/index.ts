// D&C Site Office — Xero connect (Supabase Edge Function "xero-oauth").
// Two jobs, both over GET so they work as plain browser navigations:
//   ?start=1   → send the director off to Xero to approve the connection
//   ?code=...  → Xero sends them back here; swap the code for tokens and store them
//
// Secrets to set (Edge Functions → Secrets):
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// Deploy with "Verify JWT" turned OFF — Xero's redirect carries no JWT; the random
// one-time `state` we mint on ?start protects the callback instead.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) ?? "";
const REDIRECT = `${env("SUPABASE_URL")}/functions/v1/xero-oauth`;
// Read-only access to invoices + their payments, plus offline_access for a refresh
// token. This app was created after 2 Mar 2026, so Xero NO LONGER allows the old broad
// "accounting.transactions" scope — new apps must use the granular scopes. We only ever
// READ, so we use the ".read" variants (never writes anything to Xero).
const SCOPES = "offline_access accounting.invoices.read accounting.payments.read";
const BACK = "https://dandcgroundworks.com/office.html#invoices";

const sb = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

function page(msg: string, ok = true) {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
     <title>Xero</title><body style="font-family:system-ui;background:#273E57;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
     <div><h2 style="font-weight:600">${ok ? "Xero connected 🎉" : "Xero connection failed"}</h2>
     <p style="opacity:.8;max-width:30em;margin:1em auto">${msg}</p>
     <a href="${BACK}" style="display:inline-block;margin-top:1em;background:#57d38a;color:#13351f;padding:.7em 1.4em;border-radius:10px;text-decoration:none;font-weight:600">Back to the Site Office</a></div></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const db = sb();

  // --- Start: mint a one-time state, send the director to Xero's approval screen.
  if (url.searchParams.get("start")) {
    const clientId = env("XERO_CLIENT_ID");
    if (!clientId) return page("The Xero app isn't set up yet (no Client ID).", false);
    const state = crypto.randomUUID();
    await db.from("app_secrets").upsert({ key: "xero_oauth_state", value: state });
    const auth = new URL("https://login.xero.com/identity/connect/authorize");
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", REDIRECT);
    auth.searchParams.set("scope", SCOPES);
    auth.searchParams.set("state", state);
    return Response.redirect(auth.toString(), 302);
  }

  // --- Callback: Xero redirected back with a code (or an error).
  const code = url.searchParams.get("code");
  if (!code) {
    const err = url.searchParams.get("error");
    return err ? page(`Xero said: ${err}.`, false) : page("Nothing to do.", false);
  }

  // Check the state matches the one we minted on ?start.
  const { data: st } = await db.from("app_secrets").select("value").eq("key", "xero_oauth_state").maybeSingle();
  if (!st || st.value !== url.searchParams.get("state")) {
    return page("Security check failed (state mismatch). Please start again.", false);
  }

  // Swap the code for tokens.
  const basic = btoa(`${env("XERO_CLIENT_ID")}:${env("XERO_CLIENT_SECRET")}`);
  const tok = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
  }).then((r) => r.json());
  if (!tok.access_token) return page("Xero wouldn't issue a token. Check the Client ID / Secret.", false);

  // Which Xero organisation did they pick?
  const conns = await fetch("https://api.xero.com/connections", {
    headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" },
  }).then((r) => r.json());
  const org = Array.isArray(conns) && conns[0] ? conns[0] : null;
  if (!org) return page("Connected, but no Xero organisation came back.", false);

  await db.from("xero_tokens").upsert({
    id: 1,
    tenant_id: org.tenantId,
    tenant_name: org.tenantName || "",
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 1800) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  await db.from("app_secrets").delete().eq("key", "xero_oauth_state");

  // Bounce straight back into the Site Office's Invoices tab. (A rendered HTML
  // page would show as raw source — Supabase serves function bodies as text/plain
  // with nosniff — so a redirect is both cleaner and seamless.) Query before the
  // hash so the #invoices tab routing still works.
  return Response.redirect("https://dandcgroundworks.com/office.html?xero=connected#invoices", 302);
});
