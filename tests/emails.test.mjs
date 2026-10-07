// End-to-end test of the Emails and schedule page's backend: editable email
// wording, the setup-invite, the Monday play-invite, "off the waitlist"
// emails, and the adjustable schedule. LOCAL Supabase only.
// Run all tests with: tests/run.sh
import { assert, call, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, minute, at, MAIL, SERVICE_KEY } from './lib.mjs';

const hour = 60 * minute;
const runTasks = async () => call('/functions/v1/timed-tasks', { token: SERVICE_KEY, body: {} });
async function inbox() {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.map(m => ({ id: m.ID, to: m.To[0].Address, subject: m.Subject }));
}
const text = async id => (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()).Text;

await clearInbox();
const dev = await bootstrapDeveloper();
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
await setClock(null);
const s = (await rpcOk(dev, 'dev_week')).session;
const members = {};

console.log('Setup-invite');
await check('the setup-invite uses the app wording, names the linked players, and its link works', async () => {
  await clearInbox();
  assert.equal((await inviteAsDeveloper(dev, 'yara.green@example.com')).status, 200);
  const [mail] = await inbox();
  assert.equal(mail.subject, 'Your invitation to STA - STA Members App');
  const body = await text(mail.id);
  assert.match(body, /^Hello Yara Green,/);
  assert.match(body, /expires after 24 hours/);
  assert.match(body, /What the app stores/);
  members.yara = await acceptInvite('yara.green@example.com', PW);
  assert.equal(await rpcOk(dev, 'is_developer'), true);
});

await check('an edited setup-invite is used for the next invite', async () => {
  const r = await call('/rest/v1/email_templates', { token: dev, body: {
    key: 'setup_invite', subject: 'Welcome, {{player_names}}!', body: 'Set your password here: {{link}}\n' } });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  await clearInbox();
  assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
  const [mail] = await inbox();
  assert.equal(mail.subject, 'Welcome, Alice Johnson!');
  members.alice = await acceptInvite('alice.johnson@example.com', PW);
  await call('/rest/v1/email_templates?key=eq.setup_invite', { token: dev, method: 'DELETE' });
});

await check('members cannot read or change email wording or the schedule', async () => {
  const read = await call('/rest/v1/email_templates?select=*', { token: members.alice, method: 'GET' });
  assert.deepEqual(read.data, []);
  const write = await call('/rest/v1/email_templates', { token: members.alice, body: { key: 'no_spot', subject: 'x', body: 'y' } });
  assert.ok(write.status >= 400);
  await rpcFails(members.alice, 'dev_save_schedule', { p_rows: [] }, /Developers only/);
  const page = await call('/functions/v1/email-admin', { token: members.alice, body: {} });
  assert.equal(page.status, 403);
});

await check('the Emails page gets every email with its wording, and the schedule', async () => {
  const r = await call('/functions/v1/email-admin', { token: dev, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.emails.length, 17);
  assert.ok(r.data.emails.every(e => e.subject && e.body && e.sent && e.to && e.edited === null));
  assert.equal(r.data.schedule.length, 10);
});

console.log('Play-invite');
await check('when sign-ups open, the play-invite goes once to current members who have set up their account', async () => {
  // Bob is a current member without an account; Carol has an account but lapsed.
  await inviteAsDeveloper(dev, 'carol.lee@example.com');
  await acceptInvite('carol.lee@example.com', PW);
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: false } });
  await call('/rest/v1/email_templates', { token: dev, body: {
    key: 'play_invite', subject: 'Custom: sign up for {{date}}', body: 'Sign up: {{signup_link}}\n' } });
  await clearInbox();
  await setClock(at(s.signups_open_at, -minute));
  assert.deepEqual((await runTasks()).data.tasks, [], 'nothing before sign-ups open');
  await setClock(s.signups_open_at);
  assert.deepEqual((await runTasks()).data.tasks, ['play_invite']);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
  const mail = await inbox();
  assert.deepEqual(mail.map(m => m.to).sort(), ['alice.johnson@example.com', 'dev@example.com', 'yara.green@example.com']);
  assert.match(mail[0].subject, /^Custom: sign up for October \d+/);
  assert.match(await text(mail[0].id), /^Sign up: \S+\/app\/signup\.html$/m, 'links to the Sunday Doubles sign-up tab');
  await call('/rest/v1/email_templates?key=eq.play_invite', { token: dev, method: 'DELETE' });
});

console.log('Off the waitlist');
const mine = async (token, first) => (await rpcOk(token, 'my_week')).players.find(p => p.first_name === first).id;
await check('when a player cancels, whoever moves off the waitlist gets the "good news" email', async () => {
  await clearInbox();
  await setClock(at(s.signups_open_at, hour));
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 1 });
  await rpcOk(members.alice, 'sign_up', { p_player_id: await mine(members.alice, 'Alice') });
  await setClock(at(s.signups_open_at, 2 * hour));
  if (!members.zack) {
    assert.equal((await inviteAsDeveloper(dev, 'zack.baker@example.com')).status, 200);
    members.zack = await acceptInvite('zack.baker@example.com', PW);
  }
  // Fill the court with 3 random players, but not Yara or Zack (simulated
  // sign-ups skip Inactive members, so they're Inactive meanwhile).
  const setCurrent = v => call('/rest/v1/accounts?email=in.(yara.green@example.com,zack.baker@example.com)',
    { token: dev, method: 'PATCH', body: { membership_current: v } });
  await setCurrent(false);
  await rpcOk(dev, 'dev_simulate_signups', { p_count: 3 });   // courts full
  await setCurrent(true);
  await setClock(at(s.signups_open_at, 3 * hour));
  await rpcOk(members.yara, 'sign_up', { p_player_id: await mine(members.yara, 'Yara') }); // waitlist #1
  await rpcOk(members.zack, 'sign_up', { p_player_id: await mine(members.zack, 'Zack') }); // waitlist #2
  await rpcOk(members.alice, 'cancel_signup', { p_player_id: await mine(members.alice, 'Alice') });
  assert.deepEqual((await runTasks()).data.tasks, ['moved_off_waitlist']);
  const [mail] = await inbox();
  assert.equal(mail.to, 'yara.green@example.com');
  assert.match(mail.subject, /good news, you have a spot/);
  assert.match(await text(mail.id), /^Hello Yara,/);
  assert.deepEqual((await runTasks()).data.tasks, [], 'sent only once');
});

