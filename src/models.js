'use strict';
/**
 * Model selection by clicking each site's own model menu.
 *
 * Provider fields (all overridable in Settings → Provider overrides):
 *   selectors.modelButton   button that opens the model menu (its text = current model)
 *   selectors.modelOption   menu entries (default: role=menuitem / menuitemradio / option)
 *   moreModels              regex for entries that open a submenu ("More models", "Legacy models"…)
 *   modelToggles            [{ label, selector, match }] on/off switches, e.g. DeepSeek "DeepThink":
 *                           switched on when the requested model matches `match` (regex), else off
 *   staticModels            model names to advertise for toggle-only sites
 *
 * The requested model is matched loosely against the menu text, so "claude-opus-4-1",
 * "opus 4.1" and "Opus-4.1" all pick "Opus 4.1"; "gpt-5-thinking" picks "GPT-5 Thinking".
 */
const { sleep, slugify } = require('./util');

const DEFAULT_OPTION = '[role="menuitem"], [role="menuitemradio"], [role="option"]';
const DEFAULT_MORE = 'more models|other models|legacy|show more|更多|其他';
const STOP = new Set(['claude', 'gemini', 'google', 'openai', 'chatgpt', 'gpt', 'anthropic', 'model', 'models', 'deepseek', 'kimi', 'moonshot', 'grok', 'xai', 'qwen', 'mistral', 'latest', 'chat', 'the', 'ai']);

class ModelError extends Error {
  constructor(message, status = 400, code = 'model_not_found') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** Distinctive tokens of a requested model name. Empty = "no particular model". */
function modelTokens(model) {
  return words(model).filter((t) => !STOP.has(t));
}

/** 1 = every distinctive token of `model` appears in `label`. */
function score(model, label) {
  const want = modelTokens(model);
  if (!want.length) return 0;
  const have = words(label);
  const joined = have.join('');
  let hit = 0;
  for (const t of want) if (have.includes(t) || (t.length > 2 && joined.includes(t))) hit++;
  return hit / want.length;
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

async function firstVisible(page, selector) {
  if (!selector) return null;
  const loc = page.locator(selector);
  const n = Math.min(await loc.count().catch(() => 0), 10);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  return null;
}

async function visibleOptions(page, optionSel) {
  const loc = page.locator(optionSel).filter({ visible: true });
  const n = Math.min(await loc.count().catch(() => 0), 60);
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = (await loc.nth(i).innerText().catch(() => '')).trim();
    if (text) out.push({ index: i, text, label: firstLine(text), loc: loc.nth(i) });
  }
  return out;
}

async function closeMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(150);
}

/** "More models", "Legacy models"… — submenu openers, not models (models carry a version number). */
function isExpander(provider, label) {
  const more = new RegExp(provider.moreModels || DEFAULT_MORE, 'i');
  return more.test(label) && label.length < 40 && !/\d/.test(label);
}

function pickBest(model, options) {
  let best = null;
  for (const o of options) {
    const sc = score(model, o.label) || score(model, o.text) * 0.99;
    if (!best || sc > best.sc || (sc === best.sc && o.label.length < best.o.label.length)) best = { o, sc };
  }
  return best && best.sc >= 1 ? best.o : null;
}

/** Open the menu and collect options, expanding "More models"-style submenus once. */
async function collectOptions(page, sel, provider, { want } = {}) {
  const btn = await firstVisible(page, sel.modelButton);
  if (!btn) return null;
  await btn.click({ timeout: 5000 });
  await sleep(500);
  const optionSel = sel.modelOption || DEFAULT_OPTION;
  let options = await visibleOptions(page, optionSel);
  if (want && pickBest(want, options)) return { options, btn };
  const expanders = options.filter((o) => isExpander(provider, o.label));
  for (const ex of expanders) {
    await ex.loc.hover({ timeout: 2000 }).catch(() => {});
    await sleep(400);
    let extra = await visibleOptions(page, optionSel);
    if (extra.length <= options.length) {
      await ex.loc.click({ timeout: 2000 }).catch(() => {});
      await sleep(500);
      extra = await visibleOptions(page, optionSel);
    }
    options = extra;
    if (want && pickBest(want, options)) break;
  }
  return { options, btn };
}

