// End-to-end test of the Casual Play calendar: posting and taking back
// availability, what others see, settings, and singles/doubles match emails.
// LOCAL Supabase only. Run all tests with: tests/run.sh (or scripts/test-in-copy.sh)
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper,
         bootstrapDeveloper, clearInbox, summary, PW, MAIL, SERVICE_KEY } from './lib.mjs';

const runTasks = async () => call('/functions/v1/timed-tasks', { token: SERVICE_KEY, body: {} });
async function casualMail() {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.filter(m => /^Casual Play/.test(m.Subject)).map(m => ({ id: m.ID, to: m.To[0].Address }));
}
const text = async id => (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()).Text;

await clearInbox();
const dev = await bootstrapDeveloper();
// Monday November 9, 2026, 8:00am Eastern.
await rpcOk(dev, 'dev_set_test_clock', { p_clock: '2026-11-09T13:00:00Z' });
const TUE = '2026-11-10';

const m = {};
for (const [key, email] of [['alice', 'alice.johnson@example.com'], ['bob', 'bob.smith@example.com'],
                            ['carol', 'carol.lee@example.com'], ['yara', 'yara.green@example.com'],
                            ['henry', 'henry.moore@example.com']]) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  m[key] = await acceptInvite(email, PW);
}
const cal = token => rpcOk(token, 'casual_calendar');
const player = async (token, first) => (await cal(token)).players.find(p => p.first_name === first).id;
const id = {
  alice: await player(m.alice, 'Alice'), bob: await player(m.bob, 'Bob'), carol: await player(m.carol, 'Carol'),
  yara: await player(m.yara, 'Yara'), zack: await player(m.yara, 'Zack'), henry: await player(m.henry, 'Henry'),
  dana: await player(dev, 'Dana')
};
const submit = (token, playerId, date, start, minutes, type, show) =>
  rpc(token, 'casual_submit', { p_player_id: playerId, p_date: date, p_start: start, p_minutes: minutes,
                                ...(type ? { p_play_type: type } : {}), ...(show === undefined ? {} : { p_show_name: show }) });

console.log('Calendar');
await check('members see 4 weeks from today, the 6 level choices, and their own level chosen at first', async () => {
  const c = await cal(m.alice);
  assert.equal(c.today, '2026-11-09');
  assert.equal(c.days, 28);
  assert.equal(c.now_minutes, 8 * 60);
  assert.deepEqual(c.levels, ['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+']);
  assert.deepEqual(c.prefs, { show_name: false, notify: false, levels: ['3.5'], saved: false });
  assert.deepEqual(c.slots, []);
  assert.ok((await rpc(null, 'casual_calendar')).status >= 400, 'not for signed-out visitors');
});

console.log('Posting');
await check('a member posts 1, 1.5 and 2 hour times', async () => {
  for (const [start, minutes] of [['06:00', 60], ['09:00', 90], ['19:00', 120]]) {
    const r = await submit(m.alice, id.alice, TUE, start, minutes);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const mine = (await cal(m.alice)).slots;
  assert.deepEqual(mine.map(s => [s.day, s.start, s.minutes, s.mine, s.name]),
    [[TUE, 360, 60, true, 'Alice Johnson'], [TUE, 540, 90, true, 'Alice Johnson'], [TUE, 1140, 120, true, 'Alice Johnson']]);
});

await check('times must be on the hour or half hour, 6am to 9pm, 1 to 2 hours, in the next 4 weeks, and not started', async () => {
  const fails = async (date, start, minutes, pattern) => {
    const r = await submit(m.bob, id.bob, date, start, minutes);
    assert.ok(r.status >= 400, `${date} ${start} ${minutes} should fail`);
    assert.match(r.data.message, pattern);
  };
  await fails(TUE, '05:30', 60, /6am and 9pm/);
  await fails(TUE, '20:30', 60, /6am and 9pm/);
  await fails(TUE, '19:30', 120, /6am and 9pm/);
  await fails(TUE, '09:15', 60, /hour or half hour/);
  await fails(TUE, '09:00', 45, /1, 1.5 or 2 hours/);
  await fails(TUE, '09:00', 150, /1, 1.5 or 2 hours/);
  await fails('2026-12-07', '09:00', 60, /next 4 weeks/);
  await fails('2026-11-08', '09:00', 60, /next 4 weeks/);
  await fails('2026-11-09', '08:00', 60, /already started/);
  assert.equal((await submit(m.bob, id.bob, '2026-11-09', '08:30', 60)).status, 200, 'later today is fine');
  assert.equal((await submit(m.bob, id.bob, '2026-12-06', '20:00', 60)).status, 200, 'the 28th day is fine');
});

await check('a player cannot overlap their own times, or post for someone else\'s player', async () => {
  const r = await submit(m.alice, id.alice, TUE, '10:00', 60);
  assert.match(r.data.message, /already available/);
  assert.match((await submit(m.alice, id.bob, TUE, '12:00', 60)).data.message, /not linked to your account/);
  assert.equal((await submit(m.yara, id.zack, TUE, '09:00', 60)).status, 200, 'family members can be posted for');
});

await check('members whose membership lapsed cannot post', async () => {
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: false } });
  assert.match((await submit(m.carol, id.carol, TUE, '12:00', 60)).data.message, /membership/);
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: true } });
});

