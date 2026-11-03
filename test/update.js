'use strict';
/**
 * In-app update test: a fake GitHub API serves modified copies of this repository.
 * ai2vpn runs under the real supervisor (scripts/run-app.sh).
 *   node test/update.js
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO_DIR = path.resolve(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 500);
const GH_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2v-upd-'));
const DATA = path.join(TMP, 'data');

/** Build a GitHub-style tarball (top folder owner-repo-sha/) of this repo with edits applied. */
function makeTarball(sha, edit) {
  const top = `icebays-ai2vpn-${sha.slice(0, 7)}`;
  const dir = path.join(TMP, 'src-' + sha, top);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_DIR }).toString().split('\n').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(REPO_DIR, f))) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO_DIR, f), path.join(dir, f));
  }
  edit(dir);
  const out = path.join(TMP, `${sha}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', path.dirname(dir), top]);
  return fs.readFileSync(out);
}

const versions = {};
let served = null;
const gh = http.createServer((req, res) => {
  const json = (o, s = 200) => {
    res.writeHead(s, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const v = versions[served];
  if (req.url === '/repos/icebays/ai2vpn') return json({ default_branch: 'main' });
  if (req.url === '/repos/icebays/ai2vpn/commits/main') return json({ sha: v.sha, html_url: 'https://example/' + v.sha, commit: { message: v.message + '\n\nbody', committer: { date: new Date().toISOString() } } });
  if (req.url === `/repos/icebays/ai2vpn/tarball/${v.sha}`) {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    return res.end(v.tar);
  }
  if (req.url.startsWith('/repos/icebays/ai2vpn/compare/')) return json({ commits: [{ sha: v.sha, commit: { message: v.message } }] });
  json({ message: 'Not Found' }, 404);
});

let cookie = '';
async function req(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return { status: r.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      if ((await fetch(BASE + '/healthz')).ok) return;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('server did not come up');
}
async function waitRestart() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + '/healthz');
    } catch (e) {
      break; // went down
    }
    await sleep(200);
  }
  await waitUp();
}
const page = async () => (await fetch(BASE + '/')).text();

async function main() {
  const step = (s) => console.log('  ✓', s);
  versions.good = {
    sha: 'a'.repeat(40),
    message: 'Add a marker to the UI',
    tar: makeTarball('a'.repeat(40), (d) => {
      fs.appendFileSync(path.join(d, 'public', 'index.html'), '\n<!-- update-marker -->\n');
      fs.writeFileSync(path.join(d, 'src', 'NEW_FILE.txt'), 'new');
    }),
  };
  versions.broken = {
    sha: 'b'.repeat(40),
    message: 'Broken release',
    tar: makeTarball('b'.repeat(40), (d) => fs.appendFileSync(path.join(d, 'src', 'server.js'), '\nthis is not javascript (\n')),
  };
  versions.dockerfile = {
    sha: 'c'.repeat(40),
    message: 'Change the image',
    tar: makeTarball('c'.repeat(40), (d) => fs.appendFileSync(path.join(d, 'Dockerfile'), '\n# new system package\n')),
  };
  await new Promise((r) => gh.listen(GH_PORT, '127.0.0.1', r));

  const proc = spawn('sh', [path.join(REPO_DIR, 'scripts', 'run-app.sh')], {
    env: {
      ...process.env,
      APP_IMAGE_DIR: REPO_DIR,
      DATA_DIR: DATA,
      PORT: String(PORT),
      ADMIN_PASSWORD: 'pw',
      HEADLESS: 'true',
      VPN_MODE: 'external',
      UPDATE_API_BASE: `http://127.0.0.1:${GH_PORT}`,
      UPDATE_REPO: 'icebays/ai2vpn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  try {
    await waitUp();
    await req('POST', '/api/login', { password: 'pw' });
    let u = await req('GET', '/api/update');
    assert.equal(u.json.installed.source, 'image');
    assert.equal(u.json.config.repo, 'icebays/ai2vpn');

    served = 'good';
    u = await req('POST', '/api/update/check', {});
    assert.equal(u.json.status, 'available', u.text);
    assert.deepEqual(u.json.changes.map((c) => `${c.path}:${c.change}`), ['public/index.html:modified', 'src/NEW_FILE.txt:added'], u.text);
    assert.deepEqual(u.json.rebuildNeeded, []);
    assert.equal(u.json.latest.message, 'Add a marker to the UI');
    step('check: detects the 2 changed files, no rebuild needed');

    u = await req('POST', '/api/update/install', {});
    assert.equal(u.json.status, 'restarting', u.text);
    await waitRestart();
    assert.ok((await page()).includes('update-marker'), 'new UI not served after update');
    u = await req('GET', '/api/update');
    assert.equal(u.json.installed.source, 'update');
    assert.equal(u.json.installed.sha, versions.good.sha);
    assert.equal(u.json.canRollback, true);
    assert.ok(fs.lstatSync(path.join(DATA, 'app', 'releases', versions.good.sha, 'node_modules')).isSymbolicLink(), 'node_modules should be reused');
    u = await req('POST', '/api/update/check', {});
    assert.equal(u.json.status, 'up-to-date', u.text);
    step('install → restart → new code running (deps reused), then up to date');

    u = await req('POST', '/api/update/rollback', {});
    await waitRestart();
    assert.ok(!(await page()).includes('update-marker'));
    assert.equal((await req('GET', '/api/update')).json.installed.source, 'image');
    step('manual rollback → image version');

    served = 'broken';
    await req('POST', '/api/update/install', {});
    await waitRestart();
    // run-app.sh: two quick crashes → removes /data/app/current → image code again
    await sleep(6000);
    await waitUp();
    assert.ok(!fs.existsSync(path.join(DATA, 'app', 'current')), 'broken release should be rolled back');
    assert.equal((await req('GET', '/api/update')).json.installed.source, 'image');
    assert.ok(logs.includes('rolling back to the version built into the image'), 'supervisor should log the rollback');
    step('broken release crashes → supervisor rolls back automatically');

    served = 'dockerfile';
    u = await req('POST', '/api/update/check', {});
    assert.equal(u.json.status, 'available');
    assert.deepEqual(u.json.rebuildNeeded, ['Dockerfile'], u.text);
    step('changes to the Dockerfile are flagged as "rebuild needed"');

    console.log('\nUpdate tests passed.');
  } catch (e) {
    console.error('\nUPDATE TEST FAILED:', e.message);
    console.error('--- log ---\n' + logs.slice(-5000));
    process.exitCode = 1;
  } finally {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch (e) {}
    gh.close();
    await sleep(1500);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main();
