// End-to-end test of the Members Table (Developers > Members and this week):
// adding and editing members, Membership, Sunday Doubles, App Access, and
// uploading the club's current member list. LOCAL Supabase only.
// Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper, signIn,
         bootstrapDeveloper, clearInbox, summary, PW, MAIL, SERVICE_KEY, at } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);
const table = async () => rpcOk(dev, 'dev_members');
const row = async email => (await table()).find(m => m.email === email);
const save = (m, changes = {}) => rpc(dev, 'dev_save_member', {
  p_player_id: m.player_id ?? null, p_first_name: m.first_name, p_last_name: m.last_name, p_email: m.email,
  p_level: m.level ?? null, p_sex: m.sex ?? null, p_active: m.membership !== 'inactive', p_sunday_doubles: !!m.sunday_doubles,
  p_developer: !!m.is_developer, ...changes });
const mailTo = async (address, subject) => {
  const list = (await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json()).messages;
  return list.filter(x => x.To[0].Address === address && subject.test(x.Subject));
};

console.log('The Members Table');
await check('one row per person with Name, Email, Membership, Sunday Doubles and App Access', async () => {
  const a = await row('alice.johnson@example.com');
  assert.deepEqual([a.first_name, a.last_name, a.membership, a.sunday_doubles, a.app_access, a.level, a.sex, a.is_developer],
                   ['Alice', 'Johnson', 'active', true, 'yes', '3.5', 'F', false]);
  assert.equal((await row('bob.smith@example.com')).app_access, 'pending');
  const emails = (await table()).map(m => m.email);
  assert.equal(new Set(emails).size, emails.length, 'one person per email');
});

let newbie;
await check('a developer adds a member: Pending STA Member App Invitation until Send Invite', async () => {
  const r = await save({ first_name: ' Nora ', last_name: 'Quinn', email: ' Nora.Quinn@Example.com ', level: '3.0', sex: 'f',
                         membership: 'active', sunday_doubles: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  newbie = await row('nora.quinn@example.com');
  assert.deepEqual([newbie.first_name, newbie.sex, newbie.membership, newbie.sunday_doubles, newbie.app_access],
                   ['Nora', 'F', 'active', false, 'pending']);
});

await check('bad entries are refused: duplicate email, bad level or sex, missing name', async () => {
  assert.match((await save({ first_name: 'Al', last_name: 'J', email: 'alice.johnson@example.com' })).data.message, /already belongs to Alice Johnson/);
  assert.match((await save({ first_name: 'X', last_name: 'Y', email: 'x@example.com', level: '3.7' })).data.message, /Level/);
  assert.match((await save({ first_name: 'X', last_name: 'Y', email: 'x@example.com', sex: 'Q' })).data.message, /Sex/);
  assert.match((await save({ first_name: ' ', last_name: 'Y', email: 'x@example.com' })).data.message, /first and last name/);
  assert.match((await save({ first_name: 'X', last_name: 'Y', email: 'not-an-email' })).data.message, /valid email/);
});

await check('the email can change before the member joins; an unaccepted invitation is cancelled', async () => {
  assert.equal((await inviteAsDeveloper(dev, 'nora.quinn@example.com')).status, 200);
  assert.equal((await row('nora.quinn@example.com')).app_access, 'invited');
  assert.equal((await save(newbie, { p_email: 'nora.q@example.com' })).status, 200);
  newbie = await row('nora.q@example.com');
  assert.equal(newbie.app_access, 'pending', 'the old invitation no longer counts');
  assert.equal((await inviteAsDeveloper(dev, 'nora.q@example.com')).status, 200);
  const nora = await acceptInvite('nora.q@example.com', PW);
  assert.equal((await row('nora.q@example.com')).app_access, 'yes');
  assert.match((await save(newbie, { p_email: 'nora.other@example.com' })).data.message, /already joined/);
  const access = await rpcOk(nora, 'my_access');
  assert.deepEqual([access.member, access.sunday_doubles, access.developer], [true, false, false]);
});

console.log('Sunday Doubles');
await check('members without Sunday Doubles get News and Casual Play, but nothing from Sunday Doubles', async () => {
  const nora = await signIn('nora.q@example.com', PW);
  await rpcOk(nora, 'news_posts');
  await rpcOk(nora, 'casual_calendar');
  await rpcFails(nora, 'my_week', {}, /Not a member/);
  await rpcFails(nora, 'my_courts', {});
  await rpcFails(nora, 'my_review', {});
  await rpcFails(nora, 'sign_up', { p_player_id: newbie.player_id });
});

await check('only Sunday Doubles players get the Monday play-invite', async () => {
  const week = await rpcOk(dev, 'dev_week');
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: at(week.session.signups_open_at, 3600000) });
  await clearInbox();
  await call('/functions/v1/timed-tasks', { token: SERVICE_KEY, body: {} });
  assert.equal((await mailTo('alice.johnson@example.com', /sign-ups are open/)).length, 1);
  assert.equal((await mailTo('nora.q@example.com', /sign-ups are open/)).length, 0);
  await rpcOk(dev, 'dev_set_test_clock', { p_clock: null });
});

