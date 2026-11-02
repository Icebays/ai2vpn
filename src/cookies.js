'use strict';
/**
 * Parse cookies pasted by the user into Playwright cookie objects. Accepts:
 *  - JSON array from browser extensions (Cookie-Editor, EditThisCookie, …)
 *  - Netscape cookies.txt
 *  - a raw "Cookie:" header ("name=value; name2=value2"), scoped to the provider's domain
 */
function parseCookieText(text, fallbackUrl) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Nothing to import');
  let host = '';
  try {
    host = new URL(fallbackUrl).hostname.replace(/^www\./, '');
  } catch (e) {}

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = arr.cookies || [arr];
    return arr.map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        domain: c.domain || (host ? '.' + host : undefined),
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: c.secure !== undefined ? !!c.secure : true,
      };
      const exp = c.expirationDate ?? c.expires ?? c.expiry;
      if (exp && Number(exp) > 0) out.expires = Math.floor(Number(exp));
      const ss = String(c.sameSite || '').toLowerCase();
      out.sameSite = ss === 'strict' ? 'Strict' : ss === 'no_restriction' || ss === 'none' ? 'None' : 'Lax';
      if (out.sameSite === 'None') out.secure = true;
      if (c.hostOnly && out.domain) out.domain = out.domain.replace(/^\./, '');
      if (out.name.startsWith('__Host-')) {
        out.domain = out.domain.replace(/^\./, '');
        out.path = '/';
        out.secure = true;
      }
      return out;
    });
  }

  const lines = raw.split(/\r?\n/);
  if (lines.some((l) => l.split('\t').length >= 7)) {
    const out = [];
    for (let l of lines) {
      let httpOnly = false;
      if (l.startsWith('#HttpOnly_')) {
        httpOnly = true;
        l = l.slice(10);
      } else if (l.startsWith('#') || !l.trim()) continue;
      const p = l.split('\t');
      if (p.length < 7) continue;
      const [domain, , path, secure, expires, name, value] = p;
      const c = { name, value, domain, path: path || '/', secure: secure === 'TRUE', httpOnly, sameSite: 'Lax' };
      if (Number(expires) > 0) c.expires = Number(expires);
      out.push(c);
    }
    return out;
  }

  if (!host) throw new Error('Cannot infer the cookie domain for a raw Cookie header');
  return raw
    .replace(/^cookie:\s*/i, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => {
      const i = s.indexOf('=');
      const name = s.slice(0, i).trim();
      const c = { name, value: s.slice(i + 1).trim(), domain: '.' + host, path: '/', secure: true, httpOnly: false, sameSite: 'Lax' };
      if (name.startsWith('__Host-')) c.domain = host;
      return c;
    });
}

module.exports = { parseCookieText };
