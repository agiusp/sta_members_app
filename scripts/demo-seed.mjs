#!/usr/bin/env node
// Fills a DEMO copy of the app with made-up club data: members, three past
// Sundays of play, this week's sign-ups, game reviews, news, and Casual Play
// times. It turns on demo mode (emails go to the Demo inbox), test mode with
// the clock on the Thursday before the demo Sunday, and switches off
// two-step sign-in for the demo developer.
//
// It refuses to run if the database holds any email address not ending in
// @example.com, so it can never touch the real club's data.
//
//   Local demo copy: scripts/demo-copy.sh (runs this for you)
//   Online demo:     SUPABASE_URL=... SERVICE_ROLE_KEY=... PUBLISHABLE_KEY=... \
//                    DEMO_PASSWORD=... node scripts/demo-seed.mjs
//
// DEMO_PASSWORD is the password for the two demo sign-ins shared with the
// people trying the demo: alice.johnson@example.com (member) and
// dev@example.com (developer). Keep it out of the repo.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SERVICE_ROLE_KEY;
const PUBLIC = process.env.PUBLISHABLE_KEY;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!URL_ || !SERVICE || !PUBLIC || !DEMO_PASSWORD) {
  console.error('Set SUPABASE_URL, SERVICE_ROLE_KEY, PUBLISHABLE_KEY and DEMO_PASSWORD.');
  process.exit(1);
}
if (DEMO_PASSWORD.length < 10) { console.error('DEMO_PASSWORD must be at least 10 characters.'); process.exit(1); }

async function call(path, { method = 'POST', body, token = SERVICE, key = SERVICE, prefer } = {}) {
  const res = await fetch(URL_ + path, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
               ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return data;
}
const table = (name, query = '') => call(`/rest/v1/${name}${query}`, { method: 'GET' });
const insert = (name, rows, prefer = 'return=representation') => call(`/rest/v1/${name}`, { body: rows, prefer });
const patch = (name, query, body) => call(`/rest/v1/${name}?${query}`, { method: 'PATCH', body, prefer: 'return=minimal' });
const asUser = (token, fn, args = {}) => call(`/rest/v1/rpc/${fn}`, { token, key: PUBLIC, body: args });

// ---------- Safety check ----------
const existing = await table('accounts', '?select=email');
const real = existing.filter(a => !a.email.endsWith('@example.com'));
if (real.length) {
  console.error(`Refusing: this database has ${real.length} account(s) that are not made-up @example.com addresses.`);
  process.exit(1);
}

// ---------- Dates (US Eastern) ----------
// The demo Sunday is the next Sunday; the clock is the Thursday before, 2pm.
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dow = new Date(todayEt + 'T12:00:00Z').getUTCDay();
const SUNDAY = addDays(todayEt, dow === 0 ? 7 : 7 - dow);
// Eastern time to UTC, allowing for daylight saving time.
function et(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' UTC');
  return new Date(guess.getTime() + (guess - shown)).toISOString();
}
const CLOCK = et(addDays(SUNDAY, -3), '14:00');
console.log(`Demo Sunday ${SUNDAY}; clock set to Thursday ${addDays(SUNDAY, -3)} 2:00 PM Eastern.`);

// ---------- Settings ----------
await patch('settings', 'id=eq.true', {
  demo: true, test_mode: true, test_clock: CLOCK, dev_two_step: false,
  contact_emails: ['dev@example.com'],
});

// ---------- Members (the made-up players from supabase/seed.sql) ----------
const seed = readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
const people = [...seed.matchAll(/\('([a-z.]+@example\.com)', '([^']+)', '([^']+)', '([\d.]+)', '([MF])'\)/g)]
  .map(([, email, first, last, level, sex]) => ({ email, first, last, level, sex }));
const emails = [...new Set(people.map(p => p.email))];
await insert('accounts', emails.map(email => ({ email, is_developer: email === 'dev@example.com' })),
             'resolution=ignore-duplicates,return=minimal');
const have = await table('players', '?select=id,account_email,first_name,last_name');
const missing = people.filter(p => !have.some(h => h.account_email === p.email && h.first_name === p.first));
if (missing.length) {
  await insert('players', missing.map(p => ({ account_email: p.email, first_name: p.first, last_name: p.last,
                                               level: p.level, sex: p.sex })), 'return=minimal');
}
// Most members play Sunday Doubles; a few only use News and Casual Play, and
// two haven't renewed their membership (Inactive).
const casualOnly = ['Beth', 'Chloe', 'Dina', 'Elena', 'Fiona'];
await patch('players', 'id=gt.0', { sunday_doubles: true });
await patch('players', `first_name=in.(${casualOnly.join(',')})`, { sunday_doubles: false });
await patch('accounts', 'email=in.(victor.king@example.com,uma.young@example.com)', { membership_current: false });
const players = await table('players', '?select=id,account_email,first_name,last_name,level,sex,sunday_doubles&order=id');
const byName = n => players.find(p => `${p.first_name} ${p.last_name}` === n);
const who = n => byName(n).id;

