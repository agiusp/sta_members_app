# Developing the online app (local only)

The STA Members App lives in `app/` (web pages) and `supabase/` (database, access rules and server functions). For now it runs only on your Mac. Nothing here is online, and no real emails are sent.

The standalone scheduler (`index.html` at the top level) is unchanged and still works on its own.

## One-time setup

- **Colima** (free Docker runtime), installed with `brew install colima docker` and started automatically with `brew services start colima`. Give it at least 4 CPUs and 6 GB of memory by setting `cpu: 4` and `memory: 6` in `~/.colima/default/colima.yaml`, then running `brew services restart colima`. With Colima's default 2 GB, Supabase stalls and invite emails can arrive with dead links.
- The Supabase parts this app doesn't use (realtime, file storage, log analytics) are switched off in `supabase/config.toml` to save memory.
- **Supabase CLI**, installed with `brew install supabase/tap/supabase`.

## Starting it

From this folder:

```
supabase start                                   # database, sign-in, test inbox
scripts/serve.py                                 # serves the pages (never cached)
```

Then open:

| Page | Tab | Address |
|---|---|---|
| Member sign-in | | http://127.0.0.1:3000/app/ |
| News | | http://127.0.0.1:3000/app/news.html |
| Sunday Doubles | Sign-up | http://127.0.0.1:3000/app/signup.html |
| | Court Assignments (from Saturday 8pm) | http://127.0.0.1:3000/app/courts.html |
| | Game Review | http://127.0.0.1:3000/app/review.html |
| Casual Play | | http://127.0.0.1:3000/app/casual.html |
| Developers (only developers see this tab) | Members and this week | http://127.0.0.1:3000/app/developer.html |
| | Scheduler | http://127.0.0.1:3000/app/scheduler.html |
| | Emails, schedule and settings | http://127.0.0.1:3000/app/emails.html |

| Tool | Address |
|---|---|
| Test inbox (catches every email the app sends) | http://127.0.0.1:54324 |
| Database dashboard (Supabase Studio) | http://127.0.0.1:54323 |

Stop with `supabase stop` and Ctrl+C in the web server's terminal.

## Test data

`supabase/seed.sql` loads fictitious players only (from `sample_data.csv`, plus 16 more), two past Sundays of play history (from `fictitious_past_play.csv`) for the ball roster, and a developer account `dev@example.com`. Zack Baker is linked to Yara Green's account, to test family members. **Never put real member data in this repo.** It is public.

To get in as the developer:

1. `scripts/invite-first-developer.sh dev@example.com`
2. Open the test inbox, open the invite, and click **Accept the invite**.
3. Set a password (at least 10 characters).

From the Developers page you can invite the fictitious members (their invites also land in the test inbox), set the number of courts, and use the **test clock** to pretend it's, say, Saturday 11:59am.

To test a busy week, use **Simulate sign-ups** in the Developers page's test panel. It signs up any number of random fictitious players (there are 43), one minute apart. **Clear this week's sign-ups** undoes it. Both only work in test mode.

`supabase db reset` wipes the local database and reloads the test data. Accounts created before the reset stop working, and old invite links in the test inbox go dead.

## Emails and schedule

- **Wording:** developers edit every email in the app, under **Developers > Emails, schedule and settings**. Edits are saved in the database and used from the next email. The default wording, used until an email is edited and after **Reset to default**, is in `supabase/functions/_shared/default-emails.ts`. The page can also show all emails as one printable document.
- **Timing:** the same page sets the day and time of every deadline and timed email (sign-ups open and close, the Saturday developer emails, the player emails, the late-lock cutoff), plus on/off switches for the optional emails. The conditions (for example, "only if nothing is locked yet") are fixed in `claim_due_tasks` in the database.
- **Timed tasks:** the `timed-tasks` function sends whatever is due. Online, a scheduler will call it every minute. Locally, set the test clock and click **Run timed tasks now** on the Developers page.
- **Where emails go:** locally, every email lands in the test inbox, whatever the address. Online, they go through the email service set by the `RESEND_API_KEY` secret, from the address in the `EMAIL_FROM` secret (just the address, e.g. `no-reply@yourclub.org`; the sender name is the program name). "Forgot password" emails are the only ones still sent by Supabase itself.
- **Restart after changing function code:** after editing or adding anything under `supabase/functions/`, run `supabase stop && supabase start`. The local function runtime caches the code.
- **Migration gotcha:** Supabase's migration tool can misread a `case ... end` expression inside a function's `if` condition. Use `if`/`else` with a variable instead.

