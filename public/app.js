'use strict';
/* ai2vpn web UI — no build step, plain DOM. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { accounts: [], providers: [], settings: null, vpn: null, tab: 'accounts', codeLang: 'curl' };

// ---------------- helpers ----------------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && path.startsWith('/api/') && path !== '/api/login') { showLogin(); throw new Error('Not logged in'); }
  if (!r.ok) { const e = new Error((data && (data.error?.message || data.error)) || `HTTP ${r.status}`); e.data = data; throw e; }
  return data;
}

function toast(msg, err = false) {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Copied');
}

function timeAgo(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

const mask = (k) => (k ? k.slice(0, 10) + '•'.repeat(10) + k.slice(-4) : '');

function modal(html, { wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"></div>`;
  const box = back.firstChild;
  if (typeof html === 'string') box.innerHTML = html; else box.appendChild(html);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && !wide) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back && !wide) close(); });
  box.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  $('#modal-root').appendChild(back);
  return { el: box, close };
}

function tpl(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }

// ---------------- auth ----------------
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  setTimeout(() => $('#login-password').focus(), 50);
}
async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  state.providers = await api('/api/providers');
  await Promise.all([loadAccounts(), loadVpn(), loadSettings()]);
  switchTab(location.hash.slice(1) || 'accounts');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    await api('/api/login', { body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});
$('#logout').onclick = async () => { await api('/api/logout', { body: {} }); showLogin(); };

// ---------------- tabs ----------------
function switchTab(tab) {
  if (!$(`[data-view="${tab}"]`)) tab = 'accounts';
  state.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('[data-view]').forEach((v) => (v.hidden = v.dataset.view !== tab));
  history.replaceState(null, '', '#' + tab);
  if (tab === 'api') renderApi();
  if (tab === 'vpn') renderVpn();
  if (tab === 'settings') renderSettings();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });
$('#vpn-pill').onclick = () => switchTab('vpn');

// ---------------- accounts ----------------
async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  renderAccounts();
  if (state.tab === 'api') renderApi();
}

function statusBadge(a) {
  const out = [];
  if (a.disabled) out.push('<span class="badge">disabled</span>');
  if (a.lastCheck) out.push(a.lastCheck.loggedIn ? '<span class="badge ok">● logged in</span>' : '<span class="badge bad">● logged out</span>');
  else out.push('<span class="badge">not checked</span>');
  if (a.running) out.push('<span class="badge run">browser running</span>');
  if (a.credentials) out.push(`<span class="badge" title="Saved sign-in for ${esc(a.credentials.email)}${a.credentials.autoRelogin ? ' — signs in again automatically when the session expires' : ''}">🔑 ${a.credentials.autoRelogin ? 'auto re-login' : 'saved login'}</span>`);
  return out.join(' ');
}

function renderAccounts() {
  const root = $('#accounts');
  $('#accounts-empty').hidden = state.accounts.length > 0;
  root.innerHTML = state.accounts.map((a) => `
    <div class="card acc" data-id="${a.id}">
      <div class="acc-head">
        <div class="avatar" style="background:${esc(a.color)}">${esc(a.providerName[0] || '?')}</div>
        <div class="acc-title"><strong>${esc(a.name)}</strong><span class="muted small">${esc(a.providerName)}</span></div>
      </div>
      <div>${statusBadge(a)}</div>
      <div>
        <div class="kv"><span>Base URL</span><code class="copyable" data-copy="${esc(a.endpoints.base)}">${esc(a.endpoints.base)}</code></div>
        <div class="kv"><span>Model</span><code class="copyable" data-copy="${esc(a.slug)}">${esc(a.slug)}</code></div>
        <div class="kv"><span>API key</span><code class="copyable" data-copy="${esc(a.apiKey)}">${esc(mask(a.apiKey))}</code></div>
      </div>
      <div class="acc-stats">${a.stats.requests || 0} requests · ${a.stats.errors || 0} errors · last used ${timeAgo(a.stats.lastUsed)}</div>
      ${a.stats.lastError ? `<div class="acc-error" title="${esc(a.stats.lastError)}">${esc(a.stats.lastError)}</div>` : ''}
      ${a.debugAt ? `<div class="acc-stats">Last failure (${timeAgo(a.debugAt)}): <a href="/api/accounts/${a.id}/debug.png" target="_blank">screenshot</a> · <a href="/api/accounts/${a.id}/debug.html" target="_blank">page HTML</a></div>` : ''}
      <div class="actions">
        <button class="btn primary small" data-act="login">Sign in</button>
        <button class="btn small" data-act="browser">Open browser</button>
        <button class="btn small" data-act="test">Test</button>
        <button class="btn small" data-act="check">Check login</button>
        <button class="btn small" data-act="more">More ▾</button>
      </div>
    </div>`).join('');
}

$('#accounts').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) return copy(c.dataset.copy);
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = state.accounts.find((x) => x.id === b.closest('[data-id]').dataset.id);
  if (!a) return;
  const act = b.dataset.act;
  if (act === 'login') openLogin(a);
  if (act === 'browser') openBrowser(a);
  if (act === 'test') openPlayground(a);
  if (act === 'check') checkLogin(a, b);
  if (act === 'more') openAccountMenu(a);
});

async function checkLogin(a, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await api(`/api/accounts/${a.id}/check`, { body: {} });
    toast(r.loggedIn ? `${a.name}: logged in ✓` : `${a.name}: not logged in — open the browser to sign in`, !r.loggedIn);
  } catch (e) { toast(e.message, true); }
  await loadAccounts();
}

$('#add-account-btn').onclick = () => openAddAccount();
function openAddAccount() {
  const m = modal(tpl('tpl-add-account'));
  let chosen = null;
  const pp = $('#pp', m.el);
  pp.innerHTML = state.providers.map((p) => `<button type="button" data-p="${esc(p.id)}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</button>`).join('');
  pp.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    chosen = b.dataset.p;
    $$('button', pp).forEach((x) => x.classList.toggle('sel', x === b));
    const p = state.providers.find((x) => x.id === chosen);
    const name = $('#acc-name', m.el);
    if (!name.value || name.dataset.auto) { name.value = p.name; name.dataset.auto = '1'; }
  });
  $('#acc-name', m.el).addEventListener('input', (e) => delete e.target.dataset.auto);
  $('#acc-create', m.el).onclick = async () => {
    if (!chosen) return toast('Pick a service', true);
    try {
      const a = await api('/api/accounts', { body: { provider: chosen, name: $('#acc-name', m.el).value, slug: $('#acc-slug', m.el).value } });
      m.close();
      await loadAccounts();
      if (chosen === 'custom') openAdvanced(a); else openLogin(a);
    } catch (e) { toast(e.message, true); }
  };
}

function openAccountMenu(a) {
  const m = modal(`<div class="modal-body">
    <h3>${esc(a.name)}</h3>
    <div class="kv"><span>Per-account URL</span><code class="copyable" data-copy="${esc(a.endpoints.accountBase)}">${esc(a.endpoints.accountBase)}</code></div>
    <div class="kv"><span>OpenAPI</span><a href="${esc(a.endpoints.openapi)}" target="_blank">openapi.json</a> · <a href="${esc(a.endpoints.docs)}" target="_blank">Swagger UI</a></div>
    <div class="actions" style="flex-direction:column;align-items:stretch">
      <button class="btn" data-m="key">Copy API key</button>
      <button class="btn" data-m="cookies">Import cookies…</button>
      <button class="btn" data-m="advanced">Rename / advanced settings…</button>
      ${a.credentials ? '<button class="btn" data-m="forget">Forget saved sign-in</button>' : ''}
      <button class="btn" data-m="rotate">Rotate API key</button>
      <button class="btn" data-m="close">Close browser</button>
      <button class="btn danger" data-m="reset">Reset browser profile (log out)</button>
      <button class="btn danger" data-m="delete">Delete account</button>
    </div></div>`);
  m.el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]'); if (c) return copy(c.dataset.copy);
    const b = e.target.closest('[data-m]'); if (!b) return;
    const act = b.dataset.m;
    try {
      if (act === 'key') return copy(a.apiKey);
      if (act === 'cookies') { m.close(); return openCookies(a); }
      if (act === 'advanced') { m.close(); return openAdvanced(a); }
      if (act === 'forget') { await api(`/api/accounts/${a.id}/credentials`, { method: 'DELETE' }); toast('Saved sign-in removed'); }
      if (act === 'rotate') { if (!confirm('Rotate the key? Clients using the old key will stop working.')) return; await api(`/api/accounts/${a.id}/rotate-key`, { body: {} }); toast('New key generated'); }
      if (act === 'close') { await api(`/api/accounts/${a.id}/close`, { body: {} }); toast('Browser closed'); }
      if (act === 'reset') { if (!confirm('Delete the browser profile (cookies, login) for this account?')) return; await api(`/api/accounts/${a.id}/reset-profile`, { body: {} }); toast('Profile reset'); }
      if (act === 'delete') { if (!confirm(`Delete "${a.name}" and its browser profile?`)) return; await api(`/api/accounts/${a.id}?wipe=1`, { method: 'DELETE' }); toast('Deleted'); }
      m.close();
      loadAccounts();
    } catch (err) { toast(err.message, true); }
  });
}

function openLogin(a) {
  const c = a.credentials || {};
  const emailOnly = a.provider === 'claude';
  const m = modal(`<div class="modal-body">
    <h3>Sign in — ${esc(a.name)}</h3>
    <p class="muted small">Log in to your ${esc(a.providerName)} account directly. ai2vpn opens the real sign-in page inside the container (through the VPN) and fills it in for you.
      If the site asks for something it can't do automatically (captcha, emailed code, passkey), you can finish here or in the remote browser.</p>
    <form id="lg-form" autocomplete="off">
      <label>Email / username<input id="lg-email" autocomplete="off" value="${esc(c.email || '')}" required></label>
      <label>Password${emailOnly ? ' <span class="muted small">(Claude usually emails you a code instead — leave empty)</span>' : ''}
        <input id="lg-pass" type="password" autocomplete="new-password" placeholder="${c.email ? 'saved — leave empty to reuse' : ''}"></label>
      <label>2FA secret <span class="muted small">(optional, base32 key from your authenticator setup — codes are generated automatically)</span>
        <input id="lg-totp" autocomplete="off" placeholder="${c.totp ? 'saved — leave empty to reuse' : 'JBSWY3DPEHPK3PXP'}"></label>
      <label class="check"><input type="checkbox" id="lg-remember" ${a.credentials ? 'checked' : ''}> Save these credentials and sign in again automatically when the session expires</label>
      <div class="notice small" id="lg-status" hidden></div>
      <div id="lg-code-row" class="row" hidden>
        <input id="lg-code" placeholder="Verification code from email / SMS" autocomplete="one-time-code">
        <button class="btn" type="button" id="lg-code-go">Submit code</button>
      </div>
      <div class="actions right">
        <button class="btn ghost" type="button" id="lg-browser">Use remote browser instead</button>
        <button class="btn ghost" type="button" data-close>Close</button>
        <button class="btn primary" type="submit" id="lg-go">Sign in</button>
      </div>
    </form></div>`);
  const status = (msg, ok) => { const el = $('#lg-status', m.el); el.hidden = false; el.innerHTML = msg; el.classList.toggle('warn', !ok); };
  const handle = async (r) => {
    await loadAccounts();
    if (r.loggedIn) { toast(`${a.name}: signed in ✓`); m.close(); return; }
    $('#lg-code-row', m.el).hidden = !r.codeRequested;
    status(`${esc(r.needsUser || 'Not signed in yet.')}<br><span class="muted">Page: ${esc(r.url)}</span> · <a href="#" id="lg-open">Open remote browser</a>`, false);
    $('#lg-open', m.el).onclick = (e) => { e.preventDefault(); m.close(); openBrowser(a); };
  };
  const busy = (on) => { $('#lg-go', m.el).disabled = on; $('#lg-code-go', m.el).disabled = on; if (on) status('Signing in… this can take up to a minute.', true); };
  $('#lg-form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(true);
    try {
      const body = { email: $('#lg-email', m.el).value.trim(), password: $('#lg-pass', m.el).value, totpSecret: $('#lg-totp', m.el).value.trim(), remember: $('#lg-remember', m.el).checked };
      await handle(await api(`/api/accounts/${a.id}/login`, { body }));
    } catch (err) { status(esc(err.message), false); }
    busy(false);
  });
  $('#lg-code-go', m.el).onclick = async () => {
    busy(true);
    try { await handle(await api(`/api/accounts/${a.id}/login`, { body: { code: $('#lg-code', m.el).value.trim() } })); }
    catch (err) { status(esc(err.message), false); }
    busy(false);
  };
  $('#lg-browser', m.el).onclick = () => { m.close(); openBrowser(a); };
}

function openCookies(a) {
  const m = modal(`<div class="modal-body">
    <h3>Import cookies — ${esc(a.name)}</h3>
    <p class="muted small">Alternative to logging in through the remote browser (useful when a site blocks sign-in from automated browsers, e.g. Google).
    In your own browser, open ${esc(a.homeUrl)} while logged in and export cookies with an extension such as <em>Cookie-Editor</em> (Export → JSON).
    JSON, Netscape cookies.txt, or a raw <code>Cookie:</code> header are accepted.</p>
    <textarea id="ck" rows="10" spellcheck="false" placeholder='[{"domain": ".chatgpt.com", "name": "__Secure-next-auth.session-token", "value": "…"}]'></textarea>
    <div class="actions right"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ck-go">Import &amp; check</button></div></div>`);
  $('#ck-go', m.el).onclick = async () => {
    try {
      const r = await api(`/api/accounts/${a.id}/cookies`, { body: { cookies: $('#ck', m.el).value } });
      toast(`Imported ${r.imported} cookies`);
      m.close();
      checkLogin(a);
    } catch (e) { toast(e.message, true); }
  };
}

async function openAdvanced(a) {
  let def = {};
  try { def = await api(`/api/providers/${a.provider}`); } catch (e) {}
  const override = a.override || {};
  const m = modal(`<div class="modal-body">
    <h3>Account settings — ${esc(a.name)}</h3>
    <div class="row"><label class="grow">Name<input id="ad-name" value="${esc(a.name)}"></label><label class="grow">Model name / slug<input id="ad-slug" value="${esc(a.slug)}"></label></div>
    <label class="check"><input type="checkbox" id="ad-disabled" ${a.disabled ? 'checked' : ''}> Disabled (API rejects requests)</label>
    <label>Overrides for this account only (JSON — URLs, selectors, stableMs)
      <textarea id="ad-ov" rows="12" spellcheck="false">${esc(JSON.stringify(override, null, 2))}</textarea></label>
    <details><summary class="muted small">Effective provider definition</summary><pre class="code" style="max-height:260px">${esc(JSON.stringify(def, null, 2))}</pre></details>
    ${a.provider === 'custom' ? `<p class="muted small">Example: <code>{"homeUrl":"https://chat.example.com","newChatUrl":"https://chat.example.com/new","selectors":{"input":"textarea","send":"button[type=submit]","assistant":".assistant-message","busy":".stop-button"}}</code></p>` : ''}
    <div class="actions right"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ad-save">Save</button></div></div>`);
  $('#ad-save', m.el).onclick = async () => {
    let ov;
    try { ov = JSON.parse($('#ad-ov', m.el).value || '{}'); } catch (e) { return toast('Invalid JSON: ' + e.message, true); }
    try {
      await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { name: $('#ad-name', m.el).value, slug: $('#ad-slug', m.el).value, disabled: $('#ad-disabled', m.el).checked, override: ov } });
      toast('Saved'); m.close(); loadAccounts();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------------- remote browser ----------------
function openBrowser(a) {
  const root = tpl('tpl-browser');
  let ws = null;
  const m = modal(root, { wide: true, onClose: () => { if (ws) ws.close(); loadAccounts(); } });
  const canvas = $('canvas', root);
  const ctx = canvas.getContext('2d');
  const screen = $('.browser-screen', root);
  const overlay = $('.browser-overlay', root);
  const urlInput = $('.url', root);
  let meta = { w: 1280, h: 860 };
  let pending = null;
  let drawing = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/viewer/${a.id}`);
  ws.binaryType = 'blob';
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') {
      pending = ev.data;
      if (!drawing) drawLoop();
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'frame-meta') meta = { w: msg.w || meta.w, h: msg.h || meta.h };
    if (msg.type === 'meta') {
      if (document.activeElement !== urlInput) urlInput.value = msg.url;
      $('.tabs-info', root).textContent = msg.tabs > 1 ? `tab ${msg.tab + 1}/${msg.tabs}` : '';
    }
    if (msg.type === 'error') toast(msg.message, true);
    if (msg.type === 'closed') { overlay.hidden = false; overlay.textContent = 'Browser closed.'; }
  };
  ws.onclose = () => { overlay.hidden = false; if (overlay.textContent === 'Starting browser…') overlay.textContent = 'Connection closed.'; };

  async function drawLoop() {
    drawing = true;
    while (pending) {
      const blob = pending; pending = null;
      try {
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        overlay.hidden = true;
      } catch (e) {}
    }
    drawing = false;
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * meta.w), y: Math.round(((e.clientY - r.top) / r.height) * meta.h) };
  };
  let lastMove = 0;
  canvas.addEventListener('mousemove', (e) => { const n = Date.now(); if (n - lastMove < 30) return; lastMove = n; send({ type: 'mousemove', ...pos(e) }); });
  canvas.addEventListener('mousedown', (e) => { e.preventDefault(); screen.focus(); send({ type: 'mousedown', button: e.button, clickCount: e.detail || 1, ...pos(e) }); });
  canvas.addEventListener('mouseup', (e) => { e.preventDefault(); send({ type: 'mouseup', button: e.button, clickCount: e.detail || 1, ...pos(e) }); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); send({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, ...pos(e) }); }, { passive: false });
  screen.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // handled by paste event
    e.preventDefault();
    send({ type: 'keydown', key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
  });
  screen.addEventListener('paste', (e) => {
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (t) { e.preventDefault(); send({ type: 'text', text: t }); }
  });

  $('.url-form', root).addEventListener('submit', (e) => { e.preventDefault(); send({ type: 'navigate', url: urlInput.value }); screen.focus(); });
  $('.paste-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('.paste', root);
    if (inp.value) send({ type: 'text', text: inp.value });
    inp.value = '';
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (['back', 'forward', 'reload', 'home', 'closetab'].includes(act)) send({ type: act });
    if (act === 'tab') send({ type: 'tab', dir: 1 });
    if (act === 'cookies') { m.close(); openCookies(a); }
    if (act === 'done') { m.close(); checkLogin(a); }
  });
  setTimeout(() => screen.focus(), 100);
}

// ---------------- playground ----------------
function openPlayground(a) {
  const m = modal(`<div class="modal-body playground">
    <h3>Test — ${esc(a.name)}</h3>
    <label>Prompt<textarea id="pg-in">Say hello and tell me which model you are in one sentence.</textarea></label>
    <label>Files <span class="muted small">(optional — images, PDF, documents, code… up to 10)</span><input type="file" id="pg-files" multiple></label>
    <label class="check"><input type="checkbox" id="pg-stream" checked> Stream</label>
    <div class="actions" style="align-items:center"><button class="btn primary" id="pg-go">Send</button>
      <button class="btn" id="pg-watch" title="See the account's browser while it answers">Watch live</button>
      <span class="muted small" id="pg-time"></span></div>
    <h4>Response</h4><div class="out" id="pg-out"></div>
    <h4>curl</h4><pre class="code" id="pg-curl"></pre>
    <div class="actions right"><button class="btn ghost" data-close>Close</button></div></div>`, { onClose: () => ctl && ctl.abort() });
  let ctl = null;
  const curl = () => `curl ${a.endpoints.base}/chat/completions \\\n  -H "Authorization: Bearer ${a.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model: a.slug, messages: [{ role: 'user', content: $('#pg-in', m.el).value }] }).replace(/'/g, "'\\''")}'`;
  $('#pg-curl', m.el).textContent = curl();
  $('#pg-in', m.el).addEventListener('input', () => ($('#pg-curl', m.el).textContent = curl()));
  $('#pg-watch', m.el).onclick = () => openBrowser(a);
  $('#pg-go', m.el).onclick = async () => {
    const out = $('#pg-out', m.el);
    const go = $('#pg-go', m.el);
    out.textContent = '';
    let got = false;
    const waiting = document.createElement('span');
    waiting.className = 'muted';
    waiting.textContent = `Waiting for ${a.providerName} to answer… (click "Watch live" to see the browser)`;
    out.appendChild(waiting);
    const write = (t) => { if (!got) { got = true; out.textContent = ''; } out.textContent += t; out.scrollTop = out.scrollHeight; };
    go.disabled = true;
    const t0 = Date.now();
    const timer = setInterval(() => ($('#pg-time', m.el).textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`), 100);
    ctl = new AbortController();
    const stream = $('#pg-stream', m.el).checked;
    // Build OpenAI content parts: text + each file as base64 (images as image_url, others as file).
    const readDataUrl = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
    const content = [{ type: 'text', text: $('#pg-in', m.el).value }];
    for (const f of $('#pg-files', m.el).files) {
      const url = await readDataUrl(f);
      content.push(f.type.startsWith('image/') ? { type: 'image_url', image_url: { url } } : { type: 'file', file: { filename: f.name, file_data: url } });
    }
    const userContent = content.length > 1 ? content : $('#pg-in', m.el).value;
    try {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.apiKey}` },
        body: JSON.stringify({ model: a.slug, stream, messages: [{ role: 'user', content: userContent }] }),
      });
      if (!stream) {
        const j = await r.json();
        write(j.error ? '⚠ ' + j.error.message : j.choices[0].message.content);
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const l of lines) {
            if (!l.startsWith('data: ') || l === 'data: [DONE]') continue;
            const j = JSON.parse(l.slice(6));
            if (j.error) write((got ? '\n' : '') + '⚠ ' + j.error.message);
            const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (d) write(d);
          }
        }
      }
    } catch (e) { if (e.name !== 'AbortError') write('⚠ ' + e.message); }
    if (!got) write('⚠ Empty response.');
    clearInterval(timer);
    go.disabled = false;
    loadAccounts();
  };
}

// ---------------- VPN ----------------
async function loadVpn() {
  state.vpn = await api('/api/vpn');
  renderVpnPill();
  if (state.tab === 'vpn') renderVpn(true);
}

function renderVpnPill() {
  const s = state.vpn.status;
  const pill = $('#vpn-pill');
  const ip = s.ip && s.ip.ip ? `${s.ip.ip}${s.ip.country ? ' · ' + s.ip.country : ''}` : 'no IP';
  let cls = 'warn', label = '';
  if (s.status === 'connected') { cls = 'ok'; label = `VPN on · ${ip}`; }
  else if (s.status === 'external') { cls = 'ok'; label = `External · ${ip}`; }
  else if (s.status === 'connecting') { cls = 'warn'; label = 'VPN connecting…'; }
  else if (s.status === 'error') { cls = 'bad'; label = 'VPN error'; }
  else { cls = s.mode === 'none' ? 'warn' : 'bad'; label = `Direct · ${ip}`; }
  pill.className = 'pill ' + cls;
  pill.textContent = label;
}

let vpnFormFilled = false;
function renderVpn(statusOnly = false) {
  const v = state.vpn;
  if (!v) return;
  const s = v.status;
  if (!statusOnly || !vpnFormFilled) {
    vpnFormFilled = true;
    const c = v.config;
    $('#vpn-provider').innerHTML = v.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('#vpn-mode').value = s.envLocked ? s.mode : c.mode;
    $('#vpn-mode').disabled = s.envLocked;
    $('#vpn-env-locked').hidden = !s.envLocked;
    $('#vpn-provider').value = c.provider || 'custom';
    $('#vpn-wg').value = c.wireguardConfig || '';
    $('#vpn-ovpn').value = c.openvpnConfig || '';
    $('#vpn-user').value = c.openvpnUser || '';
    $('#vpn-pass').value = c.openvpnPass || '';
    $('#vpn-dns').value = c.dns || '';
    $('#vpn-lan').value = c.lanBypass || '';
    $('#vpn-ks').checked = !!c.killSwitch;
    $('#vpn-auto').checked = c.autoConnect !== false;
    updateVpnForm();
  }
  $('#vpn-capable-warning').hidden = s.capable !== false;
  $('#vpn-capable-warning').textContent = s.capableError || '';
  const ip = s.ip || {};
  const rows = [
    ['State', `<strong>${esc(s.status)}</strong>${s.error ? ` <span class="error">${esc(s.error)}</span>` : ''}`],
    ['Mode', esc(s.mode)],
    ['Interface', esc(s.iface || '—')],
    ['Exit IP', esc(ip.ip || ip.error || '—')],
    ['Location', esc([ip.city, ip.country].filter(Boolean).join(', ') || '—')],
    ['Network', esc(ip.org || '—')],
    ['Kill switch', s.killSwitch ? 'on' : 'off'],
    ['Since', s.since && s.status === 'connected' ? new Date(s.since).toLocaleString() : '—'],
  ];
  $('#vpn-status').innerHTML = rows.map(([k, val]) => `<span>${k}</span><span>${val}</span>`).join('');
  const log = $('#vpn-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
  log.textContent = (s.log || []).join('\n') || 'No log yet.';
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function updateVpnForm() {
  const mode = $('#vpn-mode').value;
  const tunnel = mode === 'wireguard' || mode === 'openvpn';
  $('#vpn-config-area').hidden = !tunnel;
  $('#vpn-external-help').hidden = mode !== 'external';
  $$('[data-mode="wireguard"]').forEach((e) => (e.hidden = mode !== 'wireguard'));
  $$('[data-mode="openvpn"]').forEach((e) => (e.hidden = mode !== 'openvpn'));
  $$('[data-mode="tunnel"]').forEach((e) => (e.hidden = !tunnel));
  const preset = state.vpn.presets.find((p) => p.id === $('#vpn-provider').value);
  $('#vpn-help').textContent = preset ? preset.help : '';
  $('#nordlynx-box').hidden = !(preset && preset.id === 'nordvpn' && mode === 'wireguard');
  $('#vpn-connect').hidden = !tunnel;
  $('#vpn-disconnect').hidden = !tunnel;
}
$('#vpn-mode').addEventListener('change', updateVpnForm);
$('#vpn-provider').addEventListener('change', updateVpnForm);
const loadFile = (input, target) => input.addEventListener('change', async () => { const f = input.files[0]; if (f) $(target).value = await f.text(); input.value = ''; });
loadFile($('#vpn-wg-file'), '#vpn-wg');
loadFile($('#vpn-ovpn-file'), '#vpn-ovpn');

function vpnFormData() {
  return {
    mode: $('#vpn-mode').value,
    provider: $('#vpn-provider').value,
    wireguardConfig: $('#vpn-wg').value,
    openvpnConfig: $('#vpn-ovpn').value,
    openvpnUser: $('#vpn-user').value,
    openvpnPass: $('#vpn-pass').value,
    dns: $('#vpn-dns').value,
    lanBypass: $('#vpn-lan').value,
    killSwitch: $('#vpn-ks').checked,
    autoConnect: $('#vpn-auto').checked,
  };
}
async function vpnAction(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working…';
  try { state.vpn = await fn(); toast('Done'); }
  catch (e) { toast(e.message, true); if (e.data && e.data.status) state.vpn = e.data; }
  btn.disabled = false; btn.textContent = label;
  renderVpnPill(); renderVpn(true);
}
$('#vpn-save').onclick = (e) => vpnAction(e.target, () => api('/api/vpn', { method: 'PUT', body: vpnFormData() }));
$('#vpn-connect').onclick = (e) => vpnAction(e.target, async () => { await api('/api/vpn', { method: 'PUT', body: vpnFormData() }); return api('/api/vpn/connect', { body: {} }); });
$('#vpn-disconnect').onclick = (e) => vpnAction(e.target, () => api('/api/vpn/disconnect', { body: {} }));
$('#vpn-refresh').onclick = (e) => vpnAction(e.target, () => api('/api/vpn/refresh-ip', { body: {} }));
$('#nord-gen').onclick = async (e) => {
  const b = e.target; b.disabled = true;
  try {
    const r = await api('/api/vpn/nordlynx', { body: { token: $('#nord-token').value, country: $('#nord-country').value } });
    $('#vpn-wg').value = r.config;
    toast(`Config generated for ${r.server}. Click "Save & connect".`);
  } catch (err) { toast(err.message, true); }
  b.disabled = false;
};

// ---------------- API tab ----------------
function apiBase() {
  const s = state.settings;
  return ((s && (s.publicUrl || s.envPublicUrl)) || location.origin).replace(/\/+$/, '') + '/v1';
}
function renderApi() {
  if (!state.settings) return;
  $('#api-base').textContent = apiBase();
  $('#api-base').dataset.copy = apiBase();
  $('#api-master').textContent = mask(state.settings.masterKey);
  $('#api-master').dataset.copy = state.settings.masterKey;
  $('#api-spec').href = apiBase() + '/openapi.json';
  $('#api-spec').textContent = 'openapi.json';
  $('#api-table tbody').innerHTML = state.accounts.map((a) => `<tr>
      <td>${esc(a.name)} <span class="muted small">${esc(a.providerName)}</span></td>
      <td><code class="copyable" data-copy="${esc(a.slug)}">${esc(a.slug)}</code></td>
      <td><code class="copyable" data-copy="${esc(a.endpoints.accountBase)}">${esc(a.endpoints.accountBase)}</code></td>
      <td><a href="${esc(a.endpoints.openapi)}" target="_blank">json</a> · <a href="${esc(a.endpoints.docs)}" target="_blank">docs</a></td></tr>`).join('') ||
    '<tr><td colspan="4" class="muted">No accounts yet.</td></tr>';
  renderCode();
}
function renderCode() {
  const a = state.accounts[0];
  const key = a ? a.apiKey : 'sk-a2v-…';
  const model = a ? a.slug : 'my-account';
  const base = apiBase();
  const ex = {
    curl: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "stream": true, "messages": [{"role": "user", "content": "Hello!"}]}'`,
    python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="${key}")\n\nstream = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n    stream=True,\n)\nfor chunk in stream:\n    print(chunk.choices[0].delta.content or "", end="", flush=True)`,
    node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}", apiKey: "${key}" });\n\nconst res = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Hello!" }],\n});\nconsole.log(res.choices[0].message.content);`,
  };
  $('#code-example').textContent = ex[state.codeLang];
}
$('#code-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.codeLang = b.dataset.lang;
  $$('#code-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderCode();
});
$('[data-view="api"]').addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) copy(c.dataset.copy); });
$('#rotate-master').onclick = async () => {
  if (!confirm('Rotate the master key?')) return;
  const r = await api('/api/settings/rotate-master', { body: {} });
  state.settings.masterKey = r.masterKey;
  renderApi();
  toast('Master key rotated');
};

// ---------------- settings ----------------
async function loadSettings() { state.settings = await api('/api/settings'); }
function renderSettings() {
  const s = state.settings;
  $('#set-public').value = s.publicUrl || '';
  $('#set-public').placeholder = s.envPublicUrl || s.detectedBase;
  $('#set-public-hint').textContent = `Currently used: ${(s.publicUrl || s.envPublicUrl || s.detectedBase)}. Leave empty to auto-detect from the request.`;
  $('#set-idle').value = s.idleMinutes;
  $('#set-timeout').value = s.requestTimeoutSec;
  $('#set-overrides').value = JSON.stringify(s.providerOverrides || {}, null, 2);
  $('#pw-locked').hidden = !s.passwordEnvLocked;
  $('#pw-form').hidden = s.passwordEnvLocked;
}
$('#set-save').onclick = async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: { publicUrl: $('#set-public').value, idleMinutes: $('#set-idle').value, requestTimeoutSec: $('#set-timeout').value } });
    await loadSettings(); await loadAccounts(); renderSettings(); toast('Saved');
  } catch (e) { toast(e.message, true); }
};
$('#overrides-save').onclick = async () => {
  let ov;
  try { ov = JSON.parse($('#set-overrides').value || '{}'); } catch (e) { return toast('Invalid JSON: ' + e.message, true); }
  try {
    await api('/api/settings', { method: 'PUT', body: { providerOverrides: ov } });
    await loadSettings(); state.providers = await api('/api/providers'); await loadAccounts(); toast('Overrides saved');
  } catch (e) { toast(e.message, true); }
};
$('#show-builtin').onclick = async (e) => {
  e.preventDefault();
  const id = prompt('Provider id (' + state.providers.map((p) => p.id).join(', ') + ')', 'chatgpt');
  if (!id) return;
  try {
    const def = await api(`/api/providers/${encodeURIComponent(id)}`);
    modal(`<div class="modal-body"><h3>${esc(def.name)}</h3><pre class="code" style="max-height:60vh">${esc(JSON.stringify(def, null, 2))}</pre><div class="actions right"><button class="btn" data-close>Close</button></div></div>`);
  } catch (err) { toast(err.message, true); }
};
$('#pw-save').onclick = async () => {
  try { await api('/api/password', { body: { current: $('#pw-cur').value, next: $('#pw-new').value } }); toast('Password changed'); $('#pw-cur').value = $('#pw-new').value = ''; }
  catch (e) { toast(e.message, true); }
};

// ---------------- polling ----------------
setInterval(() => {
  if ($('#app-view').hidden || document.hidden) return;
  if (state.tab === 'vpn') loadVpn().catch(() => {});
  else if (state.tab === 'accounts' && !$('.modal-backdrop')) loadAccounts().catch(() => {});
}, 5000);
setInterval(() => { if (!$('#app-view').hidden && !document.hidden) loadVpn().catch(() => {}); }, 30000);

// ---------------- boot ----------------
api('/api/me').then((r) => (r.loggedIn ? showApp() : showLogin())).catch(showLogin);
