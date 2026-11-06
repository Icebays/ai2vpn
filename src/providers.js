'use strict';
/**
 * Built-in provider definitions.
 *
 * Each provider is driven through its normal web UI inside a real Chromium
 * profile, so the account you log in with is the account that is used.
 * The CSS selectors below describe where the prompt box, the send button and
 * the replies live. Web UIs change often: every field can be overridden from
 * the web interface (Settings → Provider overrides) without rebuilding.
 *
 * selectors:
 *   input      prompt box (textarea or contenteditable)
 *   send       send button (optional — Enter is used when missing/disabled)
 *   busy       element visible only while a reply is being generated (optional)
 *   assistant  one element per assistant reply; the last one is read
 *   content    (optional) the part of a reply that holds the answer text
 *   exclude    (optional) elements to drop from a reply (thinking, buttons…)
 *   contentPick (optional) "last" = use only the last `content` match of a reply
 *   loggedOut  (optional) element visible only when NOT logged in
 *   fileInput  (optional) <input type=file> used to attach files (default: any file input)
 *   attach     (optional) button that opens the file picker when there's no file input
 *   attachMenu (optional) menu item to click after `attach` (e.g. "Upload files")
 *   uploading  (optional) element visible while an attachment is still uploading
 * loggedOutUrl  (optional) regex; when the page URL matches, you're logged out
 * loginUrl      (optional) where "Direct login" starts (defaults to homeUrl)
 * loginButton   (optional) button that opens the sign-in form from a landing page
 * stableMs      how long the reply must stay unchanged to count as finished
 * modelUrl      (optional) URL template used when a request names a model and the model menu
 *               can't be used, e.g. "https://chatgpt.com/?model={model}"
 * Model menu fields (selectors.modelButton / modelOption, moreModels, modelToggles,
 * staticModels — when modelButton finds nothing, the button is located automatically;
 * staticModels) are documented in src/models.js.
 */
