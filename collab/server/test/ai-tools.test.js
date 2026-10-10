'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('events');
const {checkSvg, rasterize, webSearch, sseJson, addDelta, addReasoning, fetchDoc, isPublicAddress, calculate} = require('../ai-tools');

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#3a7"/><circle id="c" cx="50" cy="50" r="20" fill="#fff"/><use href="#c" x="60"/></svg>';

test('a plain SVG picture is accepted, with its size from the viewBox', () => {
  assert.deepStrictEqual(checkSvg(GOOD), {ok: true, width: 200, height: 100});
  assert.strictEqual(checkSvg('<?xml version="1.0"?><!-- hi --><svg width="64" height="32"></svg>').width, 64);
});

test('pictures with scripts, embedded pages, images, entities or event handlers are refused', () => {
  const bad = [
    '<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="http://x/y.png"/></svg>',
    '<svg><rect onload="x()"/></svg>',
    '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>',
    '<svg><style>@import "x";</style></svg>',
    '<svg><a href="javascript:alert(1)"/></svg>',
  ];
  for (const svg of bad) assert.ok(checkSvg(svg).error, svg);
});

test('links and references may only point inside the picture', () => {
  assert.ok(checkSvg('<svg><use href="http://example.org/x.svg#a"/></svg>').error);
  assert.ok(checkSvg('<svg><rect fill="url(file:///etc/passwd#x)"/></svg>').error);
  assert.ok(checkSvg('<svg><rect fill="url(#grad)"/></svg>').ok);
});

test('text that is not an SVG picture, and empty or huge input, are refused', () => {
  assert.ok(checkSvg('<html></html>').error);
  assert.ok(checkSvg('   ').error);
  assert.ok(checkSvg('<svg>' + 'x'.repeat(201 * 1024) + '</svg>').error);
});

const rsvgInstalled = (() => {
  try {
    execFileSync('rsvg-convert', ['--version'], {stdio: 'ignore'});
    return true;
  } catch (e) {
    return false;
  }
})();

test('an SVG picture is drawn as a PNG of the width asked for', {skip: !rsvgInstalled && 'rsvg-convert is not installed here'}, async () => {
  const png = await rasterize(GOOD, 400);
  assert.deepStrictEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
  assert.strictEqual(png.readUInt32BE(16), 400, 'width');
  assert.strictEqual(png.readUInt32BE(20), 200, 'height keeps the proportions');
});

test('without rsvg-convert the person is told how to install it', async () => {
  const old = process.env.AI_RSVG;
  process.env.AI_RSVG = '/nonexistent/rsvg-convert';
  try {
    await assert.rejects(rasterize(GOOD, 100), /librsvg2-bin/);
  } finally {
    if (old === undefined) delete process.env.AI_RSVG; else process.env.AI_RSVG = old;
  }
});

test('web search returns up to five cleaned results and sends the key in a header', async () => {
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = {url, opts};
    return {ok: true, json: async () => ({web: {results: [
      {title: '<strong>Quiz</strong> &amp; more', url: 'https://example.org/a', description: 'A <em>good</em> one &quot;yes&quot;'},
      {title: 'b', url: 'https://example.org/b', description: 'c'},
    ]}})};
  };
  const out = await webSearch('quiz apps', 'k-123', fakeFetch);
  assert.match(seen.url, /q=quiz%20apps/);
  assert.strictEqual(seen.opts.headers['x-subscription-token'], 'k-123');
  assert.deepStrictEqual(out[0], {title: 'Quiz & more', url: 'https://example.org/a', snippet: 'A good one "yes"'});
  assert.strictEqual(out.length, 2);
});

test('the event stream reader copes with lines split across chunks and ignores comments', async () => {
  const parts = [': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\ndat', 'a: {"b":2}\n\ndata: [DONE]\n\ndata: {"c":3}\n\n'];
  const body = new ReadableStream({start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); }});
  const got = [];
  for await (const ev of sseJson(body)) got.push(ev);
  assert.deepStrictEqual(got, [{a: 1}, {b: 2}]);
});

test('tool calls that arrive in pieces are put back together', () => {
  const acc = {content: '', tool_calls: []};
  addDelta(acc, {tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'read_file', arguments: '{"pa'}}]});
  addDelta(acc, {tool_calls: [{index: 0, function: {arguments: 'th":"src/a.scm"}'}}]});
  addDelta(acc, {tool_calls: [{index: 1, id: 'call_2', function: {name: 'list_files', arguments: '{}'}}]});
  assert.deepStrictEqual(acc.tool_calls[0].function, {name: 'read_file', arguments: '{"path":"src/a.scm"}'});
  assert.strictEqual(acc.tool_calls[0].id, 'call_1');
  assert.strictEqual(acc.tool_calls[1].function.name, 'list_files');
});

// ---- reading documentation: only the allowed sites, only public addresses, never a redirect ----

// A stand-in for https.request: it answers with a status, a type and a body, and records the options.
function fakeTransport({status = 200, type = 'text/html; charset=utf-8', body = ''} = {}, seen = []) {
  return (opts, cb) => {
    seen.push(opts);
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = {'content-type': type};
    res.resume = () => {};
    const req = new EventEmitter();
    req.end = () => setImmediate(() => { cb(res); res.emit('data', Buffer.from(body)); res.emit('end'); });
    req.destroy = () => {};
    return req;
  };
}
const publicSite = async () => [{address: '93.184.216.34', family: 4}];

