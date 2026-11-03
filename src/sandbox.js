'use strict';
/**
 * Bridge to the sandbox container's web terminal (ttyd + tmux).
 *
 * The sandbox listens on a UNIX socket in a volume shared with ai2vpn — never on a TCP port —
 * so nothing else (not even web pages open in the account browsers) can reach the terminal.
 * ai2vpn proxies /sandbox/term/* (HTTP and WebSocket) to it, behind the admin login.
 */
const fs = require('fs');
const net = require('net');
const http = require('http');

const SOCKET = process.env.SANDBOX_SOCKET || '/run/sandbox/ttyd.sock';
const PREFIX = '/sandbox/term';

function available() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET)) return resolve(false);
    const s = net.connect(SOCKET);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: 'localhost' };
  delete headers.cookie; // the admin session cookie stays in ai2vpn
  const up = http.request({ socketPath: SOCKET, path: req.originalUrl, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.status(502).type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:24px;background:#0d0f13;color:#cbd5e1">
<h3>Sandbox not running</h3><p>Start it with <code>docker compose up -d sandbox</code> (it is part of docker-compose.yml).</p></body>`);
    } else res.end();
  });
  req.pipe(up);
}

/** Pipe a WebSocket upgrade straight through to the terminal socket. */
function proxyUpgrade(req, socket, head) {
  const up = net.connect(SOCKET);
  up.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^(cookie|host)$/i.test(k)) continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push('Host: localhost');
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const kill = () => {
    socket.destroy();
    up.destroy();
  };
  up.on('error', kill);
  socket.on('error', kill);
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
}

/** Pseudo-account for the "login browser" (same network as the sandbox → localhost callbacks work). */
const LOGIN_BROWSER = Object.freeze({ id: '_sandbox', slug: 'sandbox-login', name: 'Sandbox login browser', provider: 'custom' });

module.exports = { available, proxyHttp, proxyUpgrade, PREFIX, SOCKET, LOGIN_BROWSER };
