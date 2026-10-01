// Feeds the Emails and schedule page: every email with its default wording,
// any edited wording, and the schedule. Developers only. Saving happens
// directly from the page (the email_templates table and dev_save_schedule).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { DEFAULT_EMAILS } from "../_shared/default-emails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: isDeveloper } = await caller.rpc("is_developer");
  if (isDeveloper !== true) return reply({ error: "Developers only" }, 403);

  const [{ data: edits, error: e1 }, { data: schedule, error: e2 }, { data: settings }] = await Promise.all([
    caller.from("email_templates").select("key, subject, body, updated_at, updated_by"),
    caller.rpc("dev_schedule"),
    caller.from("settings").select("contact_emails").maybeSingle(),
  ]);
  if (e1 || e2) return reply({ error: (e1 || e2)!.message }, 500);
  // deno-lint-ignore no-explicit-any
  const byKey = new Map((edits ?? []).map((e: any) => [e.key, e]));
  return reply({
    emails: DEFAULT_EMAILS.map(d => ({ ...d, edited: byKey.get(d.key) ?? null })),
    schedule,
    contacts: (settings?.contact_emails ?? []).join(" and/or "),
  });
});
