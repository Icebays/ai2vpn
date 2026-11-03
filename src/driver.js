'use strict';
const { pageSnapshot } = require('./extract');
const { resolveProvider } = require('./providers');
const { sleep } = require('./util');

/**
 * Turn an OpenAI-style message list into one prompt for a chat web UI.
 * Each request starts a fresh conversation, so the history is replayed inline.
 */
function flattenMessages(messages) {
  const text = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && (p.type === 'text' || p.type === 'input_text') ? p.text : '')).filter(Boolean).join('\n');
    return c == null ? '' : String(c);
  };
  // Names of files attached to a message (the files themselves are uploaded separately).
  const files = (c) =>
    !Array.isArray(c)
      ? []
      : c
          .filter((p) => p && ['image_url', 'input_image', 'file', 'input_file'].includes(p.type))
          .map((p) => (p.type === 'file' ? (p.file && p.file.filename) || 'file' : p.filename || (p.type.includes('image') ? 'image' : 'file')));
  const msgs = (messages || [])
    .map((m) => {
      const f = files(m.content);
      let content = text(m.content).trim();
      return { role: m.role, content, files: f };
    })
    .filter((m) => m.content || m.files.length);
  if (!msgs.length) return '';
  const fileNote = (m) => (m.files.length ? `[Attached: ${m.files.join(', ')}]` : '');
  if (msgs.length === 1 && msgs[0].role === 'user') {
    return msgs[0].content || (msgs[0].files.length ? 'Please look at the attached file(s).' : '');
  }
  const label = { system: 'System', developer: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };
  const parts = msgs.map((m) => `[${label[m.role] || m.role}]\n${[m.content, fileNote(m)].filter(Boolean).join('\n')}`);
  const last = msgs[msgs.length - 1];
  const intro =
    'Below is a conversation transcript. Follow any [System] instructions and reply to the final [User] message as the Assistant. ' +
    'Files mentioned as [Attached: …] are uploaded with this message. Reply with the answer only, without a role label.\n\n';
  return intro + parts.join('\n\n') + (last.role === 'user' ? '' : '\n\n[User]\nContinue.');
}

