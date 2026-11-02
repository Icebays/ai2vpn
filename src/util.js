'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');

/** Run a command without a shell. Resolves stdout, rejects with stderr in the message. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${cmd} ${args.join(' ')}: ${(stderr || err.message || '').toString().trim()}`;
        const e = new Error(msg);
        e.code = err.code;
        e.stderr = stderr;
        return reject(e);
      }
      resolve(stdout.toString());
    });
  });
}

/** Like run() but never throws; returns { ok, out, err }. */
async function tryRun(cmd, args = [], opts = {}) {
  try {
    return { ok: true, out: await run(cmd, args, opts) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomId(len = 10) {
  return crypto.randomBytes(len).toString('base64url').replace(/[-_]/g, '').slice(0, len).toLowerCase();
}

function newApiKey() {
  return 'sk-a2v-' + crypto.randomBytes(24).toString('base64url');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Simple per-key async mutex with a bounded queue. */
class KeyedQueue {
  constructor(maxQueue = 20) {
    this.tails = new Map();
    this.sizes = new Map();
    this.maxQueue = maxQueue;
  }
  size(key) {
    return this.sizes.get(key) || 0;
  }
  async run(key, fn) {
    const size = this.size(key);
    if (size >= this.maxQueue) {
      const e = new Error('Too many queued requests for this account');
      e.status = 429;
      throw e;
    }
    this.sizes.set(key, size + 1);
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      const n = this.size(key) - 1;
      if (n <= 0) {
        this.sizes.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else this.sizes.set(key, n);
    }
  }
}

module.exports = { run, tryRun, sleep, randomId, newApiKey, slugify, safeEqual, KeyedQueue };