test('documentation is read only from the listed sites, over https', async () => {
  const notListed = await fetchDoc('https://example.org/page', {resolve: publicSite, transport: fakeTransport()});
  assert.match(notListed.error, /only these documentation sites/);
  const plain = await fetchDoc('http://developer.android.com/guide', {resolve: publicSite, transport: fakeTransport()});
  assert.match(plain.error, /only https/);
  const sub = await fetchDoc('https://evil.com/?x=developer.android.com', {resolve: publicSite, transport: fakeTransport()});
  assert.match(sub.error, /only these documentation sites/);
  assert.match((await fetchDoc('not a link', {resolve: publicSite, transport: fakeTransport()})).error, /not a web address/);
});

test('a documentation site whose name points to a private address is refused', async () => {
  const inside = await fetchDoc('https://docs.python.org/3/', {
    resolve: async () => [{address: '10.0.0.7', family: 4}], transport: fakeTransport()});
  assert.match(inside.error, /not on the public internet/);
  const loopback = await fetchDoc('https://docs.python.org/3/', {
    resolve: async () => [{address: '127.0.0.1', family: 4}], transport: fakeTransport()});
  assert.match(loopback.error, /not on the public internet/);
  const missing = await fetchDoc('https://docs.python.org/3/', {
    resolve: async () => { throw new Error('ENOTFOUND'); }, transport: fakeTransport()});
  assert.match(missing.error, /could not be found/);
});

test('the connection goes to the address that was checked, and redirects are not followed', async () => {
  const seen = [];
  const r = await fetchDoc('https://developer.mozilla.org/en-US/docs/Web', {
    resolve: publicSite, transport: fakeTransport({status: 301}, seen)});
  assert.match(r.error, /moved/);
  assert.strictEqual(seen[0].hostname, 'developer.mozilla.org');
  assert.strictEqual(seen[0].port, 443);
  assert.deepStrictEqual(seen[0].lookup('ignored', {}, (e, addr) => addr), '93.184.216.34');
});

test('a text page comes back as plain text, without scripts or tags; other types are refused', async () => {
  const html = '<html><head><script>steal()</script><style>p{}</style></head><body><h1>Labels</h1>' +
    '<p>A Label shows &quot;text&quot; &amp; more.</p></body></html>';
  const ok = await fetchDoc('https://appinventor.mit.edu/explore/ai2/label', {resolve: publicSite, transport: fakeTransport({body: html})});
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.url, 'https://appinventor.mit.edu/explore/ai2/label');
  assert.strictEqual(ok.text, 'Labels A Label shows "text" & more.');
  const picture = await fetchDoc('https://github.com/a.png', {resolve: publicSite, transport: fakeTransport({type: 'image/png'})});
  assert.match(picture.error, /not a text page/);
  const broken = await fetchDoc('https://github.com/x', {resolve: publicSite, transport: fakeTransport({status: 404})});
  assert.match(broken.error, /answered 404/);
});

test('a page larger than the limit is not read in full', async () => {
  const big = 'a'.repeat(1024 * 1024 + 10);
  const r = await fetchDoc('https://en.wikipedia.org/wiki/Big', {resolve: publicSite, transport: fakeTransport({body: big})});
  assert.match(r.error, /too big/);
});

test('isPublicAddress keeps private, loopback and link-local addresses out', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.9', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::5', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.strictEqual(isPublicAddress(ip), true, ip);
  }
});

// ---- arithmetic: exact, and nothing else can run ----

test('calculate works out arithmetic with brackets, powers and simple functions', () => {
  assert.deepStrictEqual(calculate('2 + 3 * 4'), {ok: true, value: 14});
  assert.strictEqual(calculate('(1 + 2) ^ 2').value, 9);
  assert.strictEqual(calculate('sqrt(16) + max(2, 7)').value, 11);
  assert.strictEqual(calculate('round(2.5) + floor(-1.5)').value, 3 + -2);
  assert.ok(Math.abs(calculate('pi').value - Math.PI) < 1e-12);
  assert.strictEqual(calculate('10 % 4').value, 2);
  assert.strictEqual(calculate('2 ^ 3 ^ 2').value, 512, 'powers group to the right, as in maths');
});

test('calculate refuses anything that is not arithmetic, and says why', () => {
  assert.match(calculate('process.exit(1)').error, /only numbers/);
  assert.match(calculate('alert(1)').error, /"alert" is not understood/);
  assert.match(calculate('1/0').error, /not a finite number/);
  assert.match(calculate('3 4').error, /extra parts/);
  assert.match(calculate('(1 + 2').error, /a bracket is missing/);
  assert.match(calculate('').error, /nothing to calculate/);
  assert.match(calculate('while(true){}').error, /only numbers/);
});

test('reasoning pieces are joined by index, and a signature or an encrypted block is kept as it arrived', () => {
  const acc = {content: '', tool_calls: []};
  addReasoning(acc, [{type: 'reasoning.text', text: 'Look ', index: 0}]);
  addReasoning(acc, [{type: 'reasoning.text', text: 'at the screen.', index: 0, signature: 'sig-1'}]);
  addReasoning(acc, [{type: 'reasoning.encrypted', data: 'enc-1', index: 1}]);
  addReasoning(acc, [{type: 'reasoning.encrypted', data: 'enc-2', index: 1}]);
  assert.deepStrictEqual(acc.reasoning_details, [
    {type: 'reasoning.text', text: 'Look at the screen.', index: 0, signature: 'sig-1'},
    {type: 'reasoning.encrypted', data: 'enc-2', index: 1},
  ]);
});
