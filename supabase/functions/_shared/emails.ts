// The wording of every email the app sends. Edit the text here; the values in
// ${...} are filled in each week. Contact addresses come from the Developer
// area's settings, not from this file (the repo is public).

export type Email = { subject: string; text: string };

export type Court = { court: number; players: { name: string; brings_balls: boolean }[] };

const PLAY_TIME = "9-10:30am";

// "2026-10-04" -> "October 4"
export function playDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "long", day: "numeric",
  });
}

function contactsLabel(contacts: string[]): string {
  return contacts.length ? contacts.join(" and/or ") : "the program organizers";
}

// Monday 9am, to every current member with an account (not sent yet).
export function playInvite(o: { playDate: string; signupLink: string; contacts: string[] }): Email {
  const date = playDateLabel(o.playDate);
  return {
    subject: `STA Sunday doubles, ${date}: sign-ups are open`,
    text: `Hello STA Players

Sign up below for the Sunday doubles match, ${date} at ${PLAY_TIME}

${o.signupLink}

Deadline: Sign up or make changes by noon on Saturday.
After that, contact ${contactsLabel(o.contacts)}

What to know:
* If you are suddenly unable to play after the signup cutoff of 12pm on Saturday, it is your responsibility to find a replacement from the wait list or from your own contacts
* Court assignments and ball assignments go out by 8pm Saturday via email
* The person designated with ball assignment must bring a new can of tennis balls
* Please arrive on time and stay through the 90 minutes of play
* A no-show or delay of 15 minutes or more without timely and reasonable explanation will be recorded as a “mischief” event. Two mischief events will result in indefinite suspension from the program for the season.
`,
  };
}

// Saturday 8pm, the same email to everyone with a court.
export function courtAssignments(o: {
  playDate: string; courts: Court[]; waitlist: string[]; courtsLink: string; contacts: string[];
}): Email {
  const date = playDateLabel(o.playDate);
  const courtLines = o.courts.map(c =>
    `Court ${c.court}: ${c.players.map(p => p.name + (p.brings_balls ? "*" : "")).join(", ")}`).join("\n");
  const waitlist = o.waitlist.length
    ? `\nWait list, in order: ${o.waitlist.join(", ")}\n`
    : "";
  return {
    subject: `STA Sunday doubles, ${date}: court assignments`,
    text: `Hello STA Players

Here are the court assignments for the Sunday doubles match, ${date} at ${PLAY_TIME}

${courtLines}

* = bringing a new can of tennis balls for that court
${waitlist}
You can also see the courts here: ${o.courtsLink}

What to know:
* If you are suddenly unable to play, it is your responsibility to find a replacement from the wait list or from your own contacts, and to let ${contactsLabel(o.contacts)} know
* The person designated with ball assignment must bring a new can of tennis balls
* Please arrive on time and stay through the 90 minutes of play
* A no-show or delay of 15 minutes or more without timely and reasonable explanation will be recorded as a “mischief” event. Two mischief events will result in indefinite suspension from the program for the season.
`,
  };
}

// Saturday 8pm, to each signed-up player left without a court.
export function noSpot(o: {
  playDate: string; firstName: string; waitlistPlace: number | null; contacts: string[];
}): Email {
  const date = playDateLabel(o.playDate);
  const place = o.waitlistPlace ? ` You were #${o.waitlistPlace} on the waitlist.` : "";
  return {
    subject: `STA Sunday doubles, ${date}: no court spot this week`,
    text: `Hello ${o.firstName},

Thank you for signing up for the Sunday doubles match on ${date}. Unfortunately, more players signed up this week than we had courts for, so there wasn't a spot for everyone and you did not get a court assignment.${place}

Please sign up next week as early as you can to get a spot. Sign-ups open Monday at 9am, and spots go in the order people sign up.

If a player who got a spot can't make it, they may contact you directly to ask you to take their place.

Questions? Contact ${contactsLabel(o.contacts)}
`,
  };
}

// Saturday 5pm, to developers, if the courts aren't locked yet.
export function lockReminder(o: { playDate: string; schedulerLink: string }): Email {
  const date = playDateLabel(o.playDate);
  return {
    subject: `Reminder: lock the courts for ${date} by 8pm`,
    text: `The courts for Sunday ${date} are not locked yet.

Please arrange and lock them in the Scheduler before 8pm tonight, when the court emails go out:
${o.schedulerLink}
`,
  };
}

// Saturday 8pm, to developers, if the courts were never locked.
export function notLockedAlert(o: { playDate: string; contacts: string[] }): Email {
  const date = playDateLabel(o.playDate);
  return {
    subject: `Courts for ${date} were not locked: no court emails were sent`,
    text: `The courts for Sunday ${date} were not locked by 8pm, so no court assignment or no-spot emails were sent, and the Designated Courts page shows nothing.

Please let the signed-up players know their courts another way.
`,
  };
}
