'use strict';
/**
 * Direct login: sign in to the provider with email + password (+ optional 2FA)
 * by filling the provider's own sign-in pages inside the account's browser.
 *
 * It works step by step on whatever form is visible (email → password → code),
 * so it copes with multi-page flows (OpenAI, Google, DeepSeek…). Anything it
 * cannot do itself — captchas, "check your email" codes, passkeys, device
 * approval — is reported as `needsUser`, and you finish it in the remote
 * browser (or send the code with `code`).
 */
const crypto = require('crypto');
const { resolveProvider } = require('./providers');
const { pageSnapshot } = require('./extract');
const { sleep } = require('./util');

const EMAIL_SEL = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input#identifierId',
  'input[name="identifier"]',
].join(', ');
const PASSWORD_SEL = 'input[type="password"]:not([aria-hidden="true"])';
const CODE_SEL = [
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  'input[name*="otp" i]',
  'input[name="totpPin"]',
  'input[id*="code" i]',
  'input[inputmode="numeric"]',
].join(', ');
const SUBMIT_TEXT = /^(continue|next|log ?in|sign ?in|submit|verify|confirm|continue with (email|password)|登录|下一步|继续|确认)$/i;
const CHALLENGE_SEL = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="recaptcha"]',
  'iframe[title*="captcha" i]',
  '#challenge-form',
  'div[id*="arkose" i]',
].join(', ');

/** RFC 6238 TOTP from a base32 secret. */
function totp(secret, step = 30, digits = 6, now = Date.now()) {
  const clean = String(secret).replace(/[\s=-]/g, '').toUpperCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('2FA secret must be base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const h = crypto.createHmac('sha1', bytes).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).toString();
  return n.padStart(digits, '0');
}

async function visible(page, sel) {
  const loc = page.locator(sel);
  const n = Math.min(await loc.count().catch(() => 0), 8);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function clickSubmit(page, field) {
  // Prefer a real submit button in the same form, then a button with a typical label, then Enter.
  const form = field ? field.locator('xpath=ancestor::form[1]') : null;
  if (form && (await form.count().catch(() => 0))) {
    const btn = form.locator('button[type="submit"], input[type="submit"]').first();
    if ((await btn.count()) && (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
      return btn.click({ timeout: 5000 }).then(() => true).catch(() => false);
    }
  }
  const buttons = page.locator('button, [role="button"], input[type="submit"]');
  const n = Math.min(await buttons.count().catch(() => 0), 60);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const txt = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
    if (SUBMIT_TEXT.test(txt) && (await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
      return b.click({ timeout: 5000 }).then(() => true).catch(() => false);
    }
  }
  if (field) await field.press('Enter').catch(() => {});
  return true;
}

async function typeInto(el, value) {
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill('');
  // type with a small delay — some sign-in forms ignore programmatic .fill()
  await el.pressSequentially(String(value), { delay: 35 });
}

async function isLoggedIn(page, provider) {
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch (e) {
      return '';
    }
  };
  if (host(page.url()) !== host(provider.homeUrl)) return false;
  const snap = await page.evaluate(pageSnapshot, { ...provider.selectors, loggedOutUrl: provider.loggedOutUrl }).catch(() => null);
  return !!(snap && snap.hasInput && !snap.loggedOut);
}

/**
 * Run (or continue) the sign-in flow.
 * @returns {Promise<{loggedIn:boolean, needsUser?:string, url:string, steps:string[]}>}
 */
async function directLogin({ browsers, store, account, email, password, totpSecret, code, timeoutMs = 90000 }) {
  const provider = resolveProvider(store, account);
  const page = await browsers.getPage(account);
  const steps = [];
  const log = (s) => {
    steps.push(s);
    console.log(`[login] ${account.slug}: ${s}`);
  };
  browsers.setBusy(account.id, true);
  try {
    if (code) {
      // Continue a flow that is waiting for an emailed/SMS code.
      const f = (await visible(page, CODE_SEL)) || (await visible(page, 'input:not([type="hidden"]):not([type="password"])'));
      if (!f) return { loggedIn: false, needsUser: 'No code field visible — finish in the remote browser.', url: page.url(), steps };
      await typeInto(f, code);
      await clickSubmit(page, f);
      log('submitted verification code');
    } else {
      if (await isLoggedIn(page, provider)) return { loggedIn: true, url: page.url(), steps: ['already logged in'] };
      await page.goto(provider.loginUrl || provider.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      log(`opened ${page.url()}`);
    }

    const done = { email: false, password: false, totp: false, entry: false };
    let lastUrl = '';
    let idleSince = Date.now();
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await sleep(900);
      if (page.isClosed()) break;
      const url = page.url();
      if (url !== lastUrl) {
        lastUrl = url;
        idleSince = Date.now();
        done.email = done.password = false; // a new page may ask again (e.g. Google re-auth)
      }
      if (await isLoggedIn(page, provider)) {
        log('logged in');
        return { loggedIn: true, url, steps };
      }

      if (await visible(page, CHALLENGE_SEL)) {
        return { loggedIn: false, needsUser: 'A captcha / bot check is shown — solve it in the remote browser.', url, steps };
      }

      const pw = await visible(page, PASSWORD_SEL);
      if (pw && password && !done.password) {
        // Some forms show email + password together.
        const em = await visible(page, EMAIL_SEL);
        if (em && email && !(await em.inputValue().catch(() => ''))) await typeInto(em, email);
        await typeInto(pw, password);
        await clickSubmit(page, pw);
        done.password = true;
        idleSince = Date.now();
        log('entered password');
        continue;
      }
      const em = await visible(page, EMAIL_SEL);
      if (em && email && !done.email) {
        const cur = await em.inputValue().catch(() => '');
        if (cur !== email) await typeInto(em, email);
        await clickSubmit(page, em);
        done.email = true;
        idleSince = Date.now();
        log('entered email');
        continue;
      }
      const cf = await visible(page, CODE_SEL);
      if (cf && !pw && !em) {
        if (totpSecret && !done.totp) {
          await typeInto(cf, totp(totpSecret));
          await clickSubmit(page, cf);
          done.totp = true;
          idleSince = Date.now();
          log('entered 2FA code');
          continue;
        }
        if (!totpSecret || done.totp) {
          return { loggedIn: false, needsUser: 'The site is asking for a verification code (email/SMS/authenticator). Enter it below or in the remote browser.', url, steps, codeRequested: true };
        }
      }
      // Landing pages with a "Log in" button before the form (e.g. ChatGPT, Kimi).
      if (!em && !pw && !done.entry && provider.loginButton) {
        const b = await visible(page, provider.loginButton);
        if (b) {
          await b.click({ timeout: 5000 }).catch(() => {});
          done.entry = true;
          idleSince = Date.now();
          log('clicked log-in button');
          continue;
        }
      }
      if (Date.now() - idleSince > 20000) {
        return {
          loggedIn: false,
          needsUser: 'Sign-in stopped at a step that needs you (e.g. "check your email" link, passkey, device approval, or an unfamiliar form). Continue in the remote browser.',
          url,
          steps,
        };
      }
    }
    return { loggedIn: false, needsUser: 'Timed out — continue in the remote browser.', url: page.url(), steps };
  } finally {
    browsers.setBusy(account.id, false);
  }
}

module.exports = { directLogin, totp };
