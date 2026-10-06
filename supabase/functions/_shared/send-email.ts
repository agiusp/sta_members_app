// Sends one plain-text email.
//
// Online: set the RESEND_API_KEY and EMAIL_FROM secrets (Resend, or swap in
// another provider's API here). Locally, with no key set, emails go to the
// local test inbox instead, so nothing ever reaches a real address.
// fromName: the app name from Settings, used as the sender name.
// In the demo (settings.demo on), emails are kept in the Demo inbox instead
// of being sent.
async function isDemo(): Promise<boolean> {
  const rows = await (await serviceRest("settings?select=demo")).json();
  return rows?.[0]?.demo === true;
}
function serviceRest(path: string, init: RequestInit = {}): Promise<Response> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

export async function sendEmail(to: string, subject: string, text: string, fromName = "STA - STA Members App"): Promise<void> {
  if (await isDemo()) {
    const res = await serviceRest("demo_inbox", {
      method: "POST", body: JSON.stringify({ to_email: to, subject, body: text }),
    });
    if (!res.ok) throw new Error(`Demo inbox: ${res.status} ${await res.text()}`);
    return;
  }
  const apiKey = Deno.env.get("RESEND_API_KEY");
  // EMAIL_FROM is the sending address online, e.g. no-reply@yourclub.org.
  const address = Deno.env.get("EMAIL_FROM") ?? "no-reply@example.com";
  const from = `${fromName.replace(/["<>]/g, "")} <${address}>`;

  const res = apiKey
    ? await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      })
    : await fetch(`${Deno.env.get("LOCAL_TEST_INBOX_URL") ?? "http://inbucket:8025"}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: { Email: address, Name: fromName },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
        }),
      });
  if (!res.ok) throw new Error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
}
