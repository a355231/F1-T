'use strict';

// Helpers for the AI helper's tools that do not touch App Inventor's projects: checking SVG pictures and
// drawing them as PNG, web search, reading documentation pages, arithmetic, and reading the model's
// streamed answers. Nothing here writes to a project. Pages are read only from a short list of
// documentation sites, and only from public addresses, so the Pi's own network stays out of reach.

const {execFile} = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const MAX_SVG_CHARS = 200 * 1024;
const MAX_PNG_BYTES = 1024 * 1024;
const rsvg = () => process.env.AI_RSVG || 'rsvg-convert';

// Things an SVG must not contain: anything that runs, loads a page, or pulls in another file.
const FORBIDDEN = [
  [/<\s*(script|foreignobject|iframe|object|embed|image|style|link|meta|animate|animatemotion|animatetransform|set|feimage)\b/i,
    'scripts, embedded pages, images and style sheets are not allowed in a picture'],
  [/<!\s*(doctype|entity)/i, 'DOCTYPE and entity declarations are not allowed'],
  [/\son[a-z]+\s*=/i, 'event handlers are not allowed'],
  [/javascript\s*:/i, 'javascript: links are not allowed'],
];

// Checks an SVG picture. Returns {ok: true, width, height} or {error}.
function checkSvg(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return {error: 'the picture is empty'};
  if (svg.length > MAX_SVG_CHARS) return {error: 'the picture is too big (over 200 KB)'};
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) {
    return {error: 'this is not an SVG picture; it must start with <svg'};
  }
  for (const [re, why] of FORBIDDEN) {
    if (re.test(svg)) return {error: why};
  }
  // References may only point inside the picture (#id), never to another file or address.
  for (const m of svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1].startsWith('#')) return {error: 'links and references may only point inside the picture'};
  }
  for (const m of svg.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
    if (!m[1].startsWith('#')) return {error: 'url(...) may only point inside the picture'};
  }
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(svg);
  const h = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i.exec(svg);
  const width = vb ? Math.round(+vb[1]) : w ? Math.round(+w[1]) : 512;
  const height = vb ? Math.round(+vb[2]) : h ? Math.round(+h[1]) : 512;
  return {ok: true, width: width || 512, height: height || 512};
}

// Draws an (already checked) SVG as a PNG, `width` pixels wide. The SVG is written to a temporary
// folder and removed afterwards.
function rasterize(svg, width) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-'));
    try {
      const input = path.join(dir, 'picture.svg');
      const output = path.join(dir, 'picture.png');
      fs.writeFileSync(input, svg);
      execFile(rsvg(), ['-w', String(width), '-f', 'png', '-o', output, input],
        {timeout: 20000, maxBuffer: 1024 * 1024}, err => {
          try {
            if (err) {
              reject(new Error(err.code === 'ENOENT'
                ? 'PNG conversion is not installed on the Pi (run: sudo apt install librsvg2-bin)'
                : 'the picture could not be drawn (' + String(err.message).split('\n')[0] + ')'));
              return;
            }
            const png = fs.readFileSync(output);
            if (png.length > MAX_PNG_BYTES) {
              reject(new Error('the PNG is too big; ask for a smaller width'));
              return;
            }
            resolve(png);
          } finally {
            fs.rmSync(dir, {recursive: true, force: true});
          }
        });
    } catch (e) {
      fs.rmSync(dir, {recursive: true, force: true});
      reject(e);
    }
  });
}

const plain = s => String(s || '').replace(/<[^>]*>/g, '')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 400);

// Web search through Brave's search API (the key is in ai.env). Returns up to five results.
async function webSearch(query, key, fetchImpl = fetch) {
  const url = 'https://api.search.brave.com/res/v1/web/search?count=5&q=' + encodeURIComponent(query);
  const r = await fetchImpl(url, {
    headers: {accept: 'application/json', 'x-subscription-token': key},
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('the search service answered ' + r.status);
  const data = await r.json();
  return ((data.web && data.web.results) || []).slice(0, 5)
    .map(x => ({title: plain(x.title), url: String(x.url || ''), snippet: plain(x.description)}));
}

// Reads an OpenAI-style event stream (`data: {...}` lines) and yields each JSON object in it.
// state, when given, is told whether the stream ended with [DONE] (state.sawDone), so that an answer that was cut
// off can be told from one that finished.
async function* sseJson(body, state = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;   // comments such as ": keep-alive" are ignored
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        state.sawDone = true;
        return;
      }
      try {
        yield JSON.parse(data);
      } catch (e) {
        // not JSON: ignore it
      }
    }
  }
}

// Adds one streamed delta (its tool-call pieces) to the reply being assembled in acc.
function addDelta(acc, delta) {
  for (const tc of delta.tool_calls || []) {
    const i = tc.index || 0;
    const slot = acc.tool_calls[i] || (acc.tool_calls[i] = {id: '', type: 'function', function: {name: '', arguments: ''}});
    if (tc.id) slot.id = tc.id;
    if (tc.function && tc.function.name && !slot.function.name) slot.function.name = tc.function.name;
    if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
  }
}

