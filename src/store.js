'use strict';
const fs = require('fs');
const path = require('path');
const { newApiKey } = require('./util');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const DEFAULTS = () => ({
  version: 1,
  settings: {
    publicUrl: '',
    idleMinutes: 20,
    requestTimeoutSec: 300,
    masterKey: newApiKey(),
  },
  accounts: [],
  vpn: {
    mode: 'none', // none | wireguard | openvpn | external
    provider: 'custom',
    wireguardConfig: '',
    openvpnConfig: '',
    openvpnUser: '',
    openvpnPass: '',
    killSwitch: false,
    autoConnect: true,
    lanBypass: '',
    dns: '',
  },
  providerOverrides: {},
});

class Store {
  constructor() {
    this.dir = DATA_DIR;
    this.file = path.join(DATA_DIR, 'config.json');
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(DATA_DIR, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'vpn'), { recursive: true, mode: 0o700 });
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    const def = DEFAULTS();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...def,
        ...raw,
        settings: { ...def.settings, ...(raw.settings || {}) },
        vpn: { ...def.vpn, ...(raw.vpn || {}) },
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        providerOverrides: raw.providerOverrides || {},
      };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] failed to read config, starting fresh:', e.message);
      const d = def;
      this._writeNow(d);
      return d;
    }
  }

  _writeNow(data = this.data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        this._writeNow();
      } catch (e) {
        console.error('[store] save failed:', e.message);
      }
    }, 100);
  }

  flush() {
    clearTimeout(this._timer);
    this._writeNow();
  }

  get settings() {
    return this.data.settings;
  }
  get accounts() {
    return this.data.accounts;
  }
  get vpn() {
    return this.data.vpn;
  }

  account(idOrSlug) {
    return this.data.accounts.find((a) => a.id === idOrSlug || a.slug === idOrSlug);
  }

  profileDir(accountId) {
    return path.join(this.dir, 'profiles', accountId);
  }
}

module.exports = { Store, DATA_DIR };
