// End-to-end test of My Rating: reported matches, confirming and disputing,
// the 7-day automatic count, Sunday Doubles Game Reviews, privacy and the maths.
// LOCAL Supabase only. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at } from './lib.mjs';

const hour = 60 * minute;
const day = 24 * hour;
const close = (a, b, msg) => assert.ok(Math.abs(Number(a) - Number(b)) < 1e-3, `${msg}: ${a} vs ${b}`);
// The same maths as the database (see app/rating-how.html).
const expected = gap => 1 / (1 + 2 ** (-2 * gap));
const step = n => 0.8 / (n + 5) ** 0.4;
const weight = g => Math.min(1, g / 20);

await clearInbox();
const dev = await bootstrapDeveloper();
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
await setClock(null);
const s = (await rpcOk(dev, 'dev_week')).session;
const m = {};
for (const email of ['alice.johnson@example.com', 'bob.smith@example.com', 'carol.lee@example.com',
                     'david.kim@example.com', 'yara.green@example.com', 'zack.baker@example.com']) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  m[email.split('.')[0]] = await acceptInvite(email, PW);
}
const players = await rpcOk(dev, 'rating_players');      // everyone but the developer
const pid = name => players.find(p => p.name === name).id;
const league = (await rpcOk(m.alice, 'rating_leagues'))[0];   // from the test data
async function acceptInviteFor(email) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  return acceptInvite(email, PW);
}

console.log('Starting point');
await check('a new player starts at their level in the Members table, with nothing counted', async () => {
  const r = await rpcOk(m.alice, 'my_rating');
  assert.equal(r.player.level, '3.5');
  close(r.rating, 3.5, 'rating');
  close(r.official, 3.5, 'official');
  assert.equal(r.played, 0);
  assert.deepEqual(r.history, []);
});

await check('players never read the results, answers or leagues tables directly', async () => {
  for (const t of ['rating_results', 'rating_confirmations', 'rating_leagues']) {
    const r = await call(`/rest/v1/${t}?select=*`, { token: m.alice, method: 'GET' });
    assert.ok(r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0), `${t}: ${JSON.stringify(r.data)}`);
  }
});

console.log('Reporting a game');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const report = { p_played_on: today, p_kind: 'league', p_league_id: league.id, p_partner: pid('Bob Smith'),
                 p_opponents: [pid('Carol Lee'), pid('David Kim')], p_sets: [[6, 4], [3, 6]] };

await check('reports are checked: type, league, opponents, sets, dates', async () => {
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_kind: null }, /casual play or a league/);
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_league_id: null }, /Choose the league/);
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_opponents: [pid('Carol Lee')] }, /Choose 2 opponents/);
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_opponents: [pid('Carol Lee'), pid('Bob Smith')] }, /only be in the game once/);
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_sets: [[8, 6]] }, /0 to 7/);
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_played_on: '2020-01-05' }, /last 30 days/);
});

let resultId;
await check('a reported league game waits for every other player; the reporter sees who', async () => {
  const r = await rpcOk(m.alice, 'report_rating_game', report);
  assert.equal(r.played, 0);
  assert.equal(r.waiting.length, 1);
  resultId = r.waiting[0].id;
  assert.equal(r.waiting[0].league, league.name);
  assert.deepEqual(r.waiting[0].answers.map(a => a.answer), [null, null, null]);
  await rpcFails(m.alice, 'report_rating_game', report, /already been reported/);
  await rpcFails(m.alice, 'answer_rating_result', { p_result_id: resultId, p_confirm: true }, /not waiting for your answer/);
});

await check('partner and opponents are all asked, each from their own side', async () => {
  const c = await rpcOk(m.carol, 'my_rating');
  assert.equal(c.to_confirm.length, 1);
  assert.deepEqual(c.to_confirm[0].sets, [[4, 6], [6, 3]]);
  assert.equal(c.to_confirm[0].partner, 'David Kim');
  const b = await rpcOk(m.bob, 'my_rating');
  assert.equal(b.to_confirm.length, 1);
  assert.deepEqual(b.to_confirm[0].sets, [[6, 4], [3, 6]]);
});

