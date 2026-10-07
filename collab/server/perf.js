'use strict';

// Speed for the hub's proxy: connections to App Inventor are reused, text is compressed, and
// files that never change per login (scripts, images, styles) are kept in memory, compressed once,
// and answered with ETags so a returning browser asks "changed?" and gets a tiny reply.

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const {promisify} = require('util');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const agent = new http.Agent({keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000});

const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_CACHE_BYTES = parseInt(process.env.STATIC_CACHE_MB || '120', 10) * 1024 * 1024;
const SHORT_TTL_MS = 60 * 1000;
const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE = /^(text\/|application\/(javascript|x-javascript|json|xml|x-gwt-rpc|wasm)|image\/svg)/i;
const STATIC_EXT = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|map|wasm|json|html?|rpc|txt|xml|mp3|ogg|wav)$/i;
const HASHED = /\/[0-9A-F]{32}\.[A-Za-z.]+$/;
const NEVER = /^\/(collab|login|_ah)(\/|$)|^\/ode\/collab/i;

function chooseEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function isCacheable(req) {
  if (req.method !== 'GET' || req.headers.range) return false;
  const path = req.url.split('?')[0];
  if (NEVER.test(path) || !STATIC_EXT.test(path)) return false;
  if (path.startsWith('/ode/')) {
    return HASHED.test(path) || /\.nocache\.js$/.test(path);
  }
  return true;
}

function isHashed(url) {
  return HASHED.test(url.split('?')[0]);
}

class StaticCache {
  constructor() {
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(url, now = Date.now()) {
    const e = this.entries.get(url);
    if (!e) return null;
    if (!e.forever && now - e.at > e.ttl) {
      this.drop(url);
      return null;
    }
    return e;
  }

  drop(url) {
    const e = this.entries.get(url);
    if (e) {
      this.bytes -= e.size;
      this.entries.delete(url);
    }
  }

  put(url, headers, body, now = Date.now()) {
    if (body.length > MAX_ENTRY_BYTES) return null;
    this.drop(url);
    const hashed = isHashed(url);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64').slice(0, 22) + '"';
    const entry = {headers, body, etag, at: now, forever: hashed,
      ttl: /\.nocache\.js/.test(url) ? 30 * 1000 : SHORT_TTL_MS, variants: {}, size: body.length};
    if (this.bytes + entry.size > MAX_CACHE_BYTES) {
      for (const [k, e] of this.entries) if (!e.forever) this.drop(k);
      if (this.bytes + entry.size > MAX_CACHE_BYTES) {
        this.entries.clear();
        this.bytes = 0;
      }
    }
    this.entries.set(url, entry);
    this.bytes += entry.size;
    return entry;
  }

  async variant(entry, enc) {
    if (!enc || !COMPRESSIBLE.test(String(entry.headers['content-type'] || '')) ||
        entry.body.length < MIN_COMPRESS_BYTES) {
      return entry.body;
    }
    if (!entry.variants[enc]) {
      entry.variants[enc] = enc === 'br'
        ? await brotli(entry.body, {params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length}})
        : await gzip(entry.body, {level: 6});
      entry.size += entry.variants[enc].length;
      this.bytes += entry.variants[enc].length;
    }
    return entry.variants[enc];
  }

  // Answers req from an entry: 304 if the browser already has it, else the best encoding.
  async serve(req, res, entry) {
    const headers = Object.assign({}, entry.headers);
    delete headers['set-cookie'];
    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    delete headers.expires;
    delete headers['last-modified'];
    headers.etag = entry.etag;
    headers['cache-control'] = entry.forever ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60';
    headers.vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, {etag: entry.etag, 'cache-control': headers['cache-control'],
        vary: headers.vary});
      res.end();
      return;
    }
    const enc = chooseEncoding(req);
    const body = await this.variant(entry, enc);
    if (body !== entry.body) headers['content-encoding'] = enc;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  }
}

// Wraps an upstream response so that large text is compressed on its way to the browser.
// Returns the stream to pipe into, and may change the headers.
function compressStream(req, upstreamRes, headers) {
  const enc = chooseEncoding(req);
  const type = String(headers['content-type'] || '');
  const length = parseInt(headers['content-length'] || '-1', 10);
  if (!enc || req.method === 'HEAD' || headers['content-encoding'] || !COMPRESSIBLE.test(type) ||
      /event-stream/i.test(type) || upstreamRes.statusCode === 206 ||
      upstreamRes.statusCode === 204 || upstreamRes.statusCode === 304 ||
      (length >= 0 && length < MIN_COMPRESS_BYTES)) {
    return null;
  }
  delete headers['content-length'];
  headers['content-encoding'] = enc;
  headers.vary = 'Accept-Encoding';
  return enc === 'br'
    ? zlib.createBrotliCompress({params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 4}})
    : zlib.createGzip({level: 5});
}

module.exports = {MAX_ENTRY_BYTES, agent, StaticCache, isCacheable, compressStream, chooseEncoding, COMPRESSIBLE};
