// End-to-end test of Developers > Sunday Program's Past Play and Player
// Reviews tabs. LOCAL Supabase only. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, SERVICE_KEY } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
await rpcOk(dev, 'dev_set_test_clock', { p_clock: '2026-10-07T16:00:00Z' });  // a Wednesday
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);

const pastPlay = season => rpcOk(dev, 'dev_past_play', season ? { p_season: season } : {});
const players = (await pastPlay()).players;
const id = name => players.find(p => p.name === name).id;
const cell = (pp, date, name) => pp.cells.find(c => c.play_date === date && c.player_id === id(name));

console.log('Past Play');
await check('shows the season\'s past Sundays from the fictitious play history', async () => {
  const pp = await pastPlay();
  assert.equal(pp.season.name, '2026');
  assert.deepEqual(pp.dates.map(d => d.play_date), ['2026-09-06', '2026-09-13']);
  assert.equal(pp.cells.length, 40);
  assert.deepEqual(cell(pp, '2026-09-06', 'Alice Johnson'), { play_date: '2026-09-06', player_id: id('Alice Johnson'), court: 1, brings_balls: true });
  assert.ok(pp.players.some(p => p.name === 'Zack Baker'), 'players who never played are listed too');
});

await check('only developers can see or change it', async () => {
  await rpcFails(alice, 'dev_past_play', {}, /Developers only/);
  await rpcFails(alice, 'dev_save_past_play', { p_play_date: '2026-09-06', p_player_id: id('Alice Johnson'), p_court: 2 }, /Developers only/);
  await rpcFails(alice, 'dev_add_past_date', { p_play_date: '2026-09-20' }, /Developers only/);
});

await check('a developer can change, add and clear cells', async () => {
  await rpcOk(dev, 'dev_save_past_play', { p_play_date: '2026-09-13', p_player_id: id('Wendy Wright'), p_court: 5, p_brings_balls: true });
  await rpcOk(dev, 'dev_save_past_play', { p_play_date: '2026-09-13', p_player_id: id('Uma Young'), p_court: 5, p_brings_balls: false });
  await rpcOk(dev, 'dev_save_past_play', { p_play_date: '2026-09-06', p_player_id: id('Frank Davis'), p_court: null });
  const pp = await pastPlay();
  assert.equal(cell(pp, '2026-09-13', 'Wendy Wright').brings_balls, true);
  assert.equal(cell(pp, '2026-09-13', 'Uma Young').brings_balls, false);
  assert.equal(cell(pp, '2026-09-06', 'Frank Davis'), undefined);
});

await check('the Scheduler\'s play history follows the edits', async () => {
  const h = (await rpcOk(dev, 'dev_scheduler_data')).history;
  assert.ok(h.some(r => r.play_date === '2026-09-13' && r.player_id === id('Wendy Wright') && r.brings_balls));
  assert.ok(!h.some(r => r.play_date === '2026-09-06' && r.player_id === id('Frank Davis')));
});

await check('an earlier Sunday can be added, and counts as played (already emailed)', async () => {
  await rpcOk(dev, 'dev_add_past_date', { p_play_date: '2026-08-30' });
  await rpcOk(dev, 'dev_save_past_play', { p_play_date: '2026-08-23', p_player_id: id('Zack Baker'), p_court: 7, p_brings_balls: true });
  const pp = await pastPlay();
  assert.deepEqual(pp.dates.map(d => d.play_date), ['2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13']);
  assert.ok(pp.dates.every(d => d.week_mode === 'courts'));
  assert.equal(cell(pp, '2026-08-23', 'Zack Baker').court, 7);
  const s = (await call('/rest/v1/sessions?play_date=eq.2026-08-23&select=locked_at,published_at,num_courts',
    { token: SERVICE_KEY, key: SERVICE_KEY, method: 'GET' })).data[0];
  assert.ok(s.locked_at && s.published_at);
  assert.equal(s.num_courts, 7);
});

await check('only earlier Sundays in a season, and courts 1 to 7', async () => {
  await rpcFails(dev, 'dev_add_past_date', { p_play_date: '2026-09-12' }, /Choose a Sunday/);
  await rpcFails(dev, 'dev_add_past_date', { p_play_date: '2026-10-11' }, /earlier Sundays/);
  await rpcFails(dev, 'dev_add_past_date', { p_play_date: '2026-04-26' }, /not in any season/);
  await rpcFails(dev, 'dev_save_past_play', { p_play_date: '2026-09-06', p_player_id: id('Alice Johnson'), p_court: 8 }, /1 to 7/);
});

console.log('Player Reviews');
const svc = { token: SERVICE_KEY, key: SERVICE_KEY };
const sid = (await call('/rest/v1/sessions?play_date=eq.2026-09-13&select=id', { ...svc, method: 'GET' })).data[0].id;
await call('/rest/v1/game_reviews', { ...svc, body: {
  session_id: sid, player_id: id('Alice Johnson'), court: 1, enjoyment: 4,
  submitted_by: 'alice.johnson@example.com', submitted_at: '2026-09-13T16:00:00Z' } });
const rid = (await call(`/rest/v1/game_reviews?session_id=eq.${sid}&select=id`, { ...svc, method: 'GET' })).data[0].id;
await call('/rest/v1/review_sets', { ...svc, body: [
  { review_id: rid, set_number: 1, team1: [id('Alice Johnson'), id('Bob Smith')], team2: [id('Carol Lee'), id('David Kim')], team1_games: 3, team2_games: 6 },
  { review_id: rid, set_number: 2, team1: [id('Alice Johnson'), id('Carol Lee')], team2: [id('Bob Smith'), id('David Kim')], team1_games: 6, team2_games: 4 }] });

await check('developers see every review with its sets, and the players\' names and levels', async () => {
  const r = await rpcOk(dev, 'dev_player_reviews');
  assert.equal(r.reviews.length, 1);
  const v = r.reviews[0];
  assert.equal(v.play_date, '2026-09-13');
  assert.equal(v.enjoyment, 4);
  assert.deepEqual(v.sets.map(s => [s.team1_games, s.team2_games]), [[3, 6], [6, 4]]);
  assert.equal(r.players[id('Carol Lee')].name, 'Carol Lee');
  assert.ok('level' in r.players[id('Carol Lee')]);
});

await check('members cannot see Player Reviews', async () => {
  await rpcFails(alice, 'dev_player_reviews', {}, /Developers only/);
});

summary();
