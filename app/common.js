// Shared by every page of the app.
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

  // ---------- Site header: logo, app name, navigation ----------
  // Every page has the same header. A page says where it belongs with
  // <body data-section="sunday" data-tab="courts">, and calls STA.initPage().
  const DEFAULT_LOGO = 'img/sta-logo.png';
  const SECTIONS = [
    { key: 'news', label: 'News', href: 'news.html' },
    { key: 'sunday', label: 'Sunday Doubles', href: 'signup.html', sundayOnly: true, tabs: [
      { key: 'signup', label: 'Sign-up', href: 'signup.html' },
      { key: 'courts', label: 'Court Assignments', href: 'courts.html' },
      { key: 'review', label: 'Game Review', href: 'review.html' }] },
    { key: 'casual', label: 'Casual Play', href: 'casual.html' },
    { key: 'dev', label: 'Developers', href: 'developer.html', devOnly: true, tabs: [
      { key: 'overview', label: 'Members and this week', href: 'developer.html' },
      { key: 'scheduler', label: 'Scheduler', href: 'scheduler.html' },
      { key: 'emails', label: 'Emails, schedule and settings', href: 'emails.html' }] }
  ];
  const BRAND_CACHE = 'sta-branding';
  const ACCESS_CACHE = 'sta-access';
  let brand = null;
  let who = null;        // signed-in email, or null
  let isDev = false;
  let isSunday = false;   // approved for Sunday Doubles
  let isMember = true;    // Active member (Inactive members see only the dues message)

  // "STA - STA Members App" shows as "STA" with "STA Members App" under it.
  function splitName(name) {
    const i = name.indexOf(' - ');
    return i > 0 ? [name.slice(0, i), name.slice(i + 3)] : [name, ''];
  }

  function websiteLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return 'Club website'; }
  }

  function renderHeader() {
    const b = brand || { program_name: 'STA - STA Members App', brand_color: '#372a7b', logo: null,
                         website_url: 'https://www.statennis.com/' };
    const section = document.body.dataset.section;
    const tab = document.body.dataset.tab;
    const [name, sub] = splitName(b.program_name);
    document.documentElement.style.setProperty('--accent', b.brand_color);

    let header = document.getElementById('siteHeader');
    if (!header) {
      header = document.createElement('header');
      header.id = 'siteHeader';
      header.className = 'site-header';
      document.body.insertBefore(header, document.body.firstChild);
    }
    let links = who && isMember ? SECTIONS.filter(s => (!s.devOnly || isDev) && (!s.sundayOnly || isSunday)).map(s =>
      `<a href="${s.href}"${s.key === section ? ' class="active" aria-current="page"' : ''}>${esc(s.label)}</a>`).join('') : '';
    if (who && isMember && b.demo) links += `<a href="demo-inbox.html"${section === 'demo' ? ' class="active" aria-current="page"' : ''}>Demo inbox</a>`;
    const demoStrip = b.demo
      ? '<div class="demo-strip"><div class="site-inner">Demo version: all players and club data are made up. Emails are not sent; they appear in the Demo inbox.</div></div>' : '';
    const website = b.website_url
      ? `<a class="site-ext" href="${esc(b.website_url)}" target="_blank" rel="noopener">${esc(websiteLabel(b.website_url))} &#8599;</a>` : '';
    header.innerHTML = `
      <div class="site-inner site-top">
        <a class="site-brand" href="${who ? 'news.html' : './'}">
          <img src="${esc(b.logo || DEFAULT_LOGO)}" alt="">
          <span class="site-name"><span class="brand-name">${esc(name)}</span>${sub ? `<span class="brand-sub">${esc(sub)}</span>` : ''}</span>
        </a>
        ${who ? `<div class="site-user"><span>${esc(who)}</span><button class="secondary" id="siteSignOut">Sign out</button></div>` : ''}
      </div>
      <nav class="site-nav" aria-label="Main"><div class="site-inner">${links}${website}</div></nav>${demoStrip}`;
    const out = document.getElementById('siteSignOut');
    if (out) out.addEventListener('click', signOut);

    // Section title and its tabs, at the top of the page content.
    const s = SECTIONS.find(x => x.key === section);
    const main = document.querySelector('main.page');
    let head = document.getElementById('sectionHead');
    if (s && main) {
      if (!head) {
        head = document.createElement('div');
        head.id = 'sectionHead';
        head.className = 'section-head';
        main.insertBefore(head, main.firstChild);
      }
      head.innerHTML = `<h1>${esc(s.label)}</h1>` + (s.tabs ? `<nav class="tabs" aria-label="${esc(s.label)}">${s.tabs.map(t =>
        `<a href="${t.href}"${t.key === tab ? ' class="active" aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}</nav>` : '');
    }

    document.querySelectorAll('.program-name').forEach(el => { el.textContent = b.program_name; });
    const page = document.body.dataset.page;
    document.title = page ? `${page} · ${name}` : name;
  }

  function showBranding(b) {
    if (!b) return;
    brand = b;
    renderHeader();
  }

  async function applyBranding() {
    try { showBranding(JSON.parse(localStorage.getItem(BRAND_CACHE))); } catch (_) { /* no cache */ }
    const { data, error } = await client.rpc('branding');
    if (error || !data) return null;
    showBranding(data);
    try { localStorage.setItem(BRAND_CACHE, JSON.stringify(data)); } catch (_) { /* storage blocked */ }
    return data;
  }

  async function signOut() {
    try { sessionStorage.removeItem(ACCESS_CACHE); } catch (_) { /* storage blocked */ }
    await client.auth.signOut();
    location.href = './';
  }

  // Draws the header and checks sign-in. Pages for members only send visitors
  // who aren't signed in to the sign-in page, which brings them back after.
  // Returns the session, or null.
  async function initPage({ requireSignIn = true } = {}) {
    renderHeader();
    const branding = applyBranding();
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      if (requireSignIn) {
        const here = location.pathname.split('/').pop();
        location.replace('./' + (here ? '?next=' + encodeURIComponent(here + location.search) : ''));
      }
      await branding;
      return null;
    }
    who = session.user.email;
    // The Developers tab is only a shortcut: the database itself decides who
    // can do what. Remembered for this browser tab so it doesn't flicker.
    try {
      const c = JSON.parse(sessionStorage.getItem(ACCESS_CACHE) || 'null');
      if (c && c.user === session.user.id) ({ developer: isDev, sunday_doubles: isSunday, member: isMember } = c);
    } catch (_) { /* storage blocked */ }
    renderHeader();
    const { data: access } = await client.rpc('my_access');
    const me = access || {};
    isMember = me.member === true;
    isDev = isMember && me.developer === true;
    isSunday = isMember && me.sunday_doubles === true;
    try { sessionStorage.setItem(ACCESS_CACHE, JSON.stringify({ user: session.user.id, developer: isDev, sunday_doubles: isSunday, member: isMember })); }
    catch (_) { /* storage blocked */ }
    renderHeader();
    const section = document.body.dataset.section;
    // Inactive members: only the dues message.
    if (!isMember) {
      blockPage('Membership needed', me.dues_message ||
        'Our records show that your STA membership has not been renewed. Please pay your membership dues to use the app.');
      await branding;
      return null;
    }
    if (section === 'sunday' && !isSunday) {
      blockPage('Sunday Doubles', 'Sunday Doubles is for advanced players approved by the Sunday Doubles program manager. ' +
        'If you would like to join, please contact the program manager.');
      await branding;
      return null;
    }
    // Developer pages need a sign-in confirmed with a code from an
    // authenticator app (two-step sign-in); ask for it first.
    if (section === 'dev') {
      if (isDev && !me.confirmed) {
        const here = location.pathname.split('/').pop();
        location.replace('two-step.html?next=' + encodeURIComponent(here + location.search));
        return null;
      }
    }
    await branding;
    return session;
  }

  // Replaces the page content with a message (no access to this page).
  function blockPage(title, message) {
    const main = document.querySelector('main.page');
    if (!main) return;
    main.innerHTML = `<div class="section-head"><h1>${esc(title)}</h1></div>
      <section class="panel"><p style="margin:0">${esc(message)}</p></section>`;
  }

  // Shows the amber test-mode banner when the app is on the test clock.
  function showTestClock(el, testMode, now) {
    el.hidden = !testMode;
    el.textContent = testMode ? `Test mode: the app is pretending it's ${fmtDateTime(now)}.` : '';
  }

  // Reads a CSV/TSV (quoted fields allowed) into rows of cells.
  function parseDelimited(text) {
    text = text.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const sep = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
  }

  // WCAG contrast ratio of white text on a background color (#rrggbb).
  function contrastWithWhite(hex) {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)));
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
  }

  return { client, authLinkType, authLinkError, TZ, fmtDateTime, fmtPlayDate, esc, rpc, showMessage,
           addPasswordToggles, parseDelimited, applyBranding, showBranding, branding: () => brand, initPage, signOut, showTestClock, splitName,
           contrastWithWhite, DEFAULT_LOGO };
})();
