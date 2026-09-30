# Developing the online app (local only)

The online version of the STA Sunday Program app lives in `app/` (web pages) and `supabase/` (database, access rules and server functions). For now it runs only on your Mac. Nothing here is online, and no real emails are sent.

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

| What | Address |
|---|---|
| Member page | http://127.0.0.1:3000/app/ |
| Developer area | http://127.0.0.1:3000/app/developer.html |
| Scheduler (developers) | http://127.0.0.1:3000/app/scheduler.html |
| Designated Courts (members, from Saturday 8pm) | http://127.0.0.1:3000/app/courts.html |
| Test inbox (catches every email the app sends) | http://127.0.0.1:54324 |
| Database dashboard (Supabase Studio) | http://127.0.0.1:54323 |

Stop with `supabase stop` and Ctrl+C in the web server's terminal.

## Test data

`supabase/seed.sql` loads fictitious players only (from `sample_data.csv`, plus 16 more), two past Sundays of play history (from `fictitious_past_play.csv`) for the ball roster, and a developer account `dev@example.com`. Zack Baker is linked to Yara Green's account, to test family members. **Never put real member data in this repo.** It is public.

To get in as the developer:

1. `scripts/invite-first-developer.sh dev@example.com`
2. Open the test inbox, open the invite, and click **Accept the invite**.
3. Set a password (at least 10 characters).

From the Developer area you can invite the fictitious members (their invites also land in the test inbox), set the number of courts, and use the **test clock** to pretend it's, say, Saturday 11:59am.

To test a busy week, use **Simulate sign-ups** in the Developer area's test panel. It signs up any number of random fictitious players (there are 43), one minute apart. **Clear this week's sign-ups** undoes it. Both only work in test mode.

`supabase db reset` wipes the local database and reloads the test data. Accounts created before the reset stop working, and old invite links in the test inbox go dead.

## Emails and timed tasks

- **Email wording:** every email the app sends is in `supabase/functions/_shared/emails.ts`. The setup-invite is Supabase's own email and isn't in this file.
- **Timed tasks:** the Saturday 5pm lock reminder and the 8pm court and no-spot emails are sent by the `timed-tasks` function. Online, a scheduler will call it every few minutes. Locally, set the test clock and click **Run timed tasks now** in the Developer area. Each task runs only once per week.
- **Where emails go:** locally, every email lands in the test inbox, whatever the address. Online, they go through the email service set by the `RESEND_API_KEY` secret.
- **New functions:** after adding a function under `supabase/functions/`, restart Supabase (`supabase stop && supabase start`). The function runtime only registers functions when it starts.

## Automated tests

```
tests/run.sh
```

Resets the local database before each test file, then walks through invites, sign-in, sign-ups, the waitlist, the Monday and Saturday deadlines, the access rules, and locking courts in the Scheduler, including replacements and the 8pm cutoff. The tests refuse to run against anything other than the local Supabase. Because they reset the database, restore your private local setup afterwards.

## Test mode

The test clock only works while `settings.test_mode` is on, which the local test data switches on. The app itself cannot switch it on. Online, it stays off.
