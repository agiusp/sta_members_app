// Sends a member their setup-invite so they can set a password. Supabase
// makes the personal link; the email itself uses the app's editable wording
// (Developers > Emails, schedule and settings). Only developers may call it, and
// only for current members already in the accounts table, so nobody outside
// the member list can get an account.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { loadTemplates, render, contactsLabel } from "../_shared/emails.ts";
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
  const { data: isDeveloper } = await caller.rpc("is_developer");
  if (isDeveloper !== true) return reply({ error: "Developers only" }, 403);

  const { email, redirectTo } = await req.json().catch(() => ({}));
  const cleanEmail = String(email ?? "").trim().toLowerCase();

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: account } = await admin
    .from("accounts").select("email, active, membership_current, user_id").eq("email", cleanEmail).maybeSingle();
  if (!account || !account.active) {
    return reply({ error: "Add this email as an active member before inviting it." }, 400);
  }
  if (!account.membership_current) {
    return reply({ error: "This member's membership has lapsed. Mark it current once dues are paid, then invite them." }, 400);
  }
  // Resending: an invite that was never accepted is replaced by a fresh one
  // (the unaccepted sign-in user holds no data).
  if (account.user_id) {
    const { data: existing } = await admin.auth.admin.getUserById(account.user_id);
    if (existing?.user?.email_confirmed_at) {
      return reply({ error: "This member already has an account. They can use \"Forgot password\" to get back in." }, 400);
    }
    await admin.auth.admin.deleteUser(account.user_id);
  }

  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "invite", email: cleanEmail, options: { redirectTo },
  });
  if (error) return reply({ error: error.message }, 400);

  const [{ data: names }, { data: settings }] = await Promise.all([
    admin.rpc("account_player_names", { p_email: cleanEmail }),
    admin.from("settings").select("contact_emails, program_name").maybeSingle(),
  ]);
  const programName = settings?.program_name ?? "STA - STA Members App";
  const message = render(await loadTemplates(admin), "setup_invite", {
    program_name: programName,
    player_names: names ?? cleanEmail,
    link: link.properties.action_link,
    contacts: contactsLabel(settings?.contact_emails ?? []),
  });
  let sendError: string | null = null;
  try {
    await sendEmail(cleanEmail, message.subject, message.text, programName);
  } catch (e) {
    sendError = String(e instanceof Error ? e.message : e);
  }
  await admin.from("email_log").insert({
    kind: "setup_invite", to_email: cleanEmail, subject: message.subject, error: sendError,
  });
  if (sendError) return reply({ error: sendError }, 502);
  return reply({ ok: true });
});
