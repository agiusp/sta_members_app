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

  return { client, authLinkType, authLinkError, TZ, fmtDateTime, fmtPlayDate, esc, rpc, showMessage };
})();