await check('it only counts once everyone has confirmed', async () => {
  await rpcOk(m.carol, 'answer_rating_result', { p_result_id: resultId, p_confirm: true });
  await rpcFails(m.carol, 'answer_rating_result', { p_result_id: resultId, p_confirm: true }, /already answered/);
  await rpcOk(m.david, 'answer_rating_result', { p_result_id: resultId, p_confirm: true });
  let a = await rpcOk(m.alice, 'my_rating');
  assert.equal(a.played, 0);
  assert.deepEqual(a.waiting[0].answers.filter(x => !x.answer).map(x => x.name), ['Bob Smith']);
  await rpcOk(m.bob, 'answer_rating_result', { p_result_id: resultId, p_confirm: true });
  a = await rpcOk(m.alice, 'my_rating');
  assert.equal(a.played, 1);
});

await check('everyone moves by result minus expectation, each with their own step', async () => {
  const a = await rpcOk(m.alice, 'my_rating');
  const change = step(0) * weight(19) * (9 / 19 - expected(-0.5));
  close(a.history[0].expected, expected(-0.5), 'expected');
  close(a.history[0].change, change, 'change');
  close(a.rating, 3.5 + change, 'alice rating');
  const c = await rpcOk(m.carol, 'my_rating');
  close(c.rating, 4.0 - change, 'carol rating');
  assert.equal(c.history[0].partner, 'David Kim');
});

await check('a player sees only their own rating, never anyone else\'s', async () => {
  const a = await rpcOk(m.alice, 'my_rating');
  const text = JSON.stringify(a);
  const carolRating = (await rpcOk(m.carol, 'my_rating')).rating;
  assert.ok(!text.includes(String(carolRating).slice(0, 8)), 'Carol\'s rating leaked into Alice\'s page');
});

console.log('Disputes: scores go back and forth');
const yesterday = at(today + 'T12:00:00Z', -day).slice(0, 10);
await check('disputing means giving the right score, which goes back to the reporter', async () => {
  const r = await rpcOk(m.carol, 'report_rating_game', { p_played_on: today, p_kind: 'casual', p_league_id: null,
    p_partner: null, p_opponents: [pid('Alice Johnson')], p_sets: [[6, 0], [6, 0]] });
  const id = r.waiting[0].id;
  await rpcFails(m.alice, 'answer_rating_result', { p_result_id: id, p_confirm: false }, /score you think is right/);
  await rpcFails(m.alice, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[0, 6], [0, 6]] }, /same score/);
  await rpcOk(m.alice, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_reason: 'It was 6-4, 6-4',
    p_sets: [[4, 6], [4, 6]] });
  let a = await rpcOk(m.alice, 'my_rating');
  assert.equal(a.to_confirm.length, 0);
  assert.equal(a.played, 1);
  const mine = a.waiting.find(w => w.id === id);
  assert.equal(mine.reported_by_me, true);
  assert.deepEqual(mine.sets, [[4, 6], [4, 6]]);
  // Back to Carol, from her side, with both scores so far.
  let c = await rpcOk(m.carol, 'my_rating');
  const back = c.to_confirm.find(x => x.id === id);
  assert.deepEqual(back.sets, [[6, 4], [6, 4]]);
  assert.deepEqual(back.history.map(h => [h.by, h.sets, h.reason]),
    [['Carol Lee', [[6, 0], [6, 0]], null], ['Alice Johnson', [[6, 4], [6, 4]], 'It was 6-4, 6-4']]);
  const list = await rpcOk(dev, 'dev_rating_disputes');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].waiting_for, ['Carol Lee']);
  await rpcFails(m.alice, 'dev_rating_disputes', {}, /developer/i);
  // Carol disputes again; Alice gets it back, and confirms: it counts.
  await rpcOk(m.carol, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[6, 3], [6, 4]] });
  a = await rpcOk(m.alice, 'my_rating');
  assert.deepEqual(a.to_confirm[0].sets, [[3, 6], [4, 6]]);
  assert.equal(a.to_confirm[0].history.length, 3);
  await rpcOk(m.alice, 'answer_rating_result', { p_result_id: id, p_confirm: true });
  a = await rpcOk(m.alice, 'my_rating');
  assert.equal(a.played, 2);
  assert.deepEqual(a.history[1].sets, [[3, 6], [4, 6]]);
  assert.equal((await rpcOk(dev, 'dev_rating_disputes')).length, 0);
});