const BUILTIN = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    color: '#10a37f',
    homeUrl: 'https://chatgpt.com/',
    loginUrl: 'https://chatgpt.com/auth/login',
    loginButton: 'button[data-testid="login-button"]',
    newChatUrl: 'https://chatgpt.com/',
    modelUrl: 'https://chatgpt.com/?model={model}',
    selectors: {
      input: '#prompt-textarea',
      send: 'button[data-testid="send-button"], #composer-submit-button',
      busy: 'button[data-testid="stop-button"]',
      assistant: '[data-message-author-role="assistant"]',
      content: '.markdown',
      exclude: 'button, [data-testid*="copy"], .sr-only',
      loggedOut: 'button[data-testid="login-button"]',
      attach: 'button[aria-label*="Add files" i], button[aria-label*="Attach" i], #composer-plus-btn',
      attachMenu: '[role="menuitem"]:has-text("Add photos & files"), [role="menuitem"]:has-text("Upload")',
      modelButton: 'button[data-testid="model-switcher-dropdown-button"], button[aria-label*="Model selector" i]',
      modelOption: '[role="menuitem"], [role="menuitemradio"], [data-testid^="model-switcher-"][role]',
    },
    loggedOutUrl: '/auth/login',
    stableMs: 1500,
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    color: '#d97757',
    homeUrl: 'https://claude.ai/new',
    loginUrl: 'https://claude.ai/login',
    newChatUrl: 'https://claude.ai/new',
    selectors: {
      input: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
      send: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
      busy: 'button[aria-label="Stop response"], button[aria-label="Stop Response"], [data-is-streaming="true"]',
      assistant: 'div[data-is-streaming], .font-claude-response, .font-claude-message',
      content: '.standard-markdown, .progressive-markdown',
      contentPick: 'last', // the answer is the last markdown block (thinking comes before it)
      exclude: 'button, details, [class*="thinking"]',
      loggedOut: 'a[href="/login"], button[data-testid="login-button"]',
      fileInput: 'input[type="file"][data-testid="file-upload"], input[type="file"]',
      attach: 'button[aria-label*="Add files" i], button[aria-label*="Attach" i], button[data-testid="input-menu-plus"]',
      attachMenu: '[role="menuitem"]:has-text("Upload a file"), [role="menuitem"]:has-text("Add files")',
      modelButton: 'button[data-testid="model-selector-dropdown"]',
    },
    loggedOutUrl: '/login',
    stableMs: 1500,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    color: '#4285f4',
    homeUrl: 'https://gemini.google.com/app',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp',
    newChatUrl: 'https://gemini.google.com/app',
    selectors: {
      input: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]',
      send: 'button.send-button:not(.stop), button[aria-label="Send message"]',
      busy: 'button.send-button.stop, button[aria-label="Stop response"]',
      assistant: 'model-response',
      content: 'message-content .markdown, message-content',
      exclude: 'button, .thoughts-container, model-thoughts',
      loggedOut: 'a[href*="accounts.google.com/ServiceLogin"], a[aria-label="Sign in"]',
      attach: 'button[aria-label*="upload file menu" i], button[aria-label*="Add files" i], button.upload-card-button',
      attachMenu: 'button[data-test-id="local-images-files-uploader-button"], [role="menuitem"]:has-text("Upload files")',
      uploading: 'mat-progress-spinner, .loading-spinner, [role="progressbar"]',
      modelButton: 'button[data-test-id="bard-mode-menu-button"], button.gds-mode-switch-button',
      modelOption: '[role="menuitem"], [role="menuitemradio"], button.mat-mdc-menu-item',
    },
    loggedOutUrl: 'accounts\\.google\\.com',
    stableMs: 2000,
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    color: '#1f1f1f',
    homeUrl: 'https://www.kimi.com/',
    loginButton: '.login-button, button.login',
    newChatUrl: 'https://www.kimi.com/',
    selectors: {
      input: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"], textarea',
      send: '.send-button-container:not(.disabled), .send-button',
      busy: '.send-button-container.stop, .stop-message-btn',
      assistant: '.chat-content-item-assistant, .segment-assistant',
      content: '.markdown-container, .markdown',
      exclude: 'button, .segment-assistant-actions, .toolcall-container, .thinking-container',
      loggedOut: '.login-button, button.login',
      modelButton: '.model-select, .current-model, [class*="model-name"]',
      modelOption: '[role="menuitem"], [role="option"], [class*="model-item"]',
    },
    stableMs: 2500,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    color: '#4d6bfe',
    homeUrl: 'https://chat.deepseek.com/',
    loginUrl: 'https://chat.deepseek.com/sign_in',
    newChatUrl: 'https://chat.deepseek.com/',
    selectors: {
      input: 'textarea#chat-input, textarea',
      send: '',
      busy: '',
      assistant: '.ds-message:has(.ds-markdown)',
      content: '.ds-markdown',
      exclude: 'button, .ds-think-content, [class*="think"]',
      loggedOut: '',
    },
    loggedOutUrl: '/sign_in|/login',
    stableMs: 3000,
    // DeepSeek has no model menu: "DeepThink" switches to the reasoning model (R1).
    modelToggles: [{ label: 'DeepThink', selector: 'div[role="button"]:has-text("DeepThink"), button:has-text("DeepThink")', match: 'reason|r1|think' }],
    staticModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    color: '#000000',
    homeUrl: 'https://grok.com/',
    loginUrl: 'https://accounts.x.ai/sign-in?redirect=grok-com',
    newChatUrl: 'https://grok.com/',
    selectors: {
      input: 'textarea, div[contenteditable="true"]',
      send: 'button[type="submit"][aria-label="Submit"], button[type="submit"]',
      busy: 'button[aria-label="Stop model response"]',
      assistant: '.message-bubble:not(.bg-surface-l1)',
      content: '.response-content-markdown, .prose',
      exclude: 'button, .thinking-container',
      loggedOut: 'a[href*="sign-in"], a[href*="accounts.x.ai"]',
      modelButton: 'button[aria-label="Model select"], button#model-select-trigger',
    },
    stableMs: 2500,
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen',
    color: '#615ced',
    homeUrl: 'https://chat.qwen.ai/',
    loginUrl: 'https://chat.qwen.ai/auth?action=signin',
    newChatUrl: 'https://chat.qwen.ai/',
    selectors: {
      input: 'textarea#chat-input, textarea',
      send: 'button#send-message-button, button.send-button',
      busy: 'button.stop-button, #stop-message-button',
      assistant: '.response-message-content, .chat-response-message',
      content: '.markdown-content-container, .markdown-prose, .markdown',
      exclude: 'button, .thinking-block, [class*="think"]',
      loggedOut: 'button.login-button, a[href*="/auth"]',
      modelButton: '#model-selector-0-button',
    },
    stableMs: 2500,
  },
  mistral: {
    id: 'mistral',
    name: 'Le Chat (Mistral)',
    color: '#fa500f',
    homeUrl: 'https://chat.mistral.ai/chat',
    loginUrl: 'https://chat.mistral.ai/login',
    newChatUrl: 'https://chat.mistral.ai/chat',
    selectors: {
      input: 'textarea, div[contenteditable="true"]',
      send: 'button[aria-label="Send question"], button[type="submit"]',
      busy: 'button[aria-label="Stop generation"]',
      assistant: '[data-message-author-role="assistant"]',
      content: '[data-message-part-type="answer"], .markdown-container-style, .prose',
      exclude: 'button',
      loggedOut: 'a[href*="/login"]',
    },
    stableMs: 2500,
  },
  custom: {
    id: 'custom',
    name: 'Custom site',
    color: '#64748b',
    homeUrl: 'about:blank',
    newChatUrl: 'about:blank',
    selectors: { input: 'textarea', send: '', busy: '', assistant: '.assistant', content: '', exclude: 'button', loggedOut: '' },
    stableMs: 3000,
    notes: 'Set the URLs and selectors for this account in its advanced settings.',
  },
};

