#!/usr/bin/env node
// Adds made-up My Rating data to a DEMO copy of the app: two leagues, ten
// weeks of games (Alice Johnson plays one most weeks and improves), one game
// waiting for Alice's answer, one score going back and forth and one disputed
// 3 times that needs a developer. Dates are counted back from the demo clock.
// It does nothing if games were already reported.
//
// scripts/demo-seed.mjs runs it. To add it to a demo that was seeded before
// My Rating existed:
//   SUPABASE_URL=... SERVICE_ROLE_KEY=... node scripts/demo-ratings.mjs
//
// It refuses to run if the database holds any email address not ending in
// @example.com.

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SERVICE_ROLE_KEY;

async function call(path, { method = 'POST', body, prefer } = {}) {
  const res = await fetch(URL_ + path, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
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

// [days before the demo clock, 'casual' or a league, reporter's side, other side, sets (reporter's side first)]
const FALL = 'Fall Doubles League 2026', SUMMER = 'Summer Singles League 2026';
const GAMES = [
  [120, SUMMER, ['Olivia Clark'], ['Paul Rodriguez'], [[6, 4], [6, 4]]],
  [113, SUMMER, ['Wendy Wright'], ['Xavier Scott'], [[3, 6], [6, 4], [6, 3]]],
  [106, SUMMER, ['Olivia Clark'], ['Wendy Wright'], [[6, 2], [6, 3]]],
  [99, SUMMER, ['Xavier Scott'], ['Paul Rodriguez'], [[4, 6], [5, 7]]],
  [70, 'casual', ['Alice Johnson'], ['Emma Brown'], [[6, 2], [6, 3]]],
  [63, FALL, ['Alice Johnson', 'Bob Smith'], ['Grace Wilson', 'Henry Moore'], [[6, 4], [6, 3]]],
  [63, FALL, ['Mia Garcia', 'Noah Robinson'], ['Carol Lee', 'David Kim'], [[4, 6], [3, 6]]],
  [56, FALL, ['Alice Johnson', 'Mia Garcia'], ['Carol Lee', 'David Kim'], [[6, 4], [6, 7]]],
  [56, FALL, ['Bob Smith', 'Grace Wilson'], ['Henry Moore', 'Noah Robinson'], [[6, 4], [6, 4]]],
  [49, 'casual', ['Alice Johnson'], ['Mia Garcia'], [[6, 3], [6, 4]]],
  [49, FALL, ['Carol Lee', 'David Kim'], ['Bob Smith', 'Henry Moore'], [[6, 3], [6, 4]]],
  [42, FALL, ['Alice Johnson', 'Bob Smith'], ['Mia Garcia', 'Noah Robinson'], [[6, 2], [6, 4]]],
  [42, FALL, ['Grace Wilson', 'Henry Moore'], ['Carol Lee', 'David Kim'], [[2, 6], [4, 6]]],
  [35, FALL, ['Alice Johnson', 'Henry Moore'], ['Carol Lee', 'David Kim'], [[7, 5], [6, 4]]],
  [35, FALL, ['Bob Smith', 'Mia Garcia'], ['Grace Wilson', 'Noah Robinson'], [[6, 3], [4, 6]]],
  [28, 'casual', ['Alice Johnson', 'Grace Wilson'], ['Ivy Taylor', 'Jack Anderson'], [[6, 4], [6, 4]]],
  [28, FALL, ['Mia Garcia', 'Henry Moore'], ['Bob Smith', 'David Kim'], [[5, 7], [6, 3]]],
  [21, FALL, ['Alice Johnson', 'Noah Robinson'], ['Grace Wilson', 'Bob Smith'], [[6, 3], [6, 2]]],
  [14, FALL, ['Alice Johnson', 'Mia Garcia'], ['Henry Moore', 'Carol Lee'], [[6, 4], [6, 4]]],
  [7, 'casual', ['Alice Johnson'], ['Carol Lee'], [[6, 4], [3, 6], [6, 4]]],
];

const etDate = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (ymd, hour) => new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00-04:00`).toISOString();
const flip = sets => sets.map(([a, b]) => [b, a]);
const teamsKey = (a, b) => {
  const [x, y] = [[...a].sort((p, q) => p - q), [...b].sort((p, q) => p - q)];
  return x[0] < y[0] ? `${x.join(',')}|${y.join(',')}` : `${y.join(',')}|${x.join(',')}`;
};

export async function seedRatings() {
  if (!URL_ || !SERVICE) throw new Error('Set SUPABASE_URL and SERVICE_ROLE_KEY.');
  const accounts = await table('accounts', '?select=email');
  if (accounts.some(a => !a.email.endsWith('@example.com'))) {
    throw new Error('Refusing: this database has accounts that are not made-up @example.com addresses.');
  }
  if ((await table('rating_results', '?select=id&source=eq.reported&limit=1')).length) {
    console.log('My Rating demo data is already there.');
    return;
  }
  const [settings] = await table('settings', '?select=test_mode,test_clock');
  const clock = settings.test_mode && settings.test_clock ? settings.test_clock : new Date().toISOString();
  const today = etDate(clock);
  const players = await table('players', '?select=id,first_name,last_name&active=eq.true');
  const id = name => {
    const p = players.find(x => `${x.first_name} ${x.last_name}` === name);
    if (!p) throw new Error(`No player called ${name}`);
    return p.id;
  };

  const leagues = await insert('rating_leagues', [{ name: FALL, active: true }, { name: SUMMER, active: false }]);
  const leagueId = name => leagues.find(l => l.name === name).id;

  // Adds one game. proposals: [[proposer name, sets from the proposer's side, reason], ...] after the first report;
  // answered: names who confirmed the current score.
  async function game(daysBack, kind, mine, theirs, sets, { status = 'confirmed', proposals = [], answered = null } = {}) {
    const day = addDays(today, -daysBack);
    const a = mine.map(id), b = theirs.map(id);
    const steps = [[mine[0], sets, null], ...proposals];
    const [lastBy, lastSets] = steps[steps.length - 1];
    const lastMine = a.includes(id(lastBy));
    const reportedAt = status === 'confirmed' ? at(addDays(day, 1), 18) : at(addDays(today, -1), 9 + steps.length);
    const [r] = await insert('rating_results', {
      played_on: day, source: 'reported', kind: kind === 'casual' ? 'casual' : 'league',
      league_id: kind === 'casual' ? null : leagueId(kind), teams_key: teamsKey(a, b),
      team1: lastMine ? a : b, team2: lastMine ? b : a, sets: lastSets,
      reported_by: id(lastBy), reported_at: reportedAt, status,
    });
    await insert('rating_proposals', steps.map(([by, s, reason], i) => {
      const byMine = a.includes(id(by));
      return { result_id: r.id, proposed_by: id(by), team1: byMine ? a : b, team2: byMine ? b : a, sets: s,
               reason, proposed_at: i === steps.length - 1 ? reportedAt : at(addDays(today, -2), 9 + i) };
    }), 'return=minimal');
    const confirmers = answered ? answered.map(id) : [...a, ...b].filter(x => x !== id(lastBy));
    if (confirmers.length) {
      await insert('rating_confirmations', confirmers.map(p => ({
        result_id: r.id, player_id: p, answer: 'confirmed',
        answered_at: status === 'confirmed' ? at(addDays(day, 2), 10) : at(today, 8) })), 'return=minimal');
    }
  }

  for (const [daysBack, kind, mine, theirs, sets] of GAMES) await game(daysBack, kind, mine, theirs, sets);

  // Waiting for Alice: Bob reported it; David and Noah confirmed.
  await game(3, FALL, ['Bob Smith', 'Alice Johnson'], ['David Kim', 'Noah Robinson'], [[6, 3], [6, 4]],
             { status: 'pending', answered: ['David Kim', 'Noah Robinson'] });
  // Going back and forth: Jack says his side won the second set.
  await game(5, 'casual', ['Carol Lee', 'Ivy Taylor'], ['Jack Anderson', 'Quinn Lewis'], [[6, 4], [6, 3]],
             { status: 'pending', answered: [],
               proposals: [['Jack Anderson', [[4, 6], [6, 3]], 'We won the second set 6-3, not 3-6.']] });
  // Disputed 3 times: waiting for a developer to settle it.
  await game(10, FALL, ['Grace Wilson', 'Henry Moore'], ['Mia Garcia', 'Noah Robinson'], [[6, 4], [6, 4]],
             { status: 'developers', answered: [],
               proposals: [['Noah Robinson', [[4, 6], [6, 4]], 'We took the first set.'],
                           ['Grace Wilson', [[6, 4], [6, 4]], 'Checked with Henry: we won both sets.'],
                           ['Noah Robinson', [[4, 6], [6, 3]], 'Mia remembers it the same way I do.']] });
  console.log(`Added ${GAMES.length + 3} My Rating games and 2 leagues.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedRatings().catch(err => { console.error(err.message); process.exit(1); });
}
