# STA Members App

The Summit Tennis Association's members app: club news, Sunday Doubles sign-ups, court assignments and game reviews, Casual Play, and the organizers' tools. It lives in `app/` and `supabase/`; see [DEVELOPING.md](DEVELOPING.md).

- **Tour (slides):** [agiusp.github.io/sta_members_app/slides/](https://agiusp.github.io/sta_members_app/slides/) shows every member and developer screen, using made-up players.
- **Online demo:** [agiusp.github.io/sta_members_app/app/](https://agiusp.github.io/sta_members_app/app/), a temporary demo with made-up players only. Emails aren't sent; they appear in its Demo inbox.

## The original Sunday Program Scheduler

A single-page, no-install web app for assigning available players to 6 courts on Sunday program day. It is still at [agiusp.github.io/sta_members_app/](https://agiusp.github.io/sta_members_app/) while the members app is being introduced.

### Usage

1. Open `index.html` in any browser (double-click it, or `open index.html` on macOS).
2. Load your roster, either way:
   - **CSV file:** click **Roster file (CSV)** and select a file. Two ready-to-use examples are included:
     - `sample_data.csv` — 26 players, 23 signed up (sequential sign-up order, no benching needed), good for a quick check.
     - `fictitious_players.csv` — 32 players, 26 signed up (sequential sign-up order) and uneven level/sex groupings, so every Organized Play mode leaves some players on the bench or a court red, and the last 2 sign-ups (#25 and #26) get auto-benched by the 24-player court capacity — good for testing that behavior and drag-and-drop fixes.
   - **Google Sheet:** the **Roster file Google sheet url** field comes pre-filled with a live, publicly-shared demo sheet ([view it here](https://docs.google.com/spreadsheets/d/1chPgcHE0WMHBzqYFdXXB4RAGKUGDPmyMSELh5KYs17w/edit?usp=drive_link)). **Note:** as of this writing, this demo sheet still uses the old checkbox-style `Availability` column (`TRUE`/`FALSE`) rather than the new sign-up-order format described below, so loading it as-is currently shows 0 available players — it's due to be updated to the new format. It still doubles as a template for the sharing settings and column layout a working sheet needs. To use your own instead, paste its URL over the pre-filled one (click **Reset to the example** to bring the demo link back). Your sheet must be shared as *"Anyone with the link — Viewer"* (Share button, top right of Sheets) and its first row must have the same `Name`/`Level`/`Sex`/`Availability` headers as the CSV format below. It reads whichever tab the link opens to by default; to target a different tab, open that tab in Sheets and copy its URL (it will end in `#gid=<number>`) into the box.
3. Optionally, load a **Past Play** file the same way (its own panel, own CSV file or Google Sheet URL field) — see [Past Play data](#past-play-data) below. This is used to flag repeat court groupings and to decide who brings balls (step 6); the app works fine without it.
4. Pick an **Organized Play** format:
   - Same-sex doubles
   - Mixed doubles
   - By play level
   - By play level and same-sex doubles
   - By play level and mixed doubles
5. Click **Auto-Assign Courts** to fill the 6 boxes (up to 4 players each) from the available pool, using a best-effort grouping for the selected format. Before that format-specific grouping runs, two automatic cuts are applied, both benching the highest (latest) sign-up numbers first: the pool is capped at 24 (6 courts × 4), and then trimmed further down to a multiple of 4 if it isn't already, so a partial four is never handed to the grouping logic. You can still move a benched player onto a court by hand afterward.
6. Adjust manually by tapping (works the same with mouse or touch, so it behaves identically on a phone as on a laptop):
   - **Tap one player, then another** to swap their places — the first tap highlights them and shows a banner; the second tap performs the swap. Works across any two courts, or a court and the Bench.
   - **Tap one player, then an empty spot** on a court or the Bench (not on another player) to move them there without swapping.
   - **Tap the same player twice** to cancel a pending selection.
   
   Each court with players has one name marked with a **`*`**: that person brings a fresh can of balls for the court. See [Ball roster](#ball-roster) below. The `*` is recomputed on every move, so it follows the court's current four.

   A court turns **green** when it has exactly 4 players who satisfy the selected format, and **red** otherwise. If a Past Play file is loaded and a court's exact 4 players were grouped together on some past date, that court also gets an extra **blue ring** outside its green/red border — hover over it to see which date(s).
7. Use **Clear Courts** to send everyone back to the bench without re-running the file load.
8. Click **Download Courts Image** to save a PNG snapshot of the 6 courts (with each player's name/sex/level and the green/red status) plus the bench, for printing or sharing in a text/group chat. It's drawn fresh from the current data, not a literal screenshot, so it looks the same crisp layout regardless of your screen size. The ball-bringer `*` is included. (The blue past-play ring is a screen-only indicator and isn't drawn into this image.)

Only players marked as available are ever placed on a court or shown in the bench; unavailable players are excluded entirely (the status line reports how many were excluded).

### Using it on a phone

The page itself is fully responsive (single-column court layout, larger tap targets, tap-to-swap interaction — no drag-and-drop anywhere, since that's unreliable on touchscreens) and works in any mobile browser. The only catch is *getting the file onto the phone*, since `index.html` lives on your computer:

- **Easiest — local Wi-Fi server:** on the computer, from this folder run `python3 -m http.server 8000`, then find the computer's local IP (e.g. `ipconfig getifaddr en0` on macOS) and visit `http://<that-ip>:8000/index.html` in the phone's browser (same Wi-Fi network required).
- **Or airdrop/email/cloud-sync** `index.html` (and a CSV) directly to the phone and open it from Files/Downloads — it runs standalone with no server needed, since everything is client-side.

### Data format

Whether it's a CSV file or a Google Sheet, the first row must be a header row containing these columns (case-insensitive, any column order):

| Column | Notes |
|---|---|
| `Name` | Player's full name |
| `Level` | Play level, e.g. NTRP rating (3.0, 3.5, 4.0, ...) — matched exactly when grouping "by play level" |
| `Sex` | `M`/`F` (or `Male`/`Female`) |
| `Availability` | `False` (case-insensitive) or blank means the player didn't sign up this week and is excluded entirely. Otherwise, a positive number (`1`, `2`, `3`, ...) gives their sign-up order for the week. |

Each court chip is displayed as `Name, Sex, Level` so you can see at a glance whether it fits the selected format.

**Auto-Assign Courts** only works with a multiple of 4 players, up to a maximum of 24 (6 courts × 4). Before it applies the selected Organized Play format, it benches whoever has the highest sign-up numbers (the last to sign up) — first to get under the 24-player cap if needed, then further if the remaining count still isn't a multiple of 4 — so the format-specific grouping always starts from a clean multiple of 4. You can still move a benched player onto a court by hand afterward.

### Past Play data

Past Play is optional. Loading it doesn't change which players get auto-assigned or where. It flags when a court's current 4 players exactly match a group that already played together on some earlier date (blue ring, hover for the date(s); see step 6 above), and it drives the [ball roster](#ball-roster).

The format is one row per player, with one additional column per past date:

| Column | Notes |
|---|---|
| `Name` | Must match that player's `Name` in the roster file exactly (trimmed) to be matched against current courts. |
| *(one column per date, e.g.* `Sep 6, 2026` *)* | That week's court/group id for this player (any short label works, e.g. `1`, `Court 1`, `A` — it just has to match the other 3 players who shared their court that week). Leave blank if the player didn't play that week. Add a `*` (e.g. `3*`) if this player brought the balls for their court that week; the `*` is ignored when matching group ids. |

Column headers and group-id values are otherwise free-form — the app only groups rows that share the same non-blank value within the same date column, and only treats a group as a real past court if it has exactly 4 players.

`fictitious_past_play.csv` is a ready-to-use example: it lists the same 26 players as `sample_data.csv`, with two past dates (`Sep 6, 2026` and `Sep 13, 2026`) of mixed-doubles groupings for 20 of them each week, with one `*` ball-bringer per court per week. Load `sample_data.csv` as the roster, `fictitious_past_play.csv` as Past Play, pick **Mixed doubles**, and click **Auto-Assign Courts** — several of the resulting courts will show the blue ring.

The **Past Play Google sheet url** field comes pre-filled with a live demo sheet holding this same data ([view it here](https://docs.google.com/spreadsheets/d/16Bac95620Pg-euiz16EVSMX8hm1L3veozzgxvECoPCc/edit?gid=0#gid=0)) — click **Load from Google Sheet** in that panel to try it directly, no download needed. It must be shared the same way as the roster sheet (*"Anyone with the link — Viewer"*).

### Ball roster

For each court, the app picks one player to bring a fresh can of balls and marks their name with `*`. It picks, in order of priority:

1. The player who has gone the **longest since last bringing balls**, according to the `*` marks in Past Play. Someone with no `*` on record is first in line, and someone who brought balls last week is last.
2. On a tie, the player who has brought balls the **fewest times** overall.
3. On a further tie, the **earliest sign-up**.

Date columns are ordered by date when every header parses as one (e.g. `Sep 6, 2026`); otherwise they're read left to right, oldest first. With no Past Play loaded, the earliest sign-up on each court brings the balls. Hover a starred name to see when they last brought balls.

### Notes

- Everything runs client-side; no server, backend, or API key is required, and your roster data never passes through any third party besides Google itself when you use the Sheet option.
- Reading a Google Sheet works by loading it as a script tag (the standard trick for public Sheets, since Google's CSV export doesn't allow direct cross-site fetches) — it only works for sheets shared publicly via link, not private ones. If the sheet isn't shared correctly, or the URL/tab is wrong, you'll get an error after a few seconds rather than a silent failure.
- The app doesn't save state between page reloads — reload the CSV file or Google Sheet URL again if you refresh the page.