## Pages and look

Every page shares one header, built by `STA.initPage()` in `app/common.js`: the logo, the app name, the menu (News, Sunday Doubles, Casual Play, and Developers for developers only) and a link to the club website. A page says where it belongs with `<body data-section="sunday" data-tab="courts">`; the menu and tabs are listed in `SECTIONS` in `common.js`. Pages for members send signed-out visitors to the sign-in page, which brings them back after signing in.

The look follows the club website (statennis.com): Playfair Display headings, small spaced-out capitals in the menu, and the logo's navy (`--accent`) and tennis-ball yellow (`--ball`), set in `app/styles.css`.

**News:** developers post, edit and delete announcements right on the News page. Members only read them. Posts are in the `news` table and only change through `dev_save_news` / `dev_delete_news`.

**Scheduler, Upload my players:** besides **Sunday Doubles** (this week's sign-ups, locked and emailed as before), the Scheduler can arrange any group of players: a CSV or tab-separated .txt file (column 1 name, 2 play level, 3 sex) or pasted lines of "name, level, sex". It uses the same Organized Play options; ball-bringers are picked at random. Nothing is saved to the database or emailed; the list is remembered in that browser only, and the courts can be copied as text or printed.

**Casual Play:** members post when they're free to play (1, 1.5 or 2 hours, 6am to 9pm Eastern, up to 4 weeks ahead), choosing Singles, Doubles or Either and whether to show their name for that time. They see when others at their 1 or 2 chosen levels are free, as half-hour cells shaded by how many players are available; others see each player's sex and level, and the name only if shown. Players who tick "Email me when players' times line up with mine" hear about everyone whose time lines up with theirs: at least an hour shared, levels suiting each other both ways, game types that fit (Either fits anything; Singles and Doubles don't fit each other), and different accounts (`casual_pairs`). There are no fixed matches; the players decide among themselves who plays (singles, or doubles if there are four). A player who shows their name for a time is emailed whenever a new player who also shows their name lines up with it, with everyone's names and email addresses (new players marked, plus a count of hidden players). A player whose name is hidden is emailed whenever a new player lines up, with a link to show their name for that time. `casual_told` records who has been told about whom. Members see who lines up with each of their times on the calendar. Emails go out through `timed-tasks` (`claim_casual_emails`). Everything goes through the `casual_*` functions; the tables can't be read or changed directly.

## Branding (settings)

Developers set the **app name**, **brand color**, **logo** and **club website** at the top of **Emails, schedule and settings**. They're stored in the `settings` table and shown on every page (including the sign-in page, through the public `branding()` function), in tab titles, as `{{program_name}}` in emails, and as the email sender name. A name like "STA - STA Members App" shows as "STA" with "STA Members App" under it. Without an uploaded logo, the club logo in `app/img/sta-logo.png` is used. The uploaded logo is shrunk in the browser and stored as a small PNG/JPEG/WebP data URL, so no file storage service is needed.

## Members and access

Developers keep the **Members Table** (Developers > Members and this week): one row per person, each with their own email address (`players.account_email` is unique). Columns: Name, Email, **Membership** (Active/Inactive, `accounts.membership_current`), **Sunday Doubles** (Yes/No, `players.sunday_doubles`), **App Access** (filled in by the app: Yes once the member accepted the invitation, otherwise "Pending STA Member App Invitation" or "Invited"), plus level, sex and Developer. Changes go through `dev_save_member`; the table comes from `dev_members`.

- **Inactive** members can sign in but see only the dues message (`my_email()` is null for them, so every member function refuses them). Marking them Active restores access. Inactive members can't be invited, and developers must be Active.
- **Sunday Doubles** (sign-up, courts, game review, the Monday play-invite) is only for Active members with Sunday Doubles = Yes (`my_sd_email()`). Everyone Active gets News and Casual Play.
- **New members** start as "Pending STA Member App Invitation" until a developer clicks Send Invite. Their email can be changed until they've joined.
- Pages ask `my_access()` what to show: the menu hides Sunday Doubles from members not approved for it, and Inactive members see only the dues message.

## Demo

A demo copy uses made-up players only (`scripts/demo-seed.mjs`, which refuses to run on a database with any address not ending in @example.com). It turns on demo mode (`settings.demo`): emails are kept in the **Demo inbox** page instead of being sent, and every page says it's a demo. It also turns on test mode with the clock on the Thursday before the next Sunday, and switches off two-step sign-in for the demo developer. Demo sign-ins are alice.johnson@example.com (member) and dev@example.com (developer), with the password in `DEMO_PASSWORD`, which is kept out of the repo.

- **Local demo copy:** `DEMO_PASSWORD=... scripts/demo-copy.sh` starts a separate copy (Supabase on ports 546xx, pages on http://127.0.0.1:3100/app/) and fills it. `scripts/demo-copy.sh stop` stops it. Your own local copy is untouched.
- **Online demo:** a separate Supabase project with the pages on GitHub Pages. `app/config.js` points pages served from github.io at it, and pages on your Mac at the local copy.

The slides in `slides/` (served at /slides/) are screenshots of the local demo copy.

## Two-step sign-in for developers

Developer powers need a sign-in confirmed with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, or the iPhone Passwords app). Members aren't affected. The first time a developer opens a Developers page, `two-step.html` shows a code to scan; after that it asks for the current code once per sign-in. The database enforces it: `is_developer()` is only true for a confirmed sign-in, so a stolen developer password alone can't change anything.

`settings.dev_two_step` switches this off, and only the database itself can change it. The automated tests switch it off, except `tests/twostep.test.mjs`. Online it must stay on.

If a developer loses their phone, remove their two-step sign-in in the database (locally in Supabase Studio at http://127.0.0.1:54323, online in the Supabase dashboard's SQL editor), and they set it up again at their next visit:

    delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'their.email@example.com');

## Security

- Members can't read or change tables directly. Everything goes through the app's functions, which check who is asking. Sessions, seasons and settings are readable by developers only.
- There is no public sign-up: accounts exist only for invited members.
- Casual Play: each player can have at most 40 upcoming times, and re-posting a time doesn't email the same players again, so one member can't flood others with emails.
- Before going live: keep test mode off and never load the test data online; point `app/config.js` at the online project; turn on TOTP two-step sign-in, 24-hour email links (`otp_expiry`), no public sign-up, and the allowed redirect address in the online project's Authentication settings, matching `supabase/config.toml`.

## Automated tests

```
tests/run.sh
```

To test **without touching your own local data**, run `scripts/test-in-copy.sh` instead. It runs the same tests in a separate copy of the app (its own Supabase on ports 544xx, files in `~/.doublesup-test-copy`) and stops it afterwards.

`tests/run.sh` resets the local database before each test file, then walks through invites, sign-in, sign-ups, the waitlist, the Monday and Saturday deadlines, the access rules, and locking courts in the Scheduler, including replacements and the 8pm cutoff. The tests refuse to run against anything other than the local Supabase. Because they reset the database, restore your private local setup afterwards.

## Test mode

The test clock only works while `settings.test_mode` is on, which the local test data switches on. The app itself cannot switch it on. Online, it stays off.
