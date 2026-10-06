// End-to-end test of the News page: members read, developers post, edit and delete.
// LOCAL Supabase only. Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);

console.log('Reading');
await check('members see an empty News page to start with', async () => {
  assert.deepEqual(await rpcOk(alice, 'news_posts'), { is_developer: false, posts: [] });
  assert.equal((await rpcOk(dev, 'news_posts')).is_developer, true);
});

await check('signed-out visitors cannot read the news', async () => {
  assert.ok((await rpc(null, 'news_posts')).status >= 400);
  const direct = await call('/rest/v1/news?select=*', { method: 'GET' });
  assert.ok(direct.status >= 400 || (Array.isArray(direct.data) && !direct.data.length), JSON.stringify(direct.data));
});

console.log('Posting');
let first;
await check('a developer posts; members see it, newest first', async () => {
  first = await rpcOk(dev, 'dev_save_news', { p_id: null, p_title: '  Courts resurfaced ', p_body: 'Back open Monday.' });
  await rpcOk(dev, 'dev_save_news', { p_id: null, p_title: 'Season party', p_body: 'Details: https://www.statennis.com/' });
  const { posts } = await rpcOk(alice, 'news_posts');
  assert.deepEqual(posts.map(p => p.title), ['Season party', 'Courts resurfaced']);
  assert.equal(posts[1].posted_by, null, 'members don\'t see who posted');
  assert.equal(posts[1].updated_at, null);
});

await check('a developer edits a post', async () => {
  await rpcOk(dev, 'dev_save_news', { p_id: first, p_title: 'Courts resurfaced', p_body: 'Back open Tuesday.' });
  const post = (await rpcOk(alice, 'news_posts')).posts.find(p => p.id === first);
  assert.equal(post.body, 'Back open Tuesday.');
  assert.ok(post.updated_at);
});

await check('titles and text cannot be empty or too long', async () => {
  await rpcFails(dev, 'dev_save_news', { p_id: null, p_title: '  ', p_body: 'x' }, /title/);
  await rpcFails(dev, 'dev_save_news', { p_id: null, p_title: 'x'.repeat(121), p_body: 'x' }, /title/);
  await rpcFails(dev, 'dev_save_news', { p_id: null, p_title: 'x', p_body: '' }, /text/);
  await rpcFails(dev, 'dev_save_news', { p_id: 999999, p_title: 'x', p_body: 'y' }, /no longer exists/);
});

await check('members cannot post, edit or delete, directly or through the functions', async () => {
  await rpcFails(alice, 'dev_save_news', { p_id: null, p_title: 'Hi', p_body: 'x' }, /Developers only/);
  await rpcFails(alice, 'dev_save_news', { p_id: first, p_title: 'Hacked', p_body: 'x' }, /Developers only/);
  await rpcFails(alice, 'dev_delete_news', { p_id: first }, /Developers only/);
  const ins = await call('/rest/v1/news', { token: alice, body: { title: 'Sneaky', body: 'x', posted_by: 'a' } });
  assert.ok(ins.status >= 400, JSON.stringify(ins.data));
  const del = await call(`/rest/v1/news?id=eq.${first}`, { token: dev, method: 'DELETE' });
  assert.ok(del.status >= 400, 'even developers only change news through the functions');
  assert.equal((await rpcOk(alice, 'news_posts')).posts.length, 2);
});

await check('a developer deletes a post', async () => {
  await rpcOk(dev, 'dev_delete_news', { p_id: first });
  assert.deepEqual((await rpcOk(alice, 'news_posts')).posts.map(p => p.title), ['Season party']);
});

summary();
