// End-to-end test of "Review my Game" and the play-invite's review paragraph.
// LOCAL Supabase only. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at, MAIL, SERVICE_KEY } from './lib.mjs';

const hour = 60 * minute;
const runTasks = async () => call('/functions/v1/timed-tasks', { token: SERVICE_KEY, body: {} });
async function inbox() {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.map(m => ({ id: m.ID, to: m.To[0].Address, subject: m.Subject }));
}
const text = async id => (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()).Text;

await clearInbox();
const dev = await bootstrapDeveloper();
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
await setClock(null);
const s = (await rpcOk(dev, 'dev_week')).session;
const m = {};
for (const email of ['alice.johnson@example.com', 'yara.green@example.com', 'carol.lee@example.com']) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  m[email.split('.')[0]] = await acceptInvite(email, PW);
}
const mine = async (token, first) => (await rpcOk(token, 'my_week')).players.find(p => p.first_name === first).id;

// The week: Alice plus 3 others on court 1 (doubles), Yara vs Zack on court 2 (singles).
await setClock(at(s.signups_open_at, hour));
await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 });
await rpcOk(m.alice, 'sign_up', { p_player_id: await mine(m.alice, 'Alice') });
await rpcOk(m.yara, 'sign_up', { p_player_id: await mine(m.yara, 'Yara') });
await rpcOk(m.yara, 'sign_up', { p_player_id: await mine(m.yara, 'Zack') });
await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: false } });
await setClock(at(s.signups_open_at, 2 * hour));
await rpcOk(dev, 'dev_simulate_signups', { p_count: 3 });
await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: true } });
const lineup = (await rpcOk(dev, 'dev_scheduler_data')).lineup;
const id = first => lineup.find(p => p.first_name === first).id;
const others = lineup.filter(p => !['Alice', 'Yara', 'Zack'].includes(p.first_name)).map(p => p.id);
assert.equal(others.length, 3);
await setClock(at(s.signups_close_at, 3 * hour));
await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: [
  { court: 1, players: [id('Alice'), ...others].map((pid, j) => ({ player_id: pid, brings_balls: j === 0 })) },
  { court: 2, players: [{ player_id: id('Yara'), brings_balls: true }, { player_id: id('Zack') }] }
] });
const sunday = (h, mins = 0) => at(s.courts_publish_at, (h + 4) * hour + mins * minute); // Sunday, from Sat 8pm

console.log('Who can review');
await check('until play ends on Sunday, the latest game to review is an earlier Sunday', async () => {
  await setClock(sunday(10, 29));
  const r = await rpcOk(m.alice, 'my_review');
  assert.notEqual(r.session.id, s.id);
});

let ali;
await check('after play ends, a player who was on a court sees their courtmates', async () => {
  await setClock(sunday(11));
  ali = await rpcOk(m.alice, 'my_review');
  assert.equal(ali.session.id, s.id);
  assert.equal(ali.open, true);
  const p = ali.players[0];
  assert.equal(p.played, true);
  assert.equal(p.court, 1);
  assert.deepEqual(p.courtmates.map(c => c.id).sort(), [...others].sort());
  assert.equal(p.review, null);
});

await check('a member who did not play is told so and cannot submit a review', async () => {
  const r = await rpcOk(m.carol, 'my_review');
  assert.equal(r.players[0].played, false);
  await rpcFails(m.carol, 'submit_review', { p_enjoyment: 4, p_player_id: r.players[0].id, p_sets: [{ partner_id: null, my_games: 6, their_games: 0 }] },
    /did not play/);
});

console.log('Submitting');
const alice = id('Alice');
await check('a doubles review: partner chosen per set; opponents worked out; scores stored as player set 1 vs 2', async () => {
  const r = await rpcOk(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [
    { partner_id: others[0], my_games: 6, their_games: 3 },
    { partner_id: others[1], my_games: 4, their_games: 4 }
  ] });
  const sets = r.players[0].review.sets;
  assert.equal(sets.length, 2);
  assert.equal(sets[0].team1[0], 'Alice Johnson', 'the reviewing player is first in player set 1');
  assert.equal(sets[0].team1.length, 2);
  assert.equal(sets[0].team2.length, 2);
  assert.ok(!sets[0].team2.includes('Alice Johnson'));
  assert.deepEqual([sets[0].team1_games, sets[0].team2_games], [6, 3]);
  assert.deepEqual([sets[1].team1_games, sets[1].team2_games], [4, 4]);
  assert.equal(sets[1].partner_id, others[1]);
});

await check('bad reviews are refused and leave the saved review unchanged', async () => {
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [{ partner_id: id('Zack'), my_games: 6, their_games: 2 }] },
    /choose your partner from the players on your court/);
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [{ partner_id: others[0], my_games: 8, their_games: 2 }] },
    /from 0 to 7/);
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [] }, /between 1 and 5/);
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice,
    p_sets: Array(6).fill({ partner_id: others[0], my_games: 1, their_games: 1 }) }, /between 1 and 5/);
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: id('Zack'), p_sets: [{ partner_id: null, my_games: 6, their_games: 2 }] },
    /not linked to your account/);
  assert.equal((await rpcOk(m.alice, 'my_review')).players[0].review.sets.length, 2);
});

