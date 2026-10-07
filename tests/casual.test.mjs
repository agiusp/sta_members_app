// End-to-end test of the Casual Play calendar: posting and taking back
// availability, what others see, settings, possible singles and doubles
// games, "Share my contact info for games", and the emails.
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
// Emails go out straight away in most checks below (the wait is tested at the end).
await rpcOk(dev, 'dev_save_casual_settings', { p_email_delay_minutes: 0 });
const TUE = '2026-11-10';

const m = {};
for (const [key, email] of [['alice', 'alice.johnson@example.com'], ['bob', 'bob.smith@example.com'],
                            ['carol', 'carol.lee@example.com'], ['yara', 'yara.green@example.com'], ['zack', 'zack.baker@example.com'],
                            ['henry', 'henry.moore@example.com']]) {
  assert.equal((await inviteAsDeveloper(dev, email)).status, 200);
  m[key] = await acceptInvite(email, PW);
}
const cal = token => rpcOk(token, 'casual_calendar');
const player = async (token, first) => (await cal(token)).players.find(p => p.first_name === first).id;
const id = {
  alice: await player(m.alice, 'Alice'), bob: await player(m.bob, 'Bob'), carol: await player(m.carol, 'Carol'),
  yara: await player(m.yara, 'Yara'), zack: await player(m.zack, 'Zack'), henry: await player(m.henry, 'Henry'),
  dana: await player(dev, 'Dana')
};
const submit = (token, playerId, date, start, minutes, show, share) =>
  rpc(token, 'casual_submit', { p_player_id: playerId, p_date: date, p_start: start, p_minutes: minutes,
                                ...(show === undefined ? {} : { p_show_name: show }),
                                ...(share === undefined ? {} : { p_share_contact: share }) });

console.log('Calendar');
await check('members see 4 weeks from today, the 6 level choices, and their own level chosen at first', async () => {
  const c = await cal(m.alice);
  assert.equal(c.today, '2026-11-09');
  assert.equal(c.days, 28);
  assert.equal(c.now_minutes, 8 * 60);
  assert.deepEqual(c.levels, ['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+']);
  assert.deepEqual(c.prefs, { show_name: false, share_contact: false, notify: false, levels: ['3.5'], saved: false });
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
});

await check('Inactive members cannot post', async () => {
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: false } });
  assert.match((await submit(m.carol, id.carol, TUE, '12:00', 60)).data.message, /Not a member/);
  await call('/rest/v1/accounts?email=eq.carol.lee@example.com', { token: dev, method: 'PATCH', body: { membership_current: true } });
});

console.log('What others see');
await check('others see sex and level, but not the name unless "Show my name" is on, nor slot ids', async () => {
  let s = (await cal(m.carol)).slots.find(x => x.day === TUE && x.start === 540 && x.level === '3.5');
  assert.deepEqual(s, { id: null, player_id: null, mine: false, day: TUE, start: 540, minutes: 90,
                        level: '3.5', sex: 'F', shown: false, shares: null, name: null, lines_up: null, doubles: null });
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
  assert.ok((await rpc(m.carol, 'casual_doubles')).status >= 400);
  assert.ok((await call('/rest/v1/casual_invites?select=*', { token: m.carol, method: 'GET' })).status >= 400);
});

