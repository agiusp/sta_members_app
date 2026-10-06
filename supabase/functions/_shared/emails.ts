// Builds emails from their templates: the developers' edited wording (the
// email_templates table) or, if an email hasn't been edited, the default
// wording in default-emails.ts. The functions below only work out the values
// that fill each email's {{placeholders}}.
// deno-lint-ignore-file no-explicit-any
import { DEFAULT_EMAILS, fill } from "./default-emails.ts";

export type Email = { subject: string; text: string };
export type Court = { court: number; players: { name: string; brings_balls: boolean }[] };
type Templates = Map<string, { subject: string; body: string }>;

// Default wording, overridden by any edits saved in the app.
export async function loadTemplates(admin: any): Promise<Templates> {
  const templates: Templates = new Map(DEFAULT_EMAILS.map(t => [t.key, { subject: t.subject, body: t.body }]));
  const { data, error } = await admin.from("email_templates").select("key, subject, body");
  if (error) throw new Error("Could not load email wording: " + error.message);
  for (const row of data ?? []) templates.set(row.key, { subject: row.subject, body: row.body });
  return templates;
}

export function render(templates: Templates, key: string, values: Record<string, string>): Email {
  const t = templates.get(key);
  if (!t) throw new Error(`No email called ${key}`);
  return { subject: fill(t.subject, values).trim(), text: fill(t.body, values) };
}

// ---------- Values used by several emails ----------

// "2026-10-04" -> "October 4"
export function playDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "long", day: "numeric",
  });
}

// "2026-10-03T23:45:00Z" -> "7:45 PM"
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  });
}

export function contactsLabel(contacts: string[]): string {
  return contacts.length ? contacts.join(" and/or ") : "the program organizers";
}

export function courtLines(courts: Court[]): string {
  return courts.map(c =>
    `Court ${c.court}: ${c.players.map(p => p.name + (p.brings_balls ? "*" : "")).join(", ")}`).join("\n");
}

export function waitlistLine(waitlist: string[]): string {
  return waitlist.length ? `\nWait list, in order: ${waitlist.join(", ")}\n` : "";
}

export function numbersLine(task: any): string {
  return `${task.signed_up} player(s) signed up for ${task.spots} spots` +
    (task.waitlist_count ? `, with ${task.waitlist_count} on the waitlist.` : ".");
}

// "today" if sent on the Sunday itself (a late lock after midnight), else "tomorrow".
export function dayWord(nowIso: string, playDate: string): string {
  const todayEastern = new Date(nowIso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return todayEastern === playDate ? "today" : "tomorrow";
}

// Whether nowIso is the day after playDate (Eastern), e.g. Monday after a Sunday.
export function dayAfter(nowIso: string, playDate: string): boolean {
  const todayEastern = new Date(nowIso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [y, m, d] = playDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return todayEastern === next;
}

// "Tuesday, October 13, 9:30 – 10:30 AM" (or "11:30 AM – 1:00 PM")
export function casualWhen(startsIso: string, endsIso: string): string {
  const day = new Date(startsIso).toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
  });
  const [from, to] = [timeLabel(startsIso), timeLabel(endsIso)];
  return `${day}, ${from.slice(-2) === to.slice(-2) ? from.slice(0, -3) : from} – ${to}`;
}

export const CASUAL_LOOKING_FOR: Record<string, string> = {
  singles: "singles", doubles: "doubles", either: "singles or doubles",
};

// One line per player whose Casual Play time lines up with yours:
// "Alice Johnson (F, 3.5) alice@example.com: free 8:00 – 9:30 AM, singles or doubles (new)".
// "(new)" only when some of the players were in an earlier email.
export function casualPlayerLines(others: any[] | null): string {
  const list = others ?? [];
  const markNew = list.some(o => !o.new);
  return list.map(o => {
    const about = [o.sex, o.level].filter(Boolean).join(", ");
    const [from, to] = [timeLabel(o.starts_at), timeLabel(o.ends_at)];
    const free = `${from.slice(-2) === to.slice(-2) ? from.slice(0, -3) : from} – ${to}`;
    return `${o.name ?? "A player who hasn't shown their name yet"}${about ? ` (${about})` : ""}${o.email ? ` ${o.email}` : ""}` +
      `: free ${free}, ${CASUAL_LOOKING_FOR[o.play_type] ?? o.play_type}${markNew && o.new ? " (new)" : ""}`;
  }).join("\n");
}

export function casualHiddenNote(count: number): string {
  if (!count) return "";
  return `\n${count} more player${count === 1 ? "" : "s"} line${count === 1 ? "s" : ""} up but ha${count === 1 ? "sn't" : "ven't"} shown their name yet. We've asked them to.\n`;
}

export const WEATHER_OPTION: Record<string, string> = {
  rain_expected: "Rain-out expected",
  self_organized: "Self-organized play",
};
