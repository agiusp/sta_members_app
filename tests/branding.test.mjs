// End-to-end test of the branding settings (app name, color, logo, club website).
// LOCAL Supabase only. Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, MAIL } from './lib.mjs';

// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);

console.log('Reading');
await check('anyone, even signed out, can read the app name, color, logo and club website', async () => {
  const r = await rpc(null, 'branding');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { program_name: 'STA - STA Members App', brand_color: '#372a7b', logo: null,
                            website_url: 'https://www.statennis.com/', demo: false });
});

console.log('Saving');
await check('only developers can change the settings', async () => {
  await rpcFails(alice, 'dev_save_branding', { p_name: 'Hacked', p_color: '#000000', p_logo: null }, /Developers only/);
  const r = await rpc(null, 'dev_save_branding', { p_name: 'Hacked', p_color: '#000000', p_logo: null });
  assert.ok(r.status >= 400);
  const direct = await call('/rest/v1/settings?id=eq.true', { token: dev, method: 'PATCH', body: { program_name: 'Sneaky' } });
  assert.equal((await rpcOk(null, 'branding')).program_name, 'STA - STA Members App', JSON.stringify(direct.data));
});

await check('a developer saves a new name, color and logo', async () => {
  const r = await rpcOk(dev, 'dev_save_branding', { p_name: '  DoublesUp  ', p_color: '#0E7C66', p_logo: PNG });
  assert.deepEqual(r, { program_name: 'DoublesUp', brand_color: '#0e7c66', logo: PNG, website_url: 'https://www.statennis.com/', demo: false });
  assert.deepEqual(await rpcOk(null, 'branding'), r);
});

await check('bad values are refused and change nothing', async () => {
  await rpcFails(dev, 'dev_save_branding', { p_name: '', p_color: '#0e7c66', p_logo: null }, /1 to 60 characters/);
  await rpcFails(dev, 'dev_save_branding', { p_name: 'x'.repeat(61), p_color: '#0e7c66', p_logo: null }, /1 to 60 characters/);
  await rpcFails(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: 'red', p_logo: null }, /#372a7b/);
  await rpcFails(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66',
    p_logo: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+' }, /PNG, JPEG or WebP/);
  await rpcFails(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66',
    p_logo: 'javascript:alert(1)' }, /PNG, JPEG or WebP/);
  await rpcFails(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66',
    p_logo: 'data:image/png;base64,' + 'A'.repeat(400000) }, /too large/);
  assert.equal((await rpcOk(null, 'branding')).logo, PNG);
});

await check('a developer changes the club website; leaving it out keeps it', async () => {
  let r = await rpcOk(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66', p_logo: PNG,
                                                  p_website: ' https://club.example.org/ ' });
  assert.equal(r.website_url, 'https://club.example.org/');
  r = await rpcOk(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66', p_logo: PNG });
  assert.equal(r.website_url, 'https://club.example.org/');
  for (const bad of ['http://club.example.org/', 'javascript:alert(1)', 'https://x.org/"onmouseover="alert(1)', ''])
    await rpcFails(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66', p_logo: PNG, p_website: bad }, /https:\/\//);
});

await check('removing the logo', async () => {
  const r = await rpcOk(dev, 'dev_save_branding', { p_name: 'DoublesUp', p_color: '#0e7c66', p_logo: null });
  assert.equal(r.logo, null);
});

console.log('Emails');
await check('emails use the program name in the subject and text, and as the sender name', async () => {
  await clearInbox();
  assert.equal((await inviteAsDeveloper(dev, 'yara.green@example.com')).status, 200);
  const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
  const msg = list.messages[0];
  assert.equal(msg.Subject, 'Your invitation to DoublesUp');
  assert.equal(msg.From.Name, 'DoublesUp');
  const full = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json();
  assert.match(full.Text, /You're invited to DoublesUp, the club's members app/);
});

await check('the Emails page offers {{program_name}} in every email', async () => {
  const r = await call('/functions/v1/email-admin', { token: dev, body: {} });
  assert.ok(r.data.emails.every(e => 'program_name' in e.placeholders));
  assert.ok(!r.data.emails.some(e => /\bSTA\b/.test(e.subject + e.body)), 'no hard-coded club name left in default wording');
});

summary();
