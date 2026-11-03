'use strict';
/**
 * In-app updates from GitHub.
 *
 * check():   ask GitHub for the newest commit on the branch, download its tarball and
 *            compare it file-by-file with the code that is running.
 * install(): unpack into /data/app/releases/<sha>, point /data/app/current at it and ask the
 *            supervisor (scripts/run-app.sh) to restart the Node process (exit code 75).
 *            The container, the VPN namespace and the sandbox keep running.
 * rollback(): remove /data/app/current → the image's own code runs again.
 *
 * run-app.sh also rolls back by itself if an updated version crashes right after starting.
 * Changes that need a new image (Dockerfile, entrypoint, sandbox, system packages, Playwright
 * version) are reported as "rebuild needed".
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { run } = require('./util');

const RESTART_CODE = 75;
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'workspace', 'sandbox-home']);
const REBUILD_FILES = [/^Dockerfile$/, /^scripts\/(entrypoint|run-app)\.sh$/, /^sandbox\//, /^docker-compose.*\.ya?ml$/, /^\.dockerignore$/];

class Updater {
  constructor(store, { onRestart, isIdle }) {
    this.store = store;
    this.onRestart = onRestart;
    this.isIdle = isIdle || (() => true);
    this.appDir = fs.realpathSync(path.resolve(__dirname, '..'));
    this.imageDir = path.resolve(process.env.APP_IMAGE_DIR || '/app');
    if (!fs.existsSync(path.join(this.imageDir, 'src', 'server.js'))) this.imageDir = this.appDir;
    this.root = path.join(store.dir, 'app');
    this.releases = path.join(this.root, 'releases');
    this.current = path.join(this.root, 'current');
    this.tmp = path.join(this.root, 'tmp');
    this.apiBase = (process.env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
    this.state = { status: 'idle', lastCheck: null, latest: null, changes: [], changedCount: 0, rebuildNeeded: [], commits: [], error: '' };
    this.pending = null; // { sha, dir }
    this.logLines = [];
    this.busy = false;
    const s = store.settings;
    s.update = { repo: '', branch: '', token: '', auto: false, intervalHours: 6, ...(s.update || {}) };
    this._timer = setInterval(() => this._tick().catch(() => {}), 15 * 60 * 1000);
    this._timer.unref();
    setTimeout(() => this._tick().catch(() => {}), 60 * 1000).unref();
  }

  get cfg() {
    const c = this.store.settings.update;
    return {
      repo: c.repo || process.env.UPDATE_REPO || 'icebays/ai2vpn',
      branch: c.branch || process.env.UPDATE_BRANCH || '',
      token: c.token || process.env.UPDATE_GITHUB_TOKEN || '',
      auto: !!c.auto,
      intervalHours: Math.max(1, Number(c.intervalHours) || 6),
    };
  }

  log(line) {
    const l = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${line}`;
    this.logLines.push(l);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    console.log('[update]', line);
  }

  installed() {
    const running = this.appDir;
    let rel = this.releases;
    try {
      rel = fs.realpathSync(this.releases);
    } catch (e) {}
    const fromUpdate = running.startsWith(rel + path.sep);
    let v = {};
    try {
      v = JSON.parse(fs.readFileSync(path.join(running, '.a2v-version.json'), 'utf8'));
    } catch (e) {}
    return { sha: v.sha || null, message: v.message || '', date: v.date || null, installedAt: v.installedAt || null, source: fromUpdate ? 'update' : 'image' };
  }

  view() {
    const c = this.cfg;
    return {
      config: { repo: c.repo, branch: c.branch, auto: c.auto, intervalHours: c.intervalHours, hasToken: !!c.token },
      installed: this.installed(),
      canRollback: fs.existsSync(this.current),
      ...this.state,
      busy: this.busy,
      log: this.logLines.slice(-60),
    };
  }

  setConfig(b) {
    const u = this.store.settings.update;
    if (b.repo !== undefined) {
      const repo = String(b.repo).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Object.assign(new Error('Repository must look like owner/name'), { status: 400 });
      u.repo = repo;
    }
    if (b.branch !== undefined) u.branch = String(b.branch).trim();
    if (b.token !== undefined && b.token !== '••••••••') u.token = String(b.token).trim();
    if (b.auto !== undefined) u.auto = !!b.auto;
    if (b.intervalHours !== undefined) u.intervalHours = Math.max(1, Number(b.intervalHours) || 6);
    this.store.save();
    this.pending = null;
  }

  async _gh(pathname) {
    const c = this.cfg;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ai2vpn-updater', 'x-github-api-version': '2022-11-28' };
    if (c.token) headers.authorization = `Bearer ${c.token}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(this.apiBase + pathname, { headers, signal: ctl.signal });
      if (r.status === 404) throw new Error(`GitHub: ${pathname} not found (private repository? add a token)`);
      if (r.status === 401 || r.status === 403) throw new Error(`GitHub refused the request (HTTP ${r.status}) — check the token, or the hourly rate limit`);
      if (!r.ok) throw new Error(`GitHub: HTTP ${r.status} for ${pathname}`);
      return r;
    } finally {
      clearTimeout(t);
    }
  }

  async check() {
    if (this.busy) throw Object.assign(new Error('An update operation is already running'), { status: 409 });
    this.busy = true;
    this.state.status = 'checking';
    this.state.error = '';
    try {
      const c = this.cfg;
      let branch = c.branch;
      if (!branch) branch = (await (await this._gh(`/repos/${c.repo}`)).json()).default_branch;
      const commit = await (await this._gh(`/repos/${c.repo}/commits/${encodeURIComponent(branch)}`)).json();
      const latest = {
        sha: commit.sha,
        message: String((commit.commit && commit.commit.message) || '').split('\n')[0],
        date: commit.commit && commit.commit.committer && commit.commit.committer.date,
        url: commit.html_url,
        branch,
      };
      this.state.latest = latest;
      this.log(`latest on ${c.repo}@${branch}: ${latest.sha.slice(0, 7)} ${latest.message}`);

      // Download + unpack the tarball, then compare with the running code.
      await fsp.mkdir(this.tmp, { recursive: true });
      for (const f of await fsp.readdir(this.tmp)) await fsp.rm(path.join(this.tmp, f), { recursive: true, force: true });
      const r = await this._gh(`/repos/${c.repo}/tarball/${latest.sha}`);
      const tarFile = path.join(this.tmp, `${latest.sha}.tar.gz`);
      await fsp.writeFile(tarFile, Buffer.from(await r.arrayBuffer()));
      const dir = path.join(this.tmp, latest.sha);
      await fsp.mkdir(dir, { recursive: true });
      await run('tar', ['-xzf', tarFile, '-C', dir, '--strip-components=1'], { timeout: 60000 });
      await fsp.rm(tarFile, { force: true });
      if (!fs.existsSync(path.join(dir, 'src', 'server.js'))) throw new Error('Downloaded code has no src/server.js — wrong repository or branch?');

      const changes = await diffTrees(this.appDir, dir);
      const rebuild = (await diffTrees(this.imageDir, dir)).filter((f) => REBUILD_FILES.some((re) => re.test(f.path))).map((f) => f.path);
      if (playwrightVersion(this.imageDir) !== playwrightVersion(dir)) rebuild.push('package.json (Playwright version)');
      this.state.changes = changes.slice(0, 100);
      this.state.changedCount = changes.length;
      this.state.rebuildNeeded = rebuild;
      this.state.lastCheck = Date.now();

      const inst = this.installed();
      this.state.commits = [];
      if (inst.sha && inst.sha !== latest.sha) {
        try {
          const cmp = await (await this._gh(`/repos/${c.repo}/compare/${inst.sha}...${latest.sha}`)).json();
          this.state.commits = (cmp.commits || []).slice(-30).reverse().map((x) => ({ sha: x.sha.slice(0, 7), message: String(x.commit.message).split('\n')[0] }));
        } catch (e) {}
      }
      if (!changes.length) {
        this.state.status = 'up-to-date';
        this.pending = null;
        await fsp.rm(dir, { recursive: true, force: true });
        this.log('running code matches the latest version');
      } else {
        this.state.status = 'available';
        this.pending = { sha: latest.sha, dir, latest };
        this.log(`update available: ${changes.length} file(s) differ${rebuild.length ? ` — rebuild needed for: ${rebuild.join(', ')}` : ''}`);
      }
      return this.view();
    } catch (e) {
      this.state.status = 'error';
      this.state.error = e.message;
      this.log('check failed: ' + e.message);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async install() {
    if (!this.pending || !fs.existsSync(this.pending.dir)) await this.check();
    if (!this.pending) return { ...this.view(), message: 'Already up to date' };
    if (this.busy) throw Object.assign(new Error('An update operation is already running'), { status: 409 });
    this.busy = true;
    this.state.status = 'installing';
    const { sha, dir, latest } = this.pending;
    try {
      await fsp.mkdir(this.releases, { recursive: true });
      const dest = path.join(this.releases, sha);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(dir, dest);
      this.pending = null;

      // Dependencies: reuse the image's node_modules when the lockfile is unchanged.
      const lock = (d) => {
        try {
          return fs.readFileSync(path.join(d, 'package-lock.json'), 'utf8');
        } catch (e) {
          return '';
        }
      };
      if (lock(dest) && lock(dest) === lock(this.imageDir) && fs.existsSync(path.join(this.imageDir, 'node_modules'))) {
        await fsp.symlink(path.join(this.imageDir, 'node_modules'), path.join(dest, 'node_modules'), 'dir');
        this.log('dependencies unchanged — reusing the installed node_modules');
      } else {
        this.log('dependencies changed — running npm ci (this can take a few minutes)…');
        const out = await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dest, timeout: 15 * 60 * 1000 });
        this.log(out.trim().split('\n').slice(-2).join(' | '));
      }
      await fsp.writeFile(path.join(dest, '.a2v-version.json'), JSON.stringify({ sha, message: latest.message, date: latest.date, installedAt: Date.now() }, null, 2));

      // Atomically switch /data/app/current → the new release.
      const previous = fs.existsSync(this.current) ? fs.realpathSync(this.current) : null;
      const tmpLink = this.current + '.new';
      await fsp.rm(tmpLink, { force: true });
      await fsp.symlink(dest, tmpLink, 'dir');
      await fsp.rename(tmpLink, this.current);
      // Keep only the new release and the one before it.
      for (const d of await fsp.readdir(this.releases)) {
        const full = path.join(this.releases, d);
        if (full !== dest && full !== previous) await fsp.rm(full, { recursive: true, force: true });
      }
      this.log(`installed ${sha.slice(0, 7)} — restarting ai2vpn`);
      this.state.status = 'restarting';
      this._restartSoon();
      return { ...this.view(), message: 'Installed. ai2vpn is restarting…' };
    } catch (e) {
      this.state.status = 'error';
      this.state.error = e.message;
      this.log('install failed: ' + e.message);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async rollback() {
    if (!fs.existsSync(this.current)) throw Object.assign(new Error('Already running the version built into the image'), { status: 400 });
    await fsp.rm(this.current, { force: true });
    this.log('rolled back to the image version — restarting ai2vpn');
    this.state.status = 'restarting';
    this._restartSoon();
    return { ...this.view(), message: 'Rolling back. ai2vpn is restarting…' };
  }

  _restartSoon() {
    if (!process.env.A2V_SUPERVISED) this.log('warning: not started by scripts/run-app.sh — restart the container to load the new version');
    setTimeout(() => this.onRestart(), 800);
  }

  async _tick() {
    const c = this.cfg;
    const due = !this.state.lastCheck || Date.now() - this.state.lastCheck > c.intervalHours * 3600 * 1000;
    if (!due || this.busy) return;
    await this.check().catch(() => {});
    if (c.auto && this.state.status === 'available' && !this.state.rebuildNeeded.length) {
      if (!this.isIdle()) return this.log('update waiting: requests are running');
      this.log('installing automatically');
      await this.install().catch(() => {});
    }
  }
}

// ---------------- helpers ----------------

async function listFiles(root, rel = '') {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name === '.a2v-version.json') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

async function hashFile(p) {
  return crypto.createHash('sha1').update(await fsp.readFile(p)).digest('hex');
}

/** Files that differ between two code trees: [{ path, change: added|modified|removed }]. */
async function diffTrees(a, b) {
  const [fa, fb] = await Promise.all([listFiles(a), listFiles(b)]);
  const sa = new Set(fa);
  const sb = new Set(fb);
  const out = [];
  for (const f of fb) {
    if (!sa.has(f)) out.push({ path: f, change: 'added' });
    else if ((await hashFile(path.join(a, f))) !== (await hashFile(path.join(b, f)))) out.push({ path: f, change: 'modified' });
  }
  for (const f of fa) if (!sb.has(f)) out.push({ path: f, change: 'removed' });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

function playwrightVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies.playwright || '';
  } catch (e) {
    return '';
  }
}

module.exports = { Updater, RESTART_CODE, diffTrees };
