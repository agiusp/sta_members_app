// End-to-end test of Phase 1 (accounts, invites, sign-ups, waitlist, deadlines,
// access rules) against the LOCAL Supabase and its fictitious test data.
// Run all tests with: tests/run.sh
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at } from './lib.mjs';

await clearInbox();

console.log('Accounts and invites');
let dev;
await check('first developer is invited with the bootstrap script and sets a password', async () => {
  dev = await bootstrapDeveloper();
  assert.equal(await rpcOk(dev, 'is_developer'), true);
});

const members = {};
await check('developer invites members through the invite function', async () => {
  for (const email of ['alice.johnson@example.com', 'bob.smith@example.com', 'carol.lee@example.com',
                       'david.kim@example.com', 'yara.green@example.com', 'zack.baker@example.com']) {
    const r = await inviteAsDeveloper(dev, email);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    members[email.split('.')[0]] = await acceptInvite(email, PW);
  }
});

await check('an invite that was not accepted can be resent, and the new link works', async () => {
  assert.equal((await inviteAsDeveloper(dev, 'emma.brown@example.com')).status, 200);
  const statuses = Object.fromEntries((await rpcOk(dev, 'dev_members')).map(m => [m.email, m.app_access]));
  assert.equal(statuses['emma.brown@example.com'], 'invited');
  assert.equal(statuses['alice.johnson@example.com'], 'yes');
  assert.equal(statuses['frank.davis@example.com'], 'pending');
  await new Promise(r => setTimeout(r, 1100)); // resends are rate-limited to one per second
  const again = await inviteAsDeveloper(dev, 'emma.brown@example.com');
  assert.equal(again.status, 200, JSON.stringify(again.data));
  members.emma = await acceptInvite('emma.brown@example.com', PW);
});

await check('resending to a member who already accepted is refused', async () => {
  const r = await inviteAsDeveloper(dev, 'alice.johnson@example.com');
  assert.equal(r.status, 400);
});

await check('inviting an email that is not on the member list is refused', async () => {
  const r = await inviteAsDeveloper(dev, 'stranger@example.com');
  assert.equal(r.status, 400);
});

await check('a member cannot send invites', async () => {
  const r = await inviteAsDeveloper(members.alice, 'bob.smith@example.com');
  assert.equal(r.status, 403);
});

await check('public self-registration is switched off', async () => {
  const r = await call('/auth/v1/signup', { body: { email: 'stranger@example.com', password: PW } });
  assert.ok(r.status >= 400, JSON.stringify(r.data));
});

console.log('Deadlines (test clock)');
const week0 = await rpcOk(dev, 'dev_week');
const s = week0.session;
assert.ok(s, 'no upcoming session was created');
const playerOf = async (token, first) =>
  (await rpcOk(token, 'my_week')).players.find(p => p.first_name === first);

await check('session deadlines are Monday 9:00, Saturday 12:00 and Saturday 20:00 Eastern', async () => {
  const et = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  assert.equal(et(s.signups_open_at), 'Mon 9:00 AM');
  assert.equal(et(s.signups_close_at), 'Sat 12:00 PM');
  assert.equal(et(s.courts_publish_at), 'Sat 8:00 PM');
});

await check('before Monday 9:00, sign-ups are not open yet', async () => {
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(s.signups_open_at, -minute) });
  const w = await rpcOk(members.alice, 'my_week');
  assert.equal(w.phase, 'not_open');
  const alice = w.players[0];
  await rpcFails(members.alice, 'sign_up', { p_player_id: alice.id }, /open Monday/);
});

console.log('Sign-ups, capacity and waitlist');
await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 1 });
const order = [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol'], ['david', 'David'], ['yara', 'Yara'], ['zack', 'Zack']];
await check('with 1 court, the first 4 sign-ups get spots and the rest are waitlisted in order', async () => {
  for (let i = 0; i < order.length; i++) {
    await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(s.signups_open_at, (i + 1) * minute) });
    const [acct, first] = order[i];
    await rpcOk(members[acct], 'sign_up', { p_player_id: (await playerOf(members[acct], first)).id });
  }
  const lineup = (await rpcOk(dev, 'dev_week')).lineup;
  assert.deepEqual(lineup.map(l => l.name.split(' ')[0]), ['Alice', 'Bob', 'Carol', 'David', 'Yara', 'Zack']);
  assert.deepEqual(lineup.map(l => l.has_spot), [true, true, true, true, false, false]);
  assert.equal((await playerOf(members.yara, 'Yara')).waitlist_place, 1);
  assert.equal((await playerOf(members.zack, 'Zack')).waitlist_place, 2);
});

