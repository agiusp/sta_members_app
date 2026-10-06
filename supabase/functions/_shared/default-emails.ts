// THE EMAIL DOCUMENT: the starting wording of every email the app sends.
//
// Developers can change any of these in the app (Developers > Emails),
// and the app then uses their version. This file is only the default,
// used until someone edits an email, and after "Reset to default".
//
// Words in {{double braces}} are filled in when the email is sent; each
// email lists the ones it can use. Don't put real email addresses here:
// this file is public. Contact addresses come from the app's settings.

export type EmailTemplate = {
  key: string;
  name: string;
  sent: string;        // when it's sent
  to: string;          // who gets it
  subject: string;
  body: string;
  placeholders: Record<string, string>; // name -> what it's filled with
  sample: Record<string, string>;       // example values for previews
};

const CONTACTS = "the email addresses in Developers > Contacts, joined with \"and/or\"";
// Previews in the app show the real contacts from settings instead.
const SAMPLE_CONTACTS = "organizers@example.com and/or helper@example.com";
const SAMPLE_COURTS = "Court 1: Alice Johnson*, Bob Smith, Carol Lee, David Kim\nCourt 2: Emma Brown*, Frank Davis, Grace Wilson, Henry Moore";

export const DEFAULT_EMAILS: EmailTemplate[] = [
  // ---------------------------------------------------------------- players
  {
    key: "setup_invite",
    name: "Setup-invite",
    sent: "When a developer clicks Send invite (or Invite all) in the Members section",
    to: "The member's email address",
    subject: "Your invitation to {{program_name}}",
    body: `Hello {{player_names}},

You're invited to {{program_name}}, the club's members app, for club news and for signing up for the Sunday doubles matches. To start using it, click the link below and choose a password:

{{link}}

This link works once and expires after 24 hours. If it has expired, contact {{contacts}} for a new one.

Once your password is set, you can sign up for Sunday Doubles each week from Monday 9am until noon on Saturday.

What the app stores: your name, email address, play level, sex, which Sundays you played, and any Casual Play times you post. Only the program organizers can see your email address. Other players see names on the court assignments. On the Casual Play calendar, they see the sex and play level of anyone who posts a time, and the name only if that player chooses to show it. When Casual Play times line up, players who show their name for those times get each other's names and email addresses. To be removed, contact {{contacts}}.
`,
    placeholders: {
      player_names: "the names of the player(s) linked to this email",
      link: "the personal link to set a password (required)",
      contacts: CONTACTS,
    },
    sample: {
      player_names: "Yara Green and Zack Baker",
      link: "https://<app address>/auth/v1/verify?token=...&type=invite",
      contacts: SAMPLE_CONTACTS,
    },
  },
  {
    key: "play_invite",
    name: "Play-invite",
    sent: "When sign-ups open (Monday 9am by default)",
    to: "Every current member who has set up their account",
    subject: "Sunday Doubles, {{date}}: sign-ups are open",
    body: `Hello Sunday Doubles players

Sign up below for the Sunday doubles match, {{date}} at 9-10:30am

{{signup_link}}
{{review_note}}
Deadline: Sign up or make changes by noon on Saturday.
After that, contact {{contacts}}

What to know:
* If you are suddenly unable to play after the signup cutoff of 12pm on Saturday, it is your responsibility to find a replacement from the wait list or from your own contacts
* Court assignments and ball assignments go out by 8pm Saturday via email
* The person designated with ball assignment must bring a new can of tennis balls
* Please arrive on time and stay through the 90 minutes of play
* A no-show or delay of 15 minutes or more without timely and reasonable explanation will be recorded as a “mischief” event. Two mischief events will result in indefinite suspension from the program for the season.
`,
    placeholders: {
      date: "the Sunday's date, e.g. October 4",
      signup_link: "the link to the sign-up page",
      review_note: "the \"Game Review\" paragraph below, only for members who played last Sunday; nothing for everyone else",
      contacts: CONTACTS,
    },
    sample: {
      date: "October 4", signup_link: "https://<app address>/app/signup.html", contacts: SAMPLE_CONTACTS,
      review_note: "\nThank you for playing yesterday! Please take a minute to review your game (the sets you played, your partners and the scores) here:\nhttps://<app address>/app/review.html\n",
    },
  },
  {
    key: "play_invite_review_note",
    name: "Play-invite: \"Game Review\" paragraph",
    sent: "Inside the play-invite, filling its {{review_note}}",
    to: "Only members whose player was on a court last Sunday",
    subject: "(not used: this is a paragraph inside the play-invite)",
    body: `
Thank you for playing {{day}}! Please take a minute to review your game (the sets you played, your partners and the scores) here:
{{review_link}}
`,
    placeholders: {
      day: "\"yesterday\", or \"last Sunday\" if the play-invite goes out later in the week",
      review_link: "the link to the Game Review tab",
    },
    sample: { day: "yesterday", review_link: "https://<app address>/app/review.html" },
  },
  {
    key: "moved_off_waitlist",
    name: "Off the waitlist",
    sent: "When someone cancels before noon Saturday and a waitlisted player moves into a spot",
    to: "The player who moved up (sent to their account's email)",
    subject: "Sunday Doubles, {{date}}: good news, you have a spot",
    body: `Hello {{first_name}},

Good news: a spot opened up, and you are now signed up to play in the Sunday doubles match on {{date}} at 9-10:30am.

Court assignments and ball assignments go out by 8pm Saturday via email.

If you can no longer play, please cancel on the sign-up page before noon on Saturday, so the next person on the waitlist gets your spot:
{{signup_link}}

After that, contact {{contacts}}
`,
    placeholders: {
      first_name: "the player's first name",
      date: "the Sunday's date",
      signup_link: "the link to the sign-up page",
      contacts: CONTACTS,
    },
    sample: { first_name: "Zack", date: "October 4", signup_link: "https://<app address>/app/signup.html", contacts: SAMPLE_CONTACTS },
  },
  {
    key: "court_assignments",
    name: "Court assignments",
    sent: "At the player-email time (Saturday 8pm by default), or within a minute of a late lock",
    to: "Everyone on a court (one email per account)",
    subject: "Sunday Doubles, {{date}}: court assignments",
    body: `Hello Sunday Doubles players

Here are the court assignments for the Sunday doubles match, {{date}} at 9-10:30am

{{courts}}

* = bringing a new can of tennis balls for that court
{{waitlist}}
You can also see the courts here: {{courts_link}}

What to know:
* If you are suddenly unable to play, it is your responsibility to find a replacement from the wait list or from your own contacts, and to let {{contacts}} know
* The person designated with ball assignment must bring a new can of tennis balls
* Please arrive on time and stay through the 90 minutes of play
* A no-show or delay of 15 minutes or more without timely and reasonable explanation will be recorded as a “mischief” event. Two mischief events will result in indefinite suspension from the program for the season.
`,
    placeholders: {
      date: "the Sunday's date",
      courts: "one line per court, e.g. \"Court 1: Alice Johnson*, Bob Smith, ...\" (required)",
      waitlist: "\"Wait list, in order: ...\" on its own line, or nothing if there's no waitlist",
      courts_link: "the link to the Court Assignments page",
      contacts: CONTACTS,
    },
    sample: {
      date: "October 4", courts: SAMPLE_COURTS,
      waitlist: "\nWait list, in order: Ivy Taylor, Jack Anderson\n",
      courts_link: "https://<app address>/app/courts.html", contacts: SAMPLE_CONTACTS,
    },
  },
  {
    key: "no_spot",
    name: "No spot this week",
    sent: "With the court assignments",
    to: "Each signed-up player left without a court",
    subject: "Sunday Doubles, {{date}}: no court spot this week",
    body: `Hello {{first_name}},

Thank you for signing up for the Sunday doubles match on {{date}}. Unfortunately, more players signed up this week than we had courts for, so there wasn't a spot for everyone and you did not get a court assignment.{{waitlist_place}}

Please sign up next week as early as you can to get a spot. Sign-ups open Monday at 9am, and spots go in the order people sign up.

If a player who got a spot can't make it, they may contact you directly to ask you to take their place.

Questions? Contact {{contacts}}
`,
    placeholders: {
      first_name: "the player's first name",
      date: "the Sunday's date",
      waitlist_place: "\" You were #2 on the waitlist.\", or nothing if the player had a spot but was left off the courts",
      contacts: CONTACTS,
    },
    sample: { first_name: "Ivy", date: "October 4", waitlist_place: " You were #2 on the waitlist.", contacts: SAMPLE_CONTACTS },
  },
  {
    key: "rain_expected",
    name: "Rain-out expected",
    sent: "At the player-email time (or within a minute of a late choice), when the week is set to Rain-out expected",
    to: "Everyone signed up, waitlist included (one email per account)",
    subject: "Sunday Doubles, {{date}}: rain-out expected, no courts assigned",
    body: `Hello Sunday Doubles players

The forecast for {{day}} looks pretty bad, so we expect a rain-out and no courts have been assigned for Sunday {{date}}.

In the event that the forecast is wrong, you are welcome to show up at 9am and enjoy self-organized play.

Questions? Contact {{contacts}}
`,
    placeholders: {
      date: "the Sunday's date",
      day: "\"tomorrow\", or \"today\" if sent after midnight",
      contacts: CONTACTS,
    },
    sample: { date: "October 4", day: "tomorrow", contacts: SAMPLE_CONTACTS },
  },
  {
    key: "self_organized",
    name: "Self-organized play",
    sent: "At the player-email time (or within a minute of a late choice), when the week is set to Uncertain weather",
    to: "Everyone signed up, waitlist included (one email per account)",
    subject: "Sunday Doubles, {{date}}: self-organized play, no courts assigned",
    body: `Hello Sunday Doubles players

The forecast for {{day}} is not looking good, so no courts have been assigned for Sunday {{date}}.

Please show up at 9am as planned and enjoy self-organized play.

Questions? Contact {{contacts}}
`,
    placeholders: {
      date: "the Sunday's date",
      day: "\"tomorrow\", or \"today\" if sent after midnight",
      contacts: CONTACTS,
    },
    sample: { date: "October 4", day: "tomorrow", contacts: SAMPLE_CONTACTS },
  },

  {
    key: "casual_game",
    name: "Casual Play: players line up with your time",
    sent: "Within a minute of another player's time lining up with yours (and again whenever someone new lines up)",
    to: "The player who posted the time, if they show their name for it. Only players who also show their name are listed",
    subject: "Casual Play: players free {{when}}",
    body: `Hello {{first_name}},

Good news: other players are free at the same time as you on {{when}} ({{looking_for}}), at levels that suit you:

{{players}}
{{hidden_note}}
Get in touch with each other (reply-all works if you copy the addresses above) to decide who plays: a singles game, or a doubles game if there are four of you (you can also invite a fourth player). Then book a court.

If more players line up with your time, we'll email you again.

Once you've set up a game, please remove this time from the Casual Play calendar (click your time, then Unsubmit), so other players no longer see you as available then:
{{slot_link}}
`,
    placeholders: {
      first_name: "the player's first name",
      when: "the day and time of the player's posted time, e.g. \"Tuesday, October 13, 8:00 – 9:30 AM\"",
      looking_for: "\"singles\", \"doubles\" or \"singles or doubles\": what the player is looking for",
      players: "one line per player who lines up: name, sex and level, email address, the time they share and what they're looking for; \"(new)\" marks players added since the last email (required)",
      hidden_note: "a line saying how many more players line up but haven't shown their name yet (empty if none)",
      slot_link: "the link that opens this time on the Casual Play calendar, where the player can Unsubmit it",
    },
    sample: {
      first_name: "Yara", when: "Tuesday, October 13, 8:00 – 9:30 AM", looking_for: "singles or doubles",
      players: "Alice Johnson (F, 3.5) alice.johnson@example.com: free 8:00 – 9:30 AM, singles or doubles\nBob Smith (M, 3.5) bob.smith@example.com: free 8:00 – 9:00 AM, singles (new)",
      hidden_note: "\n1 more player lines up but hasn't shown their name yet. We've asked them to.\n",
      slot_link: "https://<app address>/app/casual.html?slot=123",
    },
  },
  {
    key: "casual_reveal",
    name: "Casual Play: show your name to meet players",
    sent: "Within a minute of another player's time lining up with yours, if your name is hidden for that time (and again whenever someone new lines up)",
    to: "The player who posted the time, if their name is hidden for it",
    subject: "Casual Play: players free {{when}} – show your name to meet them",
    body: `Hello {{first_name}},

Other players are free at the same time as you on {{when}} ({{looking_for}}), at levels that suit you:

{{others}}

Your name is hidden for that time, so they don't know about you yet. To get their names and email addresses, and to let them know about you, turn on "Show my name" for that time:
{{reveal_link}}
`,
    placeholders: {
      first_name: "the player's first name",
      when: "the day and time of the player's posted time",
      looking_for: "\"singles\", \"doubles\" or \"singles or doubles\": what the player is looking for",
      others: "one line per player who lines up: name (if they show it), sex and level, the time they share and what they're looking for (required)",
      reveal_link: "the link that opens this time on the Casual Play calendar, with its Show my name switch (required)",
    },
    sample: {
      first_name: "Bob", when: "Tuesday, October 13, 8:00 – 9:30 AM", looking_for: "singles or doubles",
      others: "Alice Johnson (F, 3.5): free 8:00 – 9:30 AM, singles or doubles\nA player who hasn't shown their name yet (M, 4.0): free 8:30 – 9:30 AM, doubles",
      reveal_link: "https://<app address>/app/casual.html?slot=123",
    },
  },

  // ------------------------------------------------------------- developers
  {
    key: "dev_scheduler_open",
    name: "Developers: time to run the Scheduler",
    sent: "Saturday 12:01pm by default (see the schedule)",
    to: "Every developer",
    subject: "Sign-ups are closed for {{date}}: time to set up the courts",
    body: `Sign-ups for Sunday {{date}} closed at noon. {{numbers}}

{{next_step}}
{{scheduler_link}}

At 8pm, every playing member is emailed their court and ball assignments, and anyone without a court gets the "no spot this week" email.
`,
    placeholders: {
      date: "the Sunday's date",
      numbers: "e.g. \"30 player(s) signed up for 24 spots, with 6 on the waitlist.\"",
      next_step: "\"It's time to run the Scheduler...\", or a note that the courts are already locked",
      scheduler_link: "the link to the Scheduler",
    },
    sample: {
      date: "October 4", numbers: "30 player(s) signed up for 24 spots, with 6 on the waitlist.",
      next_step: "It's time to run the Scheduler: arrange the courts and ball assignments, and lock them before 8pm:",
      scheduler_link: "https://<app address>/app/scheduler.html",
    },
  },
  {
    key: "dev_reminder_1",
    name: "Developers: first reminder",
    sent: "Saturday 4pm by default (see the schedule), if nothing is locked yet",
    to: "Every developer",
    subject: "Reminder: the courts for {{date}} are not locked yet",
    body: `The courts for Sunday {{date}} are not locked yet. {{numbers}}

Please arrange the courts in the Scheduler and lock them before 8pm tonight:
{{scheduler_link}}
`,
    placeholders: {
      date: "the Sunday's date",
      numbers: "e.g. \"30 player(s) signed up for 24 spots, with 6 on the waitlist.\"",
      scheduler_link: "the link to the Scheduler",
    },
    sample: {
      date: "October 4", numbers: "30 player(s) signed up for 24 spots, with 6 on the waitlist.",
      scheduler_link: "https://<app address>/app/scheduler.html",
    },
  },
  {
    key: "dev_reminder_2",
    name: "Developers: final reminder",
    sent: "Saturday 7pm by default (see the schedule), if still nothing is locked",
    to: "Every developer",
    subject: "Final reminder: the courts for {{date}} are not locked yet",
    body: `The courts for Sunday {{date}} are not locked yet. {{numbers}}

Please arrange the courts in the Scheduler and lock them before 8pm tonight. If they aren't locked by 8pm, no court emails go out to players:
{{scheduler_link}}
`,
    placeholders: {
      date: "the Sunday's date",
      numbers: "e.g. \"30 player(s) signed up for 24 spots, with 6 on the waitlist.\"",
      scheduler_link: "the link to the Scheduler",
    },
    sample: {
      date: "October 4", numbers: "30 player(s) signed up for 24 spots, with 6 on the waitlist.",
      scheduler_link: "https://<app address>/app/scheduler.html",
    },
  },
  {
    key: "dev_courts_locked",
    name: "Developers: locked summary (courts)",
    sent: "Saturday 7:45pm by default (see the schedule), if the courts are locked; again if re-locked later",
    to: "Every developer",
    subject: "{{updated}}Courts for {{date}} are locked: player emails go out at 8pm",
    body: `The courts for Sunday {{date}} were arranged and locked by {{locked_by}} at {{locked_time}}.

{{courts}}

* = bringing a new can of tennis balls for that court
{{waitlist}}
At 8pm, every playing member will be emailed these court and ball assignments{{no_spot_note}}.

To change anything, unlock the courts in the Scheduler before 8pm:
{{scheduler_link}}
`,
    placeholders: {
      updated: "\"Updated: \" if this replaces an earlier copy, otherwise nothing",
      date: "the Sunday's date",
      locked_by: "the developer's name and email, e.g. \"Dana Developer (dev@example.com)\"",
      locked_time: "when they locked, e.g. 7:30 PM",
      courts: "one line per court",
      waitlist: "\"Wait list, in order: ...\" on its own line, or nothing",
      no_spot_note: "\", and 5 player(s) without a court will get the \"no spot this week\" email\", or nothing",
      scheduler_link: "the link to the Scheduler",
    },
    sample: {
      updated: "", date: "October 4", locked_by: "Dana Developer (dev@example.com)", locked_time: "7:30 PM",
      courts: SAMPLE_COURTS, waitlist: "\nWait list, in order: Ivy Taylor, Jack Anderson\n",
      no_spot_note: ", and 2 player(s) without a court will get the \"no spot this week\" email",
      scheduler_link: "https://<app address>/app/scheduler.html",
    },
  },
  {
    key: "dev_weather_locked",
    name: "Developers: locked summary (weather option)",
    sent: "Saturday 7:45pm by default (see the schedule), if the week is set to a weather option; again if changed later",
    to: "Every developer",
    subject: "{{updated}}This week ({{date}}) is set to: {{weather_option}}",
    body: `Sunday {{date}} was set to "{{weather_option}}" by {{locked_by}} at {{locked_time}}.

At 8pm, all {{signed_up}} signed-up player(s), including the waitlist, will be emailed the "{{weather_option}}" message.

To change this, unlock in the Scheduler before 8pm:
{{scheduler_link}}
`,
    placeholders: {
      updated: "\"Updated: \" if this replaces an earlier copy, otherwise nothing",
      date: "the Sunday's date",
      weather_option: "\"Rain-out expected\" or \"Self-organized play\"",
      locked_by: "the developer's name and email",
      locked_time: "when they chose it",
      signed_up: "how many players are signed up",
      scheduler_link: "the link to the Scheduler",
    },
    sample: {
      updated: "", date: "October 4", weather_option: "Rain-out expected",
      locked_by: "Dana Developer (dev@example.com)", locked_time: "3:00 PM", signed_up: "30",
      scheduler_link: "https://<app address>/app/scheduler.html",
    },
  },
  {
    key: "dev_not_locked",
    name: "Developers: nothing locked",
    sent: "At the player-email time (Saturday 8pm by default), if nothing was locked",
    to: "Every developer",
    subject: "Courts for {{date}} were not locked by 8pm: no emails have gone to players",
    body: `The courts for Sunday {{date}} were not locked by 8pm, so no court assignment emails have been sent, and the Court Assignments page shows nothing yet.

You can still lock them in the Scheduler until {{late_lock_until}} Sunday morning. The emails go out to players within a minute of locking, and a late lock can't be undone:
{{scheduler_link}}

If they aren't locked by then, please let the signed-up players know another way.
`,
    placeholders: {
      date: "the Sunday's date",
      late_lock_until: "the cutoff time, e.g. 7:00 AM",
      scheduler_link: "the link to the Scheduler",
    },
    sample: { date: "October 4", late_lock_until: "7:00 AM", scheduler_link: "https://<app address>/app/scheduler.html" },
  },
];

// Every email can also use {{program_name}} (Developers > Emails, schedule
// and settings).
for (const t of DEFAULT_EMAILS) {
  t.placeholders = { program_name: "the app name from Settings", ...t.placeholders };
  t.sample = { program_name: "STA - STA Members App", ...t.sample };
}

// Fills {{placeholders}}. Unknown ones are left as they are, so a typo is
// visible in the preview rather than silently dropped.
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in values ? values[name] : m));
}
