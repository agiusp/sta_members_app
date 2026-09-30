// End-to-end test of Phase 4 (Saturday 5pm reminder, 8pm court and no-spot
// emails, Designated Courts page) against the LOCAL Supabase and its test
// inbox. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at, MAIL, SERVICE_KEY } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
const members = {};
for (const email of ['alice.johnson@example.com', 'yara.green@example.com']) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  members[email.split('.')[0]] = await acceptInvite(email, PW);
}
await rpcOk(dev, 'dev_set_test_clock', { p_clock: null });
await rpcOk(dev, 'dev_week');
await clearInbox(); // only count emails sent by the timed tasks from here on

const s = (await rpcOk(dev, 'dev_week')).session;
const hour = 60 * minute;
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
const runTasks = async (token = SERVICE_KEY) => call('/functions/v1/timed-tasks', { token, body: {} });
async function inbox() {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.map(m => ({ id: m.ID, to: m.To[0].Address, subject: m.Subject }));
}
const text = async id => (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()).Text;

// The week: 2 courts (8 spots). Alice, Yara and Zack sign up first, then 10 more.
await setClock(at(s.signups_open_at, hour));
await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 });
const mine = async (token, first) => (await rpcOk(token, 'my_week')).players.find(p => p.first_name === first).id;
await rpcOk(members.alice, 'sign_up', { p_player_id: await mine(members.alice, 'Alice') });
await rpcOk(members.yara, 'sign_up', { p_player_id: await mine(members.yara, 'Yara') });
await rpcOk(members.yara, 'sign_up', { p_player_id: await mine(members.yara, 'Zack') });
await setClock(at(s.signups_open_at, 3 * hour));
await rpcOk(dev, 'dev_simulate_signups', { p_count: 10 });
const lineup = (await rpcOk(dev, 'dev_scheduler_data')).lineup;
assert.equal(lineup.filter(p => p.has_spot).length, 8);

console.log('Before 8pm');
await check('at Saturday 3pm nothing is due, and the Designated Courts page is not ready', async () => {
  await setClock(at(s.signups_close_at, 3 * hour));
  const r = await runTasks();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.tasks, []);
  const c = await rpcOk(members.alice, 'my_courts');
  assert.equal(c.ready, false);
  assert.equal(c.courts, null);
});

await check('at 5pm with the courts unlocked, developers get one reminder', async () => {
  await setClock(at(s.signups_close_at, 5 * hour));
  const r = await runTasks();
  assert.deepEqual(r.data.tasks, ['lock_reminder']);
  assert.deepEqual((await runTasks()).data.tasks, [], 'the reminder is sent only once');
  const mail = await inbox();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'dev@example.com');
  assert.match(mail[0].subject, /lock the courts/);
});

// Lock at 6pm. Zack had a spot but is swapped out for waitlist #1.
await setClock(at(s.signups_close_at, 6 * hour));
const byName = n => lineup.find(p => `${p.first_name} ${p.last_name}` === n);
const spots = lineup.filter(p => p.has_spot && p.first_name !== 'Zack');
const wl1 = lineup.find(p => p.waitlist_place === 1);
const onCourts = [...spots, wl1];
const courts = [0, 1].map(i => ({
  court: i + 1,
  players: onCourts.slice(i * 4, i * 4 + 4).map((p, j) => ({ player_id: p.id, brings_balls: j === 0 }))
}));
await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: courts });
await clearInbox();

console.log('8pm');
let published;
await check('at 8pm the court email goes to every assigned player, and the no-spot email to everyone left over', async () => {
  await setClock(s.courts_publish_at);
  const r = await runTasks();
  assert.deepEqual(r.data.tasks, ['publish']);
  assert.deepEqual(r.data.failed, []);
  published = await inbox();
  const courtMail = published.filter(m => /court assignments/.test(m.subject));
  const noSpotMail = published.filter(m => /no court spot/.test(m.subject));
  assert.equal(courtMail.length, 8, 'one per assigned player (each on their own account here)');
  assert.equal(noSpotMail.length, 5, 'Zack plus waitlist #2 to #5');
  assert.equal(r.data.sent, 13);
});

