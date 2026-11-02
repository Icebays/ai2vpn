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
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
    return c == null ? '' : String(c);
  };
  const msgs = (messages || []).map((m) => ({ role: m.role, content: text(m.content).trim() })).filter((m) => m.content);
  if (!msgs.length) return '';
  if (msgs.length === 1 && msgs[0].role === 'user') return msgs[0].content;
  const label = { system: 'System', developer: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };
  const parts = msgs.map((m) => `[${label[m.role] || m.role}]\n${m.content}`);
  const last = msgs[msgs.length - 1];
  const intro =
    'Below is a conversation transcript. Follow any [System] instructions and reply to the final [User] message as the Assistant. ' +
    'Reply with the answer only, without a role label.\n\n';
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
async function runChat({ browsers, store, account, prompt, model, onDelta, signal, timeoutMs }) {
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
    let lastChange = Date.now();
    let seenBusy = !!snap.busy;
    const stableMs = Number(provider.stableMs) || 2000;
    while (true) {
      if (signal && signal.aborted) {
        if (sel.busy) await page.locator(sel.busy).first().click({ timeout: 2000 }).catch(() => {});
        throw new ChatError('Client closed the request', 499, 'aborted');
      }
      const text = snap.text || '';
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        // Only emit when the new text extends what was already sent.
        if (text.startsWith(emitted) && text.length > emitted.length) {
          const chunk = text.slice(emitted.length);
          emitted = text;
          if (onDelta) onDelta(chunk);
        }
      }
      if (snap.busy) seenBusy = true;
      const quiet = Date.now() - lastChange;
      const need = sel.busy && seenBusy ? stableMs : Math.max(stableMs, 3000);
      if (!snap.busy && text && quiet >= need) break;
      if (Date.now() > hardDeadline) break;
      await sleep(350);
      snap = await page.evaluate(pageSnapshot, sel).catch(() => snap);
    }

    const final = lastText || '';
    if (!final.startsWith(emitted)) {
      // Formatting was rewritten after streaming (e.g. a code block closed): send the remainder.
      let i = 0;
      while (i < emitted.length && emitted[i] === final[i]) i++;
      const rest = final.slice(Math.max(i, emitted.length));
      if (rest && onDelta) onDelta(rest);
    }
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