await check('in doubles, a partner\'s dispute goes to everyone else, the reporter included', async () => {
  const r = await rpcOk(m.alice, 'report_rating_game', { p_played_on: yesterday, p_kind: 'casual', p_league_id: null,
    p_partner: pid('Bob Smith'), p_opponents: [pid('Carol Lee'), pid('David Kim')], p_sets: [[6, 4]] });
  const id = r.waiting[0].id;
  await rpcOk(m.carol, 'answer_rating_result', { p_result_id: id, p_confirm: true });
  await rpcOk(m.bob, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[6, 3]] });
  for (const t of [m.alice, m.carol, m.david]) {
    assert.ok((await rpcOk(t, 'my_rating')).to_confirm.some(x => x.id === id));
  }
  assert.ok(!(await rpcOk(m.bob, 'my_rating')).to_confirm.some(x => x.id === id));
  // They can't agree: a developer settles it by not counting it.
  await rpcOk(dev, 'dev_resolve_rating', { p_result_id: id, p_action: 'discard', p_sets: null });
  assert.ok(!(await rpcOk(m.alice, 'my_rating')).to_confirm.some(x => x.id === id));
});

await check('a developer can settle a disputed game with a corrected score', async () => {
  const r = await rpcOk(m.david, 'report_rating_game', { p_played_on: yesterday, p_kind: 'casual', p_league_id: null,
    p_partner: null, p_opponents: [pid('Zack Baker')], p_sets: [[6, 2]] });
  const id = r.waiting[0].id;
  await rpcFails(dev, 'dev_resolve_rating', { p_result_id: id, p_action: 'count', p_sets: null }, /not disputed/);
  await rpcOk(m.zack, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[3, 6]] });
  const d = (await rpcOk(dev, 'dev_rating_disputes')).find(x => x.id === id);
  assert.deepEqual(d.team1, ['Zack Baker']);                     // current score's side first
  await rpcOk(dev, 'dev_resolve_rating', { p_result_id: id, p_action: 'count', p_sets: [[4, 6]] });
  const z = await rpcOk(m.zack, 'my_rating');
  assert.equal(z.played, 1);
  assert.deepEqual(z.history[0].sets, [[4, 6]]);
});

await check('the 3rd dispute sends the game to the developers; players are no longer asked', async () => {
  const twoDaysAgo = at(today + 'T12:00:00Z', -2 * day).slice(0, 10);
  const r = await rpcOk(m.yara, 'report_rating_game', { p_played_on: twoDaysAgo, p_kind: 'casual', p_league_id: null,
    p_partner: null, p_opponents: [pid('Zack Baker')], p_sets: [[6, 1]] });
  const id = r.waiting[0].id;
  await rpcOk(m.zack, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[3, 6]] });   // 1
  await rpcOk(m.yara, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[6, 2]] });   // 2
  const z = (await rpcOk(m.zack, 'my_rating')).to_confirm.find(x => x.id === id);
  assert.equal(z.disputes, 2);
  await rpcOk(m.zack, 'answer_rating_result', { p_result_id: id, p_confirm: false, p_sets: [[4, 6]] });   // 3
  const y = await rpcOk(m.yara, 'my_rating');
  assert.ok(!y.to_confirm.some(x => x.id === id));
  assert.equal(y.waiting.find(x => x.id === id).status, 'developers');
  await rpcFails(m.yara, 'answer_rating_result', { p_result_id: id, p_confirm: true }, /disputed 3 times/);
  const list = await rpcOk(dev, 'dev_rating_disputes');
  assert.equal(list[0].id, id);                                   // needs settling: listed first
  assert.equal(list[0].status, 'developers');
  assert.equal(list[0].history.length, 4);
  await rpcOk(dev, 'dev_resolve_rating', { p_result_id: id, p_action: 'count', p_sets: [[5, 6]] });   // Zack's side first
  assert.equal((await rpcOk(m.yara, 'my_rating')).history.find(h => h.id === id).sets.toString(), [[6, 5]].toString());
});

