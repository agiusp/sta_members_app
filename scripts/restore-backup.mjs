#!/usr/bin/env node
// Loads a backup (from the weekly backup email, or Developers > Settings >
// App settings > Download a backup) into a Supabase project.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \
//     node scripts/restore-backup.mjs backup-2026-10-19.zip [--replace]
//
// The project must already have the app's tables (supabase db push). Into an
// empty project it just loads the backup. If the project already has players,
// it refuses unless --replace is given, which overwrites everything in it
// with the backup. It all happens at once: if anything fails, nothing changes.
// Members whose sign-in accounts aren't in this project show as "Pending" in
// the Members table: send them their invites again.
// The service role (secret) key is a secret: never commit it or paste it into a page.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const replace = process.argv.includes('--replace');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!file || !url || !key) {
  console.error('usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/restore-backup.mjs <backup.zip|backup.json> [--replace]');
  process.exit(1);
}

// The backup email attaches a .zip holding one .json file.
const text = file.endsWith('.zip') ? execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 1 << 30 })
                                   : readFileSync(file, 'utf8');
const backup = JSON.parse(text);
console.log(`Backup made ${backup.made_at} (app version ${backup.app_version}). Restoring into ${url}${replace ? ', replacing what is there' : ''}...`);

const res = await fetch(`${url}/rest/v1/rpc/restore_backup`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_backup: backup, p_replace: replace })
});
const out = await res.json().catch(() => null);
if (!res.ok) {
  console.error('Restore failed, nothing was changed:', out?.message || res.status);
  process.exit(1);
}
for (const [table, n] of Object.entries(out)) console.log(`  ${table}: ${n}`);
console.log('Done. Test mode and demo mode are off. Re-invite any member shown as "Pending" in the Members table.');