await check('switching Sunday Doubles to Yes opens it up', async () => {
  assert.equal((await save(newbie, { p_sunday_doubles: true })).status, 200);
  const nora = await signIn('nora.q@example.com', PW);
  assert.equal((await rpcOk(nora, 'my_access')).sunday_doubles, true);
  await rpcOk(nora, 'my_week');
});

console.log('Membership');
await check('Inactive members can sign in but can use nothing; Active again restores access', async () => {
  newbie = await row('nora.q@example.com');
  assert.equal((await save(newbie, { p_active: false })).status, 200);
  const nora = await signIn('nora.q@example.com', PW);
  const access = await rpcOk(nora, 'my_access');
  assert.equal(access.member, false);
  assert.match(access.dues_message, /membership/);
  for (const fn of ['news_posts', 'casual_calendar', 'my_week']) await rpcFails(nora, fn, {}, /Not a member/);
  assert.equal((await inviteAsDeveloper(dev, 'bob.smith@example.com')).status, 200, 'Active members can be invited');
  assert.equal((await save(await row('carol.lee@example.com'), { p_active: false })).status, 200);
  assert.equal((await inviteAsDeveloper(dev, 'carol.lee@example.com')).status, 400, 'Inactive members cannot be invited');
  assert.equal((await save(newbie, { p_active: true })).status, 200);
  await rpcOk(await signIn('nora.q@example.com', PW), 'news_posts');
});

await check('the last Active developer cannot be made Inactive or stop being a developer', async () => {
  const d = await row('dev@example.com');
  assert.match((await save(d, { p_active: false })).data.message, /at least one Active developer/);
  assert.match((await save(d, { p_developer: false })).data.message, /at least one Active developer/);
});

await check('only developers can see or change the Members Table', async () => {
  await rpcFails(alice, 'dev_members', {}, /Developers only/);
  assert.match((await rpc(alice, 'dev_save_member', { p_player_id: null, p_first_name: 'X', p_last_name: 'Y', p_email: 'x@example.com',
    p_level: null, p_sex: null, p_active: true, p_sunday_doubles: true, p_developer: true })).data.message, /Developers only/);
});

console.log('Upload current members');
const status = async () => Object.fromEntries((await table()).map(m => [m.email, m.membership]));
await check('members on the list become Active; everyone else Inactive', async () => {
  const r = await rpcOk(dev, 'dev_set_current_members',
    { p_current_emails: [' Alice.Johnson@example.com', 'carol.lee@example.com', 'dev@example.com', 'not.in.app@example.com'] });
  const s = await status();
  assert.equal(s['alice.johnson@example.com'], 'active');
  assert.equal(s['carol.lee@example.com'], 'active', 'an Inactive member on the list is Active again');
  assert.equal(s['bob.smith@example.com'], 'inactive');
  assert.equal(r.current, 3);
  assert.equal(r.lapsed, Object.keys(s).length - 3);
});

await check('removed accounts are left alone', async () => {
  await call('/rest/v1/accounts?email=eq.bob.smith@example.com', { token: dev, method: 'PATCH', body: { active: false, membership_current: true } });
  await rpcOk(dev, 'dev_set_current_members', { p_current_emails: ['dev@example.com'] });
  const [bob] = (await call('/rest/v1/accounts?email=eq.bob.smith@example.com&select=membership_current', { token: dev, method: 'GET' })).data;
  assert.equal(bob.membership_current, true);
});

await check('an empty list is refused, so nobody is made Inactive by mistake', async () => {
  await rpcFails(dev, 'dev_set_current_members', { p_current_emails: [] }, /nothing was changed/);
  await rpcFails(dev, 'dev_set_current_members', { p_current_emails: ['', '  '] }, /nothing was changed/);
});

await check('only developers can apply a member list', async () => {
  await rpcFails(alice, 'dev_set_current_members', { p_current_emails: ['alice.johnson@example.com'] }, /Developers only|Not a member/);
});

summary();