console.log('What others see');
await check('others see sex and level, but not the name unless "Show my name" is on, nor slot ids', async () => {
  let s = (await cal(m.carol)).slots.find(x => x.day === TUE && x.start === 540 && x.level === '3.5');
  assert.deepEqual(s, { id: null, player_id: null, mine: false, day: TUE, start: 540, minutes: 90, play_type: 'either',
                        level: '3.5', sex: 'F', shown: false, name: null, lines_up: null });
  await rpcOk(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5'] });
  s = (await cal(m.carol)).slots.find(x => x.day === TUE && x.start === 540 && x.level === '3.5');
  assert.equal(s.name, 'Alice Johnson');
});

await check('the tables cannot be read or changed directly', async () => {
  const read = await call('/rest/v1/casual_slots?select=*', { token: m.carol, method: 'GET' });
  assert.ok(read.status >= 400, JSON.stringify(read.data));
  const write = await call('/rest/v1/casual_slots', { token: m.carol, body: { player_id: id.carol, starts_at: '2026-11-10T15:00:00Z', minutes: 60 } });
  assert.ok(write.status >= 400);
  assert.ok((await rpc(m.carol, 'claim_casual_emails')).status >= 400, 'only the timed-tasks function hands out emails');
  assert.ok((await rpc(m.carol, 'casual_pairs')).status >= 400, 'who lines up with whom is worked out inside the app');
});

console.log('Settings');
await check('1 or 2 levels from the list', async () => {
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: [] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.0', '3.5', '4.0'] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.7'] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5', '3.5'] }, /1 or 2/);
  const p = await rpcOk(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5', '5.0+'] });
  assert.deepEqual(p, { show_name: true, notify: false, levels: ['3.5', '5.0+'], saved: true });
});

console.log('Taking a time back');
await check('a member unsubmits their own time, but not someone else\'s', async () => {
  const slot = (await cal(m.alice)).slots.find(s => s.mine && s.start === 360);
  await rpcFails(m.bob, 'casual_unsubmit', { p_slot_id: slot.id }, /not yours/);
  await rpcOk(m.alice, 'casual_unsubmit', { p_slot_id: slot.id });
  assert.ok(!(await cal(m.alice)).slots.some(s => s.start === 360));
  await rpcFails(m.alice, 'casual_unsubmit', { p_slot_id: slot.id }, /already removed/);
});

console.log('Game emails');
// Clear the times posted so far, then set everyone's settings.
for (const token of [m.alice, m.bob, m.carol, m.yara, m.henry, dev]) {
  for (const s of (await cal(token)).slots.filter(x => x.mine)) await rpcOk(token, 'casual_unsubmit', { p_slot_id: s.id });
}
const prefs = (token, show, notify, levels) => rpcOk(token, 'casual_save_prefs', { p_show_name: show, p_notify: notify, p_levels: levels });
await prefs(m.alice, true, true, ['3.5']);
await prefs(m.bob, true, true, ['3.5']);
await prefs(m.henry, true, true, ['3.5']);
await prefs(dev, true, false, ['3.5']);         // not opted in to game emails
await prefs(m.carol, false, true, ['4.0']);     // hides her name by default
await prefs(m.yara, true, true, ['4.0']);
async function mail(subject) {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.filter(x => subject.test(x.Subject)).map(x => ({ id: x.ID, to: x.To[0].Address, subject: x.Subject }));
}
const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
const to = async subject => (await mail(subject)).map(x => x.to).sort();
const body = async (subject, address) => text((await mail(subject)).find(x => x.to === address).id);
const THU = '2026-11-12', FRI = '2026-11-13', SAT = '2026-11-14', SUN = '2026-11-15', MON = '2026-11-16';
const mineOn = async (token, day, start) => (await cal(token)).slots.find(x => x.mine && x.day === day && (start === undefined || x.start === start));

await check('three players free at the same time each hear about the other two, with names and email addresses', async () => {
  await clearInbox();
  ok(await submit(m.alice, id.alice, THU, '08:00', 90, 'either'));
  assert.ok(!(await runTasks()).data.tasks.includes('casual_games'), 'one player alone: no email');
  ok(await submit(m.bob, id.bob, THU, '08:00', 90, 'either'));
  ok(await submit(m.henry, id.henry, THU, '08:00', 60, 'singles'));
  const r = await runTasks();
  assert.deepEqual(r.data.failed, [], JSON.stringify(r.data));
  const SUBJ = /^Casual Play: players free Thursday, November 12, 8:00 – (9:30|9:00) AM$/;
  assert.deepEqual(await to(SUBJ), ['alice.johnson@example.com', 'bob.smith@example.com', 'henry.moore@example.com']);
  const bobs = await body(SUBJ, 'bob.smith@example.com');
  assert.match(bobs, /^Hello Bob,/);
  assert.match(bobs, /Alice Johnson \(F, 3\.5\) alice\.johnson@example\.com: free 8:00 – 9:30 AM, singles or doubles\r?\n/);
  assert.match(bobs, /Henry Moore \(M, 3\.5\) henry\.moore@example\.com: free 8:00 – 9:00 AM, singles\r?\n/);
  assert.ok(!/\(new\)/.test(bobs), 'nothing is marked new in a first email');
  const bobSlot = await mineOn(m.bob, THU);
  assert.match(bobs, new RegExp(`please remove this time from the Casual Play calendar[^]*?/app/casual\\.html\\?slot=${bobSlot.id}`));
  assert.ok(!(await runTasks()).data.tasks.includes('casual_games'), 'each email goes out once');
  assert.deepEqual((await mineOn(m.henry, THU)).lines_up.map(o => o.name), ['Alice Johnson', 'Bob Smith']);
});

await check('a new player lining up later: those it suits get an updated email, with the new player marked', async () => {
  await clearInbox();
  await prefs(dev, true, true, ['3.5']);                                 // Dana opts in
  ok(await submit(dev, id.dana, THU, '08:30', 60, 'doubles'));            // suits Alice and Bob (Either), not Henry (Singles)
  await runTasks();
  const SUBJ = /^Casual Play: players free Thursday/;
  assert.deepEqual(await to(SUBJ), ['alice.johnson@example.com', 'bob.smith@example.com', 'dev@example.com']);
  const alices = await body(SUBJ, 'alice.johnson@example.com');
  assert.match(alices, /Dana Developer \(F, 3\.5\) dev@example\.com: free 8:30 – 9:30 AM, doubles \(new\)/);
  assert.match(alices, /Henry Moore .*singles\r?\n/, 'everyone who lines up is listed again');
  assert.ok(!/Bob Smith[^\n]*\(new\)/.test(alices));
  assert.ok(!/Henry/.test(await body(SUBJ, 'dev@example.com')), 'doubles and singles do not line up');
  await prefs(dev, true, false, ['3.5']);
});

await check('re-posting a time does not email players again who were already told about that player', async () => {
  await clearInbox();
  await rpcOk(m.bob, 'casual_unsubmit', { p_slot_id: (await mineOn(m.bob, THU)).id });
  ok(await submit(m.bob, id.bob, THU, '08:00', 90, 'either'));
  await runTasks();
  assert.deepEqual(await to(/^Casual Play/), ['bob.smith@example.com'], 'only Bob, for his new time');
});

let carolSlot;
await check('a hidden player is asked to show their name; once shown, both get each other\'s details', async () => {
  await clearInbox();
  ok(await submit(m.yara, id.yara, FRI, '10:00', 60, 'singles'));
  ok(await submit(m.carol, id.carol, FRI, '10:00', 120, 'singles'));   // hidden (her default)
  await runTasks();
  let sent = await mail(/^Casual Play/);
  assert.deepEqual(sent.map(x => x.to), ['carol.lee@example.com'], 'Yara is not told about a hidden player alone');
  assert.equal(sent[0].subject, 'Casual Play: players free Friday, November 13, 10:00 AM – 12:00 PM – show your name to meet them');
  const b = await text(sent[0].id);
  assert.match(b, /Yara Green \(F, 4\.0\): free 10:00 – 11:00 AM, singles\r?\n/, 'the other player\'s name, but not her email');
  assert.ok(!/yara\.green@/.test(b));
  carolSlot = await mineOn(m.carol, FRI);
  assert.match(b, new RegExp(`/app/casual\\.html\\?slot=${carolSlot.id}`));
  assert.ok(!(await runTasks()).data.tasks.includes('casual_games'), 'asked only once');
  assert.deepEqual((await mineOn(m.yara, FRI)).lines_up.map(o => [o.name, o.level]), [[null, '4.0']]);

  await clearInbox();
  await rpcOk(m.carol, 'casual_set_slot_name', { p_slot_id: carolSlot.id, p_show_name: true });
  await runTasks();
  assert.deepEqual(await to(/^Casual Play: players free Friday/), ['carol.lee@example.com', 'yara.green@example.com']);
  assert.match(await body(/^Casual Play/, 'yara.green@example.com'), /Carol Lee \(F, 4\.0\) carol\.lee@example\.com: free 10:00 – 11:00 AM, singles\r?\n/);
  assert.match(await body(/^Casual Play/, 'carol.lee@example.com'), /Yara Green \(F, 4\.0\) yara\.green@example\.com/);
});

await check('shown players are told how many hidden players also line up; the hidden one sees everyone', async () => {
  await clearInbox();
  ok(await submit(m.alice, id.alice, SUN, '09:00', 60, 'either'));
  ok(await submit(m.bob, id.bob, SUN, '09:00', 60, 'either'));
  ok(await submit(m.henry, id.henry, SUN, '09:00', 60, 'doubles', false));   // Henry hides his name for this time
  await runTasks();
  const alices = await body(/^Casual Play: players free Sunday/, 'alice.johnson@example.com');
  assert.match(alices, /Bob Smith/);
  assert.ok(!/henry|Henry/.test(alices));
  assert.match(alices, /1 more player lines up but hasn't shown their name yet\./);
  const henrys = await body(/show your name to meet them$/, 'henry.moore@example.com');
  assert.match(henrys, /Alice Johnson \(F, 3\.5\): free 9:00 – 10:00 AM, singles or doubles/);
  assert.match(henrys, /Bob Smith \(M, 3\.5\): free/);
});

await check('no email unless levels suit both ways, both opted in, the game fits, an hour is shared, and on different accounts', async () => {
  await clearInbox();
  ok(await submit(m.alice, id.alice, SAT, '09:00', 60, 'singles'));     // 3.5; wants 3.5
  ok(await submit(m.carol, id.carol, SAT, '09:00', 60, 'singles'));     // 4.0: Alice didn't choose 4.0
  await prefs(m.carol, false, true, ['4.0', '3.5']);                    // Carol would play a 3.5, but Alice still wouldn't play a 4.0
  ok(await submit(dev, id.dana, SAT, '09:00', 60, 'singles'));          // 3.5, but not opted in
  ok(await submit(m.bob, id.bob, SAT, '09:00', 60, 'doubles'));         // 3.5, but only wants doubles
  ok(await submit(m.henry, id.henry, SAT, '09:30', 60, 'singles'));     // 3.5, singles, but only 30 minutes shared
  ok(await submit(m.yara, id.yara, SAT, '15:00', 60, 'either'));        // Yara and Zack share an account
  ok(await submit(m.yara, id.zack, SAT, '15:00', 60, 'either'));
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), []);
  await prefs(m.carol, false, true, ['4.0']);
});