// ---- reading documentation pages ----

// Only these sites may be read, so that the helper can look up App Inventor, Android, web and Python
// documentation. Each address must be public, and the connection is made to the address that was checked.
const DOC_HOSTS = ['appinventor.mit.edu', 'developer.android.com', 'developer.mozilla.org', 'docs.python.org',
  'en.wikipedia.org', 'github.com', 'raw.githubusercontent.com', 'www.w3.org', 'learn.microsoft.com',
  'stackoverflow.com', 'docs.oracle.com'];

function hostAllowed(host) {
  return DOC_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return !(l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('::ffff:'));
  }
  return false;
}

function pageText(body, type) {
  if (/json/.test(type)) return body;
  return body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Reads one documentation page as text. Returns {ok, url, text} or {error}.
async function fetchDoc(url, {resolve = dns.lookup, transport = https.request} = {}) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (e) {
    return {error: 'that is not a web address'};
  }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return {error: 'only https pages can be read'};
  if (!hostAllowed(u.hostname)) return {error: 'only these documentation sites can be read: ' + DOC_HOSTS.join(', ')};
  let addrs;
  try {
    addrs = await resolve(u.hostname, {all: true});
  } catch (e) {
    return {error: 'the site could not be found'};
  }
  if (!addrs.length || addrs.some(a => !isPublicAddress(a.address))) return {error: 'that site is not on the public internet'};
  const pinned = addrs[0];
  return new Promise(done => {
    const req = transport({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: {'user-agent': 'AppInventor-AI-helper/1.0', accept: 'text/html,text/plain,application/json;q=0.9'},
      timeout: 15000,
      lookup: (host, opts, cb) => cb(null, pinned.address, pinned.family),
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return done({error: 'the page moved; ask for its new address directly'});
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done({error: 'the page answered ' + res.statusCode});
      }
      const type = String(res.headers['content-type'] || '');
      if (!/text\/|json/.test(type)) {
        res.resume();
        return done({error: 'that is not a text page'});
      }
      let size = 0;
      const chunks = [];
      res.on('data', c => {
        size += c.length;
        if (size > 1024 * 1024) {
          req.destroy();
          done({error: 'the page is too big'});
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done({ok: true, url: u.href, text: pageText(Buffer.concat(chunks).toString('utf8'), type).slice(0, 30000)}));
      res.on('error', e => done({error: 'the page could not be read (' + e.message + ')'}));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => done({error: 'the page could not be read (' + e.message + ')'}));
    req.end();
  });
}

// ---- arithmetic without eval ----

// Evaluates an arithmetic expression: + - * / % ^, parentheses, and sqrt, abs, min, max, round, floor,
// ceil, log, sin, cos, tan, pi, e. Returns {ok, value} or {error}.
function calculate(expression) {
  const raw = String(expression || '').slice(0, 300);
  const src = raw.replace(/\s+/g, '');
  if (!src) return {error: 'nothing to calculate'};
  const tokens = raw.match(/\d+(\.\d+)?(e[-+]?\d+)?|[A-Za-z]+|[-+*/%^(),]/gi);
  if (!tokens || tokens.join('') !== src) {
    return {error: 'only numbers, + - * / % ^, brackets and simple functions are understood'};
  }
  const FUNCS = {sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, min: Math.min, max: Math.max};
  const CONST = {pi: Math.PI, e: Math.E};
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  function primary() {
    const t = take();
    if (t === undefined) throw new Error('the expression ends too early');
    if (t === '(') {
      const v = sum();
      if (take() !== ')') throw new Error('a bracket is missing');
      return v;
    }
    if (t === '-') return -power();
    if (t === '+') return power();
    if (/^\d/.test(t)) return parseFloat(t);
    const name = t.toLowerCase();
    if (CONST[name] !== undefined && peek() !== '(') return CONST[name];
    if (FUNCS[name]) {
      if (take() !== '(') throw new Error(name + ' needs brackets');
      const args = [sum()];
      while (peek() === ',') {
        take();
        args.push(sum());
      }
      if (take() !== ')') throw new Error('a bracket is missing');
      return FUNCS[name](...args);
    }
    throw new Error('"' + t + '" is not understood');
  }
  function power() {
    const base = primary();
    if (peek() === '^') {
      take();
      return Math.pow(base, power());
    }
    return base;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function sum() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const value = sum();
    if (i !== tokens.length) throw new Error('the expression has extra parts');
    if (!Number.isFinite(value)) return {error: 'the answer is not a finite number'};
    return {ok: true, value};
  } catch (e) {
    return {error: e.message};
  }
}

module.exports = {MAX_SVG_CHARS, MAX_PNG_BYTES, DOC_HOSTS, checkSvg, rasterize, webSearch, sseJson, addDelta,
  fetchDoc, isPublicAddress, hostAllowed, calculate};
