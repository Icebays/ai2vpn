'use strict';
/**
 * Runs INSIDE the provider page (serialised by Playwright). Must be self-contained.
 * Reads the latest assistant reply and converts its HTML to Markdown.
 */
function pageSnapshot(sel) {
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const qAll = (s, root = document) => {
    if (!s) return [];
    try {
      return [...root.querySelectorAll(s)];
    } catch (e) {
      return [];
    }
  };
  const anyVisible = (s) => qAll(s).some(isVisible);

  function md(node, ctx) {
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      return ctx.pre ? t : t.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'button', 'noscript', 'textarea', 'input', 'select'].includes(tag)) return '';
    if (el.classList && el.classList.contains('katex')) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) {
        const display = !!el.closest('.katex-display');
        return display ? `\n\n$$${ann.textContent}$$\n\n` : `$${ann.textContent}$`;
      }
    }
    const kids = (c = ctx) => [...el.childNodes].map((n) => md(n, c)).join('');
    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(+tag[1])} ${kids().trim()}\n\n`;
      case 'p':
        return `\n\n${kids().trim()}\n\n`;
      case 'strong': case 'b': {
        const t = kids();
        return t.trim() ? `**${t.trim()}**` : t;
      }
      case 'em': case 'i': {
        const t = kids();
        return t.trim() ? `*${t.trim()}*` : t;
      }
      case 'del': case 's':
        return `~~${kids()}~~`;
      case 'code':
        if (ctx.pre) return el.textContent;
        return '`' + el.textContent + '`';
      case 'pre': {
        const code = el.querySelector('code') || el;
        const m = (code.className || '').match(/language-([\w+#-]+)/) || (el.className || '').match(/language-([\w+#-]+)/);
        let lang = m ? m[1] : el.getAttribute('data-language') || '';
        const text = code.textContent.replace(/\n$/, '');
        return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
      }
      case 'a': {
        const t = kids().trim();
        const href = el.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:') || !t) return t;
        return `[${t}](${el.href || href})`;
      }
      case 'img': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        return src && !src.startsWith('data:') ? `![${alt}](${el.src || src})` : '';
      }
      case 'blockquote':
        return '\n\n' + kids().trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      case 'ul': case 'ol': {
        const depth = ctx.depth || 0;
        let i = parseInt(el.getAttribute('start') || '1', 10);
        const items = [...el.children].filter((c) => c.tagName.toLowerCase() === 'li').map((li) => {
          const marker = tag === 'ol' ? `${i++}. ` : '- ';
          const body = [...li.childNodes].map((n) => md(n, { ...ctx, depth: depth + 1 })).join('').trim().replace(/\n{2,}/g, '\n');
          const indent = '  '.repeat(depth);
          return indent + marker + body.split('\n').join('\n' + indent + '  ');
        });
        return (depth ? '\n' : '\n\n') + items.join('\n') + (depth ? '\n' : '\n\n');
      }
      case 'table': {
        const rows = [...el.querySelectorAll('tr')].map((tr) =>
          [...tr.children].map((c) => [...c.childNodes].map((n) => md(n, ctx)).join('').trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '))
        );
        if (!rows.length) return '';
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r) => '| ' + Array.from({ length: w }, (_, k) => r[k] || '').join(' | ') + ' |';
        return '\n\n' + [line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n') + '\n\n';
      }
      case 'div': case 'section': case 'article': case 'figure': case 'header': case 'footer':
        return `\n${kids()}\n`;
      default:
        return kids();
    }
  }

  function toMarkdown(el) {
    // Clone, then drop anything not rendered (collapsed "thinking" panels, hidden status text…).
    const clone = el.cloneNode(true);
    const orig = [el, ...el.querySelectorAll('*')];
    const copy = [clone, ...clone.querySelectorAll('*')];
    const hidden = [];
    for (let i = 1; i < orig.length; i++) {
      if (orig[i].checkVisibility && !orig[i].checkVisibility()) hidden.push(copy[i]);
    }
    hidden.forEach((n) => n.remove());
    if (sel.exclude) qAll(sel.exclude, clone).forEach((n) => n.remove());
    return md(clone, { pre: false, depth: 0 })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  let msgs = qAll(sel.assistant);
  // With several selectors, a reply can match at multiple nesting levels: keep the outermost.
  msgs = msgs.filter((m) => !msgs.some((o) => o !== m && o.contains(m)));
  const last = msgs[msgs.length - 1];
  let text = '';
  // matched=false: the answer area isn't there yet (only status text like "Thinking…").
  let matched = !sel.content;
  if (last) {
    let parts = sel.content ? qAll(sel.content, last) : [];
    // keep only outermost matches
    parts = parts.filter((p) => !parts.some((o) => o !== p && o.contains(p)));
    if (parts.length) matched = true;
    else parts = [last];
    if (sel.contentPick === 'last' && parts.length > 1) parts = parts.slice(-1);
    text = parts.map(toMarkdown).filter(Boolean).join('\n\n');
  }
  let loggedOut = false;
  if (sel.loggedOut && anyVisible(sel.loggedOut)) loggedOut = true;
  if (sel.loggedOutUrl) {
    try {
      if (new RegExp(sel.loggedOutUrl).test(location.href)) loggedOut = true;
    } catch (e) {}
  }
  return {
    count: msgs.length,
    text,
    matched,
    busy: sel.busy ? anyVisible(sel.busy) : false,
    hasInput: anyVisible(sel.input),
    loggedOut,
    url: location.href,
  };
}

module.exports = { pageSnapshot };