// ---------- Season and three past Sundays ----------
if (!(await table('seasons', '?select=id')).length) {
  await insert('seasons', { name: String(new Date().getFullYear()), start_date: `${new Date().getFullYear()}-05-03` }, 'return=minimal');
}
const season = (await table('seasons', '?select=id&order=start_date.desc&limit=1'))[0].id;
const inactive = ['victor.king@example.com', 'uma.young@example.com'];
const regulars = players.filter(p => p.account_email !== 'dev@example.com' && p.sunday_doubles);
const current = regulars.filter(p => !inactive.includes(p.account_email));
for (const [w, back] of [[0, 21], [1, 14], [2, 7]]) {
  const date = addDays(SUNDAY, -back);
  if ((await table('sessions', `?select=id&play_date=eq.${date}`)).length) continue;
  const [s] = await insert('sessions', {
    play_date: date, season_id: season, num_courts: 5, org_play: 'level-mixed',
    signups_open_at: et(addDays(date, -6), '09:00'), signups_close_at: et(addDays(date, -1), '12:00'),
    courts_publish_at: et(addDays(date, -1), '20:00'), locked_at: et(addDays(date, -1), '15:10'),
    locked_by: 'dev@example.com', published_at: et(addDays(date, -1), '20:00'),
    play_invite_sent_at: et(addDays(date, -6), '09:00'), scheduler_notice_sent_at: et(addDays(date, -1), '12:01'),
    reminder_4pm_sent_at: et(addDays(date, -1), '16:00'), reminder_7pm_sent_at: et(addDays(date, -1), '19:00'),
    preview_sent_at: et(addDays(date, -1), '19:45'),
  });
  // 20 players a week, a different mix each week; Alice plays every week.
  const pool = regulars.filter((_, i) => (i + w * 3) % 7 !== 0);
  const week = [byName('Alice Johnson'), ...pool.filter(p => p.first_name !== 'Alice')].slice(0, 20)
    .sort((a, b) => b.level.localeCompare(a.level) || a.sex.localeCompare(b.sex));
  await insert('assignments', week.map((p, i) => ({
    session_id: s.id, court: Math.floor(i / 4) + 1, player_id: p.id, brings_balls: i % 4 === (w % 4),
  })), 'return=minimal');
  await insert('signups', week.map((p, i) => ({
    session_id: s.id, player_id: p.id, signed_up_at: et(addDays(date, -6), `09:${String(i + 1).padStart(2, '0')}`),
    signed_up_by: p.account_email,
  })), 'return=minimal');
}

// ---------- Sign-ins ----------
async function signInAs(email, password) {
  const r = await call('/auth/v1/token?grant_type=password', { token: PUBLIC, key: PUBLIC, body: { email, password } });
  return r.access_token;
}
const users = (await call('/auth/v1/admin/users?per_page=1000', { method: 'GET' })).users;
const tokens = {};
async function login(email, password) {
  const u = users.find(x => x.email === email);
  if (u) await call(`/auth/v1/admin/users/${u.id}`, { method: 'PUT', body: { password } });
  else await call('/auth/v1/admin/users', { body: { email, password, email_confirm: true } });
  tokens[email] = await signInAs(email, password);
  return tokens[email];
}
const dev = await login('dev@example.com', DEMO_PASSWORD);
const alice = await login('alice.johnson@example.com', DEMO_PASSWORD);

// ---------- This week ----------
await asUser(alice, 'my_week');                      // makes sure the demo Sunday exists
const [session] = await table('sessions', `?select=id&play_date=eq.${SUNDAY}`);
await patch('sessions', `id=eq.${session.id}`, { num_courts: 5, play_invite_sent_at: et(addDays(SUNDAY, -6), '09:00') });
if (!(await table('signups', `?select=id&session_id=eq.${session.id}`)).length) {
  // 18 sign-ups for 20 spots on 5 courts. Alice hasn't signed up yet, so
  // whoever tries the demo as Alice can.
  const signers = current.filter(p => p.first_name !== 'Alice').slice(0, 18);
  await insert('signups', signers.map((p, i) => ({
    session_id: session.id, player_id: p.id, signed_up_by: p.account_email,
    signed_up_at: new Date(Date.parse(et(addDays(SUNDAY, -6), '09:00')) + (i * i * 7 + 1) * 60000).toISOString(),
  })), 'return=minimal');
}