console.log('Settings');
await check('1 or 2 levels from the list', async () => {
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: [] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.0', '3.5', '4.0'] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.7'] }, /1 or 2/);
  await rpcFails(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5', '3.5'] }, /1 or 2/);
  let p = await rpcOk(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5', '5.0+'] });
  assert.deepEqual(p, { show_name: true, share_contact: false, notify: false, levels: ['3.5', '5.0+'], saved: true });
  p = await rpcOk(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5'], p_share_contact: true });
  assert.equal(p.share_contact, true);
  p = await rpcOk(m.alice, 'casual_save_prefs', { p_show_name: true, p_notify: false, p_levels: ['3.5'] });
  assert.equal(p.share_contact, true, 'left out: unchanged');
});

console.log('Taking a time back');
await check('a member unsubmits their own time, but not someone else\'s', async () => {
  const slot = (await cal(m.alice)).slots.find(s => s.mine && s.start === 360);
  await rpcFails(m.bob, 'casual_unsubmit', { p_slot_id: slot.id }, /not yours/);
  await rpcOk(m.alice, 'casual_unsubmit', { p_slot_id: slot.id });
  assert.ok(!(await cal(m.alice)).slots.some(s => s.start === 360));
  await rpcFails(m.alice, 'casual_unsubmit', { p_slot_id: slot.id }, /already removed/);
});

console.log('Possible games');
// Clear the times posted so far, then set everyone's settings.
const clearAll = async () => {
  for (const token of [m.alice, m.bob, m.carol, m.yara, m.zack, m.henry, dev]) {
    for (const s of (await cal(token)).slots.filter(x => x.mine)) await rpcOk(token, 'casual_unsubmit', { p_slot_id: s.id });
  }
};
await clearAll();
const prefs = (token, show, notify, levels, share) =>
  rpcOk(token, 'casual_save_prefs', { p_show_name: show, p_notify: notify, p_levels: levels, p_share_contact: share });
await prefs(m.alice, true, true, ['3.5'], true);
await prefs(m.bob, true, true, ['3.5'], true);
await prefs(m.henry, true, true, ['3.5'], true);
await prefs(dev, true, false, ['3.5'], true);          // no "Email me"
await prefs(m.carol, false, true, ['4.0'], false);     // hides her name, doesn't share
await prefs(m.yara, true, true, ['4.0'], true);
async function mail(subject) {
  const list = await (await fetch(`${MAIL}/api/v1/messages?limit=500`)).json();
  return list.messages.filter(x => subject.test(x.Subject)).map(x => ({ id: x.ID, to: x.To[0].Address, subject: x.Subject }));
}
const ok = r => assert.equal(r.status, 200, JSON.stringify(r.data));
const to = async subject => (await mail(subject)).map(x => x.to).sort();
const body = async (subject, address) => text((await mail(subject)).find(x => x.to === address).id);
const THU = '2026-11-12', FRI = '2026-11-13', SAT = '2026-11-14', SUN = '2026-11-15', MON = '2026-11-16';
const mineOn = async (token, day, start) => (await cal(token)).slots.find(x => x.mine && x.day === day && (start === undefined || x.start === start));
const invite = (token, slot, others) => call('/functions/v1/casual-invite', { token, body: { slot_id: slot, others } });
const slotOf = {};

await check('times line up whatever the email settings; email addresses only go between players who both share', async () => {
  ok(await submit(m.alice, id.alice, THU, '08:00', 90));
  ok(await submit(dev, id.dana, THU, '08:00', 90));                  // Dana has "Email me" off
  slotOf.alice = (await mineOn(m.alice, THU)).id;
  slotOf.dana = (await mineOn(dev, THU)).id;
  let a = await mineOn(m.alice, THU);
  assert.equal(a.shares, true);
  assert.deepEqual(a.lines_up.map(o => [o.slot_id, o.name, o.shares, o.email, o.asked]),
    [[slotOf.dana, 'Dana Developer', true, 'dev@example.com', []]]);
  assert.deepEqual(a.doubles, []);
  await rpcOk(dev, 'casual_set_slot_share', { p_slot_id: slotOf.dana, p_share: false });
  a = await mineOn(m.alice, THU);
  assert.deepEqual(a.lines_up.map(o => [o.name, o.shares, o.email]), [['Dana Developer', false, null]]);
  assert.equal((await mineOn(dev, THU)).lines_up[0].email, null, 'nor the other way round');
  await rpcFails(m.alice, 'casual_set_slot_share', { p_slot_id: slotOf.dana, p_share: true }, /not yours/);
});

await check('a hidden name shows to players in a game once that player shares', async () => {
  ok(await submit(m.carol, id.carol, FRI, '10:00', 60));                 // hidden, not sharing
  ok(await submit(m.yara, id.yara, FRI, '10:00', 60));
  const y = await mineOn(m.yara, FRI);
  assert.deepEqual(y.lines_up.map(o => [o.name, o.level, o.shares, o.email]), [[null, '4.0', false, null]]);
  const c = await mineOn(m.carol, FRI);
  await rpcOk(m.carol, 'casual_set_slot_share', { p_slot_id: c.id, p_share: true });
  assert.deepEqual((await mineOn(m.yara, FRI)).lines_up.map(o => [o.name, o.email]), [['Carol Lee', 'carol.lee@example.com']]);
  assert.ok(!(await cal(m.alice)).slots.some(x => x.name === 'Carol Lee'), 'still hidden on the calendar for everyone else');
  await rpcOk(m.carol, 'casual_unsubmit', { p_slot_id: c.id });
  await rpcOk(m.yara, 'casual_unsubmit', { p_slot_id: y.id });
});

await check('four players who all line up with each other and share an hour make a possible doubles game', async () => {
  ok(await submit(m.bob, id.bob, THU, '08:00', 90));
  ok(await submit(m.henry, id.henry, THU, '08:30', 60));
  slotOf.bob = (await mineOn(m.bob, THU)).id;
  slotOf.henry = (await mineOn(m.henry, THU)).id;
  // Carol would play a 3.5 and Alice a 4.0, but Bob, Henry and Dana only want 3.5.
  await prefs(m.alice, true, true, ['3.5', '4.0'], true);
  await prefs(m.carol, false, true, ['4.0', '3.5'], false);
  ok(await submit(m.carol, id.carol, THU, '08:00', 90));
  const a = await mineOn(m.alice, THU);
  assert.equal(a.lines_up.length, 4, 'singles: all four line up with Alice');
  const four = [slotOf.dana, slotOf.bob, slotOf.henry].sort((x, y) => x - y);
  // 8:30 – 9:30 AM Eastern is the only hour all four share.
  assert.deepEqual(a.doubles, [{ starts_at: '2026-11-12T13:30:00+00:00', others: four }]);
  assert.deepEqual((await mineOn(m.carol, THU)).doubles, [], 'Carol makes no four: the others don\'t suit her');
  assert.equal((await mineOn(m.henry, THU)).doubles[0].others.length, 3);
  await rpcOk(m.carol, 'casual_unsubmit', { p_slot_id: (await mineOn(m.carol, THU)).id });
  await prefs(m.alice, true, true, ['3.5'], true);
  await prefs(m.carol, false, true, ['4.0'], false);
});

console.log('Emailing players who don\'t share');
await check('a player who shares has the app email a singles partner who doesn\'t, once', async () => {
  await clearInbox();
  const r = await invite(m.alice, slotOf.alice, [slotOf.dana]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent, 1);
  const SUBJ = /^Casual Play: Alice Johnson would like a singles game Thursday, November 12, 8:00 – 9:30 AM$/;
  assert.deepEqual(await to(SUBJ), ['dev@example.com']);
  const b = await body(SUBJ, 'dev@example.com');
  assert.match(b, /^Hello Dana,/);
  assert.match(b, /Alice Johnson \(F, 3\.5\) alice\.johnson@example\.com\r?\n/);
  assert.match(b, new RegExp(`/app/casual\\.html\\?slot=${slotOf.dana}`));
  assert.deepEqual((await mineOn(m.alice, THU)).lines_up.find(o => o.slot_id === slotOf.dana).asked, ['singles']);
  assert.match((await invite(m.alice, slotOf.alice, [slotOf.dana])).data.error, /already emailed/);
});

await check('a doubles email goes only to the players who don\'t share, with the others\' names and email addresses', async () => {
  await clearInbox();
  const r = await invite(m.bob, slotOf.bob, [slotOf.alice, slotOf.dana, slotOf.henry]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const SUBJ = /^Casual Play: Bob Smith would like a doubles game Thursday, November 12, 8:30 – 9:30 AM$/;
  assert.deepEqual(await to(/^Casual Play/), ['dev@example.com']);
  const b = await body(SUBJ, 'dev@example.com');
  for (const line of [/Bob Smith \(M, 3\.5\) bob\.smith@example\.com/, /Alice Johnson \(F, 3\.5\) alice\.johnson@example\.com/,
                      /Henry Moore \(M, 3\.5\) henry\.moore@example\.com/]) assert.match(b, line);
  assert.ok(!/Dana/.test(b.replace(/^Hello Dana,/, '')), 'not listed in her own email');
  assert.match((await invite(m.bob, slotOf.bob, [slotOf.alice, slotOf.dana, slotOf.henry])).data.error, /already emailed/);
  assert.equal((await invite(m.bob, slotOf.bob, [slotOf.dana])).status, 200, 'singles is a different game');
});

await check('only for a sharing player\'s own time, with players who all line up, and not when everyone shares', async () => {
  const fails = async (token, slot, others, pattern) => assert.match((await invite(token, slot, others)).data.error, pattern);
  await fails(m.alice, slotOf.bob, [slotOf.dana], /not yours/);
  await fails(m.alice, slotOf.alice, [slotOf.bob], /all share their contact info/);
  await fails(m.alice, slotOf.alice, [slotOf.bob, slotOf.dana], /1 player for singles or 3 for doubles/);
  await fails(m.alice, slotOf.alice, [slotOf.dana, slotOf.dana, slotOf.bob], /1 player for singles or 3 for doubles/);
  await fails(m.alice, slotOf.alice, [slotOf.alice], /1 player for singles or 3 for doubles/);
  await fails(dev, slotOf.dana, [slotOf.alice], /Share my contact info/);
  ok(await submit(m.yara, id.yara, THU, '08:00', 60));                 // 4.0: doesn't suit Alice
  await fails(m.alice, slotOf.alice, [(await mineOn(m.yara, THU)).id], /no longer line up/);
  await rpcOk(m.yara, 'casual_unsubmit', { p_slot_id: (await mineOn(m.yara, THU)).id });
  assert.ok((await invite(null, slotOf.alice, [slotOf.dana])).status >= 400, 'not for signed-out visitors');
});

await check('the "a player would like to set up a game" email can be switched Off', async () => {
  await clearInbox();
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'casual_invite', p_enabled: false });
  const r = await invite(m.henry, slotOf.henry, [slotOf.dana]);
  assert.deepEqual(r.data, { sent: 0, off: true });
  assert.deepEqual(await mail(/^Casual Play/), []);
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'casual_invite', p_enabled: true });
});