class ChatError extends Error {
  constructor(message, status = 502, code = 'upstream_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Send one prompt through the provider's web UI and stream the reply.
 * onDelta(textChunk) is called as new text appears.
 */
async function runChat({ browsers, store, account, prompt, model, onDelta, signal, timeoutMs, files = [] }) {
  const provider = resolveProvider(store, account);
  let sel = { ...provider.selectors, loggedOutUrl: provider.loggedOutUrl };
  if (!sel.input || !sel.assistant) throw new ChatError('Provider is missing input/assistant selectors', 500, 'config_error');
  const page = await browsers.getPage(account);
  browsers.setBusy(account.id, true);
  try {
    let url = provider.newChatUrl || provider.homeUrl;
    if (model && provider.modelUrl && !isAlias(model, account, provider)) {
      url = provider.modelUrl.replace('{model}', encodeURIComponent(model));
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const input = page.locator(sel.input).first();
    // Wait for the prompt box; bail out early if the page clearly shows a logged-out state.
    let before = null;
    let loggedOutSince = 0;
    for (const end = Date.now() + 30000; Date.now() < end; ) {
      before = await page.evaluate(pageSnapshot, sel).catch(() => null);
      if (before && before.hasInput) break;
      if (before && before.loggedOut) {
        loggedOutSince = loggedOutSince || Date.now();
        if (Date.now() - loggedOutSince > 3000) break;
      }
      await sleep(400);
    }
    if (!before || !before.hasInput) {
      if (before && before.loggedOut) throw new ChatError(`${provider.name} account is not logged in. Open the web interface and log in.`, 401, 'not_logged_in');
      throw new ChatError(`Prompt box not found on ${page.url()} (selector: ${sel.input}). The site may have changed or needs a login/captcha — open the browser in the web UI to check.`, 502, 'input_not_found');
    }
    // Some sites (e.g. ChatGPT) allow anonymous chats: refuse instead of silently using a guest session.
    if (before.loggedOut) throw new ChatError(`${provider.name} account is not logged in. Open the web interface and log in.`, 401, 'not_logged_in');

    await fillInput(page, input, prompt);
    await sleep(250);
    if (files.length) {
      await uploadFiles(page, input, sel, files, account);
      if (signal && signal.aborted) throw new ChatError('Client closed the request', 499, 'aborted');
    }
    await submit(page, input, sel);

    // Wait for the reply to appear.
    log(account, 'prompt sent, waiting for the reply');
    const genericSel = { ...sel, assistant: GENERIC_ASSISTANT, content: '' };
    const genBefore = await page.evaluate(pageSnapshot, genericSel).catch(() => null);
    const startDeadline = Date.now() + 90000;
    const hardDeadline = Date.now() + (timeoutMs || 300000);
    let snap = before;
    let resent = false;
    const t0 = Date.now();
    while (true) {
      if (signal && signal.aborted) throw new ChatError('Client closed the request', 499, 'aborted');
      await sleep(300);
      snap = await page.evaluate(pageSnapshot, sel).catch(() => snap);
      if (snap.count > before.count || (snap.text && snap.text !== before.text)) break;
      // The configured reply selector may be outdated: after a while, look for a reply generically.
      if (genBefore && Date.now() - t0 > 8000) {
        const g = await page.evaluate(pageSnapshot, genericSel).catch(() => null);
        if (g && g.count > genBefore.count && g.text && !isEcho(g.text, prompt)) {
          log(account, `reply selector "${sel.assistant}" matched nothing — using generic reply detection. Update the selectors in Settings → Provider overrides.`);
          sel = genericSel;
          snap = g;
          break;
        }
      }
      if (!resent && !snap.busy && Date.now() - t0 > 6000) {
        // The click may not have registered: try Enter once.
        resent = true;
        const still = await input.evaluate((el) => (el.value !== undefined ? el.value : el.innerText).trim().length).catch(() => 0);
        if (still > 0) await input.press('Enter').catch(() => {});
      }
      if (Date.now() > startDeadline) {
        throw new ChatError(
          `No reply detected within 90s on ${page.url()} (reply selector: ${sel.assistant}). Open the account's browser in the web UI to see the page; a debug screenshot was saved.`,
          504,
          'timeout'
        );
      }
    }
    log(account, 'reply started');

    // Stream until the reply is stable and nothing indicates it's still generating.
    let emitted = '';
    let lastText = null;
    let prevText = null;
    let lastChange = Date.now();
    let seenBusy = !!snap.busy;
    let firstLogged = false;
    let endReason = 'stable';
    const startedAt = Date.now();
    const stableMs = Number(provider.stableMs) || 2000;
    while (true) {
      if (signal && signal.aborted) {
        if (sel.busy) await page.locator(sel.busy).first().click({ timeout: 2000 }).catch(() => {});
        throw new ChatError('Client closed the request', 499, 'aborted');
      }
      // Text outside the answer area (status lines like "Thinking…") is never streamed.
      const real = snap.matched !== false && !isPlaceholder(snap.text || '');
      const text = real ? snap.text || '' : '';
      if (text && !firstLogged) {
        firstLogged = true;
        log(account, `answer text appeared after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      }
      if ((snap.text || '') !== lastText) {
        lastText = snap.text || '';
        lastChange = Date.now();
      }
      // Stream only the part that has stopped changing, so later re-rendering can't garble output.
      if (text && text.startsWith(emitted)) {
        const cut = commitPoint(text, prevText, emitted.length);
        if (cut > emitted.length) {
          if (onDelta) onDelta(text.slice(emitted.length, cut));
          emitted = text.slice(0, cut);
        }
      }
      prevText = text;
      if (snap.busy) seenBusy = true;
      const quiet = Date.now() - lastChange;
      const need = sel.busy && seenBusy ? stableMs : Math.max(stableMs, 3000);
      // Finished = nothing says "generating" and the reply stopped changing.
      const answer = snap.matched !== false ? snap.text || '' : '';
      if (!snap.busy && answer && quiet >= need) break;
      // Answer-area selector never matched (site changed?): accept the whole reply once it's been still for a while.
      if (!snap.busy && !answer && snap.text && !isPlaceholder(snap.text) && quiet >= Math.max(need, 8000)) {
        endReason = 'stable (answer-area selector did not match; used whole reply)';
        break;
      }
      if (snap.busy && answer && quiet >= 30000) {
        endReason = 'busy indicator stuck (reply unchanged for 30s)';
        break;
      }
      if (Date.now() > hardDeadline) {
        endReason = 'request timeout';
        break;
      }
      await sleep(350);
      snap = await page.evaluate(pageSnapshot, sel).catch(() => snap);
    }

    // Final text: the answer area if found, otherwise whatever the reply element holds.
    let final = snap.matched !== false ? snap.text || '' : '';
    if (!final && lastText && !isPlaceholder(lastText)) final = lastText;
    if (final.startsWith(emitted)) {
      if (final.length > emitted.length && onDelta) onDelta(final.slice(emitted.length));
    } else if (onDelta) {
      // Rare: already-sent text was re-rendered differently. Send what's missing after the common prefix.
      let i = 0;
      while (i < emitted.length && emitted[i] === final[i]) i++;
      log(account, 'warning: reply was re-rendered after streaming started; streamed text may differ slightly from the final reply');
      const rest = final.slice(i);
      if (rest) onDelta(rest);
    }
    log(account, `ended: ${endReason}`);
    if (!final.trim()) throw new ChatError('Empty reply from provider', 502, 'empty_reply');
    log(account, `reply finished (${final.length} chars)`);
    return final;
  } catch (e) {
    if (e.code !== 'aborted') await saveDebug(store, account, page, e).catch(() => {});
    throw e;
  } finally {
    browsers.setBusy(account.id, false);
  }
}

// Typical reply containers across chat sites; used when the configured selector finds nothing.
const GENERIC_ASSISTANT = [
  '[data-message-author-role="assistant"]',
  'div[data-is-streaming]',
  '.font-claude-response',
  '.font-claude-message',
  'model-response',
  '.ds-markdown',
  '.markdown',
  '.prose',
  '[class*="markdown"]',
  '[class*="assistant"]',
].join(', ');

/** Short status lines some sites show before the answer ("Thinking…", "Searching the web…"). */
function isPlaceholder(text) {
  const t = String(text).trim();
  if (!t) return true;
  if (t.length > 120) return false;
  return (
    /^(thinking|thought|reasoning|reckoning|pondering|searching|reading|analy[sz]ing|working|loading|generating|claude is thinking|正在|思考|搜索)/i.test(t) ||
    (/(…|\.\.\.)$/.test(t) && t.length < 60)
  );
}

/**
 * How much of `text` is safe to stream: the prefix that did not change since the last poll,
 * cut at a word boundary (prose) or line boundary (lists, tables, headings), never inside an
 * open code block.
 */
function commitPoint(text, prev, already) {
  if (prev == null) return already;
  let n = 0;
  const max = Math.min(text.length, prev.length);
  while (n < max && text[n] === prev[n]) n++;
  let stable = text.slice(0, n);
  const fences = stable.match(/```/g);
  if (fences && fences.length % 2 === 1) stable = stable.slice(0, stable.lastIndexOf('```'));
  const lineStart = stable.lastIndexOf('\n') + 1;
  const line = stable.slice(lineStart);
  let cut = lineStart;
  if (line.trim() && !/^\s*([`|#>*+-]|\d+[.)])/.test(line)) {
    const sp = stable.lastIndexOf(' ');
    if (sp + 1 > lineStart) cut = sp + 1;
  }
  return Math.max(already, cut);
}

function isEcho(text, prompt) {
  const a = text.replace(/\s+/g, ' ').trim();
  const b = String(prompt).replace(/\s+/g, ' ').trim();
  return !a || a === b || (a.length > 20 && b.includes(a));
}

function log(account, msg) {
  console.log(`[chat] ${account.slug}: ${msg}`);
}

/** Keep a screenshot + HTML of the page from the last failed request (shown in the web UI). */
async function saveDebug(store, account, page, err) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(store.dir, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${account.id}.png`), timeout: 10000 });
  const html = await page.content().catch(() => '');
  fs.writeFileSync(path.join(dir, `${account.id}.html`), `<!-- ${new Date().toISOString()} ${String(err.message).replace(/--/g, '-')} -->\n${html}`);
  account.debugAt = Date.now();
}

function isAlias(model, account, provider) {
  const m = String(model).toLowerCase();
  return !m || m === 'default' || m === account.slug || m === provider.id || m === `${provider.id}/${account.slug}`;
}

/**
 * Attach files to the chat. Tries, in order:
 *   1. the page's <input type=file>
 *   2. clicking the attach button (+ menu item) and answering the file chooser
 *   3. dropping the files onto the prompt box
 * then waits until the site has finished uploading.
 * files: [{ path, name, mime }]
 */
async function uploadFiles(page, input, sel, files, account) {
  const paths = files.map((f) => f.path);
  let method = '';
  const inputs = page.locator(sel.fileInput || 'input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  if (count) {
    // Prefer an input that accepts any file type, then one that allows several files.
    const infos = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      infos.push(await inputs.nth(i).evaluate((el) => ({ multiple: el.multiple, accept: el.accept || '' })).catch(() => ({ multiple: false, accept: 'x' })));
    }
    const allImages = files.every((f) => (f.mime || '').startsWith('image/'));
    const fits = (a) => !a.accept || a.accept.includes('*/*') || (allImages && a.accept.includes('image'));
    let idx = infos.findIndex((a) => fits(a) && a.multiple);
    if (idx < 0) idx = infos.findIndex(fits);
    if (idx < 0) idx = 0;
    const target = inputs.nth(idx);
    if (infos[idx].multiple || paths.length === 1) await target.setInputFiles(paths);
    else for (const p of paths) {
      await target.setInputFiles(p);
      await sleep(600);
    }
    method = 'file input';
  } else if (sel.attach && (await page.locator(sel.attach).first().isVisible().catch(() => false))) {
    const chooserP = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.locator(sel.attach).first().click({ timeout: 5000 });
    if (sel.attachMenu) {
      const item = page.locator(sel.attachMenu).first();
      await item.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
      await item.click({ timeout: 4000 }).catch(() => {});
    }
    const chooser = await chooserP.catch(() => null);
    if (!chooser) throw new ChatError('Clicked the attach button but no file picker opened (selectors attach / attachMenu may be outdated).', 502, 'upload_failed');
    if (chooser.isMultiple() || paths.length === 1) await chooser.setFiles(paths);
    else await chooser.setFiles(paths[0]); // site allows one file at a time
    method = 'attach button';
  } else {
    const payload = await Promise.all(
      files.map(async (f) => ({ name: f.name, type: f.mime || 'application/octet-stream', b64: (await require('fs').promises.readFile(f.path)).toString('base64') }))
    );
    await input.evaluate((el, list) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }, payload);
    method = 'drag & drop';
  }
  log(account, `attached ${files.length} file(s) via ${method}: ${files.map((f) => f.name).join(', ')}`);

  // Wait for the upload: no "uploading" indicator and (if known) the send button enabled.
  await sleep(1200 + 300 * files.length);
  const deadline = Date.now() + (Number(process.env.UPLOAD_TIMEOUT_SEC) || 180) * 1000;
  while (Date.now() < deadline) {
    const uploading = sel.uploading ? await page.locator(sel.uploading).first().isVisible().catch(() => false) : false;
    let ready = true;
    if (sel.send) {
      const btn = page.locator(sel.send).first();
      ready = (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false));
    }
    if (!uploading && ready) return;
    await sleep(500);
  }
  log(account, 'upload still looks busy after the timeout — sending anyway');
}

async function fillInput(page, input, text) {
  await input.click({ timeout: 10000 }).catch(() => {});
  const isField = await input.evaluate((el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  if (isField) {
    await input.fill(text);
  } else {
    await input.focus().catch(() => {});
    // clear existing content
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.insertText(text);
  }
}

async function submit(page, input, sel) {
  if (sel.send) {
    const btn = page.locator(sel.send).first();
    try {
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      for (let i = 0; i < 20 && !(await btn.isEnabled().catch(() => false)); i++) await sleep(150);
      await btn.click({ timeout: 5000 });
      return;
    } catch (e) {
      /* fall through to Enter */
    }
  }
  await input.press('Enter');
}

module.exports = { runChat, flattenMessages, ChatError };