// ---------- Game reviews of last Sunday ----------
const last = (await table('sessions', `?select=id&play_date=eq.${addDays(SUNDAY, -7)}`))[0];
const lastCourts = await table('assignments', `?select=court,player_id&session_id=eq.${last.id}`);
const done = await table('game_reviews', `?select=player_id&session_id=eq.${last.id}`);
const onCourt = c => lastCourts.filter(a => a.court === c).map(a => a.player_id);
const reviewers = [[1, 0, 4, 'Great match, very even.'], [1, 2, 5, ''], [2, 1, 4, 'Fun group.'], [3, 0, 3, ''], [4, 3, 5, 'Loved it!']];
for (const [court, i, enjoyment, comments] of reviewers) {
  const ids = onCourt(court);
  const me = players.find(p => p.id === ids[i]);
  if (!me || me.first_name === 'Alice' || done.some(d => d.player_id === me.id)) continue;
  const partners = ids.filter(x => x !== me.id);
  const token = tokens[me.account_email] ?? await login(me.account_email, randomBytes(18).toString('base64url'));
  await asUser(token, 'submit_review', { p_player_id: me.id, p_enjoyment: enjoyment, p_comments: comments || null, p_sets: [
    { partner_id: partners[0], my_games: 6, their_games: 4 },
    { partner_id: partners[1], my_games: 3, their_games: 6 },
    { partner_id: partners[2], my_games: 6, their_games: 5 },
  ] });
}

// ---------- News ----------
if (!(await table('news', '?select=id')).length) {
  await insert('news', [
    { title: 'Welcome to the STA Members App', posted_by: 'dev@example.com', created_at: et(addDays(SUNDAY, -13), '10:00'),
      body: 'Sign up for Sunday Doubles, see your court, review your game, and find Casual Play partners, all in one place.\n\nQuestions? Reply to any email from the app.' },
    { title: 'Courts 3 and 4 resurfaced', posted_by: 'dev@example.com', created_at: et(addDays(SUNDAY, -9), '18:30'),
      body: 'The resurfacing is finished and all courts are open again. Thanks for your patience!' },
    { title: 'End-of-season party', posted_by: 'dev@example.com', created_at: et(addDays(SUNDAY, -4), '08:15'),
      body: 'Join us after Sunday Doubles at the end of the month for food and a round-robin. Details on the club website: https://www.statennis.com/' },
  ], 'return=minimal');
}

// ---------- Casual Play ----------
const casual = [
  // [name, show name, emails, levels, [day offset from Thursday, start, minutes, type, show for this time]]
  ['Alice Johnson', true, true, ['3.5'], [[2, '09:00', 120, 'either'], [5, '18:00', 90, 'singles']]],
  ['Bob Smith', true, true, ['3.5', '4.0'], [[2, '09:00', 90, 'either']]],
  ['Grace Wilson', false, true, ['3.5'], [[2, '08:30', 120, 'doubles']]],
  ['Henry Moore', true, true, ['3.5'], [[2, '10:00', 60, 'singles'], [6, '07:00', 90, 'either']]],
  ['Mia Garcia', true, true, ['3.5'], [[1, '17:00', 120, 'doubles'], [5, '18:00', 120, 'either']]],
  ['Carol Lee', true, true, ['4.0'], [[1, '07:00', 60, 'singles'], [8, '12:00', 90, 'either']]],
  ['David Kim', false, true, ['4.0', '4.5'], [[1, '07:00', 90, 'either']]],
  ['Olivia Clark', true, true, ['4.5'], [[3, '15:00', 120, 'doubles']]],
  ['Paul Rodriguez', true, false, ['4.5'], [[3, '15:30', 90, 'doubles']]],
  ['Emma Brown', true, true, ['3.0'], [[4, '11:00', 60, 'either'], [10, '09:30', 60, 'either']]],
  ['Frank Davis', true, true, ['3.0'], [[4, '10:30', 120, 'singles']]],
  ['Noah Robinson', false, true, ['3.5'], [[6, '07:00', 120, 'either'], [12, '18:30', 90, 'doubles']]],
];
if (!(await table('casual_slots', '?select=id&limit=1')).length) {
  const thursday = addDays(SUNDAY, -3);
  await insert('casual_prefs', casual.map(([n, show, notify, levels]) => ({
    account_email: byName(n).account_email, show_name: show, notify, levels })),
    'resolution=merge-duplicates,return=minimal');
  await insert('casual_slots', casual.flatMap(([n, , , , slots]) => slots.map(([d, start, minutes, type]) => ({
    player_id: who(n), starts_at: et(addDays(thursday, d), start), minutes, play_type: type }))), 'return=minimal');
}

// ---------- Emails: this week's play-invite and the Casual Play emails ----------
await patch('sessions', `id=eq.${session.id}`, { play_invite_sent_at: null });
const run = await call('/functions/v1/timed-tasks', { body: {} });
console.log(`Ran the timed emails: ${run.sent} saved to the Demo inbox${run.failed.length ? `, ${run.failed.length} failed: ${run.failed.join('; ')}` : ''}.`);
console.log('Demo ready. Sign in as alice.johnson@example.com (member) or dev@example.com (developer) with DEMO_PASSWORD.');
