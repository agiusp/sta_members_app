// Runs whatever timed task is due (Saturday 5pm reminder, Saturday 8pm court
// and no-spot emails) and sends its emails. Safe to call as often as you like:
// the database hands out each task only once.
//
// Online, a scheduler calls this every few minutes with the service role key.
// Developers can also trigger it (locally, the "Run timed tasks now" button).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import * as emails from "../_shared/emails.ts";
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

type Outgoing = { kind: string; to: string; email: emails.Email };

// deno-lint-ignore no-explicit-any
function emailsFor(task: any, appUrl: string): Outgoing[] {
  const contacts: string[] = task.contact_emails ?? [];
  if (task.kind === "lock_reminder") {
    const email = emails.lockReminder({ playDate: task.play_date, schedulerLink: appUrl + "scheduler.html" });
    return task.developer_emails.map((to: string) => ({ kind: task.kind, to, email }));
  }
  if (task.kind === "not_locked_alert") {
    const email = emails.notLockedAlert({ playDate: task.play_date, contacts });
    return task.developer_emails.map((to: string) => ({ kind: task.kind, to, email }));
  }
  if (task.kind === "publish") {
    const courtEmail = emails.courtAssignments({
      playDate: task.play_date, courts: task.courts, waitlist: task.waitlist,
      courtsLink: appUrl + "courts.html", contacts,
    });
    return [
      ...task.court_recipients.map((to: string) => ({ kind: "courts", to, email: courtEmail })),
      // deno-lint-ignore no-explicit-any
      ...task.no_spot.map((p: any) => ({
        kind: "no_spot", to: p.email,
        email: emails.noSpot({ playDate: task.play_date, firstName: p.first_name,
                               waitlistPlace: p.waitlist_place, contacts }),
      })),
    ];
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  let allowed = auth === `Bearer ${serviceKey}`;
  if (!allowed) {
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data } = await caller.rpc("is_developer");
    allowed = data === true;
  }
  if (!allowed) return reply({ error: "Developers only" }, 403);

  const admin = createClient(url, serviceKey);
  const { data: tasks, error } = await admin.rpc("claim_due_tasks");
  if (error) return reply({ error: error.message }, 500);

  const appUrl = Deno.env.get("APP_URL") ?? "http://127.0.0.1:3000/app/";
  const throttle = Deno.env.get("RESEND_API_KEY") ? 600 : 0; // stay under the provider's rate limit
  let sent = 0;
  const failed: string[] = [];
  for (const task of tasks) {
    for (const out of emailsFor(task, appUrl)) {
      let err: string | null = null;
      try {
        await sendEmail(out.to, out.email.subject, out.email.text);
        sent++;
      } catch (e) {
        err = String(e instanceof Error ? e.message : e);
        failed.push(err);
      }
      await admin.from("email_log").insert({
        session_id: task.session_id, kind: out.kind, to_email: out.to,
        subject: out.email.subject, error: err,
      });
      if (throttle) await new Promise((r) => setTimeout(r, throttle));
    }
  }
  // deno-lint-ignore no-explicit-any
  return reply({ tasks: tasks.map((t: any) => t.kind), sent, failed });
});
