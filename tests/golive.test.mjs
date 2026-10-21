// End-to-end test of the go-live additions: switching Casual Play and My
// Rating off for members, developers' Player history, and backups (weekly
// email, download, restore). LOCAL Supabase only. Run all tests with: tests/run.sh
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, call, rpc, rpcOk, rpcFails, check, acceptInvite, inviteAsDeveloper, execSync,
         bootstrapDeveloper, clearInbox, summary, PW, API, MAIL, SERVICE_KEY, minute, at } from './lib.mjs';

const runTasks = () => call('/functions/v1/timed-tasks', { token: SERVICE_KEY, body: {} });
const asService = (fn, args) => call(`/rest/v1/rpc/${fn}`, { token: SERVICE_KEY, key: SERVICE_KEY, body: args });

await clearInbox();
const dev = await bootstrapDeveloper();
const setClock = iso => rpcOk(dev, 'dev_set_test_clock', { p_clock: iso });
await setClock(null);
assert.equal((await inviteAsDeveloper(dev, 'alice.johnson@example.com')).status, 200);
const alice = await acceptInvite('alice.johnson@example.com', PW);
const members = await rpcOk(dev, 'dev_members');
const devPlayer = members.find(m => m.email === 'dev@example.com');

console.log('Features members see');
await check('Casual Play and My Rating are on by default, and my_access says so', async () => {
  const a = await rpcOk(alice, 'my_access');
  assert.equal(a.casual_on, true);
  assert.equal(a.rating_on, true);
});

await check('only developers switch them, and members see the change', async () => {
  await rpcFails(alice, 'dev_save_features', { p_casual: false, p_rating: false }, /eveloper/);
  await rpcFails(alice, 'dev_app_settings', {}, /eveloper/);
  const s = await rpcOk(dev, 'dev_save_features', { p_casual: false, p_rating: false });
  assert.equal(s.casual_on, false);
  assert.equal(s.rating_on, false);
  const a = await rpcOk(alice, 'my_access');
  assert.equal(a.casual_on, false);
  assert.equal(a.rating_on, false);
  await rpcFails(dev, 'dev_save_features', { p_casual: null, p_rating: true }, /On or Off/);
});

await check('while My Rating is off, the Scheduler uses Level instead of Dynamic Level', async () => {
  const s = (await rpcOk(dev, 'dev_week')).session;
  await setClock(at(s.signups_open_at, 60 * minute));
  await rpcOk(dev, 'dev_simulate_signups', { p_count: 50 });
  // Alice and Bob win 4 games 6-0, 6-0, 6-0, all confirmed: Bob's Dynamic
  // Level goes up a step.
  const t = {};
  for (const name of ['bob.smith', 'carol.lee', 'david.kim']) {
    assert.equal((await inviteAsDeveloper(dev, `${name}@example.com`)).status, 200);
    t[name] = await acceptInvite(`${name}@example.com`, PW);
  }
  const pid = email => members.find(m => m.email === email).player_id;
  // On the 4 days before the app's day (the test clock).
  const now = new Date((await rpcOk(dev, 'dev_week')).now).getTime();
  const daysAgo = n => new Date(now - n * 24 * 60 * minute).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 0; i < 4; i++) {
    await rpcOk(alice, 'report_rating_game', { p_played_on: daysAgo(4 - i), p_kind: 'casual', p_league_id: null,
      p_partner: pid('bob.smith@example.com'), p_opponents: [pid('carol.lee@example.com'), pid('david.kim@example.com')],
      p_sets: [[6, 0], [6, 0], [6, 0]] });
  }
  for (const token of Object.values(t)) {
    for (const r of (await rpcOk(token, 'my_rating')).to_confirm) {
      await rpcOk(token, 'answer_rating_result', { p_result_id: r.id, p_confirm: true });
    }
  }
  const bob = pid('bob.smith@example.com');
  assert.equal((await rpcOk(dev, 'dev_members')).find(m => m.player_id === bob).dynamic_level, '4.0');
  const level = async () => (await rpcOk(dev, 'dev_scheduler_data')).lineup.find(l => l.id === bob).level;
  assert.equal(await level(), '3.5', 'My Rating off: Level');
  await rpcOk(dev, 'dev_save_features', { p_casual: false, p_rating: true });
  assert.equal(await level(), '4.0', 'My Rating on: Dynamic Level');
  await rpcOk(dev, 'dev_save_features', { p_casual: true, p_rating: true });
});

console.log('Player history (Developers > Ratings)');
await check("a developer sees a player's rating history, the same as the player's own", async () => {
  await rpcOk(dev, 'dev_simulate_rating_results', { p_count: 6 });
  const mine = await rpcOk(dev, 'my_rating');
  const seen = await rpcOk(dev, 'dev_rating_history', { p_player: devPlayer.player_id });
  assert.equal(seen.player.name, 'Dana Developer');
  for (const k of ['rating', 'official', 'played', 'history']) assert.deepEqual(seen[k], mine[k], k);
  assert.ok(seen.history.length >= 4, "the last 2 made-up results wait for an answer");
});

await check('members cannot see anyone else\'s rating history', async () => {
  await rpcFails(alice, 'dev_rating_history', { p_player: devPlayer.player_id }, /eveloper/);
  const r = await rpc(alice, 'rating_summary', { p_player: devPlayer.player_id });
  assert.ok(r.status >= 400, 'rating_summary is not callable');
  await rpcFails(dev, 'dev_rating_history', { p_player: 999999 }, /No such player/);
});

