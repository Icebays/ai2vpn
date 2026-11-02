'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const { resolveProvider } = require('./providers');
const { pageSnapshot } = require('./extract');
const { sleep } = require('./util');

const HEADLESS = process.env.HEADLESS === 'true';
const VIEWPORT = { width: 1280, height: 860 };

/**
 * One persistent Chromium profile per account (stored in /data/profiles/<id>),
 * launched on demand and closed after a period of inactivity.
 */
class BrowserManager {
  constructor(store) {
    this.store = store;
    this.sessions = new Map(); // accountId -> { context, starting, lastUsed, viewers:Set }
    this._sweeper = setInterval(() => this._sweep().catch(() => {}), 60 * 1000);
    this._sweeper.unref();
  }

  isRunning(accountId) {
    const s = this.sessions.get(accountId);
    return !!(s && s.context);
  }

  async getContext(account) {
    let s = this.sessions.get(account.id);
    if (s && s.context) {
      s.lastUsed = Date.now();
      return s.context;
    }
    if (s && s.starting) return s.starting;
    s = { context: null, starting: null, lastUsed: Date.now(), viewers: new Set() };
    this.sessions.set(account.id, s);
    s.starting = this._launch(account)
      .then((ctx) => {
        s.context = ctx;
        s.starting = null;
        ctx.on('close', () => {
          if (this.sessions.get(account.id) === s) this.sessions.delete(account.id);
          for (const v of s.viewers) v.onContextClosed();
        });
        return ctx;
      })
      .catch((e) => {
        this.sessions.delete(account.id);
        throw e;
      });
    return s.starting;
  }

