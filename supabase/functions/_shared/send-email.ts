// Sends one plain-text email, with optional attachments.
//
// Online: set the BREVO_API_KEY and EMAIL_FROM secrets (Brevo's free plan
// sends up to 300 emails a day; swap in another provider's API here if
// needed). Locally, with no key set, emails go to the local test inbox
// instead, so nothing ever reaches a real address.
// fromName: the app name from Settings, used as the sender name.
// In the demo (settings.demo on), emails are kept in the Demo inbox instead
// of being sent (attachments are only named there).
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

export type Attachment = { name: string; content: Uint8Array };

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Pause between emails when sending many, to stay under the provider's rate limit.
export const sendDelayMs = Deno.env.get("BREVO_API_KEY") ? 100 : 0;

export async function sendEmail(to: string, subject: string, text: string, fromName = "STA - STA Members App",
                                attachments: Attachment[] = []): Promise<void> {
  if (await isDemo()) {
    const note = attachments.map(a => `\n\n[Attached: ${a.name}, ${Math.ceil(a.content.length / 1024)} KB]`).join("");
    const res = await serviceRest("demo_inbox", {
      method: "POST", body: JSON.stringify({ to_email: to, subject, body: text + note }),
    });
    if (!res.ok) throw new Error(`Demo inbox: ${res.status} ${await res.text()}`);
    return;
  }
  const apiKey = Deno.env.get("BREVO_API_KEY");
  // EMAIL_FROM is the sending address online, e.g. noreply@mail.statennis.com.
  const address = Deno.env.get("EMAIL_FROM") ?? "no-reply@example.com";
  const name = fromName.replace(/["<>]/g, "");

  const res = apiKey
    ? await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender: { name, email: address },
          to: [{ email: to }],
          subject,
          textContent: text,
          ...(attachments.length ? { attachment: attachments.map(a => ({ name: a.name, content: base64(a.content) })) } : {}),
        }),
      })
    : await fetch(`${Deno.env.get("LOCAL_TEST_INBOX_URL") ?? "http://inbucket:8025"}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: { Email: address, Name: name },
          To: [{ Email: to }],
          Subject: subject,
          Text: text,
          Attachments: attachments.map(a => ({ Filename: a.name, Content: base64(a.content) })),
        }),
      });
  if (!res.ok) throw new Error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
}
