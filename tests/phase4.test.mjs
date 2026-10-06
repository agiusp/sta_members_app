// End-to-end test of Phase 4 (Saturday developer reminders, 8pm court and
// no-spot emails, Designated Courts page) against the LOCAL Supabase and its test
// inbox. Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at, MAIL, SERVICE_KEY } from './lib.mjs';

await clearInbox();
const dev = await bootstrapDeveloper();
const members = {};
for (const email of ['alice.johnson@example.com', 'yara.green@example.com', 'zack.baker@example.com']) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  members[email.split('.')[0]] = await acceptInvite(email, PW);
}
// A second developer, who hasn't set up an account: reminders still go to them.
await call('/rest/v1/accounts?email=eq.bob.smith@example.com', { token: dev, method: 'PATCH', body: { is_developer: true } });
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
await rpcOk(members.zack, 'sign_up', { p_player_id: await mine(members.zack, 'Zack') });
await setClock(at(s.signups_open_at, 3 * hour));
await rpcOk(dev, 'dev_simulate_signups', { p_count: 10 });
const lineup = (await rpcOk(dev, 'dev_scheduler_data')).lineup;
assert.equal(lineup.filter(p => p.has_spot).length, 8);

const devEmails = ['bob.smith@example.com', 'dev@example.com'];
const sat = h => at(s.signups_close_at, (h - 12) * hour); // Saturday at hour h (Eastern)
async function devMail() {
  const mail = await inbox();
  assert.ok(mail.every(m => devEmails.includes(m.to)), 'developer emails go only to developers');
  return mail;
}

console.log('Saturday developer reminders (courts not locked)');
await check('at 12:01 every developer is told sign-ups are closed and it is time to run the Scheduler', async () => {
  await setClock(sat(12) );
  assert.deepEqual((await runTasks()).data.tasks, [], 'nothing at 12:00 exactly');
  await setClock(at(sat(12), minute));
  const r = await runTasks();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.tasks, ['dev_scheduler_open']);
  const mail = await devMail();
  assert.deepEqual(mail.map(m => m.to).sort(), devEmails);
  assert.match(mail[0].subject, /Sign-ups are closed .*time to set up the courts/);
  const body = await text(mail[0].id);
  assert.match(body, /13 player\(s\) signed up for 8 spots, with 5 on the waitlist/);
  assert.match(body, /scheduler\.html/);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
});

await check('at 3pm nothing new is due, and the Designated Courts page is not ready', async () => {
  await setClock(sat(15));
  assert.deepEqual((await runTasks()).data.tasks, []);
  const c = await rpcOk(members.alice, 'my_courts');
  assert.equal(c.ready, false);
  assert.equal(c.courts, null);
});

await check('at 4pm, still unlocked: a reminder to every developer', async () => {
  await clearInbox();
  await setClock(sat(16));
  assert.deepEqual((await runTasks()).data.tasks, ['dev_reminder_1']);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
  const mail = await devMail();
  assert.equal(mail.length, 2);
  assert.match(mail[0].subject, /^Reminder: the courts for .* are not locked yet/);
});

await check('at 7pm, still unlocked: a final reminder to every developer', async () => {
  await clearInbox();
  await setClock(sat(19));
  assert.deepEqual((await runTasks()).data.tasks, ['dev_reminder_2']);
  const mail = await devMail();
  assert.equal(mail.length, 2);
  assert.match(mail[0].subject, /^Final reminder/);
  assert.match(await text(mail[0].id), /no court emails go out to players/);
});

// Dana Developer locks at 7:30pm. Zack had a spot but is swapped out for waitlist #1.
await setClock(sat(19.5));
const spots = lineup.filter(p => p.has_spot && p.first_name !== 'Zack');
const wl1 = lineup.find(p => p.waitlist_place === 1);
const onCourts = [...spots, wl1];
const courts = [0, 1].map(i => ({
  court: i + 1,
  players: onCourts.slice(i * 4, i * 4 + 4).map((p, j) => ({ player_id: p.id, brings_balls: j === 0 }))
}));
await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: courts });

