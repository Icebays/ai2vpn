'use strict';
/**
 * File attachments for chat requests.
 *
 * Accepted in OpenAI chat message content parts:
 *   { type: "image_url", image_url: { url: "data:image/png;base64,…" | "https://…" } }
 *   { type: "file", file: { filename: "report.pdf", file_data: "data:application/pdf;base64,…" } }
 *   { type: "file", file: { file_id: "file-…" } }          ← from POST /v1/files
 *   { type: "input_file", filename, file_data | file_url | file_id }   (Responses-style)
 *   { type: "input_image", image_url: "…" }                           (Responses-style)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024;
const MAX_FILES = Number(process.env.MAX_FILES_PER_REQUEST) || 10;
const FILE_TTL_MS = (Number(process.env.FILE_TTL_HOURS) || 24) * 3600 * 1000;

const EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'text/html': '.html',
  'application/json': '.json', 'application/xml': '.xml', 'text/xml': '.xml', 'application/zip': '.zip',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

function httpError(message, status = 400, code = 'invalid_file') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function safeName(name, mime) {
  let n = path.basename(String(name || '')).replace(/[^\w.\- ()一-鿿]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (!n) n = 'file';
  if (!path.extname(n) && mime && EXT[mime]) n += EXT[mime];
  return n;
}

function mimeFor(name, fallback = 'application/octet-stream') {
  return MIME[path.extname(String(name || '')).toLowerCase()] || fallback;
}

function parseDataUrl(url) {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const isB64 = /;base64/i.test(m[2] || '');
  const buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, buffer: buf };
}

/** Download a remote file (goes out through the container's VPN like everything else). */
async function fetchRemote(url) {
  if (!/^https?:\/\//i.test(url)) throw httpError(`Unsupported file URL: ${String(url).slice(0, 60)}`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw httpError(`Could not download ${url}: HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw httpError(`File too large: ${url}`, 413);
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) throw httpError(`File too large: ${url}`, 413);
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim() || mimeFor(url);
    let name = '';
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
    if (m) name = decodeURIComponent(m[1]);
    if (!name) name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return { mime, buffer, name };
  } catch (e) {
    if (e.name === 'AbortError') throw httpError(`Timed out downloading ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Files API storage (/v1/files) ----------------

class FileStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.dir, { recursive: true });
    this._timer = setInterval(() => this.cleanup(), 30 * 60 * 1000);
    this._timer.unref();
    this.cleanup();
  }
  _meta(id) {
    return path.join(this.dir, `${id}.json`);
  }
  _blob(id) {
    return path.join(this.dir, `${id}.bin`);
  }
  validId(id) {
    return /^file-[A-Za-z0-9]{16,40}$/.test(String(id));
  }
  async save({ buffer, filename, mime, purpose, owner }) {
    const id = 'file-' + crypto.randomBytes(12).toString('hex');
    const meta = {
      id,
      object: 'file',
      bytes: buffer.length,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor((Date.now() + FILE_TTL_MS) / 1000),
      filename: safeName(filename, mime),
      purpose: purpose || 'user_data',
      mime: mime || mimeFor(filename),
      owner,
    };
    await fs.promises.writeFile(this._blob(id), buffer, { mode: 0o600 });
    await fs.promises.writeFile(this._meta(id), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }
  /** Save from a stream (multipart upload). */
  async saveStream({ stream, filename, mime, purpose, owner }) {
    const id = 'file-' + crypto.randomBytes(12).toString('hex');
    const blob = this._blob(id);
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(blob, { mode: 0o600 });
      stream.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_FILE_BYTES) {
          stream.unpipe(out);
          stream.resume();
          out.destroy();
          reject(httpError(`File larger than ${MAX_FILE_BYTES / 1048576} MB`, 413));
        }
      });
      stream.on('limit', () => reject(httpError(`File larger than ${MAX_FILE_BYTES / 1048576} MB`, 413)));
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('error', reject);
    }).catch(async (e) => {
      await fs.promises.rm(blob, { force: true });
      throw e;
    });
    const meta = {
      id,
      object: 'file',
      bytes,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor((Date.now() + FILE_TTL_MS) / 1000),
      filename: safeName(filename, mime),
      purpose: purpose || 'user_data',
      mime: mime && mime !== 'application/octet-stream' ? mime : mimeFor(filename),
      owner,
    };
    await fs.promises.writeFile(this._meta(id), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }
  get(id) {
    if (!this.validId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this._meta(id), 'utf8'));
    } catch (e) {
      return null;
    }
  }
  read(id) {
    return fs.promises.readFile(this._blob(id));
  }
  list(owner) {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((m) => m && (!owner || m.owner === owner))
      .sort((a, b) => b.created_at - a.created_at);
  }
  async remove(id) {
    await fs.promises.rm(this._blob(id), { force: true });
    await fs.promises.rm(this._meta(id), { force: true });
  }
  cleanup() {
    const now = Date.now() / 1000;
    for (const m of this.list()) if (m.expires_at && m.expires_at < now) this.remove(m.id).catch(() => {});
  }
}

/** Public view of a stored file (OpenAI file object). */
function fileObject(m) {
  const { owner, mime, ...rest } = m;
  return { ...rest, status: 'processed' };
}

// ---------------- extraction from chat messages ----------------

/**
 * Collect every attachment in the conversation, in order, de-duplicated.
 * Returns [{ name, mime, buffer, messageIndex }].
 */
async function extractAttachments(messages, { files, owner, isMaster }) {
  const out = [];
  const seen = new Set();
  const add = (att) => {
    if (att.buffer.length > MAX_FILE_BYTES) throw httpError(`${att.name}: larger than ${MAX_FILE_BYTES / 1048576} MB`, 413);
    const h = crypto.createHash('sha1').update(att.buffer).digest('hex');
    if (seen.has(h)) return;
    seen.add(h);
    if (out.length >= MAX_FILES) throw httpError(`At most ${MAX_FILES} files per request`, 400, 'too_many_files');
    out.push({ ...att, name: safeName(att.name, att.mime) });
  };
  const fromFileId = async (id, mi) => {
    const m = files.get(id);
    if (!m || (!isMaster && m.owner !== owner)) throw httpError(`Unknown file id '${id}'`, 404, 'file_not_found');
    add({ name: m.filename, mime: m.mime, buffer: await files.read(id), messageIndex: mi });
  };
  const fromUrl = async (url, name, mi, kind) => {
    const d = parseDataUrl(url);
    if (d) {
      let n = name || `${kind}-${out.length + 1}`;
      return add({ name: n, mime: d.mime, buffer: d.buffer, messageIndex: mi });
    }
    const r = await fetchRemote(url);
    add({ name: name || r.name || `${kind}-${out.length + 1}`, mime: r.mime, buffer: r.buffer, messageIndex: mi });
  };

  for (let mi = 0; mi < (messages || []).length; mi++) {
    const c = messages[mi] && messages[mi].content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image_url' || p.type === 'input_image') {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url && p.image_url.url;
        if (p.file_id) await fromFileId(p.file_id, mi);
        else if (url) await fromUrl(url, '', mi, 'image');
      } else if (p.type === 'file' || p.type === 'input_file') {
        const f = p.type === 'file' ? p.file || {} : p;
        if (f.file_id) await fromFileId(f.file_id, mi);
        else if (f.file_data) {
          const data = /^data:/.test(f.file_data) ? f.file_data : `data:${mimeFor(f.filename)};base64,${f.file_data}`;
          await fromUrl(data, f.filename, mi, 'file');
        } else if (f.file_url) await fromUrl(f.file_url, f.filename, mi, 'file');
      }
    }
  }
  return out;
}

/** Write attachments to a fresh temp folder; returns absolute paths. */
async function materialize(attachments, baseDir) {
  const dir = path.join(baseDir, 'tmp', crypto.randomBytes(6).toString('hex'));
  await fs.promises.mkdir(dir, { recursive: true });
  const used = new Set();
  const paths = [];
  for (const a of attachments) {
    let name = a.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const ext = path.extname(a.name);
      name = `${path.basename(a.name, ext)} (${i})${ext}`;
    }
    used.add(name.toLowerCase());
    const p = path.join(dir, name);
    await fs.promises.writeFile(p, a.buffer);
    paths.push(p);
  }
  return { dir, paths };
}

module.exports = { FileStore, fileObject, extractAttachments, materialize, mimeFor, MAX_FILE_BYTES, MAX_FILES };
