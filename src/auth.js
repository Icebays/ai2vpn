'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeEqual } = require('./util');

const COOKIE = 'a2v_session';
const MAX_AGE = 7 * 24 * 3600 * 1000;

class AdminAuth {
  constructor(store) {
    this.file = path.join(store.dir, 'admin.json');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {}
    if (!data.secret) data.secret = crypto.randomBytes(32).toString('hex');
    if (!process.env.ADMIN_PASSWORD && !data.hash) {
      const pw = crypto.randomBytes(9).toString('base64url');
      data.salt = crypto.randomBytes(16).toString('hex');
      data.hash = hashPw(pw, data.salt);
      console.log('='.repeat(64));
      console.log(`  No ADMIN_PASSWORD set. Generated web UI password: ${pw}`);
      console.log('  (change it in Settings, or set ADMIN_PASSWORD)');
      console.log('='.repeat(64));
    }
    this.data = data;
    this._save();
    this.failures = new Map();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get envLocked() {
    return !!process.env.ADMIN_PASSWORD;
  }

  checkPassword(pw) {
    if (process.env.ADMIN_PASSWORD) return safeEqual(pw, process.env.ADMIN_PASSWORD);
    return safeEqual(hashPw(String(pw), this.data.salt), this.data.hash);
  }

  setPassword(pw) {
    if (this.envLocked) throw new Error('Password is set by the ADMIN_PASSWORD environment variable');
    if (!pw || String(pw).length < 6) throw new Error('Password must be at least 6 characters');
    this.data.salt = crypto.randomBytes(16).toString('hex');
    this.data.hash = hashPw(String(pw), this.data.salt);
    this.data.secret = crypto.randomBytes(32).toString('hex'); // log out everywhere
    this._save();
  }

  issue() {
    const exp = Date.now() + MAX_AGE;
    const sig = crypto.createHmac('sha256', this.data.secret).update(String(exp)).digest('base64url');
    return `${exp}.${sig}`;
  }

  verify(token) {
    if (!token) return false;
    const [exp, sig] = String(token).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const good = crypto.createHmac('sha256', this.data.secret).update(exp).digest('base64url');
    return safeEqual(sig, good);
  }

  fromRequest(req) {
    return this.verify(parseCookies(req.headers.cookie || '')[COOKIE]);
  }

  /** crude brute-force protection: 10 failures per IP per 10 minutes */
  allowAttempt(ip) {
    const now = Date.now();
    const f = (this.failures.get(ip) || []).filter((t) => now - t < 600000);
    this.failures.set(ip, f);
    return f.length < 10;
  }
  recordFailure(ip) {
    const f = this.failures.get(ip) || [];
    f.push(Date.now());
    this.failures.set(ip, f);
  }

  cookie(token, req) {
    const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? MAX_AGE / 1000 : 0}${secure}`;
  }

  middleware() {
    return (req, res, next) => {
      if (this.fromRequest(req)) return next();
      res.status(401).json({ error: 'Not logged in' });
    };
  }
}

function hashPw(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { AdminAuth };