await check('a member cannot sign up anyone else', async () => {
  const zack = await playerOf(members.zack, 'Zack');
  await rpcFails(members.alice, 'sign_up', { p_player_id: zack.id }, /not linked/);
});

await check('signing up twice is refused', async () => {
  await rpcFails(members.alice, 'sign_up', { p_player_id: (await playerOf(members.alice, 'Alice')).id }, /Already/);
});

await check('when someone cancels, the first person on the waitlist moves up', async () => {
  await rpcOk(members.bob, 'cancel_signup', { p_player_id: (await playerOf(members.bob, 'Bob')).id });
  const yara = await playerOf(members.yara, 'Yara');
  assert.equal(yara.has_spot, true);
  assert.equal((await playerOf(members.zack, 'Zack')).waitlist_place, 1);
});

await check('adding a court gives waitlisted players spots', async () => {
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 });
  assert.equal((await playerOf(members.zack, 'Zack')).has_spot, true);
});

console.log('Saturday noon cutoff');
await check('at 11:59 Saturday, cancelling still works', async () => {
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(s.signups_close_at, -minute) });
  await rpcOk(members.david, 'cancel_signup', { p_player_id: (await playerOf(members.david, 'David')).id });
});

await check('from 12:00 Saturday, sign-ups and cancellations are refused with the contact emails', async () => {
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: s.signups_close_at });
  assert.equal((await rpcOk(members.alice, 'my_week')).phase, 'closed');
  await rpcFails(members.alice, 'cancel_signup',
    { p_player_id: (await playerOf(members.alice, 'Alice')).id }, /organizers@example\.com and\/or helper@example\.com/);
  await rpcFails(members.bob, 'sign_up', { p_player_id: (await playerOf(members.bob, 'Bob')).id }, /closed/);
});

await check('after the cutoff, a developer can still remove a player for an emergency', async () => {
  const carol = (await rpcOk(dev, 'dev_week')).lineup.find(l => l.name === 'Carol Lee');
  await rpcOk(dev, 'dev_remove_signup', { p_signup_id: carol.signup_id });
  assert.equal((await playerOf(members.carol, 'Carol')).signed_up, false);
});

console.log('Access rules');
await check('signed-out visitors can read nothing', async () => {
  for (const table of ['accounts', 'players', 'signups', 'sessions', 'settings']) {
    const r = await call(`/rest/v1/${table}?select=*`, { method: 'GET' });
    assert.ok(r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0), `${table}: ${JSON.stringify(r.data)}`);
  }
  const r = await rpc(null, 'my_week');
  assert.ok(r.status >= 400);
});

await check('a member sees only their own account, players and sign-ups', async () => {
  const accts = await call('/rest/v1/accounts?select=email', { token: members.yara, method: 'GET' });
  assert.deepEqual(accts.data.map(a => a.email), ['yara.green@example.com']);
  const players = await call('/rest/v1/players?select=first_name', { token: members.yara, method: 'GET' });
  assert.deepEqual(players.data.map(p => p.first_name), ['Yara']);
  const signups = await call('/rest/v1/signups?select=player_id', { token: members.alice, method: 'GET' });
  assert.equal(signups.data.length, 1);
});

await check('a member cannot write sign-ups, players, accounts or settings directly', async () => {
  const alice = await playerOf(members.alice, 'Alice');
  const tries = [
    ['/rest/v1/signups', { session_id: s.id, player_id: alice.id, signed_up_at: '2000-01-01', signed_up_by: 'x' }],
    ['/rest/v1/players', { account_email: 'alice.johnson@example.com', first_name: 'X', last_name: 'Y' }],
    ['/rest/v1/accounts', { email: 'friend@example.com' }]
  ];
  for (const [path, body] of tries) {
    const r = await call(path, { token: members.alice, body });
    assert.ok(r.status >= 400, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  const upd = await call('/rest/v1/accounts?email=eq.alice.johnson@example.com',
    { token: members.alice, method: 'PATCH', body: { is_developer: true } });
  assert.equal(await rpcOk(members.alice, 'is_developer'), false, JSON.stringify(upd.data));
  await call('/rest/v1/settings?id=eq.true', { token: members.alice, method: 'PATCH', body: { contact_emails: ['x@example.com'] } });
  const settings = await rpcOk(dev, 'dev_week');
  assert.deepEqual(settings.settings.contact_emails, ['organizers@example.com', 'helper@example.com']);
});

await check('a member cannot use developer functions or internal helpers', async () => {
  await rpcFails(members.alice, 'dev_week', {}, /Developers only/);
  await rpcFails(members.alice, 'dev_members', {}, /Developers only/);
  await rpcFails(members.alice, 'dev_set_test_clock', { p_clock: null });
  await rpcFails(members.alice, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 7 });
  await rpcFails(members.alice, 'session_lineup', { p_session_id: s.id });
  await rpcFails(members.alice, 'ensure_upcoming_session', {});
});

await check('simulated sign-ups fill spots first, then the waitlist, in sign-up order', async () => {
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(s.signups_open_at, 60 * minute) });
  await rpcOk(dev, 'dev_clear_signups');
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 7 });
  // 43 players in the test data: Dana Developer, the 26 original and 16 more.
  assert.equal(await rpcOk(dev, 'dev_simulate_signups', { p_count: 35 }), 35);
  const lineup = (await rpcOk(dev, 'dev_week')).lineup;
  assert.equal(lineup.filter(l => l.has_spot).length, 28);
  assert.deepEqual(lineup.filter(l => !l.has_spot).map(l => l.waitlist_place), [1, 2, 3, 4, 5, 6, 7]);
  const times = lineup.map(l => new Date(l.signed_up_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(await rpcOk(dev, 'dev_simulate_signups', { p_count: 50 }), 8, 'only the 8 remaining players can be added');
  await rpcOk(dev, 'dev_clear_signups');
  assert.equal((await rpcOk(dev, 'dev_week')).lineup.length, 0);
});