async function applyToggles(page, provider, model, log) {
  const toggles = provider.modelToggles || [];
  let applied = 0;
  for (const t of toggles) {
    const el = await firstVisible(page, t.selector);
    if (!el) {
      log(`model toggle "${t.label}" not found (selector ${t.selector})`);
      continue;
    }
    const want = new RegExp(t.match, 'i').test(model);
    const on = await el.evaluate((n) => {
      const a = (k) => n.getAttribute(k);
      return a('aria-pressed') === 'true' || a('aria-checked') === 'true' || a('data-state') === 'on' || /(^|[\s_-])(selected|active|checked|on)([\s_-]|$)|--selected|--active/i.test(n.className || '');
    });
    if (on !== want) {
      await el.click({ timeout: 3000 });
      await sleep(300);
      log(`turned ${want ? 'on' : 'off'} "${t.label}"`);
    }
    applied++;
  }
  return applied;
}

/**
 * Select `model` in the open chat page. Returns { changed, label } or throws ModelError
 * (status 400) listing what the site offers when nothing matches.
 * Returns null when the site has no model menu/toggles (caller may fall back to modelUrl).
 */
async function selectModel(page, provider, model, log = () => {}) {
  const sel = provider.selectors || {};
  const toggles = (provider.modelToggles || []).length;
  if (!sel.modelButton && !toggles) return null;
  let result = { changed: false, label: '' };
  // Words that drive a toggle (e.g. "think") are not part of the menu entry's name.
  const menuModel = toggles
    ? words(model).filter((w) => !provider.modelToggles.some((t) => new RegExp(t.match, 'i').test(w))).join(' ')
    : model;

  if (sel.modelButton && modelTokens(menuModel).length) {
    const btn = await firstVisible(page, sel.modelButton);
    if (!btn) {
      if (!toggles) return null;
    } else {
      const current = firstLine(await btn.innerText().catch(() => ''));
      if (score(menuModel, current) >= 1) {
        log(`model "${current}" already selected`);
        result.label = current;
      } else {
        const got = await collectOptions(page, sel, provider, { want: menuModel });
        const choice = got && pickBest(menuModel, got.options);
        if (!choice) {
          const labels = got ? [...new Set(got.options.map((o) => o.label))] : [];
          await closeMenu(page);
          {
            throw new ModelError(
              `Model "${menuModel}" not found in ${provider.name}'s model menu.` + (labels.length ? ` Available: ${labels.join(' | ')}` : ' (menu had no recognizable entries — selectors may be outdated)')
            );
          }
        } else {
          await choice.loc.click({ timeout: 5000 });
          await sleep(600);
          // Some menus stay open after choosing; close them.
          if ((await page.locator(sel.modelOption || DEFAULT_OPTION).filter({ visible: true }).count().catch(() => 0)) > 0) await closeMenu(page);
          log(`selected model "${choice.label}"`);
          result = { changed: true, label: choice.label };
        }
      }
    }
  }
  if (toggles) {
    const n = await applyToggles(page, provider, model, log);
    if (n) result.changed = true;
  }
  return result;
}

/** Read the model names a site offers (for /v1/models and the web UI). */
async function discoverModels(page, provider) {
  const sel = provider.selectors || {};
  const labels = [];
  if (sel.modelButton) {
    const got = await collectOptions(page, sel, provider, {});
    if (got) {
      for (const o of got.options) if (!isExpander(provider, o.label)) labels.push(o.label);
      await closeMenu(page);
    }
  }
  for (const m of provider.staticModels || []) labels.push(m);
  const seen = new Set();
  return labels
    .filter((l) => l && l.length <= 60 && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()))
    .map((label) => ({ id: slugify(label), label }));
}

module.exports = { selectModel, discoverModels, modelTokens, score, ModelError };