console.log('Backups');
await check('only developers can download a backup; it has every table but the Demo inbox', async () => {
  await rpcFails(alice, 'dev_backup', {}, /eveloper/);
  const b = await rpcOk(dev, 'dev_backup');
  assert.equal(b.backup_of, 'STA Members App');
  assert.ok(b.app_version >= '20261021000000');
  assert.ok(b.tables.players.length >= 40);
  assert.ok(b.tables.accounts.some(a => a.email === 'alice.johnson@example.com'));
  assert.ok(!('demo_inbox' in b.tables));
});

await check('members and developers cannot claim or restore backups themselves', async () => {
  for (const token of [alice, dev, null]) {
    assert.ok((await rpc(token, 'claim_backup', {})).status >= 400);
    assert.ok((await rpc(token, 'restore_backup', { p_backup: {}, p_replace: true })).status >= 400);
  }
});

await check('the backup address is checked, and no backup is emailed without one', async () => {
  await rpcFails(dev, 'dev_save_backup_email', { p_email: 'not an email' }, /look right/);
  await rpcFails(dev, 'dev_request_backup', {}, /backup email address first/);
  const r = await runTasks();
  assert.ok(!r.data.tasks.includes('backup'));
});

// The attached zip, unzipped.
async function backupEmail(to) {
  const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + to)}`)).json();
  if (!list.messages.length) return null;
  const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
  const part = msg.Attachments[0];
  assert.match(part.FileName, /^backup-\d{4}-\d\d-\d\d\.zip$/);
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  const zip = join(dir, part.FileName);
  writeFileSync(zip, Buffer.from(await (await fetch(`${MAIL}/api/v1/message/${msg.ID}/part/${part.PartID}`)).arrayBuffer()));
  return { msg, zip, data: JSON.parse(execSync(`unzip -p "${zip}"`, { encoding: 'utf8', maxBuffer: 1 << 28 })) };
}

let mailed;
await check('the weekly backup is emailed from Monday 2am (US Eastern), once a week', async () => {
  await rpcOk(dev, 'dev_save_backup_email', { p_email: ' Backups@Example.com ' });
  await setClock('2026-10-26T05:59:00Z');   // Monday 1:59am EDT: not yet
  await clearInbox();
  assert.ok(!(await runTasks()).data.tasks.includes('backup'));
  await setClock('2026-10-26T06:01:00Z');   // Monday 2:01am EDT
  assert.ok((await runTasks()).data.tasks.includes('backup'));
  assert.ok(!(await runTasks()).data.tasks.includes('backup'), 'not twice');
  mailed = await backupEmail('backups@example.com');
  assert.match(mailed.msg.Subject, /backup of 2026-10-26/);
  assert.match(mailed.msg.Text, /keep this email private/);
  assert.ok(mailed.data.tables.players.length >= 40);
  await setClock('2026-10-31T12:00:00Z');   // later that week: nothing
  assert.ok(!(await runTasks()).data.tasks.includes('backup'));
  const s = await rpcOk(dev, 'dev_app_settings');
  assert.equal(s.backup_email, 'backups@example.com');
  assert.equal(s.backup_sent_at.slice(0, 16), '2026-10-26T06:01');
});

await check('"Email a backup now" sends one at the next run', async () => {
  assert.equal((await rpcOk(dev, 'dev_request_backup')).backup_requested, true);
  await clearInbox();
  assert.ok((await runTasks()).data.tasks.includes('backup'));
  assert.ok(await backupEmail('backups@example.com'));
  assert.equal((await rpcOk(dev, 'dev_app_settings')).backup_requested, false);
});

await check('a backup restores everything, only with --replace when the app has players', async () => {
  const news = await rpcOk(dev, 'dev_save_news', { p_id: null, p_title: 'After the backup', p_body: 'Not in it.' });
  assert.ok(news);
  const bad = await asService('restore_backup', { p_backup: { hello: 1 } });
  assert.match(bad.data.message, /not a backup/);
  const refused = await asService('restore_backup', { p_backup: mailed.data });
  assert.match(refused.data.message, /already has players/);
  // Through the script, from the emailed zip.
  const out = execSync(`node scripts/restore-backup.mjs "${mailed.zip}" --replace`, {
    encoding: 'utf8', env: { ...process.env, SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY } });
  assert.match(out, /Done/);
  const after = await rpcOk(dev, 'dev_backup');
  for (const t of ['players', 'accounts', 'signups', 'rating_results', 'game_reviews', 'email_templates']) {
    assert.deepEqual(after.tables[t].length, mailed.data.tables[t].length, t);
  }
  assert.ok(!after.tables.news.some(n => n.title === 'After the backup'), 'the later news post is gone');
  // Test mode comes back off; sign-ins still work (their accounts exist in this project).
  assert.equal(after.tables.settings[0].test_mode, false);
  assert.equal((await rpcOk(alice, 'my_access')).member, true);
  // New rows still get fresh ids.
  assert.ok(await rpcOk(dev, 'dev_save_news', { p_id: null, p_title: 'After the restore', p_body: 'Fine.' }));
});

summary();