await check('the reporter can withdraw a game that doesn\'t count yet', async () => {
  const r = await rpcOk(m.david, 'report_rating_game', { p_played_on: today, p_kind: 'casual', p_league_id: null,
    p_partner: null, p_opponents: [pid('Zack Baker')], p_sets: [[6, 2]] });
  await rpcOk(m.david, 'withdraw_rating_result', { p_result_id: r.waiting[0].id });
  assert.equal((await rpcOk(m.zack, 'my_rating')).to_confirm.length, 0);
});

await check('a reported game nobody answers still doesn\'t count after 7 days', async () => {
  await rpcOk(m.yara, 'report_rating_game', { p_played_on: today, p_kind: 'casual', p_league_id: null,
    p_partner: null, p_opponents: [pid('Zack Baker')], p_sets: [[6, 3]] });
  await setClock(new Date(Date.now() + 8 * day).toISOString());
  const z = await rpcOk(m.zack, 'my_rating');
  assert.equal(z.to_confirm.length, 1);
  const before = z.played;
  await rpcOk(m.zack, 'answer_rating_result', { p_result_id: z.to_confirm[0].id, p_confirm: true });
  assert.equal((await rpcOk(m.zack, 'my_rating')).played, before + 1);
  await setClock(null);
});

console.log('Developers: games and leagues');
await check('developers see every game with each player\'s answer, but no ratings', async () => {
  const g = await rpcOk(dev, 'dev_rating_games');
  const lg = g.games.filter(x => x.league_id === league.id);
  assert.equal(lg.length, 1);
  assert.equal(lg[0].counted, true);
  assert.deepEqual(lg[0].answers.map(a => a.answer), ['confirmed', 'confirmed', 'confirmed']);
  assert.ok(!/rating_after|"rating"/.test(JSON.stringify(g)));
  await rpcFails(m.alice, 'dev_rating_games', {}, /developer/i);
});

await check('developers add, rename and finish leagues; finished leagues take no new games', async () => {
  let g = await rpcOk(dev, 'dev_save_league', { p_id: null, p_name: 'Spring Singles', p_active: true });
  const spring = g.leagues.find(l => l.name === 'Spring Singles');
  await rpcFails(dev, 'dev_save_league', { p_id: null, p_name: ' spring singles ', p_active: true }, /already a league/);
  g = await rpcOk(dev, 'dev_save_league', { p_id: spring.id, p_name: 'Spring Singles 2027', p_active: false });
  assert.equal(g.leagues.find(l => l.id === spring.id).active, false);
  assert.ok(!(await rpcOk(m.alice, 'rating_leagues')).some(l => l.id === spring.id));
  await rpcFails(m.alice, 'report_rating_game', { ...report, p_league_id: spring.id, p_partner: null,
    p_opponents: [pid('Yara Green')] }, /Choose the league/);
  await rpcFails(m.alice, 'dev_save_league', { p_id: null, p_name: 'Mine', p_active: true }, /developer/i);
});

console.log('Dynamic Level in the Members table');
const member = async name => (await rpcOk(dev, 'dev_members')).find(x => `${x.first_name} ${x.last_name}` === name);
const setLevel = (x, level) => rpcOk(dev, 'dev_save_member', { p_player_id: x.player_id, p_first_name: x.first_name,
  p_last_name: x.last_name, p_email: x.email, p_level: level, p_sex: x.sex, p_active: x.membership === 'active',
  p_sunday_doubles: x.sunday_doubles, p_developer: x.is_developer });
