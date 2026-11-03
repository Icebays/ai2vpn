'use strict';
/**
 * VPN manager: brings up WireGuard or OpenVPN inside the container so that all
 * outbound traffic (the browsers talking to ChatGPT/Claude/…) leaves through
 * the VPN, while the web UI / API stay reachable on the container's own port.
 *
 * Routing layout (IPv4):
 *   prio 100   fwmark 0x1/0x1 -> table 100   replies to inbound connections go out eth0
 *   prio 31999 table main suppress_prefixlength 0   local/LAN routes keep working (WireGuard)
 *   prio 32000 not fwmark 51820 -> table 51820       everything else -> wg0
 * OpenVPN uses its own "redirect-gateway def1" routes in the main table.
 * Inbound connections on eth0 get connmark 0x1; their reply packets get fwmark 0x1.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const { run, tryRun, sleep } = require('./util');

const WG_IF = 'wg0';
const WG_MARK = 51820;
const OVPN_MARK = 51821;
const IN_TABLE = 100;
const RESOLV = '/etc/resolv.conf';

class VpnManager {
  constructor(store) {
    this.store = store;
    this.dir = path.join(store.dir, 'vpn');
    this.state = { status: 'disconnected', error: '', iface: '', since: 0, ip: null, capable: null, capableError: '' };
    this.logLines = [];
    this.ovpn = null;
    this.want = false; // user wants VPN up (for auto-reconnect)
    this.busy = Promise.resolve();
    this.net = null; // { gw, dev, subnets, nameservers }
    this._reconnectTimer = null;
    this._monitor = null;
  }

  get cfg() {
    const v = this.store.vpn;
    if (process.env.VPN_MODE) return { ...v, mode: process.env.VPN_MODE };
    return v;
  }

  log(line) {
    const l = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logLines.push(l);
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300);
    console.log('[vpn]', line);
  }

  status() {
    return { ...this.state, mode: this.cfg.mode, killSwitch: !!this.cfg.killSwitch, log: this.logLines.slice(-80), envLocked: !!process.env.VPN_MODE };
  }

  /** Serialize connect/disconnect operations. */
  _serial(fn) {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => {});
    return p;
  }

  async init() {
    if (this.cfg.mode === 'external') {
      this.state.capable = true;
      this.state.status = 'external';
      this.refreshIp().catch(() => {});
      this._startMonitor();
      return;
    }
    const probe = await tryRun('iptables', ['-t', 'mangle', '-S']);
    const ipprobe = await tryRun('ip', ['-4', 'route', 'show', 'default']);
    this.state.capable = probe.ok && ipprobe.ok;
    if (!this.state.capable) {
      this.state.capableError = 'Container lacks NET_ADMIN (or iptables/iproute2). Run it with --cap-add NET_ADMIN --device /dev/net/tun.';
      this.log(this.state.capableError + ' ' + (probe.err || ipprobe.err || ''));
      this.refreshIp().catch(() => {});
      return;
    }
    try {
      await this._setupBaseRouting();
    } catch (e) {
      this.log('base routing setup failed: ' + e.message);
    }
    await this._applyKillSwitch().catch((e) => this.log('kill switch: ' + e.message));
    const resume = !!this.store.vpn.resumeAfterRestart; // was connected before an in-app update
    if (resume) {
      delete this.store.vpn.resumeAfterRestart;
      this.store.save();
    }
    if (this.cfg.mode !== 'none' && (this.cfg.autoConnect || resume)) {
      this.connect().catch(() => {});
    } else {
      this.refreshIp().catch(() => {});
    }
    this._startMonitor();
  }

  _startMonitor() {
    clearInterval(this._monitor);
    this._monitor = setInterval(() => {
      if (this.state.status === 'connected' || this.state.status === 'external') this.refreshIp().catch(() => {});
    }, 5 * 60 * 1000);
    this._monitor.unref();
  }

  async _detectNet() {
    const def = await run('ip', ['-4', 'route', 'show', 'default']);
    // When OpenVPN is up the default may still be the original one (def1 uses /1 routes)
    const m = def.match(/default via (\S+) dev (\S+)/);
    if (!m) throw new Error('No default route found');
    const [, gw, dev] = m;
    const links = await run('ip', ['-4', 'route', 'show', 'dev', dev, 'scope', 'link']);
    const subnets = links
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((s) => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(s));
    const nameservers = readNameservers(this._origResolv());
    return { gw, dev, subnets, nameservers };
  }

  _origResolv() {
    const backup = path.join(this.dir, 'resolv.conf.orig');
    if (!fs.existsSync(backup)) {
      try {
        fs.copyFileSync(RESOLV, backup);
      } catch (e) {}
    }
    try {
      return fs.readFileSync(backup, 'utf8');
    } catch (e) {
      return '';
    }
  }

  async _setupBaseRouting() {
    this.net = await this._detectNet();
    const { gw, dev, subnets } = this.net;
    this.log(`network: gateway ${gw} on ${dev}, local ${subnets.join(', ') || '-'}`);
    await run('ip', ['-4', 'route', 'replace', 'default', 'via', gw, 'dev', dev, 'table', String(IN_TABLE)]);
    for (const s of subnets) await tryRun('ip', ['-4', 'route', 'replace', s, 'dev', dev, 'table', String(IN_TABLE)]);
    await this._ensureRule(['fwmark', '0x1/0x1', 'lookup', String(IN_TABLE), 'priority', '100']);

    await ensureChain('mangle', 'A2V_PRE', 'PREROUTING');
    await run('iptables', ['-t', 'mangle', '-A', 'A2V_PRE', '-i', dev, '-m', 'conntrack', '--ctstate', 'NEW', '-j', 'CONNMARK', '--set-xmark', '0x1/0x1']);
    await ensureChain('mangle', 'A2V_OUT', 'OUTPUT');
    await run('iptables', ['-t', 'mangle', '-A', 'A2V_OUT', '-m', 'connmark', '--mark', '0x1/0x1', '-j', 'MARK', '--set-xmark', '0x1/0x1']);

    // Optional LAN networks that should bypass the tunnel.
    for (const cidr of this._lanBypass()) {
      await tryRun('ip', ['-4', 'route', 'replace', cidr, 'via', gw, 'dev', dev]);
    }
  }

  _lanBypass() {
    return String(this.cfg.lanBypass || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(s));
  }

  async _ensureRule(args) {
    // delete all copies, then add one
    for (let i = 0; i < 5; i++) {
      const r = await tryRun('ip', ['-4', 'rule', 'del', ...args]);
      if (!r.ok) break;
    }
    await run('ip', ['-4', 'rule', 'add', ...args]);
  }

  /**
   * The tunnels carry IPv4 only, so whenever a tunnel mode is configured, new outbound IPv6
   * is blocked (replies to inbound connections are still allowed). No-op without IPv6.
   */
  async _blockIpv6() {
    if (this._noV6) return;
    const probe = await tryRun('ip6tables', ['-S']);
    if (!probe.ok) {
      this._noV6 = true;
      return;
    }
    await ensureChain('filter', 'A2V_V6', 'OUTPUT', true, 'ip6tables');
    if (!['wireguard', 'openvpn'].includes(this.cfg.mode)) return;
    const add = (...a) => run('ip6tables', ['-A', 'A2V_V6', ...a]);
    await add('-o', 'lo', '-j', 'RETURN');
    await add('-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'RETURN');
    await add('-p', 'ipv6-icmp', '-j', 'RETURN');
    await add('-j', 'REJECT');
  }

  /** Build the kill-switch chain. Applied whenever killSwitch is on and a VPN mode is configured. */
  async _applyKillSwitch({ connecting = false, endpoints = [] } = {}) {
    if (!this.state.capable) return;
    await this._blockIpv6().catch((e) => this.log('ipv6 block: ' + e.message));
    const on = this.cfg.killSwitch && ['wireguard', 'openvpn'].includes(this.cfg.mode);
    await ensureChain('filter', 'A2V_KS', 'OUTPUT', true);
    if (!on) return;
    const net = this.net || (await this._detectNet());
    const add = (...a) => run('iptables', ['-A', 'A2V_KS', ...a]);
    await add('-o', 'lo', '-j', 'RETURN');
    await add('-m', 'mark', '--mark', '0x1/0x1', '-j', 'RETURN');
    await add('-o', WG_IF, '-j', 'RETURN');
    await add('-o', 'tun+', '-j', 'RETURN');
    await add('-m', 'mark', '--mark', String(WG_MARK), '-j', 'RETURN');
    await add('-m', 'mark', '--mark', String(OVPN_MARK), '-j', 'RETURN');
    for (const s of [...net.subnets, ...this._lanBypass()]) await add('-d', s, '-j', 'RETURN');
    for (const ip of endpoints) await add('-d', ip, '-j', 'RETURN');
    if (connecting) {
      // Only while (re)connecting: allow DNS so the VPN endpoint can be resolved.
      // (Docker's embedded resolver may forward from inside this namespace to any upstream.)
      await add('-p', 'udp', '--dport', '53', '-j', 'RETURN');
      await add('-p', 'tcp', '--dport', '53', '-j', 'RETURN');
    }
    await add('-j', 'REJECT');
  }

  connect() {
    this.want = true;
    clearTimeout(this._reconnectTimer);
    return this._serial(() => this._connect());
  }

  disconnect() {
    this.want = false;
    clearTimeout(this._reconnectTimer);
    return this._serial(async () => {
      await this._teardown();
      this.state.status = 'disconnected';
      this.state.error = '';
      this.log('disconnected');
      await this._applyKillSwitch().catch((e) => this.log('kill switch: ' + e.message));
      this.refreshIp().catch(() => {});
    });
  }

  /** Re-apply settings after the config was saved. */
  async reconfigure() {
    if (this.cfg.mode === 'external') {
      this.state.status = 'external';
      return this.refreshIp();
    }
    if (!this.state.capable) return;
    await this._serial(async () => {
      if (this.net) await this._setupBaseRouting().catch((e) => this.log(e.message));
      if (this.state.status !== 'connected') await this._applyKillSwitch().catch((e) => this.log('kill switch: ' + e.message));
    });
    if (this.cfg.mode === 'none' && this.state.status !== 'disconnected') await this.disconnect();
  }

  async _connect() {
    const cfg = this.cfg;
    if (cfg.mode === 'external') return this.refreshIp();
    if (!this.state.capable) throw new Error(this.state.capableError || 'VPN not supported in this container');
    if (!['wireguard', 'openvpn'].includes(cfg.mode)) throw new Error('Choose WireGuard or OpenVPN first');
    await this._teardown();
    if (!this.net) await this._setupBaseRouting();
    this.state = { ...this.state, status: 'connecting', error: '', iface: '', ip: null };
    try {
      if (cfg.mode === 'wireguard') await this._wgUp(cfg);
      else await this._ovpnUp(cfg);
      this.state.status = 'connected';
      this.state.since = Date.now();
      await this._applyKillSwitch().catch((e) => this.log('kill switch: ' + e.message));
      this.log(`connected via ${this.state.iface}`);
      await this.refreshIp().catch(() => {});
    } catch (e) {
      this.state.status = 'error';
      this.state.error = e.message;
      this.log('connect failed: ' + e.message);
      await this._teardown().catch(() => {});
      await this._applyKillSwitch().catch(() => {});
      this._scheduleReconnect();
      throw e;
    }
  }

  _scheduleReconnect(delay = 20000) {
    if (!this.want || !this.cfg.autoConnect) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this.want) return;
      this.log('reconnecting…');
      this._serial(() => this._connect()).catch(() => {});
    }, delay);
  }

  // ---------------- WireGuard ----------------
  async _wgUp(cfg) {
    const conf = parseWgConfig(cfg.wireguardConfig || '');
    if (!conf.privateKey || !conf.peers.length) throw new Error('WireGuard config needs [Interface] PrivateKey and at least one [Peer]');
    const addrs = conf.addresses.filter(isV4Cidr);
    if (!addrs.length) throw new Error('WireGuard config has no IPv4 Address');

    // Resolve endpoints now (while DNS still works) so wg doesn't need DNS later.
    await this._applyKillSwitch({ connecting: true });
    const peers = [];
    for (const p of conf.peers) {
      let endpoint = p.endpoint;
      if (endpoint) {
        const [host, port] = splitHostPort(endpoint);
        const ip = await resolve4(host);
        endpoint = `${ip}:${port || 51820}`;
      }
      peers.push({ ...p, endpoint });
    }
    const lines = ['[Interface]', `PrivateKey = ${conf.privateKey}`, `FwMark = ${WG_MARK}`];
    for (const p of peers) {
      lines.push('', '[Peer]', `PublicKey = ${p.publicKey}`);
      if (p.presharedKey) lines.push(`PresharedKey = ${p.presharedKey}`);
      if (p.endpoint) lines.push(`Endpoint = ${p.endpoint}`);
      const allowed = (p.allowedIps.length ? p.allowedIps : ['0.0.0.0/0']).filter(isV4Cidr);
      lines.push(`AllowedIPs = ${(allowed.length ? allowed : ['0.0.0.0/0']).join(', ')}`);
      lines.push(`PersistentKeepalive = ${p.keepalive || 25}`);
    }
    const file = path.join(this.dir, 'wg0.setconf');
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });

    const add = await tryRun('ip', ['link', 'add', WG_IF, 'type', 'wireguard']);
    if (!add.ok) throw new Error('Cannot create WireGuard interface (is the wireguard kernel module available on the host?): ' + add.err);
    await run('wg', ['setconf', WG_IF, file]);
    for (const a of addrs) await run('ip', ['-4', 'address', 'add', a, 'dev', WG_IF]);
    await run('ip', ['link', 'set', 'mtu', String(conf.mtu || 1420), 'up', 'dev', WG_IF]);
    await run('ip', ['-4', 'route', 'replace', 'default', 'dev', WG_IF, 'table', String(WG_MARK)]);
    await this._ensureRule(['table', 'main', 'suppress_prefixlength', '0', 'priority', '31999']);
    await this._ensureRule(['not', 'fwmark', String(WG_MARK), 'table', String(WG_MARK), 'priority', '32000']);
    this.state.iface = WG_IF;
    this._writeDns(cfg.dns || conf.dns.filter(isV4).join(' ') || '1.1.1.1 9.9.9.9');
    this._applyKillSwitch({ endpoints: peers.map((p) => (p.endpoint || '').split(':')[0]).filter(Boolean) }).catch(() => {});

    // Wait for a handshake.
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const hs = await tryRun('wg', ['show', WG_IF, 'latest-handshakes']);
      if (hs.ok && hs.out.split('\n').some((l) => Number((l.split(/\s+/)[1] || '0')) > 0)) {
        this.log('WireGuard handshake completed');
        return;
      }
      if (i === 4) {
        // Poke the tunnel so a handshake is initiated.
        tryRun('ping', ['-c', '1', '-W', '1', '1.1.1.1']);
      }
    }
    throw new Error('No WireGuard handshake after 15s — check the keys/endpoint, or the server may be blocked');
  }

  async _wgDown() {
    await tryRun('ip', ['-4', 'rule', 'del', 'not', 'fwmark', String(WG_MARK), 'table', String(WG_MARK), 'priority', '32000']);
    await tryRun('ip', ['-4', 'rule', 'del', 'table', 'main', 'suppress_prefixlength', '0', 'priority', '31999']);
    await tryRun('ip', ['-4', 'route', 'flush', 'table', String(WG_MARK)]);
    await tryRun('ip', ['link', 'del', WG_IF]);
  }

  // ---------------- OpenVPN ----------------
  async _ovpnUp(cfg) {
    let conf = String(cfg.openvpnConfig || '');
    if (!/^\s*remote\s+/m.test(conf)) throw new Error('OpenVPN config must contain at least one "remote" line');
    await this._applyKillSwitch({ connecting: true });
    // Resolve remotes up front.
    const endpoints = [];
    const out = [];
    for (const line of conf.split(/\r?\n/)) {
      const m = line.match(/^\s*remote\s+(\S+)(.*)$/);
      if (m && !isV4(m[1])) {
        try {
          const ip = await resolve4(m[1]);
          endpoints.push(ip);
          out.push(`remote ${ip}${m[2]}`);
          continue;
        } catch (e) {
          this.log(`could not resolve ${m[1]}: ${e.message}`);
        }
      } else if (m) endpoints.push(m[1]);
      // drop directives we control ourselves
      if (/^\s*(up|down|route-up|dev|auth-user-pass|script-security|redirect-gateway|block-outside-dns)\b/.test(line)) continue;
      out.push(line);
    }
    conf = out.join('\n');
    const confFile = path.join(this.dir, 'client.ovpn');
    fs.writeFileSync(confFile, conf, { mode: 0o600 });
    const args = ['--config', confFile, '--dev', 'tun0', '--dev-type', 'tun', '--redirect-gateway', 'def1', '--mark', String(OVPN_MARK)];
    args.push('--pull-filter', 'ignore', 'route-ipv6', '--pull-filter', 'ignore', 'ifconfig-ipv6', '--pull-filter', 'ignore', 'block-outside-dns');
    args.push('--script-security', '2', '--up', path.join(__dirname, '..', 'scripts', 'ovpn-dns.sh'), '--up-restart');
    args.push('--connect-retry-max', '3', '--verb', '3', '--auth-nocache');
    if (cfg.openvpnUser) {
      const authFile = path.join(this.dir, 'auth.txt');
      fs.writeFileSync(authFile, `${cfg.openvpnUser}\n${cfg.openvpnPass || ''}\n`, { mode: 0o600 });
      args.push('--auth-user-pass', authFile);
    }
    this._applyKillSwitch({ connecting: true, endpoints }).catch(() => {});
    await new Promise((resolve, reject) => {
      const proc = spawn('openvpn', args, { cwd: this.dir, env: { ...process.env, A2V_DNS: cfg.dns || '' } });
      this.ovpn = proc;
      let done = false;
      const timer = setTimeout(() => finish(new Error('OpenVPN did not connect within 60s')), 60000);
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          try {
            proc.kill('SIGTERM');
          } catch (e) {}
          reject(err);
        } else resolve();
      };
      const onData = (buf) => {
        for (const line of buf.toString().split('\n')) {
          const l = line.trim();
          if (!l) continue;
          this.log('openvpn: ' + l.replace(/^\w{3} \w{3}\s+\d+ [\d:]+ \d{4} /, ''));
          if (l.includes('Initialization Sequence Completed')) finish();
          if (l.includes('AUTH_FAILED')) finish(new Error('OpenVPN authentication failed — use the provider\'s "service/manual" credentials, not your login password'));
          if (/Cannot open TUN\/TAP|ERROR: Cannot ioctl TUNSETIFF/.test(l)) finish(new Error('No /dev/net/tun in the container (add --device /dev/net/tun)'));
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => finish(e));
      proc.on('exit', (code) => {
        this.log(`openvpn exited (${code})`);
        if (this.ovpn === proc) this.ovpn = null;
        finish(new Error(`OpenVPN exited with code ${code}`));
        if (this.state.status === 'connected') {
          this.state.status = 'error';
          this.state.error = 'OpenVPN process exited';
          this._restoreDns();
          this._scheduleReconnect(5000);
        }
      });
    });
    this.state.iface = 'tun0';
    if (cfg.dns) this._writeDns(cfg.dns);
  }

  async _ovpnDown() {
    const proc = this.ovpn;
    this.ovpn = null;
    if (!proc) return;
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (e) {}
        r();
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        r();
      });
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        clearTimeout(t);
        r();
      }
    });
  }

  async _teardown() {
    await this._ovpnDown().catch(() => {});
    await this._wgDown().catch(() => {});
    this._restoreDns();
    this.state.iface = '';
  }

  _writeDns(servers) {
    const list = String(servers).split(/[\s,]+/).filter(isV4);
    if (!list.length) return;
    this._origResolv();
    try {
      fs.writeFileSync(RESOLV, list.map((s) => `nameserver ${s}`).join('\n') + '\noptions timeout:2 attempts:2\n');
      this.log('DNS: ' + list.join(', '));
    } catch (e) {
      this.log('could not write resolv.conf: ' + e.message);
    }
  }

  _restoreDns() {
    const backup = path.join(this.dir, 'resolv.conf.orig');
    try {
      if (fs.existsSync(backup)) fs.writeFileSync(RESOLV, fs.readFileSync(backup));
    } catch (e) {}
  }

  async refreshIp() {
    const info = await publicIpInfo();
    this.state.ip = info;
    return info;
  }

  async shutdown() {
    this.want = false;
    clearTimeout(this._reconnectTimer);
    await this._teardown().catch(() => {});
  }
}