await check('a time taken back before the email run: nobody is told about it', async () => {
  await clearInbox();
  ok(await submit(m.yara, id.yara, MON, '10:00', 60, 'singles'));
  ok(await submit(m.carol, id.carol, MON, '10:00', 60, 'singles', true));
  await rpcOk(m.carol, 'casual_unsubmit', { p_slot_id: (await mineOn(m.carol, MON)).id });
  const r = await runTasks();
  assert.deepEqual(r.data.failed, []);
  assert.deepEqual(await mail(/^Casual Play/), []);
  assert.deepEqual((await mineOn(m.yara, MON)).lines_up, []);
});

await check('a player who turns game emails on hears about times already posted', async () => {
  await clearInbox();
  await prefs(m.alice, true, false, ['3.5']);
  ok(await submit(m.alice, id.alice, MON, '15:00', 60, 'singles'));
  ok(await submit(m.bob, id.bob, MON, '15:00', 60, 'singles'));
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), [], 'Alice has game emails off');
  await prefs(m.alice, true, true, ['3.5']);
  await runTasks();
  assert.deepEqual(await to(/^Casual Play: players free Monday/), ['alice.johnson@example.com', 'bob.smith@example.com']);
});

await check('a player can have at most 40 upcoming times', async () => {
  for (const x of (await cal(m.henry)).slots.filter(x => x.mine)) await rpcOk(m.henry, 'casual_unsubmit', { p_slot_id: x.id });
  const day = i => new Date(Date.UTC(2026, 10, 17 + Math.floor(i / 2))).toISOString().slice(0, 10);
  for (let i = 0; i < 40; i++) ok(await submit(m.henry, id.henry, day(i), i % 2 ? '18:00' : '07:00', 60));
  assert.match((await submit(m.henry, id.henry, day(39), '12:00', 60)).data.message, /40 upcoming times/);
  for (const x of (await cal(m.henry)).slots.filter(x => x.mine)) await rpcOk(m.henry, 'casual_unsubmit', { p_slot_id: x.id });
});

await check('the email wording is editable like the others', async () => {
  const r = await call('/functions/v1/email-admin', { token: dev, body: {} });
  for (const key of ['casual_game', 'casual_reveal']) assert.ok(r.data.emails.some(x => x.key === key), key);
});

summary();