await check('the Members table shows each player\'s official level from My Rating as Dynamic Level', async () => {
  const a = await member('Alice Johnson');
  assert.equal(a.level, '3.5');
  assert.equal(a.dynamic_level, Number((await rpcOk(m.alice, 'my_rating')).official).toFixed(1));
  let w = await member('Wendy Wright');                         // no results: a copy of her Level
  assert.equal(w.dynamic_level, w.level);
  await setLevel(w, '');
  assert.equal((await member('Wendy Wright')).dynamic_level, null);
  await setLevel(w, '4.5');
  assert.equal((await member('Wendy Wright')).dynamic_level, '4.5');
});

await check('Dynamic Level follows results: a player who keeps beating stronger players moves up', async () => {
  // Bob (3.5) beats Ivy (4.0) in singles, 6-0 6-0, five times: everyone confirms.
  const ivy = await acceptInviteFor('ivy.taylor@example.com');
  for (let i = 0; i < 5; i++) {
    const r = await rpcOk(m.bob, 'report_rating_game', { p_played_on: at(today + 'T12:00:00Z', -i * day).slice(0, 10),
      p_kind: 'casual', p_league_id: null, p_partner: null, p_opponents: [pid('Ivy Taylor')], p_sets: [[6, 0], [6, 0]] });
    await rpcOk(ivy, 'answer_rating_result', { p_result_id: r.waiting[0].id, p_confirm: true });
  }
  const b = await rpcOk(m.bob, 'my_rating');
  assert.ok(Number(b.rating) >= 3.85, `Bob's rating ${b.rating}`);
  assert.equal((await member('Bob Smith')).dynamic_level, '4.0');
  assert.equal((await member('Bob Smith')).level, '3.5');         // Level itself is left alone
});

console.log('The level and its 0.1 buffer');
await check('What if: the level is the nearest 0.5, moving only 0.1 past a halfway point', async () => {
  const p = (r, mine, theirs) => rpcOk(m.alice, 'rating_preview', { p_rating: r, p_official: 3.5, p_played: 0,
    p_partner: null, p_opponent1: r, p_opponent2: null, p_my_games: mine, p_their_games: theirs });
  const dip = await p(3.3, 0, 6);                   // 3.3 -> about 3.24: past halfway (3.25), not 0.1 past
  assert.ok(dip.rating_after < 3.25 && dip.rating_after >= 3.15, JSON.stringify(dip));
  close(dip.official_after, 3.5, 'stays 3.5');
  const drop = await p(3.3, 0, 20);                 // a big loss: below 3.15, so a 3.0
  assert.ok(drop.rating_after < 3.15);
  close(drop.official_after, 3.0, 'drops to 3.0');
  const near = await p(3.75, 10, 9);                // about 3.76: past halfway (3.75), not 0.1 past
  assert.ok(near.rating_after >= 3.75 && near.rating_after < 3.85, JSON.stringify(near));
  close(near.official_after, 3.5, 'still 3.5');
  const up = await p(3.7, 20, 0);                   // about 3.91: 3.9 is a 4.0
  assert.ok(up.rating_after >= 3.85);
  close(up.official_after, 4.0, 'up to 4.0 from 3.85');
});

