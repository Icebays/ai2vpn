'use strict';
const express = require('express');
const crypto = require('crypto');
const { runChat, flattenMessages, ChatError } = require('./driver');
const { safeEqual, KeyedQueue } = require('./util');
const { buildOpenApi } = require('./openapi');
const { directLogin } = require('./login');
const { FileStore, fileObject, extractAttachments, materialize, mimeFor, MAX_FILE_BYTES } = require('./attachments');
const Busboy = require('busboy');
const fsp = require('fs').promises;

function baseUrl(store, req) {
  const configured = (store.settings.publicUrl || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function modelId(account) {
  return account.slug;
}

function oaiError(res, status, message, code = 'error', type = 'invalid_request_error') {
  res.status(status).json({ error: { message, type, code } });
}

function getKey(req) {
  const h = req.headers.authorization || '';
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim();
  return (req.headers['x-api-key'] || '').toString().trim();
}

const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));

function createOpenAIRouter({ store, browsers }) {
  const router = express.Router({ mergeParams: true });
  const queue = new KeyedQueue(Number(process.env.MAX_QUEUE || 20));
  const files = new FileStore(store.dir);
  const isMasterKey = (req) => {
    const key = getKey(req);
    return !!(key && store.settings.masterKey && safeEqual(key, store.settings.masterKey));
  };

  /** Who owns uploaded files: the account behind the key, or "master". */
  function fileOwner(req, res) {
    if (isMasterKey(req) && !req.params.slug) return 'master';
    const a = resolveAccount(req, res, 'x-files');
    return a ? a.id : null;
  }

  /** Find the account this request is for, or send a 401/404. */
  function resolveAccount(req, res, requestedModel) {
    const key = getKey(req);
    if (!key) return oaiError(res, 401, 'Missing API key (Authorization: Bearer sk-a2v-...)', 'invalid_api_key', 'authentication_error');
    const isMaster = store.settings.masterKey && safeEqual(key, store.settings.masterKey);
    const pinned = req.params.slug ? store.account(req.params.slug) : null;
    if (req.params.slug && !pinned) return oaiError(res, 404, `Unknown account '${req.params.slug}'`, 'account_not_found');
    if (pinned) {
      if (isMaster || (pinned.apiKey && safeEqual(key, pinned.apiKey))) return pinned;
      return oaiError(res, 401, 'Invalid API key for this account', 'invalid_api_key', 'authentication_error');
    }
    const byKey = store.accounts.find((a) => a.apiKey && safeEqual(key, a.apiKey));
    if (byKey) return byKey;
    if (!isMaster) return oaiError(res, 401, 'Invalid API key', 'invalid_api_key', 'authentication_error');
    // master key: route by model name
    const m = String(requestedModel || '').toLowerCase();
    const enabled = store.accounts.filter((a) => !a.disabled);
    const hit =
      enabled.find((a) => a.slug === m) ||
      enabled.find((a) => `${a.provider}/${a.slug}` === m) ||
      enabled.find((a) => a.provider === m) ||
      enabled.find((a) => m.startsWith(a.provider + '/'));
    if (hit) return hit;
    return oaiError(res, 404, `No account matches model '${requestedModel}'. Use one of: ${enabled.map(modelId).join(', ')}`, 'model_not_found');
  }

  router.get('/models', (req, res) => {
    const key = getKey(req);
    const isMaster = key && store.settings.masterKey && safeEqual(key, store.settings.masterKey);
    let accounts;
    if (req.params.slug) {
      const a = resolveAccount(req, res);
      if (!a) return;
      accounts = [a];
    } else if (isMaster) accounts = store.accounts.filter((a) => !a.disabled);
    else {
      const a = resolveAccount(req, res);
      if (!a) return;
      accounts = [a];
    }
    res.json({
      object: 'list',
      data: accounts.map((a) => ({
        id: modelId(a),
        object: 'model',
        created: Math.floor((a.createdAt || Date.now()) / 1000),
        owned_by: a.provider,
        name: a.name,
      })),
    });
  });

  router.get('/openapi.json', (req, res) => {
    const a = req.params.slug ? store.account(req.params.slug) : null;
    res.json(buildOpenApi({ base: baseUrl(store, req), account: a, accounts: a ? [a] : store.accounts }));
  });

  router.post('/chat/completions', async (req, res) => {
    const body = req.body || {};
    const account = resolveAccount(req, res, body.model);
    if (!account) return;
    if (account.disabled) return oaiError(res, 403, 'This account is disabled', 'account_disabled');
    if (!Array.isArray(body.messages) || !body.messages.length) return oaiError(res, 400, "'messages' must be a non-empty array");
    const prompt = flattenMessages(body.messages);
    if (!prompt) return oaiError(res, 400, 'No text content in messages');
    let attachments = [];
    try {
      attachments = await extractAttachments(body.messages, { files, owner: account.id, isMaster: isMasterKey(req) });
    } catch (e) {
      return oaiError(res, e.status || 400, e.message, e.code || 'invalid_file');
    }

    const stream = !!body.stream;
    const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const model = modelId(account);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

    let headersSent = false;
    const startStream = () => {
      if (headersSent) return;
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(chunk({ role: 'assistant', content: '' }));
    };
    let keepAlive = null;
    if (stream) {
      startStream();
      keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    }

    account.stats = account.stats || { requests: 0, errors: 0 };
    account.stats.requests++;
    account.stats.lastUsed = Date.now();
    store.save();

    try {
      const chat = async () => {
        let tmp = null;
        try {
          let fileList = [];
          if (attachments.length) {
            tmp = await materialize(attachments, store.dir);
            fileList = attachments.map((a, i) => ({ path: tmp.paths[i], name: a.name, mime: a.mime }));
          }
          return await runChatOnce(fileList);
        } finally {
          if (tmp) fsp.rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
        }
      };
      const runChatOnce = (fileList) =>
        runChat({
          browsers,
          store,
          account,
          prompt,
          files: fileList,
          model: body.model,
          signal: ac.signal,
          timeoutMs: (Number(store.settings.requestTimeoutSec) || 300) * 1000,
          onDelta: stream ? (d) => res.write(chunk({ content: d })) : null,
        });
      const text = await queue.run(account.id, async () => {
        try {
          return await chat();
        } catch (e) {
          // Session expired: sign in again with the saved credentials, then retry once.
          const c = account.credentials;
          if (e.code !== 'not_logged_in' || !c || c.autoRelogin === false || !c.email) throw e;
          console.log(`[api] ${account.slug}: session expired, signing in again`);
          const r = await directLogin({ browsers, store, account, email: c.email, password: c.password, totpSecret: c.totpSecret });
          if (!r.loggedIn) {
            e.message += ` Automatic re-login did not finish: ${r.needsUser || 'unknown reason'}`;
            throw e;
          }
          account.lastCheck = { loggedIn: true, at: Date.now(), url: r.url };
          return chat();
        }
      });
      const usage = { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(text), total_tokens: approxTokens(prompt) + approxTokens(text) };
      if (stream) {
        clearInterval(keepAlive);
        res.write(chunk({}, 'stop'));
        if (body.stream_options && body.stream_options.include_usage) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage,
        });
      }
    } catch (e) {
      clearInterval(keepAlive);
      const status = e.status || 500;
      if (status !== 499) {
        account.stats.errors++;
        account.stats.lastError = `${new Date().toISOString()} ${e.message}`;
        if (e.code === 'not_logged_in') account.lastCheck = { loggedIn: false, at: Date.now() };
        store.save();
        console.error(`[api] ${account.slug}: ${e.message}`);
      }
      if (res.writableEnded || ac.signal.aborted) return;
      if (stream) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error', code: e.code || 'error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        oaiError(res, status, e.message, e.code || 'error', e instanceof ChatError ? 'upstream_error' : 'server_error');
      }
    }
  });

  // ---------------- Files API (OpenAI-compatible) ----------------
  router.post('/files', (req, res) => {
    const owner = fileOwner(req, res);
    if (!owner) return;
    if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      return oaiError(res, 400, 'Upload with multipart/form-data: fields "file" and "purpose"');
    }
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_FILE_BYTES + 1 } });
    } catch (e) {
      return oaiError(res, 400, e.message);
    }
    let purpose = 'user_data';
    let saving = null;
    bb.on('field', (name, val) => {
      if (name === 'purpose') purpose = String(val).slice(0, 40);
    });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || saving) return stream.resume();
      saving = files.saveStream({ stream, filename: info.filename, mime: info.mimeType, purpose, owner });
      saving.catch(() => stream.resume());
    });
    bb.on('close', async () => {
      if (!saving) return oaiError(res, 400, 'Missing "file" field');
      try {
        const meta = await saving;
        meta.purpose = purpose;
        res.json(fileObject(meta));
      } catch (e) {
        oaiError(res, e.status || 400, e.message, e.code || 'invalid_file');
      }
    });
    bb.on('error', (e) => oaiError(res, 400, e.message));
    req.pipe(bb);
  });

  const ownFile = (req, res) => {
    const owner = fileOwner(req, res);
    if (!owner) return null;
    const m = files.get(req.params.id);
    if (!m || (owner !== 'master' && m.owner !== owner)) {
      oaiError(res, 404, `No such file: ${req.params.id}`, 'file_not_found');
      return null;
    }
    return m;
  };
  router.get('/files', (req, res) => {
    const owner = fileOwner(req, res);
    if (!owner) return;
    res.json({ object: 'list', data: files.list(owner === 'master' ? null : owner).map(fileObject) });
  });
  router.get('/files/:id', (req, res) => {
    const m = ownFile(req, res);
    if (m) res.json(fileObject(m));
  });
  router.get('/files/:id/content', async (req, res) => {
    const m = ownFile(req, res);
    if (!m) return;
    res.type(m.mime || mimeFor(m.filename));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(m.filename)}"`);
    res.send(await files.read(m.id));
  });
  router.delete('/files/:id', async (req, res) => {
    const m = ownFile(req, res);
    if (!m) return;
    await files.remove(m.id);
    res.json({ id: m.id, object: 'file', deleted: true });
  });

  router.use((req, res) => oaiError(res, 404, `Unknown endpoint ${req.method} ${req.originalUrl}`, 'not_found'));
  return router;
}

module.exports = { createOpenAIRouter, baseUrl, modelId };
