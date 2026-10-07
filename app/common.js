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

  // ---------- App Messages ----------
  // Messages the app shows members on its pages. Developers can change the
  // wording in Settings > App Messages; their edits (in the database) replace
  // these defaults. {{name}} is filled in when the message is shown.
  const MESSAGES = [
    { key: 'inactive', group: 'Access', name: 'Membership not renewed (Inactive members)',
      where: 'Every page, for members marked Inactive in the Members table',
      text: "Our records show that your STA membership has not been renewed for this year. Please pay your membership dues, and your access to the STA Members App will be restored." },
    { key: 'not_sunday', group: 'Access', name: 'Not approved for Sunday Doubles',
      where: 'The Sunday Doubles pages, for members with Sunday Doubles = No',
      text: 'Sunday Doubles is for advanced players approved by the Sunday Doubles program manager. If you would like to join, please contact the program manager.' },
    { key: 'signin_wrong', group: 'Sign-in page', name: 'Wrong email or password', where: 'Sign-in page',
      text: 'Email or password is incorrect.' },
    { key: 'reset_sent', group: 'Sign-in page', name: 'Password reset sent', where: 'Sign-in page, after "Forgot password?"',
      text: 'If that email belongs to a member, a password reset link is on its way.' },
    { key: 'link_failed', group: 'Sign-in page', name: 'Email link didn\'t work', where: 'Sign-in page, when an invitation or reset link has expired or was already used',
      text: 'That link didn\'t work ({{reason}}). Email links work once and expire after 24 hours. If this was an invite, ask a developer to resend it. If you already have a password, sign in below or use "Forgot password?".',
      placeholders: { reason: 'the reason the sign-in service gave' } },
    { key: 'signup_not_open', group: 'Sunday Doubles', name: 'Sign-ups not open yet', where: 'Sign-up page, before sign-ups open',
      text: 'Sign-ups open {{open_time}}.', placeholders: { open_time: 'when sign-ups open, e.g. "Mon, Oct 5, 9:00 AM ET"' } },
    { key: 'signup_open', group: 'Sunday Doubles', name: 'Sign-ups open', where: 'Sign-up page, while sign-ups are open',
      text: 'Sign up or cancel until {{close_time}}.', placeholders: { close_time: 'when sign-ups close' } },
    { key: 'signup_closed', group: 'Sunday Doubles', name: 'Sign-ups closed', where: 'Sign-up page, after the Saturday cutoff',
      text: 'Sign-ups are closed. Court and ball assignments go out by email by {{publish_time}}. Can\'t play after all? It\'s your responsibility to find a replacement from the waitlist or your own contacts{{contacts_note}}.',
      placeholders: { publish_time: 'when the court emails go out', contacts_note: '", and to let <the contacts> know" (empty if there are no contacts)' } },
    { key: 'no_session', group: 'Sunday Doubles', name: 'No Sunday scheduled', where: 'Sign-up and Court Assignments pages, outside the season',
      text: 'No Sunday session is scheduled right now. Check back later in the week.' },
    { key: 'courts_later', group: 'Sunday Doubles', name: 'Courts not posted yet', where: 'Court Assignments page, before Saturday 8pm',
      text: 'Court assignments will be posted here, and sent by email, at {{publish_time}}.', placeholders: { publish_time: 'when the court emails go out' } },
    { key: 'courts_not_locked', group: 'Sunday Doubles', name: 'Courts late', where: 'Court Assignments page, if the courts weren\'t ready on time',
      text: 'Court assignments haven\'t been posted yet. They\'ll appear here, and be sent by email, as soon as they are.' },
    { key: 'courts_rain', group: 'Sunday Doubles', name: 'Rain-out expected', where: 'Court Assignments page, when the week is set to Rain-out expected',
      text: 'The forecast for {{day}} looks pretty bad, so we expect a rain-out. In the event that the forecast is wrong, you are welcome to show up at 9am and enjoy self-organized play.',
      placeholders: { day: '"today" or "tomorrow"' } },
    { key: 'courts_self', group: 'Sunday Doubles', name: 'Self-organized play', where: 'Court Assignments page, when the week is set to Self-organized play',
      text: 'The forecast for {{day}} is not looking good. Please show up at 9am as planned and enjoy self-organized play.',
      placeholders: { day: '"today" or "tomorrow"' } },
    { key: 'courts_replacement', group: 'Sunday Doubles', name: 'Finding a replacement', where: 'Court Assignments page, under the waitlist',
      text: 'Can\'t play after all? It\'s your responsibility to find a replacement from the wait list or your own contacts.' },
    { key: 'review_none', group: 'Sunday Doubles', name: 'Nothing to review yet', where: 'Game Review page, before the first Sunday',
      text: 'There is no game to review yet.' },
    { key: 'review_not_played', group: 'Sunday Doubles', name: 'Didn\'t play last Sunday', where: 'Game Review page, for members who weren\'t on a court',
      text: 'Our records show that you did not play on {{date}}, so there is no game for you to review. Only players who were assigned to a court that Sunday can review it.',
      placeholders: { date: 'the Sunday\'s date' } },
    { key: 'casual_intro', group: 'Casual Play', name: 'How Casual Play works', where: 'Casual Play page, under the levels and Emails settings',
      text: 'Other members see the sex and play level of everyone who posts a time, and your name only if you show it for that time. An orange ring on one of your times means another player at a level that suits you both is free for at least an hour then: a possible singles game. A green ring means three such players are free together: a possible doubles game. Your name and email address only go to players in a game with you who also choose Yes for "Share my contact info for games". When everyone in a game shares, click the ring to copy their email addresses. If you share and some players don\'t, you can have the app email them about the game. With "Email me" on, you also hear by email when players\' times line up with yours.' },
    { key: 'news_website', group: 'News', name: 'Club website note', where: 'News page, under the posts',
      text: 'Club events, schedules and membership forms are on the club website: {{website}}', placeholders: { website: 'the club website link (Settings > App settings)' } }
  ];
  let messageEdits = {};
  // Loaded once per page, with the branding (anyone may read them: the
  // sign-in page needs them before anyone signs in).
  const messagesLoaded = client.rpc('app_messages').then(({ data }) => { messageEdits = data || {}; }, () => {});

  // A message as plain text (for showMessage, which escapes it).
  function msgText(key, values = {}) {
    const m = MESSAGES.find(x => x.key === key);
    const text = messageEdits[key] ?? (m ? m.text : key);
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, n) => (n in values ? values[n] : all));
  }

  // A message as HTML: the wording is escaped, then {{name}} is replaced by
  // values, which the caller passes already safe for HTML.
  function msg(key, values = {}) {
    const m = MESSAGES.find(x => x.key === key);
    const text = messageEdits[key] ?? (m ? m.text : key);
    return esc(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (all, n) => (n in values ? values[n] : all)).replace(/\n/g, '<br>');
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
    { key: 'dev', label: 'Developers', href: 'members.html', devOnly: true, tabs: [
      { key: 'members', label: 'Members', href: 'members.html' },
      { key: 'sunday', label: 'Sunday Program', href: 'developer.html' },
      { key: 'scheduler', label: 'Scheduler', href: 'scheduler.html' },
      { key: 'settings', label: 'Settings', href: 'settings.html' }] }
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
    await messagesLoaded;
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
      blockPage('Membership needed', msg('inactive'));
      await branding;
      return null;
    }
    if (section === 'sunday' && !isSunday) {
      blockPage('Sunday Doubles', msg('not_sunday'));
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
  // messageHtml comes from msg(), so it is already safe HTML.
  function blockPage(title, messageHtml) {
    const main = document.querySelector('main.page');
    if (!main) return;
    main.innerHTML = `<div class="section-head"><h1>${esc(title)}</h1></div>
      <section class="panel"><p style="margin:0">${messageHtml}</p></section>`;
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

  // Saves rows of cells as a CSV file (opens in Excel, Numbers or Google Sheets).
  function downloadCsv(filename, rows) {
    const cell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const blob = new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // WCAG contrast ratio of white text on a background color (#rrggbb).
  function contrastWithWhite(hex) {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)));
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
  }

  return { client, authLinkType, authLinkError, TZ, fmtDateTime, fmtPlayDate, esc, rpc, showMessage,
           addPasswordToggles, parseDelimited, downloadCsv, applyBranding, showBranding, branding: () => brand, initPage, signOut, showTestClock, splitName,
           contrastWithWhite, DEFAULT_LOGO, MESSAGES, msg, msgText, messagesLoaded, messageEdits: () => messageEdits };
})();