console.log('7:45pm');
await check('at 7:45, developers get the arrangement, who locked it, and the 8pm reminder', async () => {
  await clearInbox();
  await setClock(sat(19.5) );
  assert.deepEqual((await runTasks()).data.tasks, [], 'nothing before 7:45');
  await setClock(sat(19.75));
  assert.deepEqual((await runTasks()).data.tasks, ['preview']);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
  const mail = await devMail();
  assert.equal(mail.length, 2);
  assert.match(mail[0].subject, /^Courts for .* are locked: player emails go out at 8pm/);
  const body = await text(mail[0].id);
  assert.match(body, /arranged and locked by Dana Developer \(dev@example\.com\) at 7:30 PM/);
  assert.match(body, /Court 1: Alice Johnson\*/);
  assert.match(body, /Court 2: /);
  assert.match(body, /At 8pm, every playing member will be emailed/);
  assert.match(body, /5 player\(s\) without a court/);
});

await check('if the courts are unlocked and re-locked after 7:45, developers get an updated copy', async () => {
  await clearInbox();
  await setClock(sat(19.8));
  await rpcOk(dev, 'dev_unlock_courts');
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: courts });
  assert.deepEqual((await runTasks()).data.tasks, ['preview']);
  const mail = await devMail();
  assert.equal(mail.length, 2);
  assert.match(mail[0].subject, /^Updated: Courts for/);
});
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
  const zack = published.find(m => /no court spot/.test(m.subject) && m.to === 'zack.baker@example.com');
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
  assert.deepEqual(kinds, { dev_scheduler_open: 2, dev_reminder_1: 2, dev_reminder_2: 2, dev_courts_locked: 4, court_assignments: 8, no_spot: 5 });
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

// Opens week n (n weeks after the first), signs up k random players on
// Monday, and returns the session plus a helper for Saturday times.
async function openWeek(n, k) {
  await setClock(at(s.signups_open_at, n * 7 * 24 * hour + hour));
  const wk = (await rpcOk(dev, 'dev_week')).session;
  if (k) await rpcOk(dev, 'dev_simulate_signups', { p_count: k });
  const wsat = h => at(wk.signups_close_at, (h - 12) * hour);
  return { wk, wsat };
}
const weekLineup = async () => (await rpcOk(dev, 'dev_scheduler_data')).lineup;

console.log('Courts not locked by 8pm, then locked late');
let week1;
await check('if the courts are not locked by 8pm, developers are alerted that they can still lock until 7am Sunday', async () => {
  week1 = await openWeek(1, 10);
  await clearInbox();
  await setClock(week1.wsat(20));
  const r = await runTasks();
  assert.deepEqual(r.data.tasks, ['not_locked_alert'], 'reminders whose time has passed are skipped, not sent late');
  const mail = await inbox();
  assert.deepEqual(mail.map(m => m.to).sort(), devEmails);
  assert.match(await text(mail[0].id), /You can still lock them in the Scheduler until 7:00 AM Sunday/);
  const c = await rpcOk(members.alice, 'my_courts');
  assert.equal(c.ready, false);
  assert.equal(c.not_locked, true);
  assert.deepEqual((await runTasks()).data.tasks, [], 'the alert is sent only once');
});

await check('a late lock at 9pm sends the court and no-spot emails on the next run, and is final at once', async () => {
  await clearInbox();
  await setClock(week1.wsat(21));
  const lu = await weekLineup();
  const four = lu.slice(0, 4).map((p, j) => ({ player_id: p.id, brings_balls: j === 0 }));
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: [{ court: 1, players: four }] });
  await rpcFails(dev, 'dev_unlock_courts', {}, /final/);
  const r = await runTasks();
  assert.deepEqual(r.data.tasks, ['publish']);
  const mail = await inbox();
  assert.equal(mail.filter(m => /court assignments/.test(m.subject)).length, 4);
  assert.equal(mail.filter(m => /no court spot/.test(m.subject)).length, 6);
  assert.equal((await rpcOk(members.alice, 'my_courts')).ready, true);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
});

await check('after 7am Sunday it is too late to lock', async () => {
  const w = await openWeek(3, 8);
  await setClock(w.wsat(20));
  await runTasks();
  // Sunday 7:00am (from the app, so it's right on the weekend the clocks change).
  await setClock((await rpcOk(dev, 'dev_week_times')).late_lock_until);
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: [] }, /too late/);
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: null, p_courts: [], p_mode: 'rain_expected' }, /too late/);
});