await check('a rating from 1 to 5 is required; comments are optional, up to 1000 characters', async () => {
  const set = [{ partner_id: others[0], my_games: 6, their_games: 3 }];
  await rpcFails(m.alice, 'submit_review', { p_player_id: alice, p_sets: set }, /rate how much you enjoyed/);
  await rpcFails(m.alice, 'submit_review', { p_player_id: alice, p_sets: set, p_enjoyment: 6 }, /from 1 to 5/);
  await rpcFails(m.alice, 'submit_review', { p_player_id: alice, p_sets: set, p_enjoyment: 0 }, /from 1 to 5/);
  await rpcFails(m.alice, 'submit_review', { p_player_id: alice, p_sets: set, p_enjoyment: 3, p_comments: 'x'.repeat(1001) },
    /at most 1000 characters/);
  const r = await rpcOk(m.alice, 'submit_review', { p_player_id: alice, p_sets: set, p_enjoyment: 5,
    p_comments: '  Great rallies, but court 1 needed squeegeeing.  ' });
  assert.equal(r.players[0].review.enjoyment, 5);
  assert.equal(r.players[0].review.comments, 'Great rallies, but court 1 needed squeegeeing.');
  const blank = await rpcOk(m.alice, 'submit_review', { p_player_id: alice, p_sets: set, p_enjoyment: 2, p_comments: '   ' });
  assert.equal(blank.players[0].review.comments, null, 'blank comments are stored as none');
  const row = await call(`/rest/v1/game_reviews?select=enjoyment,comments&player_id=eq.${alice}&session_id=eq.${s.id}`, { token: dev, method: 'GET' });
  assert.deepEqual(row.data, [{ enjoyment: 2, comments: null }], 'developers can see ratings');
});

await check('submitting again replaces the earlier review', async () => {
  const r = await rpcOk(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [{ partner_id: others[2], my_games: 2, their_games: 6 }] });
  assert.equal(r.players[0].review.sets.length, 1);
  assert.deepEqual([r.players[0].review.sets[0].team1_games, r.players[0].review.sets[0].team2_games], [2, 6]);
});

await check('singles: the player is automatically player set 1 and the opponent player set 2', async () => {
  const r = await rpcOk(m.yara, 'submit_review', { p_enjoyment: 4, p_player_id: id('Yara'), p_sets: [
    { partner_id: null, my_games: 6, their_games: 4 }, { partner_id: null, my_games: 3, their_games: 6 }] });
  const yara = r.players.find(p => p.name === 'Yara Green');
  assert.deepEqual(yara.courtmates.map(c => c.name), ['Zack Baker']);
  assert.deepEqual(yara.review.sets[0].team1, ['Yara Green']);
  assert.deepEqual(yara.review.sets[0].team2, ['Zack Baker']);
});

await check('a family account reviews separately for each linked player who played', async () => {
  const r = await rpcOk(m.yara, 'submit_review', { p_enjoyment: 4, p_player_id: id('Zack'), p_sets: [{ partner_id: null, my_games: 4, their_games: 6 }] });
  const zack = r.players.find(p => p.name === 'Zack Baker');
  assert.deepEqual(zack.review.sets[0].team1, ['Zack Baker']);
  assert.deepEqual(zack.review.sets[0].team2, ['Yara Green']);
  assert.ok(r.players.find(p => p.name === 'Yara Green').review, 'Yara keeps her own review');
});

console.log('Privacy');
await check("members see only their own players' reviews; developers see all", async () => {
  const mineOnly = await call('/rest/v1/game_reviews?select=player_id', { token: m.alice, method: 'GET' });
  assert.deepEqual(mineOnly.data.map(r => r.player_id), [alice]);
  const sets = await call('/rest/v1/review_sets?select=review_id', { token: m.alice, method: 'GET' });
  assert.equal(sets.data.length, 1);
  const all = await call(`/rest/v1/game_reviews?select=player_id&session_id=eq.${s.id}`, { token: dev, method: 'GET' });
  assert.equal(all.data.length, 3);
  const write = await call('/rest/v1/game_reviews', { token: m.alice, body: { session_id: s.id, player_id: alice, court: 1, submitted_by: 'x', submitted_at: '2026-01-01' } });
  assert.ok(write.status >= 400);
});

console.log('Play-invite');
await check('the next play-invite asks only members who played to review their game', async () => {
  await clearInbox();
  const nextMonday9 = at(s.signups_open_at, 7 * 24 * hour);
  await setClock(nextMonday9);
  assert.deepEqual((await runTasks()).data.tasks, ['play_invite']);
  const mail = await inbox();
  const body = async to => text(mail.find(x => x.to === to).id);
  const aliceText = await body('alice.johnson@example.com');
  assert.match(aliceText, /Thank you for playing yesterday! Please take a minute to review your game/);
  assert.match(aliceText, /review\.html/);
  assert.match(await body('yara.green@example.com'), /Thank you for playing yesterday/);
  assert.doesNotMatch(await body('carol.lee@example.com'), /review your game/);
});

await check('reviews close the next Sunday at 9am', async () => {
  await setClock(at(sunday(9), 7 * 24 * hour));
  const r = await rpcOk(m.alice, 'my_review');
  assert.equal(r.open, false);
  await rpcFails(m.alice, 'submit_review', { p_enjoyment: 4, p_player_id: alice, p_sets: [{ partner_id: others[0], my_games: 6, their_games: 1 }] },
    /closed/);
});

await setClock(null);
summary();
