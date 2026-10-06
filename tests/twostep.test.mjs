// End-to-end test of two-step sign-in for developers (a code from an
// authenticator app). LOCAL Supabase only.
// Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { createHmac } from 'node:crypto';
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper, signIn,
         bootstrapDeveloper, clearInbox, summary, setTwoStep, PW } from './lib.mjs';

// The 6-digit code an authenticator app would show for this key right now.
function totp(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);
await setTwoStep(true);

console.log('Two-step sign-in');
let devPlain, factor;
await check('a developer signed in with only a password has no developer powers', async () => {
  devPlain = await signIn('dev@example.com', PW);
  assert.deepEqual(await rpcOk(devPlain, 'my_developer'), { developer: true, confirmed: false });
  await rpcFails(devPlain, 'dev_members', {}, /Developers only/);
  const direct = await call('/rest/v1/accounts?select=email', { token: devPlain, method: 'GET' });
  assert.equal(direct.data.length, 1, 'sees only their own account');
  assert.equal((await inviteAsDeveloper(devPlain, 'bob.smith@example.com')).status, 403);
  assert.equal((await call('/functions/v1/timed-tasks', { token: devPlain, body: {} })).status, 403);
});

await check('members are not affected', async () => {
  assert.deepEqual(await rpcOk(alice, 'my_developer'), { developer: false, confirmed: false });
  await rpcOk(alice, 'my_week');
});

await check('after setting up an authenticator app and entering a code, developer powers work', async () => {
  const en = await call('/auth/v1/factors', { token: devPlain, body: { factor_type: 'totp', friendly_name: 'STA developer' } });
  assert.equal(en.status, 200, JSON.stringify(en.data));
  factor = en.data;
  const ch = await call(`/auth/v1/factors/${factor.id}/challenge`, { token: devPlain, body: {} });
  const bad = await call(`/auth/v1/factors/${factor.id}/verify`, { token: devPlain, body: { challenge_id: ch.data.id, code: '000000' } });
  assert.ok(bad.status >= 400, 'a wrong code is refused');
  const ch2 = await call(`/auth/v1/factors/${factor.id}/challenge`, { token: devPlain, body: {} });
  const ok = await call(`/auth/v1/factors/${factor.id}/verify`, { token: devPlain, body: { challenge_id: ch2.data.id, code: totp(factor.totp.secret) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const devConfirmed = ok.data.access_token;
  assert.deepEqual(await rpcOk(devConfirmed, 'my_developer'), { developer: true, confirmed: true });
  await rpcOk(devConfirmed, 'dev_members');
});

await check('the next password sign-in needs a code again before developer powers work', async () => {
  const again = await signIn('dev@example.com', PW);
  await rpcFails(again, 'dev_members', {}, /Developers only/);
});

console.log('Locked-down tables and functions');
await check('members cannot read sessions, seasons or settings directly', async () => {
  for (const t of ['sessions', 'seasons', 'settings']) {
    const r = await call(`/rest/v1/${t}?select=*`, { token: alice, method: 'GET' });
    assert.deepEqual(r.data, [], t);
  }
});

await check('helper functions cannot be called directly; branding can, by anyone', async () => {
  assert.ok((await rpc(alice, 'late_lock_until', { p_play_date: '2026-11-15' })).status >= 400);
  assert.ok((await rpc(null, 'dev_save_branding', { p_name: 'x', p_color: '#000000', p_logo: null })).status >= 400);
  assert.ok((await rpc(alice, 'casual_slot_limit')).status >= 400);
  assert.equal((await rpc(null, 'branding')).status, 200);
});

await setTwoStep(false);
await check('news shows who posted only to developers', async () => {
  await rpcOk(dev, 'dev_save_news', { p_id: null, p_title: 'Hello', p_body: 'Welcome' });
  assert.equal((await rpcOk(alice, 'news_posts')).posts[0].posted_by, null);
  assert.equal((await rpcOk(dev, 'news_posts')).posts[0].posted_by, 'dev@example.com');
});

summary();
