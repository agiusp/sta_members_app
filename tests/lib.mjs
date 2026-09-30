// Shared helpers for the end-to-end tests. They talk to the LOCAL Supabase
// only, and refuse to run against anything else.
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const env = Object.fromEntries(
  execSync('supabase status -o env', { encoding: 'utf8' })
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const API = env.API_URL;
const MAIL = env.INBUCKET_URL || env.MAILPIT_URL;
const PUBLIC_KEY = env.PUBLISHABLE_KEY;
const SERVICE_KEY = env.SERVICE_ROLE_KEY;
const APP_URL = 'http://127.0.0.1:3000/app/';
assert.match(API, /^http:\/\/127\.0\.0\.1/, 'Refusing to run against a non-local Supabase');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

async function call(path, { token, method = 'POST', body, key = PUBLIC_KEY } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token || key}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const rpc = (token, fn, args = {}) => call(`/rest/v1/rpc/${fn}`, { token, body: args });
async function rpcOk(token, fn, args) {
  const r = await rpc(token, fn, args);
  assert.ok(r.status < 300, `${fn} failed: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function rpcFails(token, fn, args, pattern) {
  const r = await rpc(token, fn, args);
  assert.ok(r.status >= 400, `${fn} should have failed but returned ${JSON.stringify(r.data)}`);
  if (pattern) assert.match(r.data.message || JSON.stringify(r.data), pattern);
}

// Finds the newest email to `to` in the local test inbox, follows its link,
// sets the password and returns a signed-in access token.
async function acceptInvite(to, password) {
  let msg;
  for (let i = 0; i < 20 && !msg; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + to)}`)).json();
    msg = list.messages?.[0];
    if (!msg) await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(msg, `No email arrived for ${to}`);
  const full = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json();
  const link = (full.Text.match(/https?:\/\/\S+\/auth\/v1\/verify\S+/) || [])[0];
  assert.ok(link, 'Invite email has no link');
  const res = await fetch(link.replace(/&amp;/g, '&'), { redirect: 'manual' });
  const location = res.headers.get('location') || '';
  assert.ok(location.startsWith(APP_URL), `Invite redirects to ${location}`);
  const params = new URLSearchParams(location.split('#')[1]);
  assert.equal(params.get('type'), 'invite');
  const token = params.get('access_token');
  const upd = await call('/auth/v1/user', { token, method: 'PUT', body: { password } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  return signIn(to, password);
}

async function signIn(email, password) {
  const r = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
  assert.equal(r.status, 200, `sign-in failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.access_token;
}

// Right after `supabase db reset` restarts the sign-in service, its first
// emails can time out (the email goes out but the invite isn't saved, so its
// link is dead). Retry those; a later, newer email is the one acceptInvite uses.
async function retryOnTimeout(fn) {
  for (let attempt = 1; ; attempt++) {
    const r = await fn();
    if (r.status < 500 || attempt === 4) return r;
    await new Promise(res => setTimeout(res, 2000));
  }
}

async function inviteAsDeveloper(devToken, email) {
  return retryOnTimeout(() =>
    call('/functions/v1/invite-member', { token: devToken, body: { email, redirectTo: APP_URL } }));
}

export const PW = 'correct-horse-battery';
export const minute = 60000;
export const at = (iso, deltaMs = 0) => new Date(new Date(iso).getTime() + deltaMs).toISOString();

export async function clearInbox() {
  await fetch(`${MAIL}/api/v1/messages`, { method: 'DELETE' });
}

// Invites dev@example.com with the bootstrap script and returns its token.
export async function bootstrapDeveloper() {
  const r = await retryOnTimeout(() => {
    const out = execSync('scripts/invite-first-developer.sh dev@example.com', { encoding: 'utf8' });
    return { status: out.includes('"id"') ? 200 : 504, data: out };
  });
  assert.equal(r.status, 200, r.data);
  return acceptInvite('dev@example.com', PW);
}

export function summary() {
  console.log(`\nAll ${passed} checks passed.`);
}

export { assert, execSync, API, MAIL, PUBLIC_KEY, SERVICE_KEY, APP_URL, check, call, rpc, rpcOk, rpcFails,
         acceptInvite, signIn, retryOnTimeout, inviteAsDeveloper };