await check('the court email lists every court, marks ball-bringers and shows the waitlist', async () => {
  const body = await text(published.find(m => m.to === 'alice.johnson@example.com').id);
  assert.match(body, /Court 1: Alice Johnson\*/);
  assert.match(body, /Court 2: /);
  assert.equal((body.match(/\*,|\*\n/g) || []).length, 2, 'one ball-bringer per court');
  assert.match(body, /Wait list, in order: /);
  assert.match(body, /courts\.html/);
});

await check('no-spot emails are addressed to the player, with their waitlist place if they had one', async () => {
  const zack = published.find(m => /no court spot/.test(m.subject) && m.to === 'yara.green@example.com');
  const zackText = await text(zack.id);
  assert.match(zackText, /^Hello Zack,/);
  assert.doesNotMatch(zackText, /on the waitlist/, 'Zack had a spot, so no waitlist place');
  const wl2 = lineup.find(p => p.waitlist_place === 2);
  const wl2Mail = published.find(m => /no court spot/.test(m.subject) && m.to === wl2.first_name.toLowerCase() + '.' + wl2.last_name.toLowerCase() + '@example.com');
  assert.match(await text(wl2Mail.id), /You were #2 on the waitlist/);
});

await check('running the tasks again sends nothing more', async () => {
  assert.deepEqual((await runTasks()).data.tasks, []);
  assert.equal((await inbox()).length, 13);
});

await check('every email sent is logged', async () => {
  const log = (await call(`/rest/v1/email_log?select=kind,to_email,error&session_id=eq.${s.id}`, { token: dev, method: 'GET' })).data;
  const kinds = log.reduce((m, l) => ({ ...m, [l.kind]: (m[l.kind] || 0) + 1 }), {});
  assert.deepEqual(kinds, { lock_reminder: 1, courts: 8, no_spot: 5 });
  assert.ok(log.every(l => l.error === null));
});

console.log('Designated Courts page');
await check('from 8pm any member sees all courts, ball-bringers and the waitlist', async () => {
  const c = await rpcOk(members.yara, 'my_courts');
  assert.equal(c.ready, true);
  assert.equal(c.courts.length, 2);
  assert.ok(c.courts.every(ct => ct.players.length === 4 && ct.players.filter(p => p.brings_balls).length === 1));
  assert.equal(c.waitlist.length, 4);
  assert.ok(!JSON.stringify(c.courts).match(/level|sex|email/), 'names only');
});

console.log('Courts never locked');
await check('if the courts are not locked by 8pm, developers get an alert and nothing goes to players', async () => {
  await clearInbox();
  const nextSat8pm = at(s.courts_publish_at, 7 * 24 * hour);
  await setClock(nextSat8pm);
  const r = await runTasks();
  assert.deepEqual(r.data.tasks, ['not_locked_alert']);
  const mail = await inbox();
  assert.deepEqual(mail.map(m => m.to), ['dev@example.com']);
  const c = await rpcOk(members.alice, 'my_courts');
  assert.equal(c.ready, false);
  assert.equal(c.not_locked, true);
});

console.log('Access rules');
await check('members and visitors cannot run the timed tasks or claim them directly', async () => {
  assert.equal((await runTasks(members.alice)).status, 403);
  assert.equal((await call('/functions/v1/timed-tasks', { body: {} })).status >= 400, true);
  await rpcFails(members.alice, 'claim_due_tasks', {});
  await rpcFails(dev, 'claim_due_tasks', {});
  const log = await call('/rest/v1/email_log?select=*', { token: members.alice, method: 'GET' });
  assert.deepEqual(log.data, []);
});

await setClock(null);
summary();
