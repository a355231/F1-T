'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {execFileSync} = require('node:child_process');
const {checkSvg, rasterize, webSearch, sseJson, addDelta} = require('../ai-tools');

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
