// solve.js — an independent, dependency-free implementation of makefun-site 1.0.0's build semantics.
// run(input) returns the output tree {path: text} the reference generator writes for one site.
// The rules implemented here are the ones stated in makefun-site's README (front matter, its Markdown
// subset, slugs, templates, report); this module contains no code copied from the reference.

/* ------------------------------------------------------------------ text rules */

const HTML_ESCAPES = [];
HTML_ESCAPES[38] = '&amp;';
HTML_ESCAPES[60] = '&lt;';
HTML_ESCAPES[62] = '&gt;';
HTML_ESCAPES[34] = '&quot;';
HTML_ESCAPES[39] = '&#39;';

const ESCAPE_SCAN = /[&<>"']/g;

/** `text` with & < > " and ' replaced, and nothing else. */
function escapeHtml(text) {
  ESCAPE_SCAN.lastIndex = 0;
  let m = ESCAPE_SCAN.exec(text);
  if (m === null) return text;
  let out = '';
  let last = 0;
  do {
    out += text.slice(last, m.index);
    out += HTML_ESCAPES[m[0].charCodeAt(0)];
    last = m.index + 1;
    m = ESCAPE_SCAN.exec(text);
  } while (m !== null);
  return out + text.slice(last);
}

const COMBINING = /\p{M}/gu;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, other runs of characters one "-",
 *  at most 64 characters with a dash left at the cut dropped, "untitled" when nothing is left. */
function slugify(text) {
  const len = text.length;
  let ascii = true;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out;
  let gap = false;
  if (ascii) {
    let acc = '';
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      let keep;
      if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = text[i];
      else {
        if (acc.length > 0) gap = true;
        continue;
      }
      if (gap) {
        acc += '-';
        gap = false;
      }
      acc += keep;
    }
    out = acc;
  } else {
    const plain = text.normalize('NFKD').replace(COMBINING, '');
    let acc = '';
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (acc.length > 0) gap = true;
        continue;
      }
      if (gap) {
        acc += '-';
        gap = false;
      }
      acc += keep;
    }
    out = acc;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique in `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether a code unit is JavaScript's \s (whitespace), without a regex per character. */
function isWhitespaceCode(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The slug of `text`, cached for the length of one build. */
function slugFor(b, text) {
  let v = b.slugs.get(text);
  if (v === undefined) {
    v = slugify(text);
    b.slugs.set(text, v);
  }
  return v;
}

/** A date in words, cached for the length of one build. */
function longDateFor(b, date) {
  let v = b.dates.get(date);
  if (v === undefined) {
    v = longDate(date);
    b.dates.set(date, v);
  }
  return v;
}

/** The number of runs of characters other than whitespace in `text`. */
function wordsOf(text) {
  const len = text.length;
  let i = 0;
  let n = 0;
  while (i < len) {
    let c = text.charCodeAt(i);
    while (i < len) {
      if (!(c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWhitespaceCode(c)))) break;
      i++;
      if (i < len) c = text.charCodeAt(i);
    }
    if (i >= len) break;
    n++;
    i++;
    while (i < len) {
      c = text.charCodeAt(i);
      if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWhitespaceCode(c))) break;
      i++;
    }
  }
  return n;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/* ------------------------------------------------------------------ front matter */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

function isBlankLine(line) {
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimTrailingST(line) {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A title/summary value: quoted with only \" and \\ escapes, or bare. */
function stringValue(raw) {
  const len = raw.length;
  if (raw.charCodeAt(0) === 34) {
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < len - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw[i + 1];
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
      else out += raw[i];
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function frontMatterValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringValue(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) {
          if (raw.charCodeAt(i) !== 45) {
            ok = false;
            break;
          }
        } else {
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
    }
    if (ok) {
      const y = Number(raw.slice(0, 4));
      const m = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (!(y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m))) return { value: raw };
    }
    return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(len - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
    }
    return { value: raw };
  }
  if (key === 'slug') {
    if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
    let i = 0;
    for (;;) {
      const start = i;
      while (i < raw.length) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) i++;
        else break;
      }
      if (i === start) return { error: 'key "slug": not a slug' };
      if (i === raw.length) break;
      if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
      i++;
      if (i === raw.length) return { error: 'key "slug": not a slug' };
    }
    return { value: raw };
  }
  return { error: `unknown key "${key}"` };
}

/** A source's front matter and body: {data, body}, or {error} with the first reason it is refused. */
function parseFrontMatter(text) {
  const len = text.length;
  if (!(len >= 3 && text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45 && (len === 3 || text.charCodeAt(3) === 10))) {
    return { error: 'no front matter' };
  }
  if (len === 3) return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let closeEnd = -1;
  let lineStart = 4;
  for (;;) {
    let nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? len : nl;
    if (lineEnd - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      closeStart = lineStart;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
    if (lineStart >= len) break;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let n = 1;
  let p = 4;
  while (p < closeStart) {
    let nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? closeStart : nl;
    const line = text.slice(p, lineEnd);
    p = lineEnd + 1;
    n++;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const llen = line.length;
    let k = 0;
    while (k < llen && isKeyChar(line.charCodeAt(k))) k++;
    if (k === 0 || k >= llen || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === llen) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${n} is not "key: value"` };
    raw = trimTrailingST(raw);
    if (FM_KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = frontMatterValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd >= len ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

/* ------------------------------------------------------------------ Markdown */

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

const SPECIAL_SCAN = /[\\`*[&<>"']/g;

function isHtmlEscapeCode(c) {
  return c === 38 || c === 60 || c === 62 || c === 34 || c === 39;
}

/** The first `]` at or after `from` that is not escaped by a backslash. */
function findCloseBracket(s, from) {
  let p = from;
  for (;;) {
    const q = s.indexOf(']', p);
    if (q === -1) return -1;
    let b = q - 1;
    let count = 0;
    while (b >= 0 && s.charCodeAt(b) === 92) {
      count++;
      b--;
    }
    if ((count & 1) === 0) return q;
    p = q + 1;
  }
}

/** The first `**` at or after `from` whose first star is not escaped. */
function findDoubleStar(s, from) {
  let p = from;
  for (;;) {
    const q = s.indexOf('**', p);
    if (q === -1) return -1;
    let b = q - 1;
    let count = 0;
    while (b >= 0 && s.charCodeAt(b) === 92) {
      count++;
      b--;
    }
    if ((count & 1) === 0) return q;
    p = q + 1;
  }
}

/** The first single `*` at or after `from` (not part of a `**` run, not escaped). */
function findSingleStar(s, from) {
  let p = from;
  for (;;) {
    const q = s.indexOf('*', p);
    if (q === -1) return -1;
    let b = q - 1;
    let count = 0;
    while (b >= 0 && s.charCodeAt(b) === 92) {
      count++;
      b--;
    }
    if ((count & 1) === 1) {
      p = q + 1;
      continue;
    }
    if (s.charCodeAt(q + 1) === 42) {
      p = q + 2;
      continue;
    }
    return q;
  }
}

const HAS_WS = /\s/;

/** Whether `target` opens on a URL scheme. */
function hasScheme(target) {
  const len = target.length;
  if (len === 0) return false;
  let c = target.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  let i = 1;
  while (i < len) {
    c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) i++;
    else break;
  }
  return i < len && target.charCodeAt(i) === 58;
}

/** A relative link path from `dir`, or null when it climbs above the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link's href: resolved against the site's pages and static files, or kept as written. */
function resolveLink(env, target) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  if (rel !== '') {
    const path = resolvePath(env.dir, rel);
    if (path !== null) {
      const page = env.b.map.get(path);
      if (page !== undefined) return page.url + frag;
      if (env.b.staticsSet.has(path)) return `${env.b.base}/${path}${frag}`;
    }
  }
  env.b.broken.add(`broken-link ${env.src} -> ${target}`);
  return target;
}

/** `s` rendered inline; `env` resolves links. */
function inline(s, env) {
  const len = s.length;
  let out = '';
  let i = 0;
  while (i < len) {
    SPECIAL_SCAN.lastIndex = i;
    const m = SPECIAL_SCAN.exec(s);
    if (m === null) return out + s.slice(i);
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < len) {
        const nc = s.charCodeAt(j + 1);
        if (nc < 128 && ESCAPABLE[nc] === 1) {
          out += nc === 62 ? '&gt;' : s[j + 1];
          i = j + 2;
          continue;
        }
      }
      out += '\\';
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>';
        out += escapeHtml(s.slice(j + 1, k));
        out += '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findDoubleStar(s, j + 2);
        if (k > j + 2) {
          out += '<strong>';
          out += inline(s.slice(j + 2, k), env);
          out += '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += '<em>';
          out += inline(s.slice(j + 1, k), env);
          out += '</em>';
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    if (c === 91) {
      const k = findCloseBracket(s, j + 1);
      let mEnd = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) mEnd = s.indexOf(')', k + 2);
      const target = mEnd === -1 ? '' : s.slice(k + 2, mEnd);
      if (target !== '' && !HAS_WS.test(target)) {
        out += '<a href="';
        out += escapeHtml(resolveLink(env, target));
        out += '">';
        out += inline(s.slice(j + 1, k), env);
        out += '</a>';
        i = mEnd + 1;
        continue;
      }
      out += '[';
      i = j + 1;
      continue;
    }
    out += HTML_ESCAPES[c];
    i = j + 1;
  }
  return out;
}

function trimST(line) {
  const len = line.length;
  let s = 0;
  while (s < len) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = len;
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s === 0 && e === len ? line : line.slice(s, e);
}

function isBlankAt(line) {
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceLang(line) {
  const len = line.length;
  if (len < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < len) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  let k = j;
  while (k < len) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  const len = line.length;
  if (len < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < len; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingIs(line) {
  const len = line.length;
  let k = 0;
  while (k < len && line.charCodeAt(k) === 35) k++;
  if (k < 1 || k > 6 || k >= len) return false;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return false;
  let s = k;
  while (s < len) {
    const d = line.charCodeAt(s);
    if (d !== 32 && d !== 9) break;
    s++;
  }
  let e = len;
  while (e > s) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  return e > s;
}

/** A heading's depth and text, or null. */
function headingParts(line) {
  const len = line.length;
  let k = 0;
  while (k < len && line.charCodeAt(k) === 35) k++;
  if (k < 1 || k > 6 || k >= len) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let s = k;
  while (s < len) {
    const d = line.charCodeAt(s);
    if (d !== 32 && d !== 9) break;
    s++;
  }
  let e = len;
  while (e > s) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  if (e <= s) return null;
  return { depth: k, text: line.slice(s, e) };
}

function isHR(line) {
  const len = line.length;
  if (len < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (c0 === 42) {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  } else return false;
  for (let k = 3; k < len; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isContinued(line) {
  const len = line.length;
  if (len < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < len && line.charCodeAt(i) === 32) i++;
  if (i >= len) return false;
  const c = line.charCodeAt(i);
  return c < 128 ? !(c === 32 || (c >= 9 && c <= 13)) : !isWhitespaceCode(c);
}

/** `src` rendered: {html, toc, excerpt}. */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankAt(line)) {
        i++;
        continue;
      }
      // a non-blank line opening on a space is a paragraph line
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        parts.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${escapeHtml(lang)}">`);
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]));
          parts.push('\n');
          i++;
        }
        i++;
        parts.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingParts(line);
      if (h !== null) {
        const id = uniqueSlug(slugFor(env.b, h.text), ids);
        const html = inline(h.text, env);
        parts.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        const t = trimST(raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1));
        if (t !== '') body.push(t);
        i++;
      }
      if (body.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push(`<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
    }

    // A list starts on "- ", "* " or "digits. "; anything else is a paragraph.
    let ordered = false;
    let start = 1;
    let firstContent = null;
    if (c0 === 45 || c0 === 42) {
      if (line.charCodeAt(1) === 32) firstContent = line.slice(2);
    } else if (c0 >= 48 && c0 <= 57) {
      let digits = 0;
      while (digits < line.length) {
        const c = line.charCodeAt(digits);
        if (c < 48 || c > 57) break;
        digits++;
      }
      if (digits >= 1 && digits <= 9 && line.charCodeAt(digits) === 46 && line.charCodeAt(digits + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, digits));
        firstContent = line.slice(digits + 2);
      }
    }
    if (firstContent !== null) {
      const items = [[trimST(firstContent)]];
      i++;
      for (;;) {
        if (i >= n) break;
        const cur = lines[i];
        let next = null;
        if (ordered) {
          let digits = 0;
          while (digits < cur.length) {
            const c = cur.charCodeAt(digits);
            if (c < 48 || c > 57) break;
            digits++;
          }
          if (digits >= 1 && digits <= 9 && cur.charCodeAt(digits) === 46 && cur.charCodeAt(digits + 1) === 32) next = cur.slice(digits + 2);
        } else if ((cur.charCodeAt(0) === 45 || cur.charCodeAt(0) === 42) && cur.charCodeAt(1) === 32) {
          next = cur.slice(2);
        }
        if (next !== null) {
          items.push([trimST(next)]);
          i++;
        } else if (isContinued(cur)) {
          items[items.length - 1].push(trimST(cur));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      parts.push(ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (let k = 0; k < items.length; k++) {
        parts.push('<li>');
        parts.push(inline(items[k].join('\n'), env));
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }

    const end = line.length - 1;
    const body = [c0 !== 32 && c0 !== 9 && line.charCodeAt(end) !== 32 && line.charCodeAt(end) !== 9 ? line : trimST(line)];
    i++;
    while (i < n) {
      const cur = lines[i];
      const cc = cur.charCodeAt(0);
      if (cur.length === 0 || cc === 32 || cc === 9) {
        if (isBlankAt(cur)) break;
      } else if (cc === 96) {
        if (fenceLang(cur) !== null) break;
      } else if (cc === 35) {
        if (headingIs(cur)) break;
      } else if (cc === 45 || cc === 42) {
        if (isHR(cur)) break;
      }
      const ce = cur.length - 1;
      if (cc !== 32 && cc !== 9 && cur.charCodeAt(ce) !== 32 && cur.charCodeAt(ce) !== 9) body.push(cur);
      else body.push(trimST(cur));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/* ------------------------------------------------------------------ templates */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

const K_TEXT = 0;
const K_VAR = 1;
const K_RAW = 2;
const K_IF = 3;
const K_FOR = 4;
const K_INCLUDE = 5;

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        standalone = false;
        break;
      }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          standalone = false;
          break;
        }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: -1, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: K_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'raw' ? K_RAW : K_VAR, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: K_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: K_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== K_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? K_FOR : K_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === -1 ? parent.body : parent.kind === K_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: K_INCLUDE, name: m[1] });
      } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === K_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

function ownerOf(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s;
}

function lookupName(scope, name) {
  const s = ownerOf(scope, name);
  return s === null ? undefined : s.vars[name];
}

function lookup(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += (k === 0 ? '' : ', ') + textOf(v[k]);
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Every name a parsed template reads from an enclosing scope; null when it cannot be cached (an include cycle). */
function templateFreeVars(templates) {
  const done = new Map();
  const state = new Map();
  let collectNodes;

  function freeOf(name) {
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    const st = state.get(name);
    if (st === 1) return null;
    if (st === 2) return done.get(name);
    state.set(name, 1);
    const set = new Set();
    const ok = collectNodes(nodes, new Set(), set);
    const free = ok ? set : null;
    state.set(name, 2);
    done.set(name, free);
    return free;
  }

  collectNodes = (nodes, bound, set) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const kind = node.kind;
      if (kind === K_VAR || kind === K_RAW) {
        const first = node.path[0];
        if (!bound.has(first)) set.add(first);
      } else if (kind === K_IF) {
        const first = node.path[0];
        if (!bound.has(first)) set.add(first);
        if (!collectNodes(node.then, bound, set)) return false;
        if (node.else !== null && !collectNodes(node.else, bound, set)) return false;
      } else if (kind === K_FOR) {
        const first = node.path[0];
        if (!bound.has(first)) set.add(first);
        const inner = new Set(bound);
        inner.add(node.name);
        inner.add('loop');
        if (!collectNodes(node.body, inner, set)) return false;
      } else if (kind === K_INCLUDE) {
        const f = freeOf(node.name);
        if (f === null) return false;
        for (const n of f) if (!bound.has(n)) set.add(n);
      }
    }
    return true;
  };

  const info = new Map();
  for (const name of templates.keys()) {
    const free = freeOf(name);
    info.set(name, free === null ? null : [...free]);
  }
  return info;
}

/** A Map key standing for a value's identity: objects by a per-build id, primitives by type and text. */
function identityOf(ctx, v) {
  const t = typeof v;
  if (t === 'object') {
    if (v === null) return 0;
    let id = ctx.ids.get(v);
    if (id === undefined) {
      id = ctx.nextId++;
      ctx.ids.set(v, id);
    }
    return id + 1;
  }
  if (t === 'string') return 's' + v;
  if (t === 'number') return 'n' + v;
  if (t === 'boolean') return v ? 'b1' : 'b0';
  return 'u';
}

function renderNodes(nodes, scope, ctx, depth, parts) {
  const templates = ctx.templates;
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const kind = node.kind;
    if (kind === K_TEXT) parts.push(node.text);
    else if (kind === K_VAR) parts.push(escapeHtml(textOf(lookup(scope, node.path))));
    else if (kind === K_RAW) parts.push(textOf(lookup(scope, node.path)));
    else if (kind === K_IF) {
      const branch = truthy(lookup(scope, node.path)) !== node.not ? node.then : node.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
    } else if (kind === K_FOR) {
      const xs = lookup(scope, node.path);
      if (Array.isArray(xs)) {
        const total = xs.length;
        for (let k = 0; k < total; k++) {
          const vars = {};
          vars[node.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === total - 1, length: total };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, parts);
        }
      }
    } else {
      const t = templates.get(node.name);
      if (t === undefined || depth >= 8) continue;
      const info = ctx.info.get(node.name);
      let cacheable = info !== undefined && info !== null;
      if (cacheable) {
        for (let q = 0; q < info.length; q++) {
          const nm = info[q];
          const owner = ownerOf(scope, nm);
          if (owner === null || owner.parent !== null) continue;
          if (nm === 'site' || nm === 'tags' || nm === 'recent') continue;
          cacheable = false;
          break;
        }
      }
      if (!cacheable) {
        renderNodes(t, scope, ctx, depth + 1, parts);
        continue;
      }
      let key;
      const fn = info.length;
      if (fn === 0) key = 0;
      else if (fn === 1) key = identityOf(ctx, lookupName(scope, info[0]));
      else {
        let k = '';
        for (let i = 0; i < fn; i++) k += identityOf(ctx, lookupName(scope, info[i])) + '\u0000';
        key = k;
      }
      let byDepth = ctx.cache.get(node.name);
      if (byDepth === undefined) {
        byDepth = new Map();
        ctx.cache.set(node.name, byDepth);
      }
      let byKey = byDepth.get(depth);
      if (byKey === undefined) {
        byKey = new Map();
        byDepth.set(depth, byKey);
      }
      const hit = byKey.get(key);
      if (hit !== undefined) {
        parts.push(hit);
        continue;
      }
      const tmp = [];
      renderNodes(t, scope, ctx, depth + 1, tmp);
      const html = tmp.join('');
      byKey.set(key, html);
      parts.push(html);
    }
  }
}

/* ------------------------------------------------------------------ the build */

const RESERVED_DIRS = ['tags', 'page'];

function readSources(b) {
  const files = [];
  const inputFiles = b.input.files;
  for (let i = 0; i < inputFiles.length; i++) files.push(inputFiles[i]);
  files.sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const content = f.content;
      b.sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else {
      b.statics.push({ path: f.path, content: f.content });
    }
  }
}

function frontMatterPhase(b) {
  const kept = [];
  const templates = b.templates;
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    s.data = data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (let k = 0; k < RESERVED_DIRS.length; k++) {
      const d = RESERVED_DIRS[k];
      if (s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== null) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout !== undefined ? data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinkPhase(b) {
  const taken = new Map();
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = dir === '' ? new Set(['posts', 'tags', 'page']) : new Set();
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugFor(b, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.map.set(s.path, s);
  }
}

function markdownPhase(b) {
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const env = { b, dir: dirOf(s.path), src: s.path };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collectionPhase(b) {
  const posts = [];
  for (let i = 0; i < b.sources.length; i++) if (b.sources[i].post) posts.push(b.sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

/** A source's tags, each slug once, in its own order: [{name, slug}]. */
function ownTagNames(b, s) {
  const tags = s.data.tags;
  if (tags === undefined) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < tags.length; i++) {
    const name = tags[i];
    const slug = slugFor(b, name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push({ name, slug });
    }
  }
  return out;
}

function tagPhase(b) {
  const bySlug = new Map();
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    const refs = [];
    const names = ownTagNames(b, p);
    for (let k = 0; k < names.length; k++) {
      const name = names[k].name;
      const slug = names[k].slug;
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (s.post) continue;
    const names = ownTagNames(b, s);
    const refs = [];
    for (let k = 0; k < names.length; k++) {
      const name = names[k].name;
      const slug = names[k].slug;
      const tag = bySlug.get(slug);
      refs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

function cardOf(b, s) {
  const data = s.data;
  const hasDate = data.date !== undefined;
  const date = hasDate ? data.date : '';
  const refs = s.tagRefs;
  const tags = [];
  for (let k = 0; k < refs.length; k++) {
    const t = refs[k];
    tags.push({ name: t.name, slug: t.slug, url: t.url });
  }
  return {
    title: data.title,
    url: s.url,
    date,
    date_long: hasDate ? longDateFor(b, date) : '',
    summary: data.summary !== undefined ? data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags,
  };
}

function linkOf(b, s) {
  if (s === null) return null;
  const hasDate = s.data.date !== undefined;
  const date = hasDate ? s.data.date : '';
  return { title: s.data.title, url: s.url, date, date_long: hasDate ? longDateFor(b, date) : '' };
}

function layoutPhase(b) {
  const cards = new Map();
  for (let i = 0; i < b.posts.length; i++) cards.set(b.posts[i], cardOf(b, b.posts[i]));
  b.cards = cards;
  const site = { title: b.input.site.title, base_url: b.base };
  const tags = [];
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    tags.push({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length });
  }
  const recent = [];
  const recentPosts = b.posts.slice(0, b.input.site.recent);
  for (let i = 0; i < recentPosts.length; i++) recent.push(cards.get(recentPosts[i]));
  const ctx = b.ctx;
  const output = b.output;
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const scopeVars = { site, tags, recent };
    if (vars !== undefined) {
      for (const key in vars) scopeVars[key] = vars[key];
    }
    const parts = [];
    renderNodes(nodes, { vars: scopeVars, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    const card = s.post ? cards.get(s) : cardOf(b, s);
    const page = { ...card, slug: s.slug, content: s.html, toc: s.toc, newer: linkOf(b, s.newer ?? null), older: linkOf(b, s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const list = [];
    const from = (k - 1) * per;
    const to = Math.min(b.posts.length, k * per);
    for (let i = from; i < to; i++) list.push(cards.get(b.posts[i]));
    const html = render('index', {
      posts: list,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    const list = [];
    for (let k = 0; k < t.posts.length; k++) list.push(cards.get(t.posts[k]));
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: list } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', undefined);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
}

function reportPhase(b) {
  const lines = [];
  for (let i = 0; i < b.report.length; i++) lines.push(b.report[i]);
  for (const line of b.broken) lines.push(line);
  lines.sort(byCodeUnits);
  let pages = 0;
  for (let i = 0; i < b.sources.length; i++) if (!b.sources[i].post) pages++;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
}

/** The output tree {path: text} for one case's input. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const ctx = { templates, info: templateFreeVars(templates), cache: new Map(), ids: new Map(), nextId: 1 };
  const b = {
    input,
    ctx,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    map: new Map(),
    slugs: new Map(),
    dates: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: Object.create(null),
  };
  readSources(b);
  const staticSet = new Set();
  for (let i = 0; i < b.statics.length; i++) staticSet.add(b.statics[i].path);
  b.staticsSet = staticSet;
  frontMatterPhase(b);
  permalinkPhase(b);
  markdownPhase(b);
  collectionPhase(b);
  tagPhase(b);
  layoutPhase(b);
  reportPhase(b);
  return b.output;
}
