// Casual Play: a member who shares their contact info for one of their times
// asks the app to email the players in a possible singles or doubles game who
// don't share theirs. The database (casual_invite) checks the request as that
// member, records who is emailed, and says what to put in the emails; this
// sends them straight away (to the Demo inbox in the demo).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import * as E from "../_shared/emails.ts";
import { sendEmail } from "../_shared/send-email.ts";

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

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { slot_id, others } = await req.json().catch(() => ({}));
  const { data: invite, error } = await caller.rpc("casual_invite", { p_slot_id: slot_id, p_others: others });
  if (error) return reply({ error: error.message }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const [templates, { data: settings }, { data: switches }] = await Promise.all([
    E.loadTemplates(admin),
    admin.from("settings").select("program_name").maybeSingle(),
    admin.from("email_switches").select("enabled").eq("key", "casual_invite").maybeSingle(),
  ]);
  if (switches?.enabled === false) return reply({ sent: 0, off: true });
  const programName: string = settings?.program_name ?? "STA - STA Members App";
  const appUrl = Deno.env.get("APP_URL") ?? "http://127.0.0.1:3000/app/";

  let sent = 0;
  const failed: string[] = [];
  for (const r of invite.recipients ?? []) {
    const email = E.render(templates, "casual_invite", {
      program_name: programName, first_name: r.first_name, inviter: invite.inviter, game: invite.kind,
      when: E.casualWhen(invite.starts_at, invite.ends_at),
      players: invite.players.filter((p: any) => p.slot_id !== r.slot_id)
        .map((p: any) => E.casualPerson(p, "A player who doesn't share their contact info")).join("\n"),
      slot_link: `${appUrl}casual.html?slot=${r.slot_id}`,
    });
    let err: string | null = null;
    try {
      await sendEmail(r.email, email.subject, email.text, programName);
      sent++;
    } catch (e) {
      err = String(e instanceof Error ? e.message : e);
      failed.push(err);
    }
    await admin.from("email_log").insert({ kind: "casual_invite", to_email: r.email, subject: email.subject, error: err });
  }
  if (failed.length) return reply({ error: failed.join("; "), sent }, 502);
  return reply({ sent });
});