console.log('Weather options');
await check('rain-out expected: no reminders, a 7:45 summary, and at 8pm the rain email to everyone signed up', async () => {
  const w = await openWeek(4, 10);
  await clearInbox();
  await setClock(w.wsat(14));
  await rpcFails(dev, 'dev_lock_courts', { p_org_play: null, p_mode: 'rain_expected',
    p_courts: [{ court: 1, players: [{ player_id: (await weekLineup())[0].id }] }] }, /No courts are assigned/);
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: null, p_courts: [], p_mode: 'rain_expected' });
  for (const h of [16, 19]) {
    await setClock(w.wsat(h));
    assert.deepEqual((await runTasks()).data.tasks, [], `no reminder at ${h}:00`);
  }
  await setClock(w.wsat(19.75));
  assert.deepEqual((await runTasks()).data.tasks, ['preview']);
  const preview = await devMail();
  assert.match(preview[0].subject, /Rain-out expected/);
  assert.match(await text(preview[0].id), /all 10 signed-up player\(s\), including the waitlist/);

  await clearInbox();
  await setClock(w.wsat(20));
  assert.deepEqual((await runTasks()).data.tasks, ['weather']);
  const mail = await inbox();
  assert.equal(mail.length, 10, 'everyone signed up, waitlist included');
  assert.ok(mail.every(m => /rain-out expected, no courts assigned/.test(m.subject)));
  const body = await text(mail[0].id);
  assert.match(body, /The forecast for tomorrow looks pretty bad, so we expect a rain-out/);
  assert.match(body, /welcome to show up at 9am and enjoy self-organized play/);
  const c = await rpcOk(members.alice, 'my_courts');
  assert.equal(c.ready, true);
  assert.equal(c.week_mode, 'rain_expected');
  assert.equal(c.courts, null);
});

await check('uncertain weather chosen late (9pm): the self-organized email goes out right away', async () => {
  const w = await openWeek(5, 6);
  await setClock(w.wsat(20));
  await runTasks(); // the "not locked" alert
  await clearInbox();
  await setClock(w.wsat(21));
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: null, p_courts: [], p_mode: 'self_organized' });
  assert.deepEqual((await runTasks()).data.tasks, ['weather']);
  const mail = await inbox();
  assert.equal(mail.length, 6);
  assert.match(mail[0].subject, /self-organized play, no courts assigned/);
  assert.match(await text(mail[0].id), /The forecast for tomorrow is not looking good/);
  assert.equal((await rpcOk(members.alice, 'my_courts')).week_mode, 'self_organized');
});

await check('a weather email sent after midnight (late lock on Sunday) says "today", not "tomorrow"', async () => {
  const w = await openWeek(6, 4);
  await setClock(w.wsat(20));
  await runTasks(); // the "not locked" alert
  await clearInbox();
  await setClock(at(w.wsat(12), 13 * hour)); // Sunday 1:00am
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: null, p_courts: [], p_mode: 'rain_expected' });
  assert.deepEqual((await runTasks()).data.tasks, ['weather']);
  const mail = await inbox();
  assert.match(await text(mail[0].id), /The forecast for today looks pretty bad/);
});

console.log('Courts locked early');
await check('if the courts are locked before 4pm, the 4pm and 7pm reminders are skipped', async () => {
  const { wsat } = await openWeek(2, 8);
  await clearInbox();
  await setClock(at(wsat(12), minute));
  assert.deepEqual((await runTasks()).data.tasks, ['dev_scheduler_open']);
  await setClock(wsat(15));
  await rpcOk(dev, 'dev_lock_courts', { p_org_play: 'mixed', p_courts: [] });
  for (const h of [16, 19]) {
    await setClock(wsat(h));
    assert.deepEqual((await runTasks()).data.tasks, [], `nothing at ${h}:00`);
  }
  await setClock(wsat(19.75));
  assert.deepEqual((await runTasks()).data.tasks, ['preview']);
});

console.log('Developers');
await check('there must always be at least one developer', async () => {
  await call('/rest/v1/accounts?email=eq.bob.smith@example.com', { token: dev, method: 'PATCH', body: { is_developer: false } });
  const r = await call('/rest/v1/accounts?email=eq.dev@example.com', { token: dev, method: 'PATCH', body: { is_developer: false } });
  assert.ok(r.status >= 400, JSON.stringify(r.data));
  assert.match(r.data.message, /at least one Active developer/);
  assert.equal(await rpcOk(dev, 'is_developer'), true);
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
