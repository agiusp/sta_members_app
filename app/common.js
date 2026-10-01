// Shared by the member and developer pages.
window.STA = (function () {
  const cfg = window.STA_CONFIG;

  // Invite and password-reset links land here with details in the URL hash.
  // Read them before the Supabase client consumes and clears the hash.
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const authLinkType = hashParams.get('type'); // 'invite' | 'recovery' | null
  const authLinkError = hashParams.get('error_description');

  const client = supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true }
  });

  const TZ = 'America/New_York';

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    }) + ' ET';
  }

  // play_date comes as 'YYYY-MM-DD' with no time zone; format it as-is.
  function fmtPlayDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
      timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  }

  function showMessage(el, msg, kind) {
    el.innerHTML = msg ? `<div class="msg ${kind || 'error'}">${esc(msg)}</div>` : '';
  }

  // Adds an eye button to every password box: click to show the password,
  // click again to hide it.
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function addPasswordToggles(root = document) {
    root.querySelectorAll('input[type="password"]:not([data-has-toggle])').forEach(input => {
      input.dataset.hasToggle = 'true';
      const wrap = document.createElement('span');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toggle';
      const set = shown => {
        input.type = shown ? 'text' : 'password';
        btn.innerHTML = shown ? EYE_OFF : EYE;
        btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', String(shown));
        btn.title = shown ? 'Hide password' : 'Show password';
      };
      set(false);
      btn.addEventListener('click', () => { set(input.type === 'password'); input.focus(); });
      wrap.appendChild(btn);
    });
  }

  return { client, authLinkType, authLinkError, TZ, fmtDateTime, fmtPlayDate, esc, rpc, showMessage, addPasswordToggles };
})();
