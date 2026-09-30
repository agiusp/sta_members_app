// End-to-end test of Phase 3 (scheduler data, locking courts, the Saturday
// time rules, replacements) against the LOCAL Supabase and its fictitious
// test data. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);

const s = (await rpcOk(dev, 'dev_week')).session;
const hour = 60 * minute;
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
const data = () => rpcOk(dev, 'dev_scheduler_data');

// A busy week: 6 courts (24 spots) and 30 sign-ups, so 6 are waitlisted.
await setClock(at(s.signups_open_at, 2 * hour));
await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 6 });
await rpcOk(dev, 'dev_simulate_signups', { p_count: 30 });

// Courts in sign-up order, 4 per court, first player of each brings balls.
function courtsFrom(lineup, n = 6) {
  const withSpot = lineup.filter(p => p.has_spot);
  return Array.from({ length: n }, (_, i) => ({
    court: i + 1,
    players: withSpot.slice(i * 4, i * 4 + 4).map((p, j) => ({ player_id: p.id, brings_balls: j === 0 }))
  }));
}

console.log('Scheduler data');
await check('the scheduler sees the line-up, spots and waitlist', async () => {
  const d = await data();
  assert.equal(d.lineup.length, 30);
  assert.equal(d.lineup.filter(p => p.has_spot).length, 24);
  assert.deepEqual(d.lineup.filter(p => !p.has_spot).map(p => p.waitlist_place), [1, 2, 3, 4, 5, 6]);
  assert.equal(d.assignments.length, 0);
});

await check('the scheduler gets two past Sundays of history, with 5 ball-bringers each', async () => {
  const d = await data();
  const dates = [...new Set(d.history.map(h => h.play_date))];
  assert.deepEqual(dates, ['2026-09-06', '2026-09-13']);
  assert.equal(d.history.length, 40);
  assert.equal(d.history.filter(h => h.brings_balls).length, 10);
});

console.log('Locking');
await check('courts cannot be locked while sign-ups are still open', async () => {
  await setClock(at(s.signups_close_at, -minute));
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: courtsFrom((await data()).lineup) }, /once sign-ups close/);
});

await setClock(at(s.signups_close_at, 3 * hour)); // Saturday 3pm
const lineup = (await data()).lineup;
const good = courtsFrom(lineup);

await check('bad arrangements are refused', async () => {
  const dup = structuredClone(good);
  dup[1].players[0] = { player_id: dup[0].players[1].player_id };
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: dup }, /more than one court/);

  const tooMany = structuredClone(good);
  tooMany[0].players.push(tooMany[5].players.pop());
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: tooMany }, /at most 4/);

  const twoBalls = structuredClone(good);
  twoBalls[0].players[1].brings_balls = true;
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: twoBalls }, /one ball-bringer/);

  const court7 = structuredClone(good);
  court7[5].court = 7;
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: court7 }, /only 6 courts/);

  const signedUp = new Set(lineup.map(p => p.id));
  const outsider = (await call('/rest/v1/players?select=id', { token: dev, method: 'GET' }))
    .data.find(p => !signedUp.has(p.id));
  const stranger = structuredClone(good);
  stranger[0].players[0].player_id = outsider.id;
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: stranger }, /signed up/);

  assert.equal((await data()).session.locked_at, null, 'failed attempts must not lock');
});

await check('at Saturday 3pm, a developer locks the courts', async () => {
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: good });
  const d = await data();
  assert.ok(d.session.locked_at);
  assert.equal(d.session.locked_by, 'dev@example.com');
  assert.equal(d.session.org_play, 'mixed');
  assert.equal(d.assignments.length, 24);
  assert.equal(d.assignments.filter(a => a.brings_balls).length, 6);
});

await check('locked courts cannot be locked again, or have their court count or players changed', async () => {
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: good }, /already locked/);
  await rpcFails(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 5 }, /locked/);
  const onCourt = lineup.find(p => p.id === good[0].players[0].player_id);
  await rpcFails(dev, 'dev_remove_signup', { p_signup_id: onCourt.signup_id }, /locked court/);
});

console.log('Replacements');
await check('a replacement: unlock, swap in a waitlisted player, re-lock, remove the player who can\'t come', async () => {
  await rpcOk(dev, 'dev_unlock_courts');
  const d = await data();
  assert.equal(d.session.locked_at, null);
  assert.equal(d.assignments.length, 24, 'unlocking keeps the saved assignments');

  const cantCome = good[2].players[3].player_id;
  const replacement = lineup.find(p => p.waitlist_place === 1).id;
  const swapped = structuredClone(good);
  swapped[2].players[3] = { player_id: replacement, brings_balls: false };
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: swapped });

  await rpcOk(dev, 'dev_remove_signup', { p_signup_id: lineup.find(p => p.id === cantCome).signup_id });
  const after = await data();
  assert.ok(after.assignments.some(a => a.player_id === replacement && a.court === 3));
  assert.ok(!after.lineup.some(p => p.id === cantCome), 'removed player is no longer signed up');
  assert.ok(after.session.locked_at, 'still locked');
});

console.log('8pm');
await check('from 8pm Saturday the courts are final: no unlocking or re-locking', async () => {
  await setClock(s.courts_publish_at);
  await rpcFails(dev, 'dev_unlock_courts', {}, /final/);
  const d = await data();
  assert.ok(d.session.locked_at);
});

console.log('Access rules');
await check('members cannot see or change court assignments', async () => {
  await rpcFails(alice, 'dev_scheduler_data', {}, /Developers only/);
  await rpcFails(alice, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: good }, /Developers only/);
  await rpcFails(alice, 'dev_unlock_courts', {}, /Developers only/);
  const r = await call('/rest/v1/assignments?select=*', { token: alice, method: 'GET' });
  assert.deepEqual(r.data, []);
  const w = await call('/rest/v1/assignments', { token: alice, body: { session_id: s.id, court: 1, player_id: 1 } });
  assert.ok(w.status >= 400);
});

await setClock(null);
summary();
