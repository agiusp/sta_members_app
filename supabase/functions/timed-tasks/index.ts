// Runs whatever timed task is due and sends its emails: the Monday
// play-invite, "off the waitlist" emails, the Saturday developer emails, the
// player emails at the publish time, and Casual Play game emails. Safe to call as often as you like:
// the database hands out each task only once. When things happen is set in
// the app (Developers > Settings), and so is the wording.
//
// Online, a scheduler calls this every minute with the service role key.
// Developers can also trigger it (locally, the "Run timed tasks now" button).
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

type Outgoing = { kind: string; to: string; email: E.Email };
type Templates = Awaited<ReturnType<typeof E.loadTemplates>>;

// off: the emails switched Off in Settings.
function emailsFor(task: any, t0: Templates, appUrl: string, programName: string, off: Set<string>): Outgoing[] {
  // Every email can use {{program_name}}.
  const R = (key: string, values: Record<string, string>) => E.render(t0, key, { program_name: programName, ...values });
  const date = task.play_date ? E.playDateLabel(task.play_date) : ""; // none for Casual Play
  const contacts = E.contactsLabel(task.contact_emails ?? []);
  const scheduler_link = appUrl + "scheduler.html";
  const toDevelopers = (key: string, values: Record<string, string>) => {
    const email = R(key, values);
    return task.developer_emails.map((to: string) => ({ kind: key, to, email }));
  };

  switch (task.kind) {
    case "play_invite": {
      // Members who played last Sunday also get the "Game Review" paragraph.
      const reviewNote = task.last_play_date && !off.has("play_invite_review_note")
        ? R("play_invite_review_note", {
            day: E.dayAfter(task.now, task.last_play_date) ? "yesterday" : "last Sunday",
            review_link: appUrl + "review.html",
          }).text
        : "";
      return task.recipients.map((r: any) => ({
        kind: "play_invite", to: r.email,
        email: R("play_invite", { date, signup_link: appUrl + "signup.html", contacts, review_note: r.played ? reviewNote : "" }),
      }));
    }
    case "moved_off_waitlist":
      return task.players.map((p: any) => ({
        kind: "moved_off_waitlist", to: p.email,
        email: R("moved_off_waitlist", { first_name: p.first_name, date, signup_link: appUrl + "signup.html", contacts }),
      }));
    case "dev_scheduler_open":
      return toDevelopers("dev_scheduler_open", {
        date, numbers: E.numbersLine(task), scheduler_link,
        next_step: task.locked
          ? "The courts are already locked. You can still unlock and change them in the Scheduler before the player emails go out:"
          : "It's time to run the Scheduler: arrange the courts and ball assignments, and lock them before the player emails go out:",
      });
    case "dev_reminder_1":
    case "dev_reminder_2":
      return toDevelopers(task.kind, { date, numbers: E.numbersLine(task), scheduler_link });
    case "preview": {
      const common = {
        updated: task.updated ? "Updated: " : "", date, scheduler_link,
        locked_by: `${task.locked_by_name} (${task.locked_by_email})`,
        locked_time: E.timeLabel(task.locked_at),
      };
      if (task.week_mode !== "courts") {
        return toDevelopers("dev_weather_locked", {
          ...common, weather_option: E.WEATHER_OPTION[task.week_mode], signed_up: String(task.signed_up),
        });
      }
      return toDevelopers("dev_courts_locked", {
        ...common, courts: E.courtLines(task.courts), waitlist: E.waitlistLine(task.waitlist),
        no_spot_note: task.left_over_count
          ? `, and ${task.left_over_count} player(s) without a court will get the "no spot this week" email`
          : "",
      });
    }
    case "not_locked_alert":
      return toDevelopers("dev_not_locked", {
        date, scheduler_link, late_lock_until: E.timeLabel(task.late_lock_until),
      });
    case "casual_games":
      return task.emails.map((r: any) => {
        const common = { first_name: r.first_name, when: E.casualWhen(r.starts_at, r.ends_at),
                         looking_for: E.CASUAL_LOOKING_FOR[r.play_type] ?? r.play_type };
        return r.kind === "game"
          ? { kind: "casual_game", to: r.email, email: R("casual_game", {
              ...common, players: E.casualPlayerLines(r.others), hidden_note: E.casualHiddenNote(r.hidden_count),
              slot_link: `${appUrl}casual.html?slot=${r.slot_id}` }) }
          : { kind: "casual_reveal", to: r.email, email: R("casual_reveal", {
              ...common, others: E.casualPlayerLines(r.others), reveal_link: `${appUrl}casual.html?slot=${r.slot_id}` }) };
      });
    case "weather": {
      const email = R(task.week_mode, { date, day: E.dayWord(task.now, task.play_date), contacts });
      return task.recipients.map((to: string) => ({ kind: task.week_mode, to, email }));
    }
    case "publish": {
      const courtEmail = R("court_assignments", {
        date, courts: E.courtLines(task.courts), waitlist: E.waitlistLine(task.waitlist),
        courts_link: appUrl + "courts.html", contacts,
      });
      return [
        ...task.court_recipients.map((to: string) => ({ kind: "court_assignments", to, email: courtEmail })),
        ...task.no_spot.map((p: any) => ({
          kind: "no_spot", to: p.email,
          email: R("no_spot", {
            first_name: p.first_name, date, contacts,
            waitlist_place: p.waitlist_place ? ` You were #${p.waitlist_place} on the waitlist.` : "",
          }),
        })),
      ];
    }
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  // The scheduler (or a test) calls with the service role key. Online, the
  // key it holds may be in a different format from this function's copy, so
  // also accept any key that can read a table only the service role can.
  let allowed = auth === `Bearer ${serviceKey}`;
  if (!allowed && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const probe = createClient(url, token, { auth: { persistSession: false } });
    const { error } = await probe.from("email_switches").select("key").limit(1);
    allowed = !error;
  }
  if (!allowed) {
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data } = await caller.rpc("is_developer");
    allowed = data === true;
  }
  if (!allowed) return reply({ error: "Developers only" }, 403);

  const admin = createClient(url, serviceKey);
  const { data: weekTasks, error } = await admin.rpc("claim_due_tasks");
  if (error) return reply({ error: error.message }, 500);
  // Casual Play game emails, all year round (not tied to a Sunday).
  const { data: casual, error: casualError } = await admin.rpc("claim_casual_emails");
  if (casualError) return reply({ error: casualError.message }, 500);
  const tasks = casual.length ? [...weekTasks, { kind: "casual_games", session_id: null, emails: casual }] : weekTasks;

  const appUrl = Deno.env.get("APP_URL") ?? "http://127.0.0.1:3000/app/";
  const throttle = Deno.env.get("RESEND_API_KEY") ? 600 : 0; // stay under the provider's rate limit
  let sent = 0;
  const failed: string[] = [];
  const templates = tasks.length ? await E.loadTemplates(admin) : new Map();
  const { data: settings } = await admin.from("settings").select("program_name").maybeSingle();
  const programName: string = settings?.program_name ?? "STA - STA Members App";
  const { data: switches } = await admin.from("email_switches").select("key, enabled");
  const off = new Set<string>((switches ?? []).filter((x: any) => !x.enabled).map((x: any) => x.key));
  for (const task of tasks) {
    let outgoing: Outgoing[];
    try {
      outgoing = emailsFor(task, templates, appUrl, programName, off).filter(o => !off.has(o.kind));
    } catch (e) {
      failed.push(`${task.kind}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const out of outgoing) {
      let err: string | null = null;
      try {
        await sendEmail(out.to, out.email.subject, out.email.text, programName);
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
  return reply({ tasks: tasks.map((t: any) => t.kind), sent, failed });
});