  async _launch(account) {
    const dir = this.store.profileDir(account.id);
    fs.mkdirSync(dir, { recursive: true });
    // A crashed Chromium leaves a lock behind that prevents the profile from opening.
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.rmSync(`${dir}/${f}`, { force: true });
      } catch (e) {}
    }
    const opts = {
      headless: HEADLESS,
      viewport: VIEWPORT,
      locale: process.env.BROWSER_LOCALE || 'en-US',
      timezoneId: process.env.TZ && process.env.TZ !== 'UTC' ? process.env.TZ : undefined,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height + 120}`,
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
    const ctx = await chromium.launchPersistentContext(dir, opts);
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (e) {}
    });
    const fixPage = async (page) => {
      page.on('dialog', (d) => d.accept().catch(() => {}));
      if (HEADLESS) {
        try {
          const cdp = await ctx.newCDPSession(page);
          const { userAgent } = await cdp.send('Browser.getVersion');
          await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
        } catch (e) {}
      }
    };
    ctx.pages().forEach(fixPage);
    ctx.on('page', fixPage);
    console.log(`[browser] started profile for ${account.slug} (${account.provider})`);
    return ctx;
  }

  /** The main page used for automation (the first tab). */
  async getPage(account) {
    const ctx = await this.getContext(account);
    let page = ctx.pages().find((p) => !p.isClosed());
    if (!page) page = await ctx.newPage();
    return page;
  }

  touch(accountId) {
    const s = this.sessions.get(accountId);
    if (s) s.lastUsed = Date.now();
  }

  async close(accountId) {
    const s = this.sessions.get(accountId);
    if (!s) return;
    this.sessions.delete(accountId);
    try {
      const ctx = s.context || (await s.starting);
      await ctx.close();
    } catch (e) {}
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  async _sweep() {
    const idleMs = (Number(this.store.settings.idleMinutes) || 0) * 60000;
    if (!idleMs) return;
    for (const [id, s] of this.sessions) {
      if (s.context && s.viewers.size === 0 && !s.busy && Date.now() - s.lastUsed > idleMs) {
        console.log(`[browser] closing idle profile ${id}`);
        await this.close(id);
      }
    }
  }

  setBusy(accountId, busy) {
    const s = this.sessions.get(accountId);
    if (s) {
      s.busy = busy;
      s.lastUsed = Date.now();
    }
  }

  /** Open the provider and decide whether the account is logged in. */
  async checkLogin(account) {
    const provider = resolveProvider(this.store, account);
    const page = await this.getPage(account);
    // Always (re)load so freshly imported cookies / a just-finished login are picked up.
    await page.goto(provider.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const sel = { ...provider.selectors, loggedOutUrl: provider.loggedOutUrl };
    let snap = null;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      snap = await page.evaluate(pageSnapshot, sel).catch(() => null);
      if (snap && (snap.loggedOut || snap.hasInput) && i >= 3) break;
    }
    const loggedIn = !!(snap && snap.hasInput && !snap.loggedOut);
    return { loggedIn, url: snap ? snap.url : page.url(), hasInput: !!(snap && snap.hasInput), loggedOutMarker: !!(snap && snap.loggedOut) };
  }

  async importCookies(account, cookies) {
    const ctx = await this.getContext(account);
    await ctx.addCookies(cookies);
    return cookies.length;
  }

  // ---------- Remote viewer (CDP screencast) ----------

  async attachViewer(account, ws) {
    const ctx = await this.getContext(account);
    const s = this.sessions.get(account.id);
    const viewer = new Viewer(ctx, ws, account, this.store);
    s.viewers.add(viewer);
    ws.on('close', () => {
      s.viewers.delete(viewer);
      viewer.dispose();
      this.touch(account.id);
    });
    await viewer.start();
    return viewer;
  }
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch (e) {
    return '';
  }
}

class Viewer {
  constructor(ctx, ws, account, store) {
    this.ctx = ctx;
    this.ws = ws;
    this.account = account;
    this.store = store;
    this.page = null;
    this.cdp = null;
    this.disposed = false;
    this.hooked = new WeakSet();
    this.lastFrameAt = 0;
    this._onPage = (p) => this.switchTo(p).catch(() => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      this.handle(msg).catch((e) => this.send({ type: 'error', message: e.message }));
    });
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async start() {
    this.ctx.on('page', this._onPage);
    let page = this.ctx.pages().filter((p) => !p.isClosed()).pop();
    if (!page) page = await this.ctx.newPage();
    if (page.url() === 'about:blank') {
      const provider = resolveProvider(this.store, this.account);
      if (provider.homeUrl && provider.homeUrl !== 'about:blank') {
        await page.goto(provider.homeUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
      }
    }
    await this.switchTo(page);
  }

  async switchTo(page) {
    if (this.disposed || page === this.page) return;
    await this._stopCast();
    this.page = page;
    if (!this.hooked.has(page)) {
      this.hooked.add(page);
      page.once('close', () => {
        if (this.page !== page || this.disposed) return;
        const next = this.ctx.pages().filter((p) => !p.isClosed()).pop();
        if (next) this.switchTo(next).catch(() => {});
      });
      page.on('framenavigated', (f) => {
        if (f !== page.mainFrame() || this.page !== page || this.disposed) return;
        this.sendMeta();
        // Watchdog: if frames stop after a cross-site navigation, restart the screencast.
        const navAt = Date.now();
        setTimeout(() => {
          if (this.disposed || this.page !== page || page.isClosed() || this.lastFrameAt > navAt) return;
          this._stopCast()
            .then(() => this._startCast(page))
            .catch(() => {});
        }, 2500);
      });
    }
    page.bringToFront().catch(() => {});
    // A brand-new tab/popup may still be swapping renderers; give it a moment to settle.
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.disposed || this.page !== page || page.isClosed()) return;
      try {
        await this._startCast(page);
        this.sendMeta();
        return;
      } catch (e) {
        lastErr = e;
        await this._stopCast();
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }

  async _startCast(page) {
    const cdp = await this.ctx.newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      this.lastFrameAt = Date.now();
      if (this.ws.readyState !== 1 || this.cdp !== cdp) return;
      if (this.ws.bufferedAmount > 4 * 1024 * 1024) return; // slow client: drop frame
      const m = f.metadata || {};
      this.send({ type: 'frame-meta', w: m.deviceWidth, h: m.deviceHeight });
      this.ws.send(Buffer.from(f.data, 'base64'));
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  }

  sendMeta() {
    if (!this.page) return;
    const pages = this.ctx.pages().filter((p) => !p.isClosed());
    this.page
      .title()
      .catch(() => '')
      .then((title) => this.send({ type: 'meta', url: this.page.url(), title, tabs: pages.length, tab: pages.indexOf(this.page) }));
  }

  async _stopCast() {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  async handle(m) {
    const page = this.page;
    if (!page || page.isClosed()) return;
    const mouseBtn = ['left', 'middle', 'right'][m.button || 0] || 'left';
    switch (m.type) {
      case 'mousemove':
        return page.mouse.move(m.x, m.y);
      case 'mousedown':
        await page.mouse.move(m.x, m.y);
        return page.mouse.down({ button: mouseBtn, clickCount: m.clickCount || 1 });
      case 'mouseup':
        await page.mouse.move(m.x, m.y);
        return page.mouse.up({ button: mouseBtn, clickCount: m.clickCount || 1 });
      case 'wheel':
        await page.mouse.move(m.x, m.y);
        return page.mouse.wheel(m.dx || 0, m.dy || 0);
      case 'keydown': {
        const key = mapKey(m.key);
        if (!key) return;
        if (key.length === 1 && !m.ctrl && !m.meta && !m.alt) return page.keyboard.insertText(key);
        if (key.length === 1) {
          const mods = [m.ctrl && 'Control', m.meta && 'Meta', m.alt && 'Alt', m.shift && 'Shift'].filter(Boolean);
          return page.keyboard.press([...mods, key].join('+'));
        }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return; // modifiers are folded into combos
        const mods = [m.ctrl && 'Control', m.meta && 'Meta', m.alt && 'Alt', m.shift && 'Shift'].filter(Boolean);
        return page.keyboard.press([...mods, key].join('+'));
      }
      case 'text':
        return page.keyboard.insertText(String(m.text || ''));
      case 'navigate': {
        let url = String(m.url || '').trim();
        if (!url) return;
        if (!/^[a-z]+:/i.test(url)) url = 'https://' + url;
        return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => this.send({ type: 'error', message: e.message }));
      }
      case 'back':
        return page.goBack({ timeout: 15000 }).catch(() => {});
      case 'forward':
        return page.goForward({ timeout: 15000 }).catch(() => {});
      case 'reload':
        return page.reload({ timeout: 30000 }).catch(() => {});
      case 'home': {
        const provider = resolveProvider(this.store, this.account);
        return page.goto(provider.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      case 'tab': {
        const pages = this.ctx.pages().filter((p) => !p.isClosed());
        const next = pages[(pages.indexOf(page) + (m.dir || 1) + pages.length) % pages.length];
        return next && this.switchTo(next);
      }
      case 'closetab': {
        const pages = this.ctx.pages().filter((p) => !p.isClosed());
        if (pages.length > 1) return page.close().catch(() => {});
        return;
      }
    }
  }

  onContextClosed() {
    this.send({ type: 'closed' });
    try {
      this.ws.close();
    } catch (e) {}
  }

  dispose() {
    this.disposed = true;
    this.ctx.off('page', this._onPage);
    this._stopCast().catch(() => {});
  }
}

const KEYMAP = { ' ': ' ', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Del: 'Delete' };
const ALLOWED_NAMED = new Set([
  'Backspace', 'Tab', 'Enter', 'Escape', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift', 'Control', 'Alt', 'Meta',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
function mapKey(k) {
  if (!k) return null;
  k = KEYMAP[k] || k;
  if ([...k].length === 1) return k;
  return ALLOWED_NAMED.has(k) ? k : null;
}

module.exports = { BrowserManager };