// Applied to every provider unless it sets its own value.
const DEFAULT_SELECTORS = {
  fileInput: 'input[type="file"]',
  uploading: '[role="progressbar"], [class*="uploading" i], [aria-label*="Uploading" i]',
};

function mergeProvider(base, over) {
  if (!over) return base;
  return {
    ...base,
    ...over,
    selectors: { ...(base.selectors || {}), ...(over.selectors || {}) },
  };
}

/**
 * Resolve the effective provider definition for an account:
 * built-in → global override (Settings) → per-account override.
 */
function resolveProvider(store, account) {
  const overrides = store.data.providerOverrides || {};
  const id = account ? account.provider : null;
  let base = BUILTIN[id] || overrides[id] || BUILTIN.custom;
  if (BUILTIN[id] && overrides[id]) base = mergeProvider(base, overrides[id]);
  if (account && account.override) base = mergeProvider(base, account.override);
  return { ...base, id: id || base.id, selectors: { ...DEFAULT_SELECTORS, ...(base.selectors || {}) } };
}

function listProviders(store) {
  const overrides = store.data.providerOverrides || {};
  const ids = new Set([...Object.keys(BUILTIN), ...Object.keys(overrides)]);
  if (process.env.ENABLE_MOCK_PROVIDER === '1') ids.add('mock');
  return [...ids].map((id) => {
    const p = id === 'mock' ? mockProvider() : BUILTIN[id] ? mergeProvider(BUILTIN[id], overrides[id]) : { id, ...overrides[id] };
    return { id, name: p.name || id, color: p.color || '#64748b', homeUrl: p.homeUrl, builtin: !!BUILTIN[id], notes: p.notes || '' };
  });
}

/** A local fake chat site used by the automated tests (ENABLE_MOCK_PROVIDER=1). */
function mockProvider() {
  const port = process.env.PORT || 8080;
  return {
    id: 'mock',
    name: 'Mock (test)',
    color: '#a855f7',
    homeUrl: `http://127.0.0.1:${port}/__mock/`,
    loginUrl: `http://127.0.0.1:${port}/__mock/login.html`,
    newChatUrl: `http://127.0.0.1:${port}/__mock/`,
    selectors: {
      input: '#prompt',
      send: '#send',
      busy: '#stop:not([hidden])',
      assistant: '.msg.assistant',
      content: '.md',
      exclude: 'button',
      loggedOut: '#login',
      attach: '#attach',
      uploading: '.uploading',
      modelButton: '#model-btn',
    },
    modelToggles: [{ label: 'Think', selector: '#think', match: 'think|reason' }],
    stableMs: 800,
  };
}

if (process.env.ENABLE_MOCK_PROVIDER === '1') {
  Object.defineProperty(BUILTIN, 'mock', { get: mockProvider, enumerable: false });
}

module.exports = { BUILTIN, resolveProvider, listProviders };
