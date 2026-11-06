'use strict';
/**
 * End-to-end test: starts the server with a local mock chat site, logs an
 * account in via cookie import, and calls the OpenAI-compatible API.
 *   npm test
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'a2v-test-'));

let cookie = '';
async function req(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return { status: r.status, json, text };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'test-pass', ENABLE_MOCK_PROVIDER: '1', HEADLESS: 'true', VPN_MODE: 'external' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  const step = (s) => console.log('  ✓', s);
  try {
    await waitUp();
    assert.equal((await req('GET', '/api/accounts')).status, 401);
    assert.equal((await req('POST', '/api/login', { password: 'nope' })).status, 401);
    assert.equal((await req('POST', '/api/login', { password: 'test-pass' })).status, 200);
    step('admin login');

    const created = await req('POST', '/api/accounts', { provider: 'mock', name: 'Mock One' });
    assert.equal(created.status, 200, created.text);
    const acc = created.json;
    assert.ok(acc.apiKey.startsWith('sk-a2v-'));
    assert.equal(acc.slug, 'mock-one');
    step('account created: ' + acc.slug);
    const a2ForFiles = (await req('POST', '/api/accounts', { provider: 'mock', name: 'Other' })).json;

    let chk = await req('POST', `/api/accounts/${acc.id}/check`, {});
    assert.equal(chk.json.loggedIn, false, JSON.stringify(chk.json));
    step('logged-out state detected');

    const noLogin = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${acc.apiKey}` });
    assert.equal(noLogin.status, 401, noLogin.text);
    assert.equal(noLogin.json.error.code, 'not_logged_in');
    const shot = await fetch(`${BASE}/api/accounts/${acc.id}/debug.png`, { headers: { cookie } });
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');
    step('API reports not_logged_in (+ debug screenshot saved)');

    const imp = await req('POST', `/api/accounts/${acc.id}/cookies`, {
      cookies: JSON.stringify([{ domain: '127.0.0.1', name: 'mock_auth', value: '1', path: '/', secure: false, hostOnly: true }]),
    });
    assert.equal(imp.json.imported, 1, imp.text);
    chk = await req('POST', `/api/accounts/${acc.id}/check`, {});
    assert.equal(chk.json.loggedIn, true, JSON.stringify(chk.json));
    step('cookie import → logged in');

    const bad = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer sk-wrong' });
    assert.equal(bad.status, 401);
    step('bad key rejected');

    const models = await req('GET', '/v1/models', null, { authorization: `Bearer ${acc.apiKey}` });
    assert.deepEqual(models.json.data.map((m) => m.id), ['mock-one']);
    step('/v1/models');

    const t0 = Date.now();
    const r1 = await req('POST', '/v1/chat/completions', { model: 'mock-one', messages: [{ role: 'user', content: 'ping <b>one</b>' }] }, { authorization: `Bearer ${acc.apiKey}` });
    assert.equal(r1.status, 200, r1.text);
    const content = r1.json.choices[0].message.content;
    assert.ok(content.includes('Hello from the **mock** model. You said: ping <b>one</b>'), content);
    assert.ok(content.includes('- one\n- two'), content);
    assert.ok(content.includes('```js\nconsole.log(1 < 2);\n```'), content);
    step(`non-streaming completion (${Date.now() - t0} ms)`);

    // streaming, via per-account URL + master key
    const settings = await req('GET', '/api/settings');
    const master = settings.json.masterKey;
    const r = await fetch(`${BASE}/acc/mock-one/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${master}` },
      body: JSON.stringify({
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'second question' },
        ],
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').includes('text/event-stream'));
    const raw = await r.text();
    const events = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    assert.equal(events[events.length - 1], '[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const deltas = chunks.filter((c) => c.choices && c.choices[0] && c.choices[0].delta.content).length;
    const streamed = chunks.map((c) => (c.choices[0] && c.choices[0].delta.content) || '').join('');
    assert.ok(deltas > 3, 'expected several deltas, got ' + deltas);
    assert.ok(streamed.includes('[System]') && streamed.includes('second question'), streamed);
    assert.ok(!/Reckoning|Pondering|Thinking|thinking/.test(streamed), 'status text leaked into the stream: ' + streamed);
    assert.ok(streamed.startsWith('Hello from the **mock** model.'), streamed);
    assert.ok(streamed.endsWith('```js\nconsole.log(1 < 2);\n```'), streamed);
    assert.ok(chunks.some((c) => c.usage), 'usage chunk');
    assert.ok(chunks.some((c) => c.choices[0] && c.choices[0].finish_reason === 'stop'));
    step(`streaming completion with history (${deltas} deltas)`);

    const routed = await req('POST', '/v1/chat/completions', { model: 'mock-one', messages: [{ role: 'user', content: 'routed' }] }, { authorization: `Bearer ${master}` });
    assert.equal(routed.status, 200, routed.text);
    const unknown = await req('POST', '/v1/chat/completions', { model: 'nope', messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${master}` });
    assert.equal(unknown.status, 404);
    step('master key routes by model');

    // concurrent requests are queued per account
    const both = await Promise.all(
      ['alpha', 'beta'].map((w) => req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: w }] }, { authorization: `Bearer ${acc.apiKey}` }))
    );
    assert.ok(both[0].json.choices[0].message.content.includes('alpha'));
    assert.ok(both[1].json.choices[0].message.content.includes('beta'));
    step('concurrent requests serialized');

    // ---- model selection through the site's model menu ----
    const ask = (model) => req('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'which model' }] }, { authorization: `Bearer ${acc.apiKey}` });
    let mr = await ask('smart-2');
    assert.equal(mr.status, 200, mr.text);
    assert.ok(mr.json.choices[0].message.content.includes('[model: Smart 2, think: off]'), mr.json.choices[0].message.content);
    mr = await ask('Legacy 0.9');
    assert.ok(mr.json.choices[0].message.content.includes('[model: Legacy 0.9,'), mr.json.choices[0].message.content);
    mr = await ask('mock-one/smart-2-think');
    assert.ok(mr.json.choices[0].message.content.includes('[model: Smart 2, think: on]'), mr.json.choices[0].message.content);
    mr = await ask('mock-one');
    assert.ok(mr.json.choices[0].message.content.includes('[model: Fast 1, think: off]'), mr.json.choices[0].message.content);
    mr = await ask('turbo-9000');
    assert.equal(mr.status, 400, mr.text);
    assert.equal(mr.json.error.code, 'model_not_found');
    assert.ok(mr.json.error.message.includes('Fast 1 | Smart 2'), mr.json.error.message);
    step('model menu: pick, submenu, toggle, default, unknown model → 400 with list');

    // the sidebar decoy must never be used, whatever the configured selector says
    for (const modelButton of ['button[aria-haspopup][aria-label*="model" i]', '']) {
      await req('PATCH', `/api/accounts/${acc.id}`, { override: { selectors: { modelButton } } });
      mr = await ask('smart 2');
      assert.equal(mr.status, 200, mr.text);
      const t = mr.json.choices[0].message.content;
      assert.ok(t.includes('[model: Smart 2,') && !t.includes('clicked the sidebar'), `modelButton=${JSON.stringify(modelButton)}: ${t}`);
    }
    await req('PATCH', `/api/accounts/${acc.id}`, { override: null });
    step('model button found near the prompt box; sidebar chat menus ignored');

    const disc = await req('POST', `/api/accounts/${acc.id}/models`, {});
    assert.deepEqual(disc.json.models.map((m) => m.label), ['Fast 1', 'Smart 2', 'Legacy 0.9'], disc.text);
    const ml = await req('GET', '/v1/models', null, { authorization: `Bearer ${acc.apiKey}` });
    assert.ok(ml.json.data.some((m) => m.id === 'mock-one/smart-2'), JSON.stringify(ml.json.data));
    const viaMaster = await req('POST', '/v1/chat/completions', { model: 'mock-one/legacy-0-9', messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${(await req('GET', '/api/settings')).json.masterKey}` });
    assert.ok(viaMaster.json.choices[0].message.content.includes('[model: Legacy 0.9,'), viaMaster.text);
    step('model discovery → /v1/models; master key with account/model');

    // ---- file attachments ----
    const b64 = (t) => Buffer.from(t).toString('base64');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const auth = { authorization: `Bearer ${acc.apiKey}` };
    // (a) base64 file + image, attached via the attach button / file chooser
    let fr = await req('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'read these' },
        { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,' + b64('hello attachments') } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } },
      ] }],
    }, auth);
    assert.equal(fr.status, 200, fr.text);
    let fc = fr.json.choices[0].message.content;
    assert.ok(fc.includes('You said: read these'), fc);
    assert.ok(fc.includes('notes.txt[17b:hello_attachments]'), fc);
    assert.ok(/image-\d\.png\[70b\]/.test(fc), fc);
    step('file + image (base64) attached via attach button / file picker');

    // (b) Files API upload → file_id, attached via the page's <input type=file>
    const fd = new FormData();
    fd.append('purpose', 'user_data');
    fd.append('file', new Blob(['{"a": 1, "b": "two"}'], { type: 'application/json' }), 'data.json');
    const up = await fetch(`${BASE}/v1/files`, { method: 'POST', headers: auth, body: fd });
    const upj = await up.json();
    assert.equal(up.status, 200, JSON.stringify(upj));
    assert.ok(upj.id.startsWith('file-') && upj.bytes === 20 && upj.filename === 'data.json', JSON.stringify(upj));
    const list = await req('GET', '/v1/files', null, auth);
    assert.ok(list.json.data.some((f) => f.id === upj.id));
    const dl = await fetch(`${BASE}/v1/files/${upj.id}/content`, { headers: auth });
    assert.equal(await dl.text(), '{"a": 1, "b": "two"}');
    const other = await req('GET', `/v1/files/${upj.id}`, null, { authorization: `Bearer ${a2ForFiles.apiKey}` });
    assert.equal(other.status, 404, 'another account must not see the file');
    await req('PATCH', `/api/accounts/${acc.id}`, { override: { newChatUrl: `${BASE}/__mock/?static-input` } });
    fr = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'text', text: 'json please' }, { type: 'file', file: { file_id: upj.id } }] }] }, auth);
    assert.equal(fr.status, 200, fr.text);
    assert.ok(fr.json.choices[0].message.content.includes('data.json[20b:{"a":_1,_"b":_"two"}]'), fr.json.choices[0].message.content);
    const del = await req('DELETE', `/v1/files/${upj.id}`, null, auth);
    assert.equal(del.json.deleted, true);
    assert.equal((await req('GET', `/v1/files/${upj.id}`, null, auth)).status, 404);
    step('Files API (upload / list / download / delete / owner isolation) + file_id via file input');

    // (c) no file input and no attach button → drag & drop onto the prompt box
    await req('PATCH', `/api/accounts/${acc.id}`, { override: { selectors: { attach: '', fileInput: '#no-such-input' } } });
    fr = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'drop.md', file_data: b64('# dropped') } }] }] }, auth);
    assert.equal(fr.status, 200, fr.text);
    fc = fr.json.choices[0].message.content;
    assert.ok(fc.includes('drop.md[9b'), fc);
    assert.ok(fc.includes('Please look at the attached file(s).'), fc);
    await req('PATCH', `/api/accounts/${acc.id}`, { override: null });
    step('file-only message via drag & drop');

    const tooMany = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: Array.from({ length: 11 }, (_, i) => ({ type: 'file', file: { filename: `f${i}.txt`, file_data: b64('x' + i) } })) }] }, auth);
    assert.equal(tooMany.status, 400);
    step('file limit enforced');

    // outdated reply selector → generic reply detection still finds the answer
    await req('PATCH', `/api/accounts/${acc.id}`, { override: { selectors: { assistant: '.selector-that-no-longer-exists' } } });
    const fb = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'fallback check' }] }, { authorization: `Bearer ${acc.apiKey}` });
    assert.equal(fb.status, 200, fb.text);
    assert.ok(fb.json.choices[0].message.content.includes('You said: fallback check'), fb.json.choices[0].message.content);
    await req('PATCH', `/api/accounts/${acc.id}`, { override: null });
    step('outdated reply selector → generic fallback');

    const spec = await req('GET', '/acc/mock-one/openapi.json');
    assert.equal(spec.json.openapi, '3.1.0');
    assert.equal(spec.json.servers[0].url, `${BASE}/acc/mock-one/v1`);
    assert.ok(spec.json.paths['/chat/completions'].post);
    step('OpenAPI spec');

    // remote viewer websocket
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/viewer/${acc.id}`, { headers: { cookie } });
      let gotFrame = false;
      let gotMeta = false;
      const t = setTimeout(() => reject(new Error('no frame from viewer')), 15000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) gotFrame = data.length > 1000 && data[0] === 0xff && data[1] === 0xd8; // JPEG
        else if (JSON.parse(data.toString()).type === 'meta') gotMeta = true;
        if (gotFrame && gotMeta) {
          ws.send(JSON.stringify({ type: 'mousemove', x: 10, y: 10 }));
          clearTimeout(t);
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
    const unauth = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/viewer/${acc.id}`);
      ws.on('error', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    assert.ok(unauth, 'viewer must require admin session');
    step('remote browser viewer streams JPEG frames');

    // ---- direct login (email/password, emailed code, TOTP, auto re-login) ----
    const { totp } = require('../src/login');
    assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 30, 8, 59000), '94287082'); // RFC 6238 vector
    const mk = async (name) => (await req('POST', '/api/accounts', { provider: 'mock', name })).json;
    const a2 = await mk('Direct');
    let lg = await req('POST', `/api/accounts/${a2.id}/login`, { email: 'user@example.com', password: 'hunter2' });
    assert.equal(lg.json.loggedIn, true, lg.text);
    step('direct login: email + password');

    const a3 = await mk('Emailed code');
    lg = await req('POST', `/api/accounts/${a3.id}/login`, { email: '2fa@example.com', password: 'hunter2' });
    assert.equal(lg.json.loggedIn, false, lg.text);
    assert.equal(lg.json.codeRequested, true, lg.text);
    lg = await req('POST', `/api/accounts/${a3.id}/login`, { code: '123456' });
    assert.equal(lg.json.loggedIn, true, lg.text);
    step('direct login: verification code step');

    const a4 = await mk('TOTP');
    lg = await req('POST', `/api/accounts/${a4.id}/login`, { email: '2fa@example.com', password: 'hunter2', totpSecret: 'JBSWY3DPEHPK3PXP', remember: true });
    assert.equal(lg.json.loggedIn, true, lg.text);
    assert.equal(lg.json.account.credentials.email, '2fa@example.com');
    assert.equal(lg.json.account.credentials.password, undefined, 'password must not be returned');
    step('direct login: automatic TOTP + saved credentials');

    await req('POST', `/api/accounts/${a4.id}/reset-profile`, {});
    const relog = await req('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'after expiry' }] }, { authorization: `Bearer ${a4.apiKey}` });
    assert.equal(relog.status, 200, relog.text);
    assert.ok(relog.json.choices[0].message.content.includes('after expiry'));
    step('expired session → automatic re-login → request succeeds');

    // ---- one API conversation = one web chat ----
    const a5 = await mk('Conversation');
    await req('POST', `/api/accounts/${a5.id}/login`, { email: 'u@example.com', password: 'hunter2' });
    const k5 = { authorization: `Bearer ${a5.apiKey}` };
    const say = async (messages, extra = {}) => {
      const r = await req('POST', '/v1/chat/completions', { messages, ...extra }, k5);
      assert.equal(r.status, 200, r.text);
      return r.json.choices[0].message.content;
    };
    const sayStream = async (messages) => {
      const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...k5 }, body: JSON.stringify({ stream: true, messages }) });
      return (await r.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6))).map((c) => (c.choices[0] && c.choices[0].delta.content) || '').join('');
    };
    const turnOf = (t) => Number((t.match(/\[turn: (\d+)\]/) || [])[1]);
    let hist = [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'first message' }];
    let c = await say(hist);
    assert.equal(turnOf(c), 1, c);
    hist.push({ role: 'assistant', content: c }, { role: 'user', content: 'second message' });
    c = await say(hist);
    assert.equal(turnOf(c), 2, c);
    assert.ok(c.includes('You said: second message [model') && !c.includes('[User]'), 'only the new message should be sent: ' + c);
    // streamed reply, and a changed system prompt (ignored for matching)
    hist = [{ role: 'system', content: 'a different system prompt' }, ...hist.slice(1), { role: 'assistant', content: c }, { role: 'user', content: 'third message' }];
    c = await sayStream(hist);
    assert.equal(turnOf(c), 3, c);
    hist.push({ role: 'assistant', content: c }, { role: 'user', content: 'fourth message' });
    c = await say(hist);
    assert.equal(turnOf(c), 4, c);
    step('follow-ups continue the same web chat (only the new message is sent, streaming too)');

    // another conversation in between, then back: the first chat is reopened by its URL
    const otherConv = await say([{ role: 'user', content: 'other topic' }]);
    assert.equal(turnOf(otherConv), 1);
    hist.push({ role: 'assistant', content: c }, { role: 'user', content: 'fifth message' });
    c = await say(hist);
    assert.equal(turnOf(c), 5, c);
    step('two conversations interleaved → each keeps its own web chat');

    // edited history → can't match → new chat with the full transcript
    const edited = [{ role: 'user', content: 'first message' }, { role: 'assistant', content: 'something else entirely' }, { role: 'user', content: 'next' }];
    c = await say(edited);
    assert.equal(turnOf(c), 1, c);
    assert.ok(c.includes('Below is a conversation transcript'), c);
    // explicit conversation id: the client only sends the new message
    assert.equal(turnOf(await say([{ role: 'user', content: 'id one' }], { conversation_id: 'abc' })), 1);
    assert.equal(turnOf(await say([{ role: 'user', content: 'id two' }], { conversation_id: 'abc' })), 2);
    // forced new chat
    assert.equal(turnOf(await say([{ role: 'user', content: 'id three' }], { conversation_id: 'abc', new_chat: true })), 1);
    step('edited history → new chat; conversation_id; new_chat');

    // site without per-chat URLs: continue only while that chat is still the open one
    await req('PATCH', `/api/accounts/${a5.id}`, { override: { newChatUrl: `${BASE}/__mock/?no-url` } });
    let x = [{ role: 'user', content: 'x one' }];
    let xc = await say(x);
    x.push({ role: 'assistant', content: xc }, { role: 'user', content: 'x two' });
    xc = await say(x);
    assert.equal(turnOf(xc), 2, xc);
    await say([{ role: 'user', content: 'y one' }]);
    x.push({ role: 'assistant', content: xc }, { role: 'user', content: 'x three' });
    xc = await say(x);
    assert.equal(turnOf(xc), 1, 'chat X is gone from the tab → new chat with transcript: ' + xc);
    assert.ok(xc.includes('Below is a conversation transcript'));
    await req('PATCH', `/api/accounts/${a5.id}`, { override: null });
    step('site without chat URLs: continues in place, falls back safely');

    await req('PUT', '/api/settings', { continueChats: false });
    let off = [{ role: 'user', content: 'off one' }];
    const offc = await say(off);
    off.push({ role: 'assistant', content: offc }, { role: 'user', content: 'off two' });
    assert.equal(turnOf(await say(off)), 1);
    await req('PUT', '/api/settings', { continueChats: true });
    step('setting off → a new chat for every request');

    const vpn = await req('GET', '/api/vpn');
    assert.ok(vpn.json.status && vpn.json.presets.length > 5);
    step('VPN status endpoint (capable=' + vpn.json.status.capable + ')');

    const html = await (await fetch(BASE + '/')).text();
    assert.ok(html.includes('ai2vpn'));
    step('web UI served');

    console.log('\nAll tests passed.');
  } catch (e) {
    console.error('\nTEST FAILED:', e.message);
    console.error('--- server log ---\n' + logs.slice(-4000));
    process.exitCode = 1;
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main();
