'use strict';
/**
 * Keeps one web chat per API conversation.
 *
 * Chat apps resend the whole history on every request. After each reply ai2vpn remembers
 * "history up to and including this reply → the web chat it happened in". When the next
 * request's history (everything before its last user message) matches, the last user
 * message is sent into that same web chat instead of opening a new one.
 *
 * - Only user/assistant text counts (system prompts are ignored, they often change per request).
 * - If the history doesn't match (edited message, regenerate, different app), a new chat
 *   is opened with the full transcript, exactly as before.
 * - A client can also name the conversation explicitly with `conversation_id` (body) or
 *   the `X-Conversation-Id` header.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 2000;
const TTL_MS = 30 * 24 * 3600 * 1000;

function textOf(content) {
  if (typeof content === 'string') return { text: content, files: 0 };
  if (!Array.isArray(content)) return { text: content == null ? '' : String(content), files: 0 };
  let text = '';
  let files = 0;
  for (const p of content) {
    if (typeof p === 'string') text += p;
    else if (p && (p.type === 'text' || p.type === 'input_text')) text += (text ? '\n' : '') + (p.text || '');
    else if (p && p.type) files++;
  }
  return { text, files };
}

/** Fingerprint of a conversation: user/assistant turns, whitespace-insensitive. */
function fingerprint(messages) {
  const turns = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const { text, files } = textOf(m.content);
      return `${m.role}:${files}:${text.replace(/\s+/g, ' ').trim()}`;
    });
  if (!turns.length) return null;
  return crypto.createHash('sha256').update(turns.join('\n\u0000')).digest('hex');
}

class Conversations {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'conversations.json');
    this.map = {};
    try {
      this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (e) {}
    this._timer = null;
    this.prune();
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.map), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('[conversations] save failed:', e.message);
      }
    }, 200);
  }

  prune() {
    const now = Date.now();
    const entries = Object.entries(this.map).filter(([, v]) => v && now - v.at < TTL_MS);
    entries.sort((a, b) => b[1].at - a[1].at);
    this.map = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }

  /** Find the web chat for a request, or null. Returns { key, url, unique }. */
  find(accountId, messages, conversationId) {
    if (conversationId) {
      const key = `${accountId}:id:${conversationId}`;
      return this.map[key] ? { key, ...this.map[key] } : null;
    }
    const prior = messages.slice(0, -1);
    const fp = fingerprint(prior);
    if (!fp) return null;
    const key = `${accountId}:fp:${fp}`;
    return this.map[key] ? { key, ...this.map[key] } : null;
  }

  /** Remember where the conversation (history + reply) now lives. */
  remember(accountId, messages, reply, { url, unique, token, conversationId, consumedKey }) {
    if (consumedKey && !conversationId) delete this.map[consumedKey]; // that state is now one turn behind
    const value = { url, unique, token, at: Date.now() };
    if (conversationId) {
      this.map[`${accountId}:id:${conversationId}`] = value;
    } else {
      const fp = fingerprint([...messages, { role: 'assistant', content: reply }]);
      if (fp) this.map[`${accountId}:fp:${fp}`] = value;
    }
    if (Object.keys(this.map).length > MAX_ENTRIES * 1.1) this.prune();
    this._save();
  }

  count(accountId) {
    return Object.keys(this.map).filter((k) => k.startsWith(accountId + ':')).length;
  }

  forgetAccount(accountId) {
    for (const k of Object.keys(this.map)) if (k.startsWith(accountId + ':')) delete this.map[k];
    this._save();
  }
}

module.exports = { Conversations, fingerprint };
