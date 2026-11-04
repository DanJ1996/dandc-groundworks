// D&C Site Office — schedule alerts sender (Supabase Edge Function "schedule-notify").
// The database trigger in office-push.sql POSTs here whenever something is added
// to the schedule; this sends a phone notification to every director who has
// alerts turned on (except whoever made the change).
//
// Secrets to set (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, HOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// Deploy with "Verify JWT" turned OFF — the HOOK_SECRET header protects it instead.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) ?? "";

webpush.setVapidDetails(
  "mailto:office@dandcgroundworks.co.uk",
  env("VAPID_PUBLIC_KEY"),
  env("VAPID_PRIVATE_KEY"),
);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!env("HOOK_SECRET") || req.headers.get("x-hook-secret") !== env("HOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const { title, body, tag, url, actor, only } = await req.json();
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: dirs } = await sb.from("profiles").select("id").eq("role", "director");
  let ids = (dirs ?? []).map((d: { id: string }) => d.id);
  if (only) ids = ids.filter((id: string) => id === only);
  else if (actor) ids = ids.filter((id: string) => id !== actor);
  if (!ids.length) return Response.json({ sent: 0 });

  const { data: subs } = await sb.from("push_subs").select("endpoint,sub").in("user_id", ids);
  const payload = JSON.stringify({ title, body, tag, url: url || "office.html#schedule" });
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s: { endpoint: string; sub: Record<string, unknown> }) => {
    try {
      // deno-lint-ignore no-explicit-any
      await webpush.sendNotification(s.sub as any, payload, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Phone unsubscribed / app removed — tidy up so we stop trying.
      if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }));
  return Response.json({ sent });
});
