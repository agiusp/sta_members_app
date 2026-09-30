// Sends a member their invite email so they can set a password.
// Only developers may call it, and only for emails already in the accounts
// table, so nobody outside the member list can get an account.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

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
  // Resending is fine until the member accepts (e.g. the first link expired).
  if (account.user_id) {
    const { data: existing } = await admin.auth.admin.getUserById(account.user_id);
    if (existing?.user?.email_confirmed_at) {
      return reply({ error: "This member already has an account. They can use \"Forgot password\" to get back in." }, 400);
    }
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(cleanEmail, { redirectTo });
  if (error) return reply({ error: error.message }, 400);
  return reply({ ok: true });
});