await check('members cannot use the test tools', async () => {
  await rpcFails(members.alice, 'dev_simulate_signups', { p_count: 5 }, /Developers only/);
  await rpcFails(members.alice, 'dev_clear_signups', {}, /Developers only/);
});

await check('not even a developer can switch test mode on from the app', async () => {
  await call('/rest/v1/settings?id=eq.true', { token: dev, method: 'PATCH', body: { test_mode: false } });
  assert.equal((await rpcOk(dev, 'dev_week')).settings.test_mode, true);
});

console.log('Inactive memberships');
let carolPlayer;
await check('an Inactive member can still sign in but gets only the dues message', async () => {
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(s.signups_open_at, 90 * minute) });
  carolPlayer = (await playerOf(members.carol, 'Carol')).id;
  const r = await call('/rest/v1/accounts?email=eq.carol.lee@example.com',
    { token: dev, method: 'PATCH', body: { membership_current: false } });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  const access = await rpcOk(members.carol, 'my_access');
  assert.equal(access.member, false);
  assert.match(access.dues_message, /membership dues/);
  await rpcFails(members.carol, 'my_week', {}, /Not a member/);
  await rpcFails(members.carol, 'sign_up', { p_player_id: carolPlayer }, /Not a member/);
});

await check('Inactive members are listed as Inactive, cannot be invited, and are skipped by simulated sign-ups', async () => {
  const carol = (await rpcOk(dev, 'dev_members')).find(m => m.email === 'carol.lee@example.com');
  assert.equal(carol.membership, 'inactive');
  await call('/rest/v1/accounts?email=eq.frank.davis@example.com',
    { token: dev, method: 'PATCH', body: { membership_current: false } });
  assert.equal((await inviteAsDeveloper(dev, 'frank.davis@example.com')).status, 400);
  await rpcOk(dev, 'dev_simulate_signups', { p_count: 100 });
  const names = (await rpcOk(dev, 'dev_week')).lineup.map(l => l.name);
  assert.ok(!names.includes('Carol Lee') && !names.includes('Frank Davis'));
  await rpcOk(dev, 'dev_clear_signups');
});

await check('a member cannot make themselves Active, but a developer can', async () => {
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com',
    { token: members.carol, method: 'PATCH', body: { membership_current: true } });
  assert.equal((await rpcOk(members.carol, 'my_access')).member, false);
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com',
    { token: dev, method: 'PATCH', body: { membership_current: true } });
  await rpcOk(members.carol, 'sign_up', { p_player_id: carolPlayer });
});

await check('a developer can change the dues message; members cannot', async () => {
  await call('/rest/v1/settings?id=eq.true', { token: members.alice, method: 'PATCH', body: { dues_message: 'hacked' } });
  await call('/rest/v1/settings?id=eq.true', { token: dev, method: 'PATCH', body: { dues_message: 'Please renew first.' } });
  assert.equal((await rpcOk(members.alice, 'my_week')).dues_message, 'Please renew first.');
});

await check('a deactivated member loses access', async () => {
  await call('/rest/v1/accounts?email=eq.bob.smith@example.com', { token: dev, method: 'PATCH', body: { active: false } });
  await rpcFails(members.bob, 'my_week', {}, /Not a member/);
});

await rpcOk(dev, 'dev_set_test_clock', { p_clock: null });
summary();
