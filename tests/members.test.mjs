// End-to-end test of uploading the list of current members
// (Developers > Members and this week). LOCAL Supabase only.
// Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);
const status = async () => Object.fromEntries((await rpcOk(dev, 'dev_members')).map(a => [a.email, a.membership_current]));

console.log('Upload current members');
await check('members on the list become current; everyone else lapsed', async () => {
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: false } });
  const r = await rpcOk(dev, 'dev_set_current_members',
    { p_current_emails: [' Alice.Johnson@example.com', 'carol.lee@example.com', 'dev@example.com', 'not.in.app@example.com'] });
  const s = await status();
  assert.equal(s['alice.johnson@example.com'], true);
  assert.equal(s['carol.lee@example.com'], true, 'a lapsed member on the list is current again');
  assert.equal(s['bob.smith@example.com'], false);
  assert.equal(r.current, 3);
  assert.equal(r.lapsed, Object.keys(s).length - 3);
});

await check('lapsed members can still sign in but cannot sign up', async () => {
  await rpcOk(dev, 'dev_set_current_members', { p_current_emails: ['dev@example.com'] });
  const week = await rpcOk(alice, 'my_week');
  assert.equal(week.membership_current, false);
});

await check('removed accounts are left alone', async () => {
  await call('/rest/v1/accounts?email=eq.bob.smith@example.com', { token: dev, method: 'PATCH', body: { active: false, membership_current: true } });
  await rpcOk(dev, 'dev_set_current_members', { p_current_emails: ['dev@example.com'] });
  assert.equal((await status())['bob.smith@example.com'], true);
});

await check('an empty list is refused, so nobody is lapsed by mistake', async () => {
  await rpcFails(dev, 'dev_set_current_members', { p_current_emails: [] }, /nothing was changed/);
  await rpcFails(dev, 'dev_set_current_members', { p_current_emails: ['', '  '] }, /nothing was changed/);
});

await check('only developers can apply a member list', async () => {
  await rpcFails(alice, 'dev_set_current_members', { p_current_emails: ['alice.johnson@example.com'] }, /Developers only/);
});

summary();