// ---------------- helpers ----------------

async function ensureChain(table, chain, parent, insertFirst = false, bin = 'iptables') {
  const t = ['-t', table];
  const exists = await tryRun(bin, [...t, '-L', chain, '-n']);
  if (!exists.ok) await run(bin, [...t, '-N', chain]);
  else await run(bin, [...t, '-F', chain]);
  const hooked = await tryRun(bin, [...t, '-C', parent, '-j', chain]);
  if (!hooked.ok) await run(bin, [...t, insertFirst ? '-I' : '-A', parent, ...(insertFirst ? ['1'] : []), '-j', chain]);
}

function parseWgConfig(text) {
  const conf = { privateKey: '', addresses: [], dns: [], mtu: 0, peers: [] };
  let section = '';
  let peer = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      if (section === 'peer') {
        peer = { publicKey: '', presharedKey: '', endpoint: '', allowedIps: [], keepalive: 0 };
        conf.peers.push(peer);
      }
      continue;
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    const list = () => val.split(',').map((s) => s.trim()).filter(Boolean);
    if (section === 'interface') {
      if (key === 'privatekey') conf.privateKey = val;
      else if (key === 'address') conf.addresses.push(...list());
      else if (key === 'dns') conf.dns.push(...list());
      else if (key === 'mtu') conf.mtu = parseInt(val, 10) || 0;
    } else if (section === 'peer' && peer) {
      if (key === 'publickey') peer.publicKey = val;
      else if (key === 'presharedkey') peer.presharedKey = val;
      else if (key === 'endpoint') peer.endpoint = val;
      else if (key === 'allowedips') peer.allowedIps.push(...list());
      else if (key === 'persistentkeepalive') peer.keepalive = parseInt(val, 10) || 0;
    }
  }
  return conf;
}

const isV4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s).trim());
const isV4Cidr = (s) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(s).trim());

function splitHostPort(s) {
  const m = String(s).match(/^\[?([^\]]+?)\]?:(\d+)$/);
  return m ? [m[1], m[2]] : [s, ''];
}

async function resolve4(host) {
  if (isV4(host)) return host;
  const r = await dns.lookup(host, { family: 4 });
  return r.address;
}

function readNameservers(text) {
  return String(text)
    .split('\n')
    .map((l) => l.match(/^\s*nameserver\s+(\S+)/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter(isV4);
}

async function publicIpInfo() {
  const get = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'curl/8', accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const j = await get('https://ipinfo.io/json');
    return { ip: j.ip, country: j.country, city: j.city, org: j.org, at: Date.now() };
  } catch (e) {
    try {
      const j = await get('https://api.ipify.org?format=json');
      return { ip: j.ip, at: Date.now() };
    } catch (e2) {
      return { ip: null, error: 'Public IP lookup failed (' + e2.message + ')', at: Date.now() };
    }
  }
}

module.exports = { VpnManager, parseWgConfig };
