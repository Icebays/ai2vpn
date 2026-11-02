'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { Store } = require('./store');
const { AdminAuth } = require('./auth');
const { BrowserManager } = require('./browser');
const { VpnManager } = require('./vpn');
const { PRESETS, nordlynxConfig } = require('./vpn-presets');
const { createOpenAIRouter, baseUrl } = require('./openai');
const { buildOpenApi } = require('./openapi');
const { listProviders, resolveProvider, BUILTIN } = require('./providers');
const { parseCookieText } = require('./cookies');
const { directLogin } = require('./login');
const { newApiKey, randomId, slugify } = require('./util');

const PORT = Number(process.env.PORT || 8080);
const store = new Store();
const auth = new AdminAuth(store);
const browsers = new BrowserManager(store);
const vpn = new VpnManager(store);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// ---------------- health ----------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------- OpenAI-compatible API ----------------
const api = createOpenAIRouter({ store, browsers });
const cors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
app.use('/v1', cors, api);
app.use('/acc/:slug/v1', cors, api);
app.get('/acc/:slug/openapi.json', cors, (req, res) => {
  const a = store.account(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Unknown account' });
  res.json(buildOpenApi({ base: baseUrl(store, req), account: a, accounts: [a] }));
});
app.get(['/docs', '/acc/:slug/docs'], (req, res) => {
  const spec = req.params.slug ? `/acc/${encodeURIComponent(req.params.slug)}/openapi.json` : '/v1/openapi.json';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API docs</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head>
<body style="margin:0;background:#fff"><div id="ui"></div><script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:${JSON.stringify(spec)},dom_id:'#ui',persistAuthorization:true});</script></body></html>`);
});

// ---------------- admin API ----------------
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!auth.allowAttempt(ip)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  if (!auth.checkPassword(String((req.body || {}).password || ''))) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', auth.cookie(auth.issue(), req));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.cookie('', req));
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ loggedIn: auth.fromRequest(req) }));

const admin = express.Router();
admin.use(auth.middleware());

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[admin]', req.method, req.path, e.message);
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  });

function accountView(a, req) {
  const p = resolveProvider(store, a);
  const base = baseUrl(store, req);
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    provider: a.provider,
    providerName: p.name,
    color: p.color,
    homeUrl: p.homeUrl,
    apiKey: a.apiKey,
    disabled: !!a.disabled,
    createdAt: a.createdAt,
    override: a.override || null,
    running: browsers.isRunning(a.id),
    credentials: a.credentials ? { email: a.credentials.email, totp: !!a.credentials.totpSecret, autoRelogin: a.credentials.autoRelogin !== false } : null,
    lastCheck: a.lastCheck || null,
    debugAt: a.debugAt || null,
    stats: a.stats || { requests: 0, errors: 0 },
    endpoints: {
      base: `${base}/v1`,
      accountBase: `${base}/acc/${a.slug}/v1`,
      openapi: `${base}/acc/${a.slug}/openapi.json`,
      docs: `${base}/acc/${a.slug}/docs`,
    },
  };
}

function uniqueSlug(wanted, exceptId) {
  let base = slugify(wanted);
  let s = base;
  for (let i = 2; store.accounts.some((a) => a.slug === s && a.id !== exceptId); i++) s = `${base}-${i}`;
  return s;
}

function need(account) {
  if (!account) {
    const e = new Error('Account not found');
    e.status = 404;
    throw e;
  }
  return account;
}

admin.get('/providers', (req, res) => res.json(listProviders(store)));
admin.get('/providers/:id', (req, res) => {
  const def = BUILTIN[req.params.id] || (store.data.providerOverrides || {})[req.params.id];
  if (!def) return res.status(404).json({ error: 'Unknown provider' });
  res.json(resolveProvider(store, { provider: req.params.id }));
});

admin.get('/accounts', (req, res) => res.json(store.accounts.map((a) => accountView(a, req))));

admin.post(
  '/accounts',
  wrap((req, res) => {
    const { name, provider, slug } = req.body || {};
    const known = listProviders(store).map((p) => p.id);
    if (!known.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
    const p = resolveProvider(store, { provider });
    const a = {
      id: randomId(12),
      slug: uniqueSlug(slug || name || `${provider}`),
      name: String(name || p.name).slice(0, 80),
      provider,
      apiKey: newApiKey(),
      createdAt: Date.now(),
      stats: { requests: 0, errors: 0 },
    };
    store.accounts.push(a);
    store.save();
    res.json(accountView(a, req));
  })
);

admin.patch(
  '/accounts/:id',
  wrap((req, res) => {
    const a = need(store.account(req.params.id));
    const b = req.body || {};
    if (b.name !== undefined) a.name = String(b.name).slice(0, 80);
    if (b.slug !== undefined) a.slug = uniqueSlug(b.slug, a.id);
    if (b.disabled !== undefined) a.disabled = !!b.disabled;
    if (b.override !== undefined) {
      if (b.override && typeof b.override !== 'object') return res.status(400).json({ error: 'override must be an object' });
      a.override = b.override && Object.keys(b.override).length ? b.override : undefined;
    }
    store.save();
    res.json(accountView(a, req));
  })
);

admin.delete(
  '/accounts/:id',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    await browsers.close(a.id);
    store.data.accounts = store.accounts.filter((x) => x.id !== a.id);
    store.save();
    if (req.query.wipe === '1') {
      require('fs').rmSync(store.profileDir(a.id), { recursive: true, force: true });
    }
    res.json({ ok: true });
  })
);

admin.post(
  '/accounts/:id/rotate-key',
  wrap((req, res) => {
    const a = need(store.account(req.params.id));
    a.apiKey = newApiKey();
    store.save();
    res.json(accountView(a, req));
  })
);

admin.post(
  '/accounts/:id/check',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    const r = await browsers.checkLogin(a);
    a.lastCheck = { loggedIn: r.loggedIn, at: Date.now(), url: r.url };
    store.save();
    res.json({ ...r, account: accountView(a, req) });
  })
);

admin.post(
  '/accounts/:id/cookies',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    const p = resolveProvider(store, a);
    const cookies = parseCookieText((req.body || {}).cookies, p.homeUrl);
    const n = await browsers.importCookies(a, cookies);
    res.json({ imported: n });
  })
);

// Direct login with email/password (+2FA). Continue a waiting flow by sending { code }.
admin.post(
  '/accounts/:id/login',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    const b = req.body || {};
    const saved = a.credentials || {};
    const email = b.email || saved.email;
    const password = b.password || saved.password;
    const totpSecret = b.totpSecret !== undefined && b.totpSecret !== '' ? b.totpSecret : saved.totpSecret;
    if (!b.code && (!email || !password) && !(email && a.provider === 'claude')) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (b.remember === true && email) {
      a.credentials = { email, password, totpSecret: totpSecret || '', autoRelogin: b.autoRelogin !== false };
    } else if (b.remember === false) {
      delete a.credentials;
    }
    store.save();
    const r = await directLogin({ browsers, store, account: a, email, password, totpSecret, code: b.code });
    if (r.loggedIn) a.lastCheck = { loggedIn: true, at: Date.now(), url: r.url };
    store.save();
    res.json({ ...r, account: accountView(a, req) });
  })
);
admin.delete(
  '/accounts/:id/credentials',
  wrap((req, res) => {
    const a = need(store.account(req.params.id));
    delete a.credentials;
    store.save();
    res.json(accountView(a, req));
  })
);

// Screenshot / HTML of the page from the last failed request.
admin.get('/accounts/:id/debug.:ext(png|html)', (req, res) => {
  const a = store.account(req.params.id);
  if (!a) return res.status(404).json({ error: 'Account not found' });
  const file = path.join(store.dir, 'debug', `${a.id}.${req.params.ext}`);
  if (!require('fs').existsSync(file)) return res.status(404).json({ error: 'No debug capture yet' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.params.ext === 'html') res.type('text/plain'); // show the source, don't render it
  res.sendFile(file);
});

admin.post(
  '/accounts/:id/close',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    await browsers.close(a.id);
    res.json(accountView(a, req));
  })
);

admin.post(
  '/accounts/:id/reset-profile',
  wrap(async (req, res) => {
    const a = need(store.account(req.params.id));
    await browsers.close(a.id);
    require('fs').rmSync(store.profileDir(a.id), { recursive: true, force: true });
    a.lastCheck = null;
    store.save();
    res.json(accountView(a, req));
  })
);

// ---- settings ----
admin.get('/settings', (req, res) =>
  res.json({
    ...store.settings,
    providerOverrides: store.data.providerOverrides,
    detectedBase: baseUrl(store, req),
    envPublicUrl: process.env.PUBLIC_URL || '',
    passwordEnvLocked: auth.envLocked,
    headless: process.env.HEADLESS === 'true',
  })
);
admin.put(
  '/settings',
  wrap((req, res) => {
    const b = req.body || {};
    const s = store.settings;
    if (b.publicUrl !== undefined) s.publicUrl = String(b.publicUrl).trim().replace(/\/+$/, '');
    if (b.idleMinutes !== undefined) s.idleMinutes = Math.max(0, Number(b.idleMinutes) || 0);
    if (b.requestTimeoutSec !== undefined) s.requestTimeoutSec = Math.min(3600, Math.max(30, Number(b.requestTimeoutSec) || 300));
    if (b.providerOverrides !== undefined) {
      if (typeof b.providerOverrides !== 'object' || Array.isArray(b.providerOverrides)) return res.status(400).json({ error: 'providerOverrides must be an object' });
      store.data.providerOverrides = b.providerOverrides || {};
    }
    store.save();
    res.json({ ok: true });
  })
);
admin.post('/settings/rotate-master', (req, res) => {
  store.settings.masterKey = newApiKey();
  store.save();
  res.json({ masterKey: store.settings.masterKey });
});
admin.post(
  '/password',
  wrap((req, res) => {
    const { current, next } = req.body || {};
    if (!auth.checkPassword(String(current || ''))) return res.status(401).json({ error: 'Current password is wrong' });
    auth.setPassword(next);
    res.setHeader('Set-Cookie', auth.cookie(auth.issue(), req));
    res.json({ ok: true });
  })
);

// ---- VPN ----
const vpnView = () => {
  const v = store.vpn;
  return {
    config: { ...v, openvpnPass: v.openvpnPass ? '••••••••' : '' },
    status: vpn.status(),
    presets: PRESETS,
  };
};
admin.get('/vpn', (req, res) => res.json(vpnView()));
admin.put(
  '/vpn',
  wrap(async (req, res) => {
    const b = req.body || {};
    const v = store.vpn;
    for (const k of ['mode', 'provider', 'wireguardConfig', 'openvpnConfig', 'openvpnUser', 'lanBypass', 'dns']) {
      if (b[k] !== undefined) v[k] = String(b[k]);
    }
    if (b.openvpnPass !== undefined && b.openvpnPass !== '••••••••') v.openvpnPass = String(b.openvpnPass);
    if (b.killSwitch !== undefined) v.killSwitch = !!b.killSwitch;
    if (b.autoConnect !== undefined) v.autoConnect = !!b.autoConnect;
    if (!['none', 'wireguard', 'openvpn', 'external'].includes(v.mode)) v.mode = 'none';
    store.flush();
    await vpn.reconfigure().catch((e) => vpn.log(e.message));
    res.json(vpnView());
  })
);
admin.post(
  '/vpn/connect',
  wrap(async (req, res) => {
    try {
      await vpn.connect();
    } catch (e) {
      return res.status(400).json({ error: e.message, ...vpnView() });
    }
    res.json(vpnView());
  })
);
admin.post(
  '/vpn/disconnect',
  wrap(async (req, res) => {
    await vpn.disconnect();
    res.json(vpnView());
  })
);
admin.post(
  '/vpn/refresh-ip',
  wrap(async (req, res) => {
    await vpn.refreshIp();
    res.json(vpnView());
  })
);
admin.post(
  '/vpn/nordlynx',
  wrap(async (req, res) => {
    const r = await nordlynxConfig(req.body || {});
    res.json(r);
  })
);

app.use('/api', admin);

// ---------------- mock provider for tests ----------------
if (process.env.ENABLE_MOCK_PROVIDER === '1') {
  app.use('/__mock', express.static(path.join(__dirname, '..', 'test', 'mock-chat')));
}

// ---------------- web UI ----------------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '5m' }));

// ---------------- websocket: remote browser viewer ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const m = req.url.match(/^\/ws\/viewer\/([\w-]+)/);
  if (!m || !auth.fromRequest(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const account = store.account(m[1]);
  if (!account) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    browsers.attachViewer(account, ws).catch((e) => {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Could not start browser: ' + e.message }));
        ws.close();
      } catch (err) {}
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ai2vpn] web UI + API listening on http://0.0.0.0:${PORT}`);
  vpn.init().catch((e) => console.error('[vpn] init failed:', e.message));
});

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[ai2vpn] ${sig}: shutting down`);
  try {
    store.flush();
  } catch (e) {}
  const t = setTimeout(() => process.exit(0), 8000);
  await browsers.closeAll().catch(() => {});
  await vpn.shutdown().catch(() => {});
  clearTimeout(t);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