console.log('"Email me" emails');
await check('players who share hear about each other with names and email addresses; those who don\'t are asked to share', async () => {
  await clearAll();
  await clearInbox();
  ok(await submit(m.alice, id.alice, THU, '08:00', 90));
  assert.ok(!(await runTasks()).data.tasks.includes('casual_games'), 'one player alone: no email');
  ok(await submit(m.bob, id.bob, THU, '08:00', 90));
  ok(await submit(m.henry, id.henry, THU, '08:00', 60, true, false));   // Henry doesn't share for this time
  ok(await submit(dev, id.dana, THU, '08:00', 60));                     // Dana shares, but has "Email me" off
  const r = await runTasks();
  assert.deepEqual(r.data.failed, [], JSON.stringify(r.data));
  const SUBJ = /^Casual Play: players free Thursday, November 12, 8:00 – (9:30|9:00) AM$/;
  assert.deepEqual(await to(SUBJ), ['alice.johnson@example.com', 'bob.smith@example.com']);
  const bobs = await body(SUBJ, 'bob.smith@example.com');
  assert.match(bobs, /^Hello Bob,/);
  assert.match(bobs, /Alice Johnson \(F, 3\.5\) alice\.johnson@example\.com: free 8:00 – 9:30 AM\r?\n/);
  assert.match(bobs, /Dana Developer \(F, 3\.5\) dev@example\.com: free 8:00 – 9:00 AM\r?\n/);
  assert.ok(!/Henry|henry/.test(bobs));
  assert.match(bobs, /1 more player lines up but doesn't share their contact info yet\./);
  assert.ok(!/\(new\)/.test(bobs), 'nothing is marked new in a first email');
  assert.match(bobs, new RegExp(`please remove this time from the Casual Play calendar[^]*?/app/casual\\.html\\?slot=${(await mineOn(m.bob, THU)).id}`));
  const henrys = await body(/share your contact info to play$/, 'henry.moore@example.com');
  assert.match(henrys, /Alice Johnson \(F, 3\.5\): free 8:00 – 9:00 AM\r?\n/, 'names, but no email addresses');
  assert.ok(!/@example\.com/.test(henrys));
  assert.match(henrys, new RegExp(`/app/casual\\.html\\?slot=${(await mineOn(m.henry, THU)).id}`));
  assert.ok(!(await runTasks()).data.tasks.includes('casual_games'), 'each email goes out once');
});

await check('a new player lining up later: those it suits get an updated email, with the new player marked', async () => {
  await clearInbox();
  await prefs(m.yara, true, true, ['4.0', '3.5'], true);
  await prefs(m.alice, true, true, ['3.5', '4.0'], true);
  ok(await submit(m.yara, id.yara, THU, '08:30', 60));                 // suits Alice only
  await runTasks();
  assert.deepEqual(await to(/^Casual Play: players free Thursday/), ['alice.johnson@example.com', 'yara.green@example.com']);
  const alices = await body(/^Casual Play: players free Thursday/, 'alice.johnson@example.com');
  assert.match(alices, /Yara Green \(F, 4\.0\) yara\.green@example\.com: free 8:30 – 9:30 AM \(new\)/);
  assert.match(alices, /Bob Smith .*\r?\n/, 'everyone who lines up is listed again');
  assert.ok(!/Bob Smith[^\n]*\(new\)/.test(alices));
  await prefs(m.yara, true, true, ['4.0'], true);
  await prefs(m.alice, true, true, ['3.5'], true);
});

await check('once a player shares, both get each other\'s details', async () => {
  await clearInbox();
  await rpcOk(m.henry, 'casual_set_slot_share', { p_slot_id: (await mineOn(m.henry, THU)).id, p_share: true });
  await runTasks();
  assert.match(await body(/^Casual Play: players free/, 'henry.moore@example.com'), /Alice Johnson \(F, 3\.5\) alice\.johnson@example\.com/);
  assert.match(await body(/^Casual Play: players free/, 'bob.smith@example.com'), /Henry Moore \(M, 3\.5\) henry\.moore@example\.com: free 8:00 – 9:00 AM \(new\)/);
});

await check('re-posting a time does not email players again who were already told about that player', async () => {
  await clearInbox();
  await rpcOk(m.bob, 'casual_unsubmit', { p_slot_id: (await mineOn(m.bob, THU)).id });
  ok(await submit(m.bob, id.bob, THU, '08:00', 90));
  await runTasks();
  assert.deepEqual(await to(/^Casual Play/), ['bob.smith@example.com'], 'only Bob, for his new time');
});

await check('no email unless levels suit both ways and an hour is shared', async () => {
  await clearInbox();
  ok(await submit(m.alice, id.alice, SAT, '09:00', 60));     // 3.5; wants 3.5
  ok(await submit(m.carol, id.carol, SAT, '09:00', 60));     // 4.0: Alice didn't choose 4.0
  await prefs(m.carol, false, true, ['4.0', '3.5'], false);  // Carol would play a 3.5, but Alice still wouldn't play a 4.0
  ok(await submit(m.henry, id.henry, SAT, '09:30', 60));     // 3.5, but only 30 minutes shared
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), []);
  assert.deepEqual((await mineOn(m.alice, SAT)).lines_up, []);
  await prefs(m.carol, false, true, ['4.0'], false);
});

