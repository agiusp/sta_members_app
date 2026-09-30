// Sends one plain-text email.
//
// Online: set the RESEND_API_KEY and EMAIL_FROM secrets (Resend, or swap in
// another provider's API here). Locally, with no key set, emails go to the
// local test inbox instead, so nothing ever reaches a real address.
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? "STA Sunday Program <no-reply@example.com>";

  const res = apiKey
    ? await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      })
    : await fetch(`${Deno.env.get("LOCAL_TEST_INBOX_URL") ?? "http://supabase_inbucket_tennis_doubles_scheduler:8025"}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: { Email: "no-reply@example.com", Name: "STA Sunday Program" },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
        }),
      });
  if (!res.ok) throw new Error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
}