await check('adding a court moves waitlisted players up and emails them too', async () => {
  await clearInbox();
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 });
  assert.deepEqual((await runTasks()).data.tasks, ['moved_off_waitlist']);
  const [mail] = await inbox();
  assert.match(await text(mail.id), /^Hello Zack,/);
});

await check('any email can be switched Off in Settings (except the invitation), by developers only', async () => {
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'moved_off_waitlist', p_enabled: false });
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 1 });
  await clearInbox();
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 });
  await runTasks();
  assert.equal((await inbox()).length, 0, 'switched off: not sent');
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'moved_off_waitlist', p_enabled: true });
  await rpcFails(dev, 'dev_set_email_switch', { p_key: 'setup_invite', p_enabled: false }, /can't be switched off/);
  await rpcFails(members.alice, 'dev_set_email_switch', { p_key: 'play_invite', p_enabled: false }, /Developers only/);
  await rpcFails(members.alice, 'dev_email_switches', {}, /Developers only/);
});

await check('with the switch off, nobody is emailed about moving up', async () => {
  await rpcOk(dev, 'dev_save_schedule', { p_rows: [{ key: 'moved_off_waitlist', enabled: false }] });
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 1 }); // Zack back on the waitlist
  await clearInbox();
  await rpcOk(dev, 'dev_set_num_courts', { p_session_id: s.id, p_num_courts: 2 }); // and up again
  assert.deepEqual((await runTasks()).data.tasks, []);
  assert.equal((await inbox()).length, 0);
  await rpcOk(dev, 'dev_save_schedule', { p_rows: [{ key: 'moved_off_waitlist', enabled: true }] });
});

console.log('Schedule');
await check('impossible schedules are refused', async () => {
  await rpcFails(dev, 'dev_save_schedule', { p_rows: [{ key: 'dev_reminder_1', days_before_sunday: 1, at_time: '21:00' }] },
    /between sign-ups closing and the player emails/);
  await rpcFails(dev, 'dev_save_schedule', { p_rows: [{ key: 'signups_open', days_before_sunday: 1, at_time: '13:00' }] },
    /open before they close/);
  await rpcFails(dev, 'dev_save_schedule', { p_rows: [{ key: 'dev_reminder_1', days_before_sunday: 1, at_time: '19:30' }] },
    /first reminder must come before the final reminder/);
  await rpcFails(dev, 'dev_save_schedule', { p_rows: [{ key: 'late_lock_until', days_before_sunday: 0, at_time: '10:00' }] },
    /no later than 9am Sunday/);
  await rpcFails(dev, 'dev_save_schedule', { p_rows: [{ key: 'nonsense', enabled: false }] }, /Unknown/);
  const sched = await rpcOk(dev, 'dev_schedule');
  assert.equal(sched.find(r => r.key === 'dev_reminder_1').at_time, '16:00:00', 'a refused save changes nothing');
});

await check('a developer can move the first reminder to 3pm, and it goes out then', async () => {
  await rpcOk(dev, 'dev_save_schedule', { p_rows: [{ key: 'dev_reminder_1', days_before_sunday: 1, at_time: '15:00' }] });
  const sat3pm = at(s.signups_close_at, 3 * hour);
  await setClock(at(sat3pm, -minute));
  await runTasks(); // the "time to run the Scheduler" email
  await clearInbox();
  await setClock(sat3pm);
  assert.deepEqual((await runTasks()).data.tasks, ['dev_reminder_1']);
});

await check('turning off a developer email stops it', async () => {
  await rpcOk(dev, 'dev_save_schedule', { p_rows: [{ key: 'dev_reminder_2', enabled: false }] });
  await setClock(at(s.signups_close_at, 7 * hour)); // 7pm
  assert.deepEqual((await runTasks()).data.tasks, []);
});

await check('new sign-up times apply to the coming week if its sign-ups have not opened yet', async () => {
  const next = at(s.signups_open_at, 7 * 24 * hour - hour); // next week, before sign-ups open
  await setClock(next);
  const before = (await rpcOk(dev, 'dev_week')).session;
  const msg = await rpcOk(dev, 'dev_save_schedule', { p_rows: [{ key: 'signups_open', days_before_sunday: 5, at_time: '10:00' }] });
  assert.match(msg, /from this coming week/);
  const after = (await rpcOk(dev, 'dev_week')).session;
  const et = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  assert.equal(et(before.signups_open_at), 'Mon 9:00 AM');
  assert.equal(et(after.signups_open_at), 'Tue 10:00 AM');
});

await setClock(null);
summary();