console.log('Sunday Doubles Game Reviews');
await check('the Scheduler uses the Dynamic Level; a review reports the result; a matching one confirms it; a different one disputes it', async () => {
  const mine = async (token, first) => (await rpcOk(token, 'my_week')).players.find(p => p.first_name === first).id;
  await setClock(at(s.signups_open_at, hour));
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 1 });
  const y = await mine(m.yara, 'Yara'), z = await mine(m.zack, 'Zack');
  await rpcOk(m.yara, 'sign_up', { p_player_id: y });
  await rpcOk(m.zack, 'sign_up', { p_player_id: z });
  // The Scheduler and This week use the Dynamic Level: Bob (Level 3.5) shows as 4.0.
  const b = await mine(m.bob, 'Bob');
  await rpcOk(m.bob, 'sign_up', { p_player_id: b });
  assert.equal((await rpcOk(dev, 'dev_scheduler_data')).lineup.find(p => p.first_name === 'Bob').level, '4.0');
  assert.equal((await rpcOk(dev, 'dev_week')).lineup.find(p => p.name === 'Bob Smith').level, '4.0');
  await rpcOk(m.bob, 'cancel_signup', { p_player_id: b });
  await setClock(at(s.signups_close_at, 3 * hour));
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: [
    { court: 1, players: [{ player_id: y, brings_balls: true }, { player_id: z }] }] });
  await setClock(at(s.courts_publish_at, 15 * hour));      // Sunday 11am
  const before = (await rpcOk(m.zack, 'my_rating')).played;

  await rpcOk(m.yara, 'submit_review', { p_player_id: y, p_enjoyment: 5, p_sets: [
    { partner_id: null, my_games: 6, their_games: 3 }, { partner_id: null, my_games: 6, their_games: 2 }] });
  // (Moving the clock back to Sunday makes Yara's earlier match wait again, so look at Sunday results only.)
  const sundays = r => r.to_confirm.filter(x => x.source === 'sunday');
  let zr = await rpcOk(m.zack, 'my_rating');
  assert.equal(sundays(zr).length, 1);

  await rpcOk(m.zack, 'submit_review', { p_player_id: z, p_enjoyment: 4, p_sets: [
    { partner_id: null, my_games: 3, their_games: 6 }, { partner_id: null, my_games: 2, their_games: 6 }] });
  zr = await rpcOk(m.zack, 'my_rating');
  assert.equal(sundays(zr).length, 0);
  assert.equal(zr.played, before + 1);
  assert.equal(zr.history.at(-1).auto_note, 'matching Game Review');

  // Yara changes her score: it needs confirming again. Zack's review still says otherwise.
  await rpcOk(m.yara, 'submit_review', { p_player_id: y, p_enjoyment: 5, p_sets: [
    { partner_id: null, my_games: 6, their_games: 3 }, { partner_id: null, my_games: 6, their_games: 1 }] });
  assert.equal(sundays(await rpcOk(m.zack, 'my_rating')).length, 1);
  await rpcOk(m.zack, 'submit_review', { p_player_id: z, p_enjoyment: 4, p_sets: [
    { partner_id: null, my_games: 3, their_games: 6 }, { partner_id: null, my_games: 2, their_games: 6 }] });
  // Zack's review proposes his score: it goes back to Yara.
  const back = sundays(await rpcOk(m.yara, 'my_rating'));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].sets, [[6, 3], [6, 2]]);
  assert.equal(back[0].history.at(-1).by, 'Zack Baker');
  assert.ok((await rpcOk(dev, 'dev_rating_disputes')).some(d => d.source === 'sunday'));
});

console.log('Test mode');
await check('a developer can add and remove made-up results for themselves', async () => {
  await setClock(null);
  assert.equal(await rpcOk(dev, 'dev_simulate_rating_results', { p_count: 8 }), 8);
  const r = await rpcOk(dev, 'my_rating');
  assert.equal(r.played, 6);
  assert.equal(r.to_confirm.length, 2);
  // Everyone else already confirmed the waiting ones: the developer's answer makes them count.
  await rpcOk(dev, 'answer_rating_result', { p_result_id: r.to_confirm[0].id, p_confirm: true });
  assert.equal((await rpcOk(dev, 'my_rating')).played, 7);
  await rpcFails(m.alice, 'dev_simulate_rating_results', { p_count: 3 }, /developer/i);
  assert.ok(await rpcOk(dev, 'dev_clear_simulated_ratings') >= 8);
  assert.equal((await rpcOk(dev, 'my_rating')).played, 0);
});

summary();
