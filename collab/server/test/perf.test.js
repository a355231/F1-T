'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const {StaticCache, COMPRESSIBLE, isCacheable, chooseEncoding} = require('../perf');

const MIN = 60 * 1000;

// A response stand-in that records what the cache wrote.
function fakeRes() {
  return {status: 0, headers: {}, body: null, ended: false,
    writeHead(s, h) { this.status = s; this.headers = Object.assign({}, h || {}); },
    end(b) { this.body = b; this.ended = true; }};
}

test('fonts that are not already compressed are compressed on the way, the others are left alone', () => {
  assert.ok(COMPRESSIBLE.test('font/ttf'));
  assert.ok(COMPRESSIBLE.test('font/otf'));
  assert.ok(COMPRESSIBLE.test('application/x-font-ttf'));
  assert.ok(!COMPRESSIBLE.test('font/woff2'), 'WOFF2 is compressed already');
  assert.ok(!COMPRESSIBLE.test('font/woff'), 'WOFF is compressed already');
  assert.ok(!COMPRESSIBLE.test('image/png'));
  assert.ok(COMPRESSIBLE.test('application/javascript; charset=utf-8'));
});

test('a compressed font decodes to exactly the original bytes', async () => {
  const cache = new StaticCache();
  const font = Buffer.alloc(200 * 1024);
  for (let i = 0; i < font.length; i++) font[i] = (i * 7919) & 0xff;
  const entry = cache.put('/static/fonts/Test.ttf', {'content-type': 'font/ttf'}, font, 0);
  const br = await cache.variant(entry, 'br');
  assert.ok(br.length < font.length, 'it got smaller');
  assert.ok(zlib.brotliDecompressSync(br).equals(font), 'decodes to the same bytes');
  const gz = await cache.variant(entry, 'gzip');
  assert.ok(zlib.gunzipSync(gz).equals(font));
});

test('a file named without a hash is kept ten minutes; a .nocache.js stub five', () => {
  const cache = new StaticCache();
  cache.put('/static/css/gwt.css', {'content-type': 'text/css'}, Buffer.alloc(4000, 1), 0);
  cache.put('/ode/ode.nocache.js', {'content-type': 'application/javascript'}, Buffer.alloc(4000, 2), 0);
  assert.ok(cache.get('/static/css/gwt.css', 59 * 1000), 'kept past the old minute');
  assert.ok(cache.get('/static/css/gwt.css', 9 * MIN), 'kept for nine minutes');
  assert.strictEqual(cache.get('/static/css/gwt.css', 11 * MIN), null, 'gone after ten');
  assert.ok(cache.get('/ode/ode.nocache.js', 4 * MIN), 'stub kept for four minutes');
  assert.strictEqual(cache.get('/ode/ode.nocache.js', 6 * MIN), null, 'stub gone after five');
});

test('a hashed file never expires, because its name changes when its contents do', () => {
  const cache = new StaticCache();
  const url = '/ode/1C2FE7FE8BCF355751901A4A7EE078A6.cache.js';
  assert.ok(isCacheable({method: 'GET', url, headers: {}}));
  cache.put(url, {'content-type': 'application/javascript'}, Buffer.alloc(4000, 3), 0);
  assert.ok(cache.get(url, 365 * 24 * 60 * MIN));
});

test('a returning browser that has the same copy gets 304, and an encoded copy otherwise', async () => {
  const cache = new StaticCache();
  const body = Buffer.from('x'.repeat(5000));
  const entry = cache.put('/static/css/a.css', {'content-type': 'text/css'}, body, 0);
  const res304 = fakeRes();
  await cache.serve({headers: {'if-none-match': entry.etag}}, res304, entry);
  assert.strictEqual(res304.status, 304);
  const res = fakeRes();
  await cache.serve({headers: {'accept-encoding': 'gzip'}}, res, entry);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.ok(zlib.gunzipSync(res.body).equals(body));
});

test('the encoding a browser asks for is the one used', () => {
  assert.strictEqual(chooseEncoding({headers: {'accept-encoding': 'gzip, deflate, br'}}), 'br');
  assert.strictEqual(chooseEncoding({headers: {'accept-encoding': 'gzip'}}), 'gzip');
  assert.strictEqual(chooseEncoding({headers: {}}), null);
});

test('the cache keeps a fixed number of files, so many tiny ones cannot use up its memory', () => {
  const cache = new StaticCache();
  for (let i = 0; i < 2500; i++) {
    cache.put('/static/js/f' + i + '.js', {'content-type': 'application/javascript'}, Buffer.alloc(10, 1), 0);
  }
  assert.ok(cache.entries.size <= 2000, 'at most 2000 entries');
  assert.ok(cache.entries.has('/static/js/f2499.js'), 'the newest is kept');
  assert.ok(!cache.entries.has('/static/js/f0.js'), 'the oldest went first');
});

test('two requests for the same encoding at once share one compression, and the bytes are counted once', async () => {
  const cache = new StaticCache();
  const body = Buffer.alloc(50 * 1024, 'a');
  const entry = cache.put('/static/js/g.js', {'content-type': 'application/javascript'}, body, 0);
  const [x, y] = await Promise.all([cache.variant(entry, 'gzip'), cache.variant(entry, 'gzip')]);
  assert.strictEqual(x, y, 'both get the same copy');
  assert.strictEqual(cache.bytes, body.length + x.length, 'the copy is counted once');
  assert.strictEqual(entry.size, body.length + x.length);
  assert.deepStrictEqual(entry.pending, {}, 'nothing is left in progress');
});

test('a copy compressed after its file was replaced is not counted against the cache', async () => {
  const cache = new StaticCache();
  const body = Buffer.alloc(50 * 1024, 'b');
  const old = cache.put('/static/js/h.js', {'content-type': 'application/javascript'}, body, 0);
  const pending = cache.variant(old, 'gzip');
  cache.put('/static/js/h.js', {'content-type': 'application/javascript'}, body, 0);   // replaced meanwhile
  await pending;
  assert.strictEqual(cache.bytes, body.length, 'only the new copy of the file is counted');
});