await check('a time taken back before the email run: nobody is told about it', async () => {
  await clearInbox();
  ok(await submit(m.yara, id.yara, MON, '10:00', 60));
  ok(await submit(m.carol, id.carol, MON, '10:00', 60, true));
  await rpcOk(m.carol, 'casual_unsubmit', { p_slot_id: (await mineOn(m.carol, MON)).id });
  const r = await runTasks();
  assert.deepEqual(r.data.failed, []);
  assert.deepEqual(await mail(/^Casual Play/), []);
  assert.deepEqual((await mineOn(m.yara, MON)).lines_up, []);
});

await check('a player who turns "Email me" on hears about times already posted', async () => {
  await clearInbox();
  await prefs(m.alice, true, false, ['3.5'], true);
  ok(await submit(m.alice, id.alice, MON, '15:00', 60));
  ok(await submit(m.bob, id.bob, MON, '15:00', 60));
  await runTasks();
  assert.deepEqual(await to(/^Casual Play/), ['bob.smith@example.com'], 'Alice has "Email me" off');
  await prefs(m.alice, true, true, ['3.5'], true);
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

await check('emails wait until both times have been posted for the waiting time (2 hours by default)', async () => {
  await clearInbox();
  assert.equal((await rpcOk(dev, 'dev_save_casual_settings', { p_email_delay_minutes: 120 })).email_delay_minutes, 120);
  const at = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
  await at('2026-11-10T13:00:00Z');                                            // Tuesday 8am
  ok(await submit(m.alice, id.alice, '2026-11-20', '09:00', 60));
  ok(await submit(m.bob, id.bob, '2026-11-20', '09:00', 60));
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), [], 'not yet');
  // A time taken back within the waiting time is never emailed about.
  await at('2026-11-10T14:00:00Z');
  await rpcOk(m.bob, 'casual_unsubmit', { p_slot_id: (await mineOn(m.bob, '2026-11-20')).id });
  ok(await submit(m.henry, id.henry, '2026-11-20', '09:00', 60));   // posted at 9am
  await at('2026-11-10T15:01:00Z');                                            // Alice's time is 2h old, Henry's isn't
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), []);
  await at('2026-11-10T16:01:00Z');                                            // both 2h old
  await runTasks();
  assert.deepEqual(await to(/^Casual Play: players free Friday, November 20/), ['alice.johnson@example.com', 'henry.moore@example.com']);
  await rpcFails(m.alice, 'dev_save_casual_settings', { p_email_delay_minutes: 0 }, /Developers only/);
  await rpcFails(dev, 'dev_save_casual_settings', { p_email_delay_minutes: 5000 }, /between/);
  await rpcOk(dev, 'dev_save_casual_settings', { p_email_delay_minutes: 0 });
});

await check('a Casual Play email switched Off is not sent', async () => {
  await clearInbox();
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'casual_game', p_enabled: false });
  ok(await submit(m.alice, id.alice, '2026-11-21', '09:00', 60));
  ok(await submit(m.henry, id.henry, '2026-11-21', '09:00', 60));
  await runTasks();
  assert.deepEqual(await mail(/^Casual Play/), []);
  await rpcOk(dev, 'dev_set_email_switch', { p_key: 'casual_game', p_enabled: true });
  assert.deepEqual(await rpcOk(dev, 'dev_email_switches'), { casual_game: true, casual_invite: true });
});

await check('the email wording is editable like the others', async () => {
  const r = await call('/functions/v1/email-admin', { token: dev, body: {} });
  for (const key of ['casual_game', 'casual_reveal', 'casual_invite']) assert.ok(r.data.emails.some(x => x.key === key), key);
});

summary();
