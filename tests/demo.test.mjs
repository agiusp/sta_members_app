// End-to-end test of demo mode: emails go to the Demo inbox instead of being
// sent. LOCAL Supabase only. Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, MAIL, SERVICE_KEY } from './lib.mjs';

const setDemo = on => call('/rest/v1/settings?id=eq.true', { token: SERVICE_KEY, key: SERVICE_KEY, method: 'PATCH', body: { demo: on } });
const inboxCount = async () => (await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json()).messages.length;

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);

console.log('Demo mode');
await check('off by default: no Demo inbox, and branding says so', async () => {
  assert.equal((await rpcOk(null, 'branding')).demo, false);
  await rpcFails(alice, 'demo_inbox', {}, /Only in the demo/);
});

await check('on: emails are kept in the Demo inbox, not sent', async () => {
  await setDemo(true);
  await clearInbox();
  assert.equal((await inviteAsDeveloper(dev, 'bob.smith@example.com')).status, 200);
  assert.equal((await rpcOk(null, 'branding')).demo, true);
  assert.equal(await inboxCount(), 0, 'nothing reached the test inbox');
  const all = await rpcOk(dev, 'demo_inbox');
  assert.equal(all[0].to, 'bob.smith@example.com');
  assert.match(all[0].subject, /invitation/);
});

await check('members see only their own demo emails; developers see all', async () => {
  await call('/rest/v1/demo_inbox', { token: SERVICE_KEY, key: SERVICE_KEY, body: { to_email: 'alice.johnson@example.com', subject: 'For Alice', body: 'Hi' } });
  assert.deepEqual((await rpcOk(alice, 'demo_inbox')).map(m => m.subject), ['For Alice']);
  assert.equal((await rpcOk(dev, 'demo_inbox')).length, 2);
});

await check('the Demo inbox table cannot be read or changed directly, and only the database can switch demo mode', async () => {
  assert.ok((await call('/rest/v1/demo_inbox?select=*', { token: alice, method: 'GET' })).status >= 400);
  await call('/rest/v1/settings?id=eq.true', { token: dev, method: 'PATCH', body: { demo: false } });
  assert.equal((await rpcOk(null, 'branding')).demo, true);
});

await setDemo(false);
summary();
