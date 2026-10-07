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
const cell = (pp, date, name) => pp.cells.find(c => c.play_date === date && c.name === name);
const history = async () => (await rpcOk(dev, 'dev_scheduler_data')).history;

console.log('Past Play');
await check('shows the season\'s Sundays from the Scheduler\'s locked courts', async () => {
  const pp = await pastPlay();
  assert.equal(pp.season.name, '2026');
  assert.deepEqual(pp.dates.map(d => d.play_date), ['2026-09-06', '2026-09-13']);
  assert.equal(pp.cells.length, 40);
  assert.deepEqual(cell(pp, '2026-09-06', 'Alice Johnson'),
    { play_date: '2026-09-06', player_id: id('Alice Johnson'), name: 'Alice Johnson', court: 1, brings_balls: true, no_show: false });
  assert.ok(pp.players.some(p => p.name === 'Zack Baker'), 'players who never played are listed too');
});

await check('developers can no longer change courts or ball-bringers there', async () => {
  await rpcFails(dev, 'dev_save_past_play', { p_play_date: '2026-09-06', p_player_id: id('Alice Johnson'), p_court: 2 });
  await rpcFails(dev, 'dev_add_past_date', { p_play_date: '2026-08-30' });
});

await check('only developers can see it, mark no-shows or upload', async () => {
  await rpcFails(alice, 'dev_past_play', {}, /Developers only/);
  await rpcFails(alice, 'dev_set_no_show', { p_play_date: '2026-09-13', p_player_id: id('Henry Moore'), p_no_show: true }, /Developers only/);
  await rpcFails(alice, 'dev_upload_past_season', { p_season: '2025', p_rows: [] }, /Developers only/);
});

console.log('No-shows');
await check('a no-show is marked in Past Play and left out of the Scheduler\'s history', async () => {
  await rpcOk(dev, 'dev_set_no_show', { p_play_date: '2026-09-13', p_player_id: id('Henry Moore'), p_no_show: true });
  assert.equal(cell(await pastPlay(), '2026-09-13', 'Henry Moore').no_show, true);
  const h = await history();
  assert.ok(!h.some(r => r.play_date === '2026-09-13' && r.player_id === id('Henry Moore')));
  assert.equal(h.length, 39);
});

await check('a no-show can be undone', async () => {
  await rpcOk(dev, 'dev_set_no_show', { p_play_date: '2026-09-13', p_player_id: id('Henry Moore'), p_no_show: false });
  assert.equal(cell(await pastPlay(), '2026-09-13', 'Henry Moore').no_show, false);
  assert.equal((await history()).length, 40);
});

await check('only players who were on a court, on Sundays whose courts are final', async () => {
  await rpcFails(dev, 'dev_set_no_show', { p_play_date: '2026-09-13', p_player_id: id('Zack Baker'), p_no_show: true }, /not on a court/);
  await rpcFails(dev, 'dev_set_no_show', { p_play_date: '2026-10-11', p_player_id: id('Alice Johnson'), p_no_show: true }, /final/);
});

console.log('Uploading a past season');
const rows2025 = [
  { name: 'Alice Johnson', play_date: '2025-05-04', court: 1, brings_balls: true },
  { name: 'Old Timer', play_date: '2025-05-04', court: 1 },
  { name: 'alice johnson', play_date: '2025-05-11', court: 2, no_show: true }
];
await check('a past season is uploaded, keeping names that aren\'t in the app', async () => {
  const res = await rpcOk(dev, 'dev_upload_past_season', { p_season: '2025', p_rows: rows2025 });
  assert.equal(res.rows, 3);
  assert.deepEqual(res.unmatched, ['Old Timer']);
  const pp = await pastPlay('2025');
  assert.equal(pp.season.uploaded, true);
  assert.deepEqual(pp.season.start_date, '2025-05-04');
  assert.deepEqual(pp.dates.map(d => d.play_date), ['2025-05-04', '2025-05-11']);
  assert.equal(cell(pp, '2025-05-04', 'Old Timer').player_id, null);
  assert.equal(cell(pp, '2025-05-04', 'Alice Johnson').player_id, id('Alice Johnson'));
  assert.deepEqual((await pastPlay()).seasons, ['2026', '2025']);
});

await check('matched names feed the Scheduler\'s history; no-shows don\'t', async () => {
  const h = await history();
  assert.ok(h.some(r => r.play_date === '2025-05-04' && r.player_id === id('Alice Johnson') && r.brings_balls));
  assert.ok(!h.some(r => r.play_date === '2025-05-11'));
  assert.equal(h.length, 41);
});

await check('uploading the season again replaces it', async () => {
  await rpcOk(dev, 'dev_upload_past_season', { p_season: '2025', p_rows: [rows2025[1]] });
  const pp = await pastPlay('2025');
  assert.equal(pp.cells.length, 1);
  assert.equal((await history()).length, 40);
});

await check('only seasons before the app, with past Sundays and courts 1 to 7', async () => {
  const row = (d, extra = {}) => [{ name: 'Old Timer', play_date: d, court: 1, ...extra }];
  await rpcFails(dev, 'dev_upload_past_season', { p_season: '2026', p_rows: row('2025-06-01') }, /ran the 2026 season/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: 'Fall', p_rows: row('2026-09-06') }, /already has Sundays/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: '2024', p_rows: row('2024-05-04') }, /Sunday/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: '2027', p_rows: row('2027-05-02') }, /past seasons/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: '2024', p_rows: row('2024-05-05', { court: 8 }) }, /1 to 7/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: '2024b', p_rows: row('2025-05-04') }, /overlap/);
  await rpcFails(dev, 'dev_upload_past_season', { p_season: ' ', p_rows: row('2024-05-05') }, /name/);
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
