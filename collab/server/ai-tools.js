'use strict';

// Helpers for the AI helper's tools that do not touch App Inventor: checking SVG pictures and drawing
// them as PNG, web search, and reading the model's streamed answers. Nothing here writes to a
// project, and nothing here fetches a page the model names, so the Pi's own network stays out of reach.

const {execFile} = require('child_process');
const fs = require('fs');
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
async function* sseJson(body) {
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
      if (data === '[DONE]') return;
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

module.exports = {MAX_SVG_CHARS, MAX_PNG_BYTES, checkSvg, rasterize, webSearch, sseJson, addDelta};
