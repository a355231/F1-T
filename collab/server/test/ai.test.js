'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Assistant, checkAttachments, modelTakesImages} = require('../ai');
const registry = require('../ai-registry');
const proj = require('../ai-project');
const {Hub} = require('../rooms');

const PIN_VALUE = 'test-pin-42';
const HOUR = 60 * 60 * 1000;
const rsvgInstalled = (() => {
  try { execFileSync('rsvg-convert', ['--version'], {stdio: 'ignore'}); return true; } catch (e) { return false; }
})();

// A response whose body is a server-sent event stream, the way OpenRouter sends a streamed answer.
function sseBody(events) {
  const text = events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join('');
  return new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); }});
}
const textTurn = (...parts) => [...parts.map(p => ({choices: [{delta: {content: p}}]})), '[DONE]'];
const toolTurn = (name, args, id = 'call_1', textBefore = '') => [
  ...(textBefore ? [{choices: [{delta: {content: textBefore}}]}] : []),
  {choices: [{delta: {tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args).slice(0, 5)}}]}}]},
  {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: JSON.stringify(args).slice(5)}}]}}]},
  '[DONE]',
];

// A small real picture, in base64: its first bytes are the PNG signature and its size is in the header.
const PNG_B64 = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]),
  Buffer.alloc(16),
]).toString('base64');

const SCM = proj.writeScm({authURL: [], YaVersion: '208', Source: 'Form', Properties: {
  $Name: 'Screen1', $Type: 'Form', $Version: '27', AppName: 'Pong', Title: 'Pong', Uuid: '0', $Components: [
    {$Name: 'Label1', $Type: 'Label', $Version: '5', Text: 'Score', Uuid: '11'},
  ]}});
const BKY = '<xml xmlns="https://developers.google.com/blockly/xml"></xml>';
const PROJECT_FILES = {
  'src/a/Screen1.scm': SCM,
  'src/a/Screen1.bky': BKY,
  'youngandroidproject/project.properties': 'main=a.Screen1\nname=Pong\n',
};

// The project's files as the server gives them to the helper: designer, blocks and properties files, sorted, a
// page of up to 3 MB at a time, with "next" naming the last file of a page (see /bundle in CollabServlet).
const BUNDLE_PAGE = 3 * 1024 * 1024;
function bundlePage(files, after) {
  const names = Object.keys(files).filter(f => /\.(scm|bky)$|project\.properties$/.test(f)).sort();
  const out = {};
  let total = 0;
  let last = null;
  for (const name of names) {
    if (after !== null && name <= after) continue;
    const size = Buffer.byteLength(files[name]);
    if (total > 0 && total + size > BUNDLE_PAGE) return {ok: true, files: out, next: last};
    total += size;
    out[name] = files[name];
    last = name;
  }
  return {ok: true, files: out, next: null};
}

// A blocks file of about kb kilobytes: valid, made of text blocks of a kilobyte each.
function bigBlocks(kb) {
  const block = '<block type="text"><field name="TEXT">' + 'a'.repeat(1000) + '</field></block>';
  let xml = '<xml xmlns="https://developers.google.com/blockly/xml">';
  while (xml.length < kb * 1024) xml += block;
  return xml + '</xml>';
}

// A model that sends a few words and then goes quiet without ending the answer.
const STALL = Symbol('stall');
// A body whose pieces arrive every gap ms: count words, then the end (or never, when count is Infinity).
function pacedBody(count, gap, signal) {
  let timer = null;
  let i = 0;
  return new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      const send = () => {
        if (i < count) {
          c.enqueue(enc.encode('data: ' + JSON.stringify({choices: [{delta: {content: 'w' + i + ' '}}]}) + '\n\n'));
          i++;
          timer = setTimeout(send, gap);
        } else {
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        }
      };
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); c.error(Object.assign(new Error('aborted'), {name: 'AbortError'})); }, {once: true});
      send();
    },
  });
}
function stalledBody(signal) {
  return new ReadableStream({start(c) {
    c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({choices: [{delta: {content: 'Let me look'}}]}) + '\n\n'));
    if (signal) signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
  }});
}

function fakeRes() {
  const r = {status: 0, headers: {}, text: '', body: null, writableEnded: false, listeners: {},
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); },
    write(c) { this.text += c; return true; },
    end(b) { if (b !== undefined) this.text += typeof b === 'string' ? b : b.toString(); this.writableEnded = true; this.body = this.text; },
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  };
  return r;
}
function fakeReq(url, method, body, cookie = 'AppInventor=ann') {
  const req = {url, method, headers: {cookie}};
  req[Symbol.asyncIterator] = async function* () { if (body) yield JSON.stringify(body); };
  return req;
}
// The events in what the helper wrote to a response. Each block has an id line and a data line; pings are noise.
const dataOf = block => block.split('\n').find(l => l.startsWith('data:'));
const events = res => res.text.split('\n\n').map(dataOf).filter(Boolean).map(l => JSON.parse(l.slice(5))).filter(e => e.type !== 'ping');
const ids = res => res.text.split('\n\n').map(b => /^id: (\d+)/m.exec(b)).filter(Boolean).map(m => +m[1]);

// Builds an assistant with a fake App Inventor (ask), a fake model (fetchImpl) that answers from a script,
// and a clock that the test can move. A script step may be a function of the request, so that it can
// use ids the tools just made. options.models lists the models OpenRouter knows, for the vision check.
function setup(script, options = {}) {
  process.env.OPENROUTER_API_KEY = 'sk-test';
  // The companion's models come from its presets; the ai.env overrides point the default preset at the test model.
  process.env.AI_MODEL_SMART = 'some/smart';
  process.env.AI_MODEL_BALANCED = 'some/model';
  process.env.AI_MODEL_FAST = 'some/fast';
  delete process.env.OPENROUTER_MODEL;
  process.env.AI_OVERRIDE_PIN = PIN_VALUE;
  delete process.env.BRAVE_API_KEY;
  // The PIN can be changed from the Team panel, into a file: each test gets a file of its own.
  process.env.AI_PIN_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-')), 'overridepin');
  if (options.vision !== undefined) process.env.AI_VISION = options.vision;
  else delete process.env.AI_VISION;
  // respond(payload) answers every model call instead of the script, when a test needs to tell the helper from its subagents.
  const {models, vision, files: projectFiles, bundleFailures: failures = 0, respond, ...rest} = options;
  let bundleFailures = failures;
  const modelList = models || [{id: 'some/model', architecture: {input_modalities: ['text']}}];
  let now = 1000000000000;
  const asked = [];
  const hub = new Hub(() => {});
  const ask = async (path, cookie, method, body, headers) => {
    asked.push({path, method, body, headers});
    if (path.startsWith('/ode/collab/whoami')) {
      const name = /AppInventor=(\w+)/.exec(cookie)[1];
      return {userId: 'u-' + name, email: name + '@team.local'};
    }
    if (path.startsWith('/ode/collab/access')) return {ok: true, projectName: 'Pong'};
    if (path.startsWith('/ode/collab/bundle')) {
      if (bundleFailures > 0) {
        bundleFailures--;
        return null;
      }
      return bundlePage(projectFiles || PROJECT_FILES, new URL(path, 'http://x').searchParams.get('after'));
    }
    if (path.startsWith('/ode/collab/files')) return {files: Object.keys(PROJECT_FILES).map(p => ({path: p, bytes: PROJECT_FILES[p].length}))};
    if (path.startsWith('/ode/collab/file?')) return {text: 'file text', bytes: 9};
    if (path.startsWith('/ode/collab/rawfile')) return {ok: true, path: 'assets/logo.png', mime: 'image/png', bytes: 40, data: PNG_B64};
    if (path.startsWith('/ode/collab/writefiles') || path.startsWith('/ode/collab/writemedia')) return {ok: true};
    return null;
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    if (url !== 'https://openrouter.ai/api/v1/chat/completions' && !url.startsWith('http://127.0.0.1')) {
      // The model list, for the vision check.
      return {ok: true, json: async () => ({data: modelList})};
    }
    calls.push({url, headers: opts.headers, payload: JSON.parse(opts.body), signal: opts.signal});
    const next = respond ? await respond(calls[calls.length - 1].payload) : script.shift();
    if (next === STALL) return {ok: true, body: stalledBody(opts.signal)};
    if (next && next.status) return {ok: false, status: next.status, text: async () => next.detail || ''};
    if (next && next.premature) return {ok: true, body: sseBody(next.premature)};
    if (next && next.paced !== undefined) return {ok: true, body: pacedBody(next.paced, next.gap, opts.signal)};
    const turn = typeof next === 'function' ? next(JSON.parse(opts.body)) : (next || textTurn('(no more script)'));
    return {ok: true, body: sseBody(turn)};
  };
  const ai = new Assistant(Object.assign({ask, hub, fetchImpl, now: () => now, log: () => {}, retryWaitMs: 5}, rest));
  return {ai, asked, calls, hub, pinFile: process.env.AI_PIN_FILE, advance: ms => { now += ms; },
    failBundles: n => { bundleFailures = n; }};
}

async function say(ai, who, text, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId, messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return events(res);
}
async function sayWith(ai, who, text, images, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId, images, messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return {res, evs: events(res)};
}
async function apply(ai, who, id, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId, id}, 'AppInventor=' + who), res);
  return res;
}
const systemOf = call => call.payload.messages[0].content;
const texts = evs => evs.filter(e => e.type === 'text').map(e => e.delta).join('');
const toolNames = call => (call.payload.tools || []).map(t => t.function.name);
const idOf = (payload, kind) => {
  const text = payload.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  const m = new RegExp('id (' + kind + '_[0-9a-f]+)').exec(text);
  return m ? m[1] : 'missing';
};
const toolErr = evs => evs.find(e => e.type === 'tool' && e.state === 'error');

test('without a key and model the helper says it is not set up and calls nobody', async () => {
  const t = setup([]);
  delete process.env.OPENROUTER_API_KEY;
  const evs = await say(t.ai, 'ann', 'hi');
  assert.match(texts(evs), /not set up/);
  assert.strictEqual(t.calls.length, 0);
  assert.strictEqual(evs[evs.length - 1].type, 'done');
});

test('answers stream: each piece of text is passed on as it arrives, then the stream ends', async () => {
  const t = setup([textTurn('Hel', 'lo ', 'there')]);
  const evs = await say(t.ai, 'ann', 'hi');
  assert.deepStrictEqual(evs.filter(e => e.type === 'text').map(e => e.delta), ['Hel', 'lo ', 'there']);
  assert.strictEqual(evs[evs.length - 1].type, 'done');
  assert.strictEqual(t.calls[0].payload.stream, true);
  assert.strictEqual(t.calls[0].headers.authorization, 'Bearer sk-test');
});

test('the model reads the project through a tool, shows the tool as it works, then answers', async () => {
  const t = setup([toolTurn('read_file', {path: 'src/a/Screen1.bky'}, 'call_9', 'Let me look. '), textTurn('All fine.')]);
  const evs = await say(t.ai, 'ann', 'what is in here?');
  assert.strictEqual(texts(evs), 'Let me look. All fine.');
  const toolEvents = evs.filter(e => e.type === 'tool');
  assert.deepStrictEqual(toolEvents.map(e => e.state), ['running', 'done']);
  assert.strictEqual(toolEvents[0].name, 'read_file');
  assert.strictEqual(toolEvents[0].label, 'Reading Screen1.bky');
  const result = t.calls[1].payload.messages.find(m => m.role === 'tool' && m.tool_call_id === 'call_9');
  assert.match(result.content, /xml/, 'the file is numbered and shown');
  assert.doesNotMatch(JSON.stringify(t.calls[0].payload.messages), /sk-test/, 'the key is never shown to the model');
});

test('a proposal is applied only by the person who got it, once', async () => {
  const t = setup([toolTurn('propose_change', {summary: 'Rename a label', files: {'src/a/Screen1.scm': 'new'}}), textTurn('Press Apply.')]);
  const evs = await say(t.ai, 'ann', 'fix it');
  const proposal = evs.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Screen1.scm', isNew: false}]);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing is written yet');
  assert.strictEqual((await apply(t.ai, 'bob', proposal.id)).status, 404, 'bob cannot apply it');
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  const write = t.asked.find(a => a.path.startsWith('/ode/collab/writefiles'));
  assert.deepStrictEqual(JSON.parse(write.body), {files: {'src/a/Screen1.scm': 'new'}});
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 404, 'only once');
});

test('small changes stop at three files; invalid proposals become a tool error the model can read', async () => {
  const four = {'src/a/a.scm': 'x', 'src/a/b.scm': 'x', 'src/a/c.bky': 'x', 'src/a/d.bky': 'x'};
  const t = setup([toolTurn('propose_change', {summary: 's', files: four}), textTurn('Sorry.')]);
  const evs = await say(t.ai, 'ann', 'rewrite everything');
  assert.strictEqual(evs.find(e => e.type === 'proposal'), undefined);
  assert.match(toolErr(evs).detail, /at most 3 files/);
});

test('an SVG picture is shown as it is drawn, turned into a PNG, and kept for its owner only', {skip: !rsvgInstalled && 'rsvg-convert is not installed here'}, async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="#e53935"/></svg>';
  const t = setup([
    toolTurn('create_svg', {name: 'Logo', svg}, 'c1'),
    p => toolTurn('svg_to_png', {picture_id: idOf(p, 'svg'), width: 240}, 'c2'),
    textTurn('Done.'),
  ]);
  const evs = await say(t.ai, 'ann', 'draw a logo');
  const svgEvent = evs.find(e => e.type === 'artifact' && e.kind === 'svg');
  assert.deepStrictEqual([svgEvent.width, svgEvent.height], [120, 60]);
  const pngEvent = evs.find(e => e.type === 'artifact' && e.kind === 'png');
  assert.deepStrictEqual([pngEvent.width, pngEvent.height], [240, 120]);
  assert.strictEqual(evs.filter(e => e.type === 'tool' && e.state === 'done').length, 2);

  const owner = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/artifact?id=' + svgEvent.id, 'GET', null, 'AppInventor=ann'), owner);
  assert.strictEqual(owner.status, 200);
  assert.strictEqual(owner.headers['content-type'], 'image/svg+xml');
  assert.match(owner.headers['content-security-policy'], /sandbox/);
  const png = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/artifact?id=' + pngEvent.id, 'GET', null, 'AppInventor=ann'), png);
  assert.strictEqual(png.headers['content-type'], 'image/png');
  const other = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/artifact?id=' + svgEvent.id, 'GET', null, 'AppInventor=bob'), other);
  assert.strictEqual(other.status, 404, 'bob cannot see ann\'s picture');
});

test('a picture with a script is refused with a plain reason', async () => {
  const t = setup([toolTurn('create_svg', {name: 'Bad', svg: '<svg><script>x()</script></svg>'}), textTurn('Sorry.')]);
  const evs = await say(t.ai, 'ann', 'draw');
  assert.strictEqual(evs.find(e => e.type === 'artifact'), undefined);
  assert.match(toolErr(evs).detail, /not allowed/);
});

test('a PNG picture is added to the project only when the person applies the proposal', {skip: !rsvgInstalled && 'rsvg-convert is not installed here'}, async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#1e88e5"/></svg>';
  const t = setup([
    toolTurn('create_svg', {name: 'Dot', svg}, 'c1'),
    p => toolTurn('svg_to_png', {picture_id: idOf(p, 'svg'), width: 80}, 'c2'),
    p => toolTurn('propose_change', {summary: 'Adds the dot picture', media: [{name: 'dot.png', picture_id: idOf(p, 'png')}]}, 'c3'),
    textTurn('Press Apply.'),
  ]);
  const evs = await say(t.ai, 'ann', 'add a dot picture');
  const proposal = evs.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.media, [{name: 'dot.png', width: 80, height: 80}]);
  assert.deepStrictEqual(proposal.files, []);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writemedia')), 'not written yet');
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  const sent = JSON.parse(t.asked.find(a => a.path.startsWith('/ode/collab/writemedia')).body).media[0];
  assert.strictEqual(sent.name, 'dot.png');
  assert.ok(sent.data.startsWith('iVBORw0KGgo'), 'the data is a PNG, in base64');
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'no source files were touched');
});

test('a picture name that is not a PNG name is refused', async () => {
  const t = setup([toolTurn('propose_change', {summary: 'x', media: [{name: '../evil.svg', picture_id: 'nope'}]}), textTurn('Sorry.')]);
  const evs = await say(t.ai, 'ann', 'add a file');
  assert.match(toolErr(evs).detail, /picture names/);
});

test('/override: a wrong PIN changes nothing, and the model never hears about it', async () => {
  const t = setup([]);
  const evs = await say(t.ai, 'ann', '/override 00000');
  assert.strictEqual(texts(evs), 'Wrong PIN.');
  assert.strictEqual(t.calls.length, 0);
  assert.match(texts(await say(t.ai, 'ann', '/override')), /Full-app mode is off/);
});

test('/override: the right PIN turns full-app mode on for that person and project, for an hour', async () => {
  const t = setup([textTurn('one'), textTurn('two'), textTurn('three')]);
  assert.match(texts(await say(t.ai, 'ann', '/override ' + PIN_VALUE)), /Full-app mode is on in this project until/);
  await say(t.ai, 'ann', 'build me a quiz app');
  assert.match(systemOf(t.calls[0]), /FULL-APP MODE/);
  assert.doesNotMatch(JSON.stringify(t.calls), new RegExp(PIN_VALUE), 'the PIN never reaches the model');
  await say(t.ai, 'bob', 'build me a quiz app');
  assert.doesNotMatch(systemOf(t.calls[1]), /FULL-APP MODE/, 'bob did not enter the PIN');
  t.advance(HOUR + 60000);
  await say(t.ai, 'ann', 'and now?');
  assert.doesNotMatch(systemOf(t.calls[2]), /FULL-APP MODE/, 'the hour is over');
});

test('after a few wrong PINs from anyone, nobody can try for 15 minutes', async () => {
  const t = setup([]);
  for (const who of ['ann', 'bob', 'cal', 'dee', 'eve']) {
    assert.strictEqual(texts(await say(t.ai, who, '/override 00000')), 'Wrong PIN.');
  }
  assert.match(texts(await say(t.ai, 'fay', '/override ' + PIN_VALUE)), /Too many wrong PINs/);
  t.advance(16 * 60 * 1000);
  assert.match(texts(await say(t.ai, 'fay', '/override ' + PIN_VALUE)), /Full-app mode is on/);
});

test('commands never reach the model, even when they are in the earlier messages', async () => {
  const t = setup([textTurn('ok')]);
  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId: '5', messages: [
    {role: 'user', content: '/override ' + PIN_VALUE},
    {role: 'assistant', content: 'Full-app mode is on.'},
    {role: 'user', content: 'hi'},
  ]}), res);
  assert.doesNotMatch(JSON.stringify(t.calls), new RegExp(PIN_VALUE));
  assert.ok(!t.calls[0].payload.messages.some(m => /^\/override/.test(m.content || '')));
});

test('/goal: the helper plans first, shows the plan, and stops when it says it is done', async () => {
  const t = setup([
    toolTurn('update_plan', {steps: [{text: 'Read the screens', status: 'doing'}, {text: 'Propose the change', status: 'todo'}]}),
    textTurn('All done: I read the screens.'),
  ]);
  const evs = await say(t.ai, 'ann', '/goal check the screens');
  assert.match(systemOf(t.calls[0]), /GOAL MODE[\s\S]*check the screens/);
  assert.ok(toolNames(t.calls[0]).includes('update_plan'));
  const plan = evs.find(e => e.type === 'plan');
  assert.deepStrictEqual(plan.steps.map(s => s.status), ['doing', 'todo']);
  assert.match(texts(evs), /All done/);
});

test('/goal stops at its step limit and says so, instead of running on', async () => {
  const script = [];
  for (let i = 0; i < 10; i++) script.push(toolTurn('list_files', {}, 'L' + i));
  const t = setup(script, {goalSteps: 3});
  const evs = await say(t.ai, 'ann', '/goal look around forever');
  assert.strictEqual(t.calls.length, 3);
  assert.match(evs.find(e => e.type === 'status').text, /step limit/);
});

// ---- the override PIN can be changed from the Team panel, the way the team code can ----

async function changePin(ai, who, body) {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/pin', 'POST', body, 'AppInventor=' + who), res);
  return {status: res.status, body: JSON.parse(res.body)};
}

test('the override PIN can be changed from the Team panel: the new one works at once, the old one stops', async () => {
  const t = setup([]);
  const done = await changePin(t.ai, 'ann', {current: PIN_VALUE, new: 'Fresh2026'});
  assert.strictEqual(done.status, 200);
  assert.strictEqual(fs.readFileSync(t.pinFile, 'utf8'), 'Fresh2026\n');
  assert.strictEqual(fs.statSync(t.pinFile).mode & 0o777, 0o600, 'only the hub\'s user can read it');
  assert.match(texts(await say(t.ai, 'ann', '/override ' + PIN_VALUE)), /^Wrong PIN\.$/);
  assert.match(texts(await say(t.ai, 'ann', '/override Fresh2026')), /Full-app mode is on/);
  assert.doesNotMatch(JSON.stringify(t.calls), /Fresh2026|test-pin-42/, 'the PIN never reaches the model');
});

test('a wrong current PIN changes nothing, and counts toward the same lock as /override', async () => {
  const t = setup([]);
  for (let i = 0; i < 4; i++) {
    assert.strictEqual((await changePin(t.ai, 'ann', {current: 'nope0000', new: 'Fresh2026'})).status, 403);
  }
  assert.strictEqual(fs.existsSync(t.pinFile), false, 'nothing was saved');
  assert.strictEqual((await changePin(t.ai, 'bob', {current: 'nope0000', new: 'Fresh2026'})).status, 403);
  const locked = await changePin(t.ai, 'fay', {current: PIN_VALUE, new: 'Fresh2026'});
  assert.strictEqual(locked.status, 429);
  assert.match(locked.body.error, /Too many wrong PINs/);
  assert.match(texts(await say(t.ai, 'fay', '/override ' + PIN_VALUE)), /Too many wrong PINs/);
});

test('the new PIN must be 4 to 20 letters or digits, as set-ai.sh asks', async () => {
  const t = setup([]);
  for (const bad of ['abc', 'has space', 'with-dash', 'x'.repeat(21), '']) {
    assert.strictEqual((await changePin(t.ai, 'ann', {current: PIN_VALUE, new: bad})).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(fs.existsSync(t.pinFile), false);
});

test('"also turn full-app mode off for everyone" ends it at once, for people already in it', async () => {
  const t = setup([textTurn('ok')]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'bob', '/override ' + PIN_VALUE);
  const r = await changePin(t.ai, 'ann', {current: PIN_VALUE, new: 'Fresh2026', endFull: true});
  assert.deepStrictEqual(r.body, {ok: true, endedFull: true});
  assert.match(texts(await say(t.ai, 'bob', '/override')), /Full-app mode is off/);
  assert.match(texts(await say(t.ai, 'ann', '/override')), /Full-app mode is off/);
});

test('with no PIN set yet, the Team panel cannot set the first one: the Pi does that', async () => {
  const t = setup([]);
  delete process.env.AI_OVERRIDE_PIN;
  try {
    const r = await changePin(t.ai, 'ann', {current: '', new: 'Fresh2026'});
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /set-ai\.sh --pin/);
  } finally {
    process.env.AI_OVERRIDE_PIN = PIN_VALUE;
  }
  assert.strictEqual(fs.existsSync(t.pinFile), false);
});

test('a PIN saved in the PIN file is used in place of the one in ai.env', async () => {
  const t = setup([]);
  fs.writeFileSync(t.pinFile, 'Elsewhere9\n');
  assert.match(texts(await say(t.ai, 'ann', '/override ' + PIN_VALUE)), /^Wrong PIN\.$/);
  assert.match(texts(await say(t.ai, 'ann', '/override Elsewhere9')), /Full-app mode is on/);
});

test('if the new PIN cannot be saved, nothing changes and the old PIN still works', async () => {
  const t = setup([]);
  process.env.AI_PIN_FILE = path.join(t.pinFile, 'nowhere', 'overridepin');   // its folder does not exist
  const r = await changePin(t.ai, 'ann', {current: PIN_VALUE, new: 'Fresh2026'});
  assert.strictEqual(r.status, 500);
  assert.match(r.body.error, /nothing has changed/);
  assert.match(texts(await say(t.ai, 'ann', '/override ' + PIN_VALUE)), /Full-app mode is on/);
});

// ---- sizes: a normal project, with big screens, can be read and changed ----

const BIG_SCREEN_EDIT = {path: 'src/a/Screen1.bky', old: '</xml>', new: '<block type="text"><field name="TEXT">hi</field></block></xml>'};

test('a project bigger than one bundle page is read in full, and a big screen can still be changed', async () => {
  const files = Object.assign({}, PROJECT_FILES, {'src/a/Screen1.bky': bigBlocks(1600), 'src/a/Screen2.scm': SCM,
    'src/a/Screen2.bky': bigBlocks(1600)});
  const t = setup([
    toolTurn('draft_replace', BIG_SCREEN_EDIT, 'r1'),
    toolTurn('propose_draft', {summary: 'A block on the main screen'}, 'p1'),
    textTurn('Press Apply.'),
  ], {files});
  const evs = await say(t.ai, 'ann', 'add a block to the main screen');
  assert.ok(!toolErr(evs), 'the change is not refused for its size');
  const proposal = evs.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Screen1.bky', isNew: false}]);
  assert.strictEqual(t.asked.filter(a => a.path.startsWith('/ode/collab/bundle')).length, 2, 'read in two pages');
});

test('in full-app mode, one change may touch several big screens, as long as all of it is under 8 MB', async () => {
  const files = Object.assign({}, PROJECT_FILES, {'src/a/Screen1.bky': bigBlocks(1500), 'src/a/Screen2.scm': SCM,
    'src/a/Screen2.bky': bigBlocks(1500)});
  const t = setup([
    toolTurn('draft_replace', BIG_SCREEN_EDIT, 'r1'),
    toolTurn('draft_replace', Object.assign({}, BIG_SCREEN_EDIT, {path: 'src/a/Screen2.bky'}), 'r2'),
    toolTurn('propose_draft', {summary: 'A block on each screen', complete: true}, 'p1'),
    textTurn('Press Apply.'),
  ], {files});
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'add a block to both screens');
  assert.ok(!toolErr(evs), 'neither change is refused: ' + JSON.stringify(toolErr(evs)));
  assert.strictEqual(evs.filter(e => e.type === 'proposal').length, 1);
});

test('a file over 2 MB cannot be changed by the helper, and the reason says so in plain words', async () => {
  const t = setup([
    toolTurn('draft_replace', {path: 'src/a/Screen1.bky', old: '</xml>', new: 'x'.repeat(2.1 * 1024 * 1024) + '</xml>'}, 'r1'),
    textTurn('I will split the change.'),
  ]);
  const evs = await say(t.ai, 'ann', 'add a very long text');
  assert.match(toolErr(evs).detail, /over 2 MB, more than the helper can change/);
  assert.doesNotMatch(JSON.stringify(evs), /too big/);
});

test('a read that fails is tried once more, and the change goes on', async () => {
  const t = setup([
    toolTurn('draft_replace', BIG_SCREEN_EDIT, 'r1'),
    toolTurn('propose_draft', {summary: 'A block'}, 'p1'),
    textTurn('Press Apply.'),
  ], {bundleFailures: 1});
  const evs = await say(t.ai, 'ann', 'add a block');
  assert.ok(evs.some(e => e.type === 'proposal'), 'the proposal is made after the second try');
  assert.strictEqual(t.asked.filter(a => a.path.startsWith('/ode/collab/bundle')).length, 2);
});

test('in full-app mode, a read that fails at the start of a message carries on from the copy kept from before', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('Started the quiz screen.'),
    textTurn('Next, the score.'),
    textTurn('Still going.'),
    textTurn('That is all for now.'),
    textTurn('The score is next.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'start a quiz app');
  t.failBundles(2);
  const evs = await say(t.ai, 'ann', 'what is next?');
  assert.ok(!evs.some(e => e.type === 'error'), 'the answer is not lost');
  assert.match(texts(evs), /The score is next\./);
  assert.ok(evs.some(e => e.type === 'status' && /copy from before/.test(e.text)));
});

test('the same tool calls over and over are a loop; a single short answer is not', async () => {
  const t = setup(Array.from({length: 12}, (_, i) => toolTurn('list_files', {}, 'L' + i)));
  const evs = await say(t.ai, 'ann', 'look around');
  assert.strictEqual(t.calls.length, 8);
  assert.match(evs.find(e => e.type === 'status').text, /repeating the same step/);
});

// ---- an AI change goes in only once every open tab has saved what it had ----

test('an AI change waits until every open tab has saved, then goes in, and the open tabs reload', async () => {
  const t = setup([
    toolTurn('draft_replace', BIG_SCREEN_EDIT, 'r1'),
    toolTurn('propose_draft', {summary: 'A block'}, 'p1'),
    textTurn('Press Apply.'),
  ]);
  const sent = [];
  t.hub.send = (id, msg) => sent.push({id, msg});
  const ann = t.hub.addClient({userId: 'u-ann', email: 'ann@team.local'});
  t.hub.join(ann.id, '5', {projectName: 'Pong', ownerEmail: 'ann@team.local'});
  const proposal = (await say(t.ai, 'ann', 'add a block')).find(e => e.type === 'proposal');
  const applying = apply(t.ai, 'ann', proposal.id);
  await until(() => sent.some(s => s.msg.t === 'freeze' && s.msg.flush));   // the tabs are asked to save
  const freeze = sent.find(s => s.msg.t === 'freeze' && s.msg.flush).msg;
  assert.strictEqual(t.asked.filter(a => a.path.startsWith('/ode/collab/writefiles')).length, 0, 'nothing is written yet');
  t.hub.ackFlush(ann.id, freeze.applyId);
  assert.strictEqual((await applying).status, 200);
  assert.strictEqual(t.asked.filter(a => a.path.startsWith('/ode/collab/writefiles')).length, 1);
  assert.ok(sent.some(s => s.msg.t === 'reload' && s.id === ann.id), 'the open tab reloads to show the change');
});

test('a tab that does not answer does not hold an AI change for long', async () => {
  const t = setup([
    toolTurn('draft_replace', BIG_SCREEN_EDIT, 'r1'),
    toolTurn('propose_draft', {summary: 'A block'}, 'p1'),
    textTurn('Press Apply.'),
  ], {flushMs: 30});
  t.hub.send = () => {};
  const ann = t.hub.addClient({userId: 'u-ann', email: 'ann@team.local'});
  t.hub.join(ann.id, '5', {projectName: 'Pong', ownerEmail: 'ann@team.local'});
  const proposal = (await say(t.ai, 'ann', 'add a block')).find(e => e.type === 'proposal');
  const started = Date.now();
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  assert.ok(Date.now() - started < 2000, 'it went in after the wait, not after a minute');
});

test('/goal with nothing after it asks for the goal', async () => {
  const t = setup([]);
  assert.match(texts(await say(t.ai, 'ann', '/goal')), /Tell me the goal/);
  assert.strictEqual(t.calls.length, 0);
});

test('web search is offered only when a search key is set, and is used through the search function', async () => {
  const t = setup([toolTurn('web_search', {query: 'quiz app ideas'}), textTurn('Here are some.')], {
    searchImpl: async (q, key) => { assert.strictEqual(key, 'brave-key'); return [{title: 'T', url: 'https://example.org', snippet: 'S'}]; },
  });
  process.env.BRAVE_API_KEY = 'brave-key';
  const evs = await say(t.ai, 'ann', 'search for quiz app ideas');
  delete process.env.BRAVE_API_KEY;
  assert.ok(toolNames(t.calls[0]).includes('web_search'));
  assert.strictEqual(evs.find(e => e.type === 'tool' && e.name === 'web_search' && e.state === 'done').detail, '1 results');
  const t2 = setup([textTurn('no search')]);
  await say(t2.ai, 'ann', 'hi');
  assert.ok(!toolNames(t2.calls[0]).includes('web_search'));
});

test('applying a full-app change sends the header that allows it; a small change does not', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Screen2'}, 'n1'), toolTurn('propose_draft', {summary: 'New screen', complete: true}, 'p1'), textTurn('Press Apply.'),
    toolTurn('propose_change', {summary: 'Small', files: {'src/a/Screen1.scm': 'y'}}), textTurn('Press Apply.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const full = (await say(t.ai, 'ann', 'add a screen')).find(e => e.type === 'proposal');
  const small = (await say(t.ai, 'bob', 'fix the label')).find(e => e.type === 'proposal');
  assert.strictEqual((await apply(t.ai, 'ann', full.id)).status, 200);
  assert.deepStrictEqual(t.asked.filter(x => x.path.startsWith('/ode/collab/writefiles')).pop().headers, {'x-collab-ai-mode': 'full'});
  assert.strictEqual((await apply(t.ai, 'bob', small.id)).status, 200);
  assert.deepStrictEqual(t.asked.filter(x => x.path.startsWith('/ode/collab/writefiles')).pop().headers, {});
});

test('a full-app change is refused if full-app mode was turned off before Apply', async () => {
  const t = setup([toolTurn('scm_new_screen', {name: 'Screen2'}, 'n1'), toolTurn('propose_draft', {summary: 'New screen', complete: true}, 'p1'), textTurn('Press Apply.')]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const proposal = (await say(t.ai, 'ann', 'add a screen')).find(e => e.type === 'proposal');
  await say(t.ai, 'ann', '/override off');
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 403);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing was written');
});

test('questions are rate limited per person; a goal costs five', async () => {
  const script = [];
  for (let i = 0; i < 20; i++) script.push(textTurn('ok'));
  const t = setup(script);
  let limited = 0;
  for (let i = 0; i < 15; i++) {
    const evs = await say(t.ai, 'ann', 'q');
    if (evs.some(e => e.type === 'error' && /Too many/.test(e.message))) limited++;
  }
  assert.ok(limited >= 3, 'limited ' + limited);
  const goalEvs = await say(t.ai, 'bob', '/goal something');
  assert.ok(!goalEvs.some(e => e.type === 'error'), 'bob is not affected');
});

test('signed-out visitors get nothing', async () => {
  const t = setup([textTurn('x')]);
  t.ai.ask = async () => null;
  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId: '5', messages: []}, ''), res);
  assert.strictEqual(res.status, 401);
});

test('the browser files are only served from the fixed list', async () => {
  const t = setup([]);
  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/static/..%2Fai.js', 'GET', null), res);
  assert.strictEqual(res.status, 404);
});

// ---- the draft: changes are made in the helper's copy and only proposed ----

test('a component added in the draft reaches the project only when the proposal is applied', async () => {
  const t = setup([
    toolTurn('scm_add_component', {screen: 'Screen1', type: 'Button', name: 'Button1', properties: {Text: 'Start'}}, 'd1'),
    toolTurn('check_project', {}, 'd2'),
    toolTurn('propose_draft', {summary: 'Adds a Start button'}, 'd3'),
    textTurn('Press Apply to add the button.'),
  ]);
  const evs = await say(t.ai, 'ann', 'add a start button');
  assert.deepStrictEqual(evs.filter(e => e.type === 'tool' && e.state === 'error'), []);
  const proposal = evs.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Screen1.scm', isNew: false}]);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing written before Apply');
  assert.match(texts(evs), /Press Apply/);
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  const written = JSON.parse(t.asked.find(a => a.path.startsWith('/ode/collab/writefiles')).body).files['src/a/Screen1.scm'];
  const obj = proj.parseScm(written);
  assert.ok(proj.findNode(obj, 'Button1'), 'the new button is in the screen');
  assert.ok(proj.findNode(obj, 'Label1'), 'the old label is kept');
});

test('the draft checks names and property names against App Inventor before anything is changed', async () => {
  const t = setup([
    toolTurn('scm_add_component', {screen: 'Screen1', type: 'Buton', name: 'B1'}, 'x1'),
    toolTurn('scm_set_property', {screen: 'Screen1', component: 'Label1', property: 'Colour', value: 'red'}, 'x2'),
    textTurn('I could not add it.'),
  ]);
  const evs = await say(t.ai, 'ann', 'add a button');
  const errors = evs.filter(e => e.type === 'tool' && e.state === 'error').map(e => e.detail);
  assert.match(errors[0], /unknown component type "Buton"/);
  assert.match(errors[1], /no designer property "Colour"/);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')));
});

test('new screens are offered only in full-app mode, and then need both their files', async () => {
  const t = setup([textTurn('no')]);
  await say(t.ai, 'ann', 'a new screen');
  assert.ok(!toolNames(t.calls[0]).includes('scm_new_screen'), 'not offered in small mode');

  const f = setup([
    toolTurn('scm_new_screen', {name: 'Quiz', app_name: 'Quiz'}, 'n1'),
    toolTurn('propose_draft', {summary: 'A quiz screen', complete: true}, 'n2'),
    textTurn('Press Apply.'),
  ]);
  await say(f.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(f.ai, 'ann', 'add a quiz screen');
  assert.ok(toolNames(f.calls[0]).includes('scm_new_screen'));
  const proposal = evs.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Quiz.scm', isNew: true}, {path: 'src/a/Quiz.bky', isNew: true}]);
  assert.strictEqual((await apply(f.ai, 'ann', proposal.id)).status, 200);
  assert.deepStrictEqual(f.asked.filter(x => x.path.startsWith('/ode/collab/writefiles')).pop().headers, {'x-collab-ai-mode': 'full'});
});

test('a handler for a component that is not on the screen is refused, and check_project names the problems', async () => {
  const t = setup([
    toolTurn('bky_add_event_handler', {screen: 'Screen1', component: 'Button9', event: 'Click'}, 'h1'),
    toolTurn('check_project', {}, 'h2'),
    textTurn('Done.'),
  ]);
  const evs = await say(t.ai, 'ann', 'wire a button');
  assert.match(toolErr(evs).detail, /no component named Button9/);
  const check = t.calls[2].payload.messages.find(m => m.role === 'tool' && m.tool_call_id === 'h2');
  assert.match(check.content, /No problems found/);
});

test('scratch notes are kept for the person and project, and only the names are listed', async () => {
  const t = setup([
    toolTurn('scratch_write', {key: 'plan', text: 'Button, then Label'}, 's1'),
    toolTurn('scratch_read', {key: 'plan'}, 's2'),
    textTurn('ok'),
  ]);
  await say(t.ai, 'ann', 'remember this');
  const read = t.calls[1].payload.messages.find(m => m.tool_call_id === 's1');
  assert.strictEqual(read.content, 'Noted.');
  assert.strictEqual(t.calls[2].payload.messages.find(m => m.tool_call_id === 's2').content, 'Button, then Label');
});

test('ask_user shows the question and ends the answer, so the person replies in their next message', async () => {
  const t = setup([toolTurn('ask_user', {question: 'Which colour should the button be?'}, 'q1'), textTurn('never sent')]);
  const evs = await say(t.ai, 'ann', 'add a button');
  assert.deepStrictEqual(evs.filter(e => e.type === 'question').map(e => e.text), ['Which colour should the button be?']);
  assert.strictEqual(t.calls.length, 1, 'no further model call');
});

// ---- pictures the model can look at ----

test('without a picture-reading model, view_picture is not offered and attached pictures are not sent', async () => {
  const t = setup([textTurn('I cannot see it.')]);
  const {evs} = await sayWith(t.ai, 'ann', 'what is this?', [{name: 'a.png', mime: 'image/png', data: PNG_B64}]);
  assert.ok(!toolNames(t.calls[0]).includes('view_picture'));
  assert.strictEqual(typeof t.calls[0].payload.messages.at(-1).content, 'string');
  assert.match(t.calls[0].payload.messages.at(-1).content, /cannot look at pictures/);
  assert.match(evs.find(e => e.type === 'status').text, /cannot look at pictures/);
  assert.doesNotMatch(JSON.stringify(t.calls), /image_url/);
});

test('with a picture-reading model (listed by OpenRouter), the project picture is shown to the model', async () => {
  const t = setup([toolTurn('view_picture', {path: 'assets/logo.png'}, 'v1'), textTurn('The logo is a small red square.')], {
    models: [{id: 'some/model', architecture: {modality: 'text+image->text', input_modalities: ['text', 'image']}}],
  });
  const evs = await say(t.ai, 'ann', 'look at the logo');
  assert.ok(toolNames(t.calls[0]).includes('view_picture'));
  const shown = t.calls[1].payload.messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.ok(shown, 'a message with the picture follows the tool result');
  assert.strictEqual(shown.content[1].type, 'image_url');
  assert.ok(shown.content[1].image_url.url.startsWith('data:image/png;base64,iVBORw0KGgo'));
  assert.match(texts(evs), /red square/);
  const artifact = evs.find(e => e.type === 'artifact');
  assert.strictEqual(artifact.kind, 'png');
});

test('AI_VISION overrides the model list: 1 turns pictures on, 0 turns them off', async () => {
  const on = setup([textTurn('ok')], {vision: '1'});
  await say(on.ai, 'ann', 'hi');
  assert.ok(toolNames(on.calls[0]).includes('view_picture'));
  const off = setup([textTurn('ok')], {vision: '0', models: [{id: 'some/model', architecture: {input_modalities: ['text', 'image']}}]});
  await say(off.ai, 'ann', 'hi');
  assert.ok(!toolNames(off.calls[0]).includes('view_picture'));
});

test('an attached picture is checked by its contents, and a fake one is refused', async () => {
  const t = setup([]);
  const bad = await sayWith(t.ai, 'ann', 'look', [{name: 'x.png', mime: 'image/png', data: Buffer.from('not a picture').toString('base64')}]);
  assert.strictEqual(bad.res.status, 400);
  assert.match(JSON.parse(bad.res.body).error, /does not look like/);
  assert.strictEqual(t.calls.length, 0);
});

test('with a picture-reading model, an attached picture goes to the model with the message, not kept after it', async () => {
  const t = setup([textTurn('A red square.'), textTurn('Still red.')], {vision: '1'});
  await sayWith(t.ai, 'ann', 'what colour?', [{name: 'a.png', mime: 'image/png', data: PNG_B64}]);
  const last = t.calls[0].payload.messages.at(-1);
  assert.strictEqual(last.role, 'user');
  assert.strictEqual(last.content[0].text, 'what colour?');
  assert.strictEqual(last.content[1].type, 'image_url');
});

// ---- small helpers ----

test('checkAttachments keeps only real pictures of the four types, at most three', () => {
  const ok = checkAttachments([{name: 'a.png', mime: 'image/png', data: PNG_B64}]);
  assert.strictEqual(ok.images.length, 1);
  assert.match(checkAttachments([{name: 'a.svg', mime: 'image/svg+xml', data: 'PHN2Zz4='}]).error, /not a PNG, JPEG, GIF or WebP/);
  assert.match(checkAttachments([1, 2, 3, 4].map(() => ({name: 'a', mime: 'image/png', data: PNG_B64}))).error, /at most 3/);
  assert.deepStrictEqual(checkAttachments(undefined), {images: []});
});

test('modelTakesImages reads OpenRouter\'s two forms of the model list', () => {
  assert.strictEqual(modelTakesImages({architecture: {input_modalities: ['text', 'image']}}), true);
  assert.strictEqual(modelTakesImages({architecture: {input_modalities: ['text']}}), false);
  assert.strictEqual(modelTakesImages({architecture: {modality: 'text+image->text'}}), true);
  assert.strictEqual(modelTakesImages({architecture: {modality: 'text->text'}}), false);
  assert.strictEqual(modelTakesImages({}), false);
});

test('the draft refuses files outside the screens, and grows only so far in small mode', async () => {
  const draft = new registry.Draft({projectId: '5', cookie: 'AppInventor=ann', ask: async () => ({ok: true, files: PROJECT_FILES}), full: false});
  await assert.rejects(draft.write('youngandroidproject/project.properties', 'x'), /not a designer or blocks file/);
  await assert.rejects(draft.write('src/a/New.scm', 'x'), /new screens need full-app mode/);
  await assert.rejects(draft.write('src/a/Screen1.scm', 'x'.repeat(20000)), /grow too much/);
  await draft.write('src/a/Screen1.scm', SCM);
  assert.strictEqual(draft.changed.size, 1);
});

// ---- full-app mode: the app is proposed once it is complete, and kept between messages until then ----

const BKY_WITH_GHOST = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="component_set_get">' +
  '<field name="COMPONENT_SELECTOR">Ghost</field></block><yacodeblocks ya-version="208" language-version="39"></yacodeblocks></xml>';

test('in full-app mode, a proposal is refused until the app is complete, and the model is told why', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    toolTurn('propose_draft', {summary: 'A quiz screen'}, 'n2'),
    toolTurn('propose_draft', {summary: 'A quiz screen', complete: true}, 'n3'),
    textTurn('Press Apply.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'build a quiz');
  const refused = evs.filter(e => e.type === 'tool' && e.name === 'propose_draft' && e.state === 'error');
  assert.strictEqual(refused.length, 1);
  assert.match(refused[0].detail, /not complete yet/);
  assert.strictEqual(evs.filter(e => e.type === 'proposal').length, 1, 'Apply appears once, when the app is complete');
});

test('in full-app mode, propose_change is not offered; in small mode it is', async () => {
  const t = setup([textTurn('ok')]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'hi');
  assert.ok(!toolNames(t.calls[0]).includes('propose_change'));
  const small = setup([textTurn('ok')]);
  await say(small.ai, 'ann', 'hi');
  assert.ok(toolNames(small.calls[0]).includes('propose_change'));
});

test('an app with a problem is not proposed; the problem is named so the model can fix it', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    toolTurn('draft_write', {path: 'src/a/Quiz.bky', content: BKY_WITH_GHOST}, 'n2'),
    toolTurn('propose_draft', {summary: 'A quiz', complete: true}, 'n3'),
    textTurn('I will fix the block.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'build a quiz');
  assert.strictEqual(evs.filter(e => e.type === 'proposal').length, 0);
  const err = evs.find(e => e.type === 'tool' && e.name === 'propose_draft' && e.state === 'error');
  assert.match(err.detail, /not proposed: 1 problem\(s\) remain/);
  assert.match(err.detail, /a block uses Ghost/);
});

test('a problem the project already had does not stop a complete app from being proposed', async () => {
  const files = Object.assign({}, PROJECT_FILES, {'youngandroidproject/project.properties': 'name=Pong\n'});  // no main screen
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    toolTurn('propose_draft', {summary: 'A quiz', complete: true}, 'n2'),
    textTurn('Press Apply.'),
  ], {files});
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'add a quiz screen');
  assert.ok(evs.some(e => e.type === 'proposal'));
});

// ---- full-app mode builds on until the app is complete; a question or a plan leaves an unfinished app alone ----

async function sayWithEffort(ai, who, text, effort) {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId: '5', effort, messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return events(res);
}

test('in full-app mode, an answer that stops with the app unfinished is asked to carry on, and the app is proposed once complete', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('The quiz screen is started.'),
    toolTurn('propose_draft', {summary: 'A quiz app', complete: true}, 'd2'),
    textTurn('Press Apply.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'start a quiz app');
  assert.match(t.calls[2].payload.messages.at(-1).content, /not complete yet/);
  assert.strictEqual(evs.filter(e => e.type === 'proposal').length, 1);
  assert.ok(!evs.some(e => e.type === 'status' && /Still building/.test(e.text)));
});

test('an unfinished app is kept between messages and shown as still building; the next message finishes it', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('Started. Next the questions.'), textTurn('Next the score.'), textTurn('Next the buttons.'), textTurn('Later.'),
    toolTurn('draft_status', {}, 'd1'),
    toolTurn('propose_draft', {summary: 'A quiz app', complete: true}, 'd2'),
    textTurn('Press Apply.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const first = await say(t.ai, 'ann', 'start a quiz app');
  assert.ok(!first.some(e => e.type === 'proposal'), 'nothing to apply yet');
  assert.ok(first.some(e => e.type === 'status' && /Still building/.test(e.text)));
  const second = await say(t.ai, 'ann', 'continue');
  assert.match(systemOf(t.calls[5]), /draft from earlier messages has 2 changed file/);
  const proposal = second.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Quiz.scm', isNew: true}, {path: 'src/a/Quiz.bky', isNew: true}]);
  assert.ok(!second.some(e => e.type === 'status' && /Still building/.test(e.text)));
});

test('a question asked while an app is unfinished is answered, and does not start more building', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('Started.'), textTurn('Next.'), textTurn('Later.'), textTurn('Done for now.'),
    textTurn('It is a quiz with two screens.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'start a quiz app');
  const evs = await say(t.ai, 'ann', 'what does the quiz screen do?');
  assert.strictEqual(t.calls.length, 6, 'one answer, and no nudges');
  assert.match(texts(evs), /two screens/);
  assert.ok(!evs.some(e => e.type === 'status'));
});

test('full-app mode has no step or time limit; any other answer has a few steps and a few minutes', async () => {
  const read = i => toolTurn('read_file', {path: 'src/a/Screen1.scm', from: i + 1}, 'r' + i);
  const full = setup([...Array.from({length: 20}, (_, i) => read(i)), textTurn('Done.')]);
  await say(full.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(full.ai, 'ann', 'go through the screen line by line');
  assert.strictEqual(full.calls.length, 21);
  assert.ok(!evs.some(e => e.type === 'status'), 'no limit was reached');
  assert.match(texts(evs), /Done\./);

  const small = setup([...Array.from({length: 20}, (_, i) => read(i)), textTurn('Done.')]);
  const smallEvs = await say(small.ai, 'ann', 'go through the screen line by line');
  assert.strictEqual(small.calls.length, 14);
  assert.match(smallEvs.find(e => e.type === 'status').text, /too many steps/);

  // Each model answer takes five minutes on the clock: a small change runs out of time after the first.
  let clock = null;
  const slow = setup(Array.from({length: 3}, (_, i) => () => {
    clock.advance(5 * 60 * 1000);
    return read(i);
  }).concat([textTurn('Done.')]));
  clock = slow;
  const slowEvs = await say(slow.ai, 'ann', 'go through the screen line by line');
  assert.strictEqual(slow.calls.length, 1, 'a small change stops after four minutes');
  assert.match(slowEvs.find(e => e.type === 'status').text, /time for this goal is up/);
});

test('the same step over and over is a loop: the helper stops, and says so', async () => {
  const t = setup(Array.from({length: 12}, (_, i) => toolTurn('list_files', {}, 'L' + i)));
  const evs = await say(t.ai, 'ann', 'look around');
  assert.strictEqual(t.calls.length, 8);
  assert.match(evs.find(e => e.type === 'status').text, /repeating the same step/);
});

test('/plan says what it would do, and cannot change the project even when the model tries', async () => {
  const t = setup([toolTurn('draft_write', {path: 'src/a/Screen1.bky', content: BKY}, 'p1'), textTurn('Here is the plan.')]);
  assert.match(texts(await say(t.ai, 'ann', '/plan')), /Tell me what to plan/);
  assert.strictEqual(t.calls.length, 0);
  const evs = await say(t.ai, 'ann', '/plan add a high score screen');
  const offered = toolNames(t.calls[0]);
  assert.ok(offered.includes('check_project') && offered.includes('ask_user'));
  for (const name of ['draft_write', 'scm_add_component', 'bky_add_blocks', 'propose_draft']) assert.ok(!offered.includes(name), name);
  assert.match(systemOf(t.calls[0]), /PLANNING ONLY/);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing was written');
  assert.match(t.calls[1].payload.messages.at(-1).content, /not available here/);
  assert.match(texts(evs), /Here is the plan\./);
});

test('/plan leaves an unfinished app alone, so the next message carries on from it', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('Started.'), textTurn('Next.'), textTurn('Later.'), textTurn('Done for now.'),
    textTurn('Here is a plan.'),
    textTurn('Carrying on.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'start a quiz app');
  await say(t.ai, 'ann', '/plan add a score screen');
  await say(t.ai, 'ann', 'carry on');
  assert.match(systemOf(t.calls[6]), /draft from earlier messages has 2 changed file/);
});

test('/discard throws away an unfinished app without a model answer, and says so when there is none', async () => {
  const t = setup([toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'), textTurn('Started.'), textTurn('Next.'), textTurn('Later.'), textTurn('Done for now.')]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'start a quiz app');
  const calls = t.calls.length;
  assert.match(texts(await say(t.ai, 'ann', '/discard')), /thrown away\. Nothing in the project was changed\. Full-app mode is still on\./);
  assert.strictEqual(t.calls.length, calls);
  assert.match(texts(await say(t.ai, 'ann', '/discard')), /There is no unfinished app/);
});

test('in full-app mode, an answer cut off in plain words carries on, and nobody is told it was cut off', async () => {
  const t = setup([cutText, textTurn('Carrying on.')]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  const evs = await say(t.ai, 'ann', 'build a quiz');
  assert.ok(!evs.some(e => e.type === 'status' && /cut off/i.test(e.text)));
  assert.match(texts(evs), /Carrying on\./);
});

test('the effort level changes how carefully the helper works; an unknown level counts as medium', async () => {
  const t = setup([textTurn('a'), textTurn('b'), textTurn('c'), textTurn('d')]);
  await sayWithEffort(t.ai, 'ann', 'hi', 'high');
  assert.match(systemOf(t.calls[0]), /Effort is HIGH/);
  await sayWithEffort(t.ai, 'ann', 'hi', 'low');
  assert.match(systemOf(t.calls[1]), /Effort is LOW/);
  await sayWithEffort(t.ai, 'ann', 'hi', 'medium');
  assert.doesNotMatch(systemOf(t.calls[2]), /Effort is/);
  const evs = await sayWithEffort(t.ai, 'ann', 'hi', 'extreme');
  assert.doesNotMatch(systemOf(t.calls[3]), /Effort is/);
  assert.ok(!evs.some(e => e.type === 'error'));
});

test('turning full-app mode off throws the unfinished app away; the next app starts from the project', async () => {
  const t = setup([
    toolTurn('scm_new_screen', {name: 'Quiz'}, 'n1'),
    textTurn('Started.'), textTurn('Next.'), textTurn('Later.'), textTurn('Done for now.'),
    toolTurn('draft_status', {}, 'd1'),
    textTurn('Nothing yet.'),
  ]);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'start a quiz app');
  assert.match(texts(await say(t.ai, 'ann', '/override off')), /draft was discarded/);
  await say(t.ai, 'ann', '/override ' + PIN_VALUE);
  await say(t.ai, 'ann', 'what changed?');
  assert.ok(!systemOf(t.calls[5]).includes('draft from earlier messages'));
  assert.ok(t.calls[6].payload.messages.some(m => m.role === 'tool' && m.content === 'Nothing has been changed yet.'));
});

// ---- a model that stops responding is cut off, instead of leaving the person waiting ----

test('a model that stops sending is cut off after the idle time, and the person is told', async () => {
  const t = setup([STALL], {idleMs: 40, retries: 0});
  const evs = await say(t.ai, 'ann', 'hi');
  assert.match(texts(evs), /Let me look/, 'what was sent before the stop is kept');
  assert.match(evs.find(e => e.type === 'error').message, /stopped sending its answer/);
  assert.strictEqual(evs[evs.length - 1].type, 'done', 'the answer is over, so the page is not left busy');
});

test('an answer that keeps arriving is not cut off', async () => {
  const t = setup([{paced: 10, gap: 15}], {idleMs: 60, turnMs: 2000});
  const evs = await say(t.ai, 'ann', 'hi');
  assert.ok(!evs.some(e => e.type === 'error'));
  assert.match(texts(evs), /w9/);
});

test('an answer that runs past the time limit is cut off with a message', async () => {
  const t = setup([{paced: Infinity, gap: 15}], {idleMs: 1000, turnMs: 120});
  const evs = await say(t.ai, 'ann', 'hi');
  assert.match(evs.find(e => e.type === 'error').message, /ran past the time limit/);
});

// ---- an answer is worked out on the server, so a dropped connection does not end it ----

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
};
const drop = res => (res.listeners.close || []).forEach(fn => fn());      // the browser's connection drops
const startAnswer = (ai, who, text = 'hi', projectId = '5') => {
  const res = fakeRes();
  const finished = ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId, messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return {res, finished};
};
const getJson = async (ai, who, url, method = 'GET', body = null) => {
  const res = fakeRes();
  await ai.handle(fakeReq(url, method, body, 'AppInventor=' + who), res);
  return res;
};
const WORDS = n => Array.from({length: n}, (_, i) => 'w' + i + ' ').join('');

test('an answer keeps going after the browser connection drops, and a reconnect gets the rest', async () => {
  const t = setup([{paced: 12, gap: 15}]);
  const {res} = startAnswer(t.ai, 'ann');
  await until(() => texts(events(res)).length >= 6);
  const lastSeen = ids(res).pop();
  drop(res);
  const again = await getJson(t.ai, 'ann', '/collab/ai/resume?projectId=5&after=' + lastSeen);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(texts(events(res)) + texts(events(again)), WORDS(12), 'every word once, in order');
  assert.strictEqual(events(again).at(-1).type, 'done');
});

test('a browser that reconnects after the end still gets the end, and only what it has not seen', async () => {
  const t = setup([textTurn('one ', 'two ', 'three')]);
  const first = await say(t.ai, 'ann', 'hi');
  assert.strictEqual(texts(first), 'one two three');
  const res = await getJson(t.ai, 'ann', '/collab/ai/resume?projectId=5&after=0');
  const all = events(res);
  assert.deepStrictEqual(all.filter(e => e.type === 'text').map(e => e.delta), ['one ', 'two ', 'three']);
  const lastText = ids(res)[all.findIndex(e => e.type === 'done') - 1];
  const rest = events(await getJson(t.ai, 'ann', '/collab/ai/resume?projectId=5&after=' + lastText));
  assert.deepStrictEqual(rest.map(e => e.type), ['done']);
});

test('Stop ends an answer that is still going, with no error shown', async () => {
  const t = setup([{paced: Infinity, gap: 15}], {idleMs: 5000, turnMs: 60000});
  const {res, finished} = startAnswer(t.ai, 'ann');
  await until(() => texts(events(res)).length >= 4);
  const stop = await getJson(t.ai, 'ann', '/collab/ai/stop', 'POST', {projectId: '5'});
  assert.deepStrictEqual(JSON.parse(stop.body), {ok: true, stopped: true});
  await finished;
  const evs = events(res);
  assert.strictEqual(evs.at(-1).type, 'done');
  assert.ok(!evs.some(e => e.type === 'error'));
});

test('an answer that nobody is watching any more is stopped after a while', async () => {
  const t = setup([{paced: Infinity, gap: 15}], {idleMs: 5000, turnMs: 60000, orphanMs: 60});
  const {res} = startAnswer(t.ai, 'ann');
  await until(() => texts(events(res)).length >= 4);
  drop(res);
  await until(() => t.ai.runs.get('u-ann|5').done);
  assert.strictEqual(t.calls[0].signal.aborted, true, 'the call to the model was cancelled');
});

test('a browser that comes back in time keeps the answer alive', async () => {
  const t = setup([{paced: 30, gap: 15}], {orphanMs: 120});
  const {res} = startAnswer(t.ai, 'ann');
  await until(() => texts(events(res)).length >= 4);
  const lastSeen = ids(res).pop();
  drop(res);
  await new Promise(r => setTimeout(r, 40));                        // away for a moment, less than orphanMs
  const again = await getJson(t.ai, 'ann', '/collab/ai/resume?projectId=5&after=' + lastSeen);
  assert.strictEqual(texts(events(res)) + texts(events(again)), WORDS(30));
  assert.ok(!events(again).some(e => e.type === 'error'));
});

test('a second request while an answer is running is refused, and a person cannot reach another person\'s answer', async () => {
  const t = setup([{paced: Infinity, gap: 15}], {idleMs: 5000, turnMs: 60000});
  const {res, finished} = startAnswer(t.ai, 'ann');
  await until(() => texts(events(res)).length >= 2);
  const second = await getJson(t.ai, 'ann', '/collab/ai/stream', 'POST', {projectId: '5', messages: [{role: 'user', content: 'again'}]});
  assert.strictEqual(second.status, 409);
  assert.match(JSON.parse(second.body).error, /still working/);
  assert.strictEqual((await getJson(t.ai, 'bob', '/collab/ai/resume?projectId=5&after=0')).status, 404, 'bob has no answer to resume');
  assert.strictEqual(JSON.parse((await getJson(t.ai, 'bob', '/collab/ai/stop', 'POST', {projectId: '5'})).body).stopped, false);
  assert.strictEqual(t.ai.activeRun('u-ann', '5').done, false, 'ann\'s answer is untouched');
  t.ai.activeRun('u-ann', '5').controller.abort();
  await finished;
});

test('the window is told whether an answer is running, and what was asked', async () => {
  const t = setup([{paced: Infinity, gap: 15}], {idleMs: 5000, turnMs: 60000});
  const idle = JSON.parse((await getJson(t.ai, 'ann', '/collab/ai/status?projectId=5')).body);
  assert.strictEqual(idle.running, false);
  const {res, finished} = startAnswer(t.ai, 'ann', 'build me a quiz');
  await until(() => texts(events(res)).length >= 2);
  const busy = JSON.parse((await getJson(t.ai, 'ann', '/collab/ai/status?projectId=5')).body);
  assert.deepStrictEqual([busy.running, busy.question], [true, 'build me a quiz']);
  t.ai.activeRun('u-ann', '5').controller.abort();
  await finished;
  assert.strictEqual(JSON.parse((await getJson(t.ai, 'ann', '/collab/ai/status?projectId=5')).body).running, false);
});

test('a quiet answer is kept awake by pings', async () => {
  const t = setup([{paced: 3, gap: 120}], {pingMs: 20});
  const {res, finished} = startAnswer(t.ai, 'ann');
  await finished;
  assert.ok(res.text.split('"type":"ping"').length - 1 >= 3, 'pings arrived between the words');
});

// ---- a model call that goes wrong for a moment is tried again, so a goal can carry on ----

test('a stalled model is tried again, what it had shown is taken back, and the answer completes', async () => {
  const t = setup([STALL, textTurn('All good.')], {idleMs: 40});
  const evs = await say(t.ai, 'ann', 'hi');
  const types = evs.map(e => e.type);
  assert.ok(types.indexOf('reset') > types.indexOf('text'), 'the partial text is taken back');
  assert.match(evs.find(e => e.type === 'status').text, /stopped responding; trying again \(2 of 3\)/);
  assert.ok(!evs.some(e => e.type === 'error'));
  assert.strictEqual(evs.filter(e => e.type === 'text').at(-1).delta, 'All good.');
  assert.strictEqual(t.calls.length, 2);
});

test('after three stalls in a row the helper gives up and says so', async () => {
  const t = setup([STALL, STALL, STALL, textTurn('never reached')], {idleMs: 30});
  const evs = await say(t.ai, 'ann', 'hi');
  assert.match(evs.find(e => e.type === 'error').message, /stopped sending its answer/);
  assert.strictEqual(t.calls.length, 3);
  assert.strictEqual(evs.at(-1).type, 'done');
});

test('an answer that ends without an ending is asked for again', async () => {
  const t = setup([{premature: [{choices: [{delta: {content: 'Let me'}}]}]}, textTurn('Done properly.')]);
  const evs = await say(t.ai, 'ann', 'hi');
  assert.ok(evs.some(e => e.type === 'reset'));
  assert.match(evs.find(e => e.type === 'status').text, /cut its answer short; trying again/);
  assert.ok(!evs.some(e => e.type === 'error'));
  assert.strictEqual(evs.filter(e => e.type === 'text').at(-1).delta, 'Done properly.');
});

test('a busy service is waited out; a refused key is not retried', async () => {
  const busy = setup([{status: 429}, textTurn('Here I am.')]);
  const evs = await say(busy.ai, 'ann', 'hi');
  assert.ok(!evs.some(e => e.type === 'error'));
  assert.strictEqual(texts(evs), 'Here I am.');
  const refused = setup([{status: 401}, textTurn('never reached')]);
  const bad = await say(refused.ai, 'ann', 'hi');
  assert.match(bad.find(e => e.type === 'error').message, /refused the key/);
  assert.strictEqual(refused.calls.length, 1);
});

test('stopping during a wait before a retry ends the answer without trying again', async () => {
  const t = setup([{status: 503}, textTurn('never reached')], {retryWaitMs: 5000});
  const {res, finished} = startAnswer(t.ai, 'ann');
  await until(() => events(res).some(e => e.type === 'status'));
  t.ai.activeRun('u-ann', '5').controller.abort();
  await finished;
  assert.strictEqual(t.calls.length, 1);
  assert.ok(!events(res).some(e => e.type === 'error'));
});

// ---- an answer that is too long for the model is cut off, and the helper is asked to write less ----

test('a tool call cut off by the length limit is not run; the model is asked to work in smaller pieces', async () => {
  const cut = [
    {choices: [{delta: {tool_calls: [{index: 0, id: 'w1', type: 'function', function: {name: 'draft_write', arguments: '{"path":"src/a/Screen1.bky","content":"<xml'}}]}}]},
    {choices: [{delta: {}, finish_reason: 'length'}]},
    '[DONE]',
  ];
  const t = setup([cut, textTurn('I will go step by step.')]);
  const evs = await say(t.ai, 'ann', 'write all the blocks');
  assert.ok(evs.some(e => e.type === 'tool' && e.id === 'w1' && e.state === 'error' && /too long/.test(e.detail)));
  assert.match(evs.find(e => e.type === 'status').text, /too long to finish in one go/);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing was written');
  const note = t.calls[1].payload.messages.at(-1);
  assert.strictEqual(note.role, 'user');
  assert.match(note.content, /cut off because it was too long/);
  assert.strictEqual(texts(evs), 'I will go step by step.');
});

const cutText = [
  {choices: [{delta: {content: 'A very long plan that never ends'}}]},
  {choices: [{delta: {}, finish_reason: 'length'}]},
  '[DONE]',
];

test('an answer cut off in plain words carries on in smaller pieces instead of giving up', async () => {
  const t = setup([cutText, textTurn('Done, in short.')]);
  const evs = await say(t.ai, 'ann', 'build it');
  assert.match(evs.find(e => e.type === 'status').text, /smaller pieces/);
  const note = t.calls[1].payload.messages.at(-1);
  assert.strictEqual(note.role, 'user');
  assert.match(note.content, /Do not repeat it/);
  assert.match(texts(evs), /Done, in short\./);
});

test('an answer that is cut off again and again is given up with a clear message', async () => {
  const t = setup([cutText, cutText, cutText, cutText, cutText, textTurn('never reached')]);
  const evs = await say(t.ai, 'ann', 'build it');
  assert.strictEqual(t.calls.length, 5);
  assert.ok(evs.some(e => e.type === 'status' && /paused/.test(e.text)));
});

test('a long tool call shows as it is written, so the window does not look stuck', async () => {
  const t = setup([toolTurn('draft_write', {path: 'src/a/Screen1.bky', content: 'x'.repeat(3000)}, 'big1'), textTurn('Written.')]);
  const evs = await say(t.ai, 'ann', 'write it');
  const writing = evs.find(e => e.type === 'tool' && e.id === 'big1' && /^Writing/.test(e.label));
  assert.ok(writing, 'a writing chip appeared');
  assert.match(writing.detail, /KB so far/);
  assert.strictEqual(evs.filter(e => e.type === 'tool' && e.id === 'big1').at(-1).state, 'done');
});

// ---- the log: what happened, never what was said ----

test('the log says what happened, and never what was said or the key', async () => {
  const lines = [];
  const t = setup([STALL, toolTurn('list_files', {}, 'L1'), textTurn('A secret answer.')], {idleMs: 30, log: m => lines.push(m)});
  await say(t.ai, 'ann', 'my private question');
  const log = lines.join('\n');
  assert.match(log, /ann asked/);
  assert.match(log, /stopped responding/);
  assert.match(log, /ann finished after \d+ s; 2 model answers, 1 tool calls/);
  assert.doesNotMatch(log, /private question|secret answer|sk-test/);
});

// The conversation is made shorter when it passes the room the model has: here a small room, so that a short
// conversation is enough. The first call is the model writing notes on the earlier steps; the answer then goes on
// from the notes.
test('a long conversation is summarised by the model when it passes the room, and the answer goes on from the notes', async () => {
  process.env.AI_CONTEXT_TOKENS = '30000';
  try {
    const t = setup([textTurn('NOTES: the person wants a quiz app with a score screen.'), textTurn('Here is the next step.')]);
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({role: 'user', content: 'question ' + i + ' ' + 'q'.repeat(2500)});
      if (i < 19) history.push({role: 'assistant', content: 'answer ' + i + ' ' + 'a'.repeat(2500)});
    }
    const res = fakeRes();
    await t.ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId: '5', messages: history}, 'AppInventor=ann'), res);
    const evs = events(res);
    assert.strictEqual(t.calls.length, 2, 'the notes, then the answer');
    assert.strictEqual(t.calls[0].payload.tools, undefined, 'the notes are written without tools');
    assert.match(texts(evs), /Here is the next step\./);
    assert.ok(evs.some(e => e.type === 'status' && /Making room/.test(e.text)), 'the person is told');
    const sent = t.calls[1].payload.messages;
    assert.match(JSON.stringify(sent), /NOTES: the person wants a quiz app/);
    assert.ok(JSON.stringify(sent).length < JSON.stringify(t.calls[0].payload.messages).length, 'what is sent is shorter');
    assert.strictEqual(sent[sent.length - 1].content, history[history.length - 1].content, 'the newest message is kept whole');
  } finally {
    delete process.env.AI_CONTEXT_TOKENS;
  }
});

test('if the notes cannot be written, the answer still goes on, and says that earlier steps were removed', async () => {
  process.env.AI_CONTEXT_TOKENS = '30000';
  try {
    const t = setup([{status: 500}, textTurn('Carrying on.')]);
    const history = [];
    for (let i = 0; i < 20; i++) history.push({role: i % 2 ? 'assistant' : 'user', content: 'message ' + i + ' ' + 'z'.repeat(2500)});
    history.push({role: 'user', content: 'what now?'});
    const res = fakeRes();
    await t.ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId: '5', messages: history}, 'AppInventor=ann'), res);
    assert.match(texts(events(res)), /Carrying on\./);
    assert.match(JSON.stringify(t.calls[1].payload.messages), /were removed to make room/);
  } finally {
    delete process.env.AI_CONTEXT_TOKENS;
  }
});

test('the helper hands a piece of the job to its one subagent: the default tier, on high reasoning; the person sees its steps but not its words', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'Set the label on Screen1 to Hello.'}, 'h1'),
    toolTurn('scm_set_property', {screen: 'Screen1', component: 'Label1', property: 'Text', value: 'Hello'}, 'c1'),
    textTurn('The label now says Hello.'),
    toolTurn('propose_draft', {summary: 'The label says Hello'}, 'p1'),
    textTurn('Press Apply to add it.'),
  ]);
  const evs = await say(t.ai, 'ann', 'change the label');
  assert.strictEqual(t.calls.length, 5);
  assert.strictEqual(t.calls[0].payload.reasoning, undefined, 'the helper itself is not sent a reasoning setting');
  assert.deepStrictEqual(t.calls[1].payload.reasoning, {effort: 'high'}, 'the subagent is sent high reasoning');
  assert.strictEqual(t.calls[1].payload.max_tokens, 32000, 'with room for its reasoning');
  assert.strictEqual(t.calls[1].payload.model, 'inclusionai/ling-3.1-flash', 'the default tier\'s model');
  assert.deepStrictEqual(t.calls[2].payload.reasoning, {effort: 'high'}, 'and so is each of its answers');
  assert.strictEqual(t.calls[3].payload.reasoning, undefined);
  assert.ok(!texts(evs).includes('The label now says Hello.'), "the subagent's words are not shown to the person");
  assert.ok(evs.some(e => e.type === 'tool' && e.name === 'scm_set_property' && e.state === 'done'), 'its steps are shown');
  assert.ok(evs.some(e => e.type === 'tool' && e.name === 'subagent' && e.state === 'done'), 'the hand-over is one step');
  assert.ok(evs.find(e => e.type === 'proposal'), 'the helper proposes the change the subagent made');
});

test('the subagent is not offered the tools that talk to the person or propose changes, and a subagent it asks for is refused', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'Check the project.'}, 'h1'),
    toolTurn('subagent', {task: 'Start another one.'}, 's1'),
    textTurn('Checked: no problems.'),
    textTurn('The project is fine.'),
  ]);
  await say(t.ai, 'ann', 'check the project');
  const helperTools = t.calls[0].payload.tools.map(x => x.function.name);
  const subTools = t.calls[1].payload.tools.map(x => x.function.name);
  assert.ok(helperTools.includes('subagent'), 'the helper has its subagent');
  for (const name of ['subagent', 'propose_draft', 'propose_change', 'ask_user', 'update_plan', 'view_picture']) {
    assert.ok(!subTools.includes(name), 'the subagent is not offered ' + name);
  }
  assert.ok(subTools.includes('check_project') && subTools.includes('scm_set_property'), 'the subagent has the project tools');
  const refused = t.calls[2].payload.messages.find(m => m.role === 'tool' && m.tool_call_id === 's1');
  assert.match(refused.content, /not available here/, 'a subagent asked for another one is refused');
});

test('reasoning a reasoning model sends with a tool call goes back with that call, as the service asks', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'Check the project.'}, 'h1'),
    [
      {choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'Check the screen ', index: 0}]}}]},
      {choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'first.', index: 0, signature: 'sig-1'}]}}]},
      {choices: [{delta: {tool_calls: [{index: 0, id: 's1', type: 'function', function: {name: 'check_project', arguments: '{}'}}]}}]},
      '[DONE]',
    ],
    textTurn('Checked: no problems.'),
    textTurn('The project is fine.'),
  ]);
  await say(t.ai, 'ann', 'check the project');
  const sent = t.calls[2].payload.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.deepStrictEqual(sent.reasoning_details, [{type: 'reasoning.text', text: 'Check the screen first.', index: 0, signature: 'sig-1'}]);
});

test('if the subagent cannot finish, the helper is told why and carries on without it; the person is not shown an error', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'Set the label.'}, 'h1'),
    {status: 500}, {status: 500}, {status: 500},
    textTurn('The subagent could not finish, so I stopped there.'),
  ]);
  const evs = await say(t.ai, 'ann', 'change the label');
  const told = t.calls[4].payload.messages.find(m => m.role === 'tool' && m.tool_call_id === 'h1');
  assert.match(told.content, /^The subagent could not finish: service answered 500/);
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown to the person');
  assert.match(texts(evs), /The subagent could not finish, so I stopped there\./);
});

// ---- models, run modes, reasoning and the subagent tiers ----

const sleep = ms => new Promise(r => setTimeout(r, ms));
// A model answer that asks for several tools at once: each call comes in its own piece of the stream.
const callsTurn = calls => [
  ...calls.map((c, i) => ({choices: [{delta: {tool_calls: [{index: i, id: c.id, type: 'function',
    function: {name: c.name, arguments: JSON.stringify(c.args || {})}}]}}]})),
  '[DONE]',
];
// An answer sent with the settings the browser sends with each message (preset, runMode, reasoning).
async function sayTuned(ai, who, text, fields = {}, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/stream', 'POST', Object.assign({projectId, messages: [{role: 'user', content: text}]}, fields),
    'AppInventor=' + who), res);
  return events(res);
}
const isSub = p => p.messages[0].content.startsWith('You are a subagent');
const taskOf = p => p.messages[1].content;
const toolMessages = p => p.messages.filter(m => m.role === 'tool');
const cardOf = (evs, id) => evs.filter(e => e.type === 'subagent' && e.id === id);
const statesOf = (evs, id) => cardOf(evs, id).map(e => e.state);
const MODEL_VARS = ['AI_MODEL_SMART', 'AI_MODEL_BALANCED', 'AI_MODEL_FAST', 'OPENROUTER_MODEL', 'AI_DAILY_LIMIT'];
const saveEnv = () => Object.fromEntries(MODEL_VARS.map(k => [k, process.env[k]]));
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('GET /collab/ai/presets: the models in order, the run modes, the defaults and the subagent tiers; signed-in people only', async () => {
  const t = setup([]);
  const saved = saveEnv();
  for (const k of ['AI_MODEL_SMART', 'AI_MODEL_BALANCED', 'AI_MODEL_FAST']) delete process.env[k];
  try {
    const res = await getJson(t.ai, 'ann', '/collab/ai/presets');
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.presets, [
      {id: 'smart', label: 'Smart', name: 'Claude Haiku 5.5', model: 'anthropic/claude-haiku-5.5',
        reasoningLevels: ['default', 'low', 'medium', 'high', 'max']},
      {id: 'balanced', label: 'Balanced', name: 'Ling 3.1 Flash', model: 'inclusionai/ling-3.1-flash',
        reasoningLevels: ['default', 'low', 'medium', 'high']},
      {id: 'fast', label: 'Fast', name: 'Ling 3 Flash', model: 'inclusionai/ling-3.0-flash',
        reasoningLevels: ['default', 'low', 'medium', 'high']},
    ]);
    assert.strictEqual(body.defaultPreset, 'balanced');
    assert.deepStrictEqual(body.runModes, [
      {id: 'normal', label: 'Normal', agents: 1}, {id: 'parallel', label: 'Parallel', agents: 2},
      {id: 'ultracode', label: 'Ultracode', agents: 3}]);
    assert.strictEqual(body.defaultRunMode, 'normal');
    assert.strictEqual(body.defaultReasoning, 'default');
    assert.deepStrictEqual(body.subagents.default, {name: 'Ling 3.1 Flash', model: 'inclusionai/ling-3.1-flash', reasoning: 'high'});
    assert.deepStrictEqual(body.subagents.smart, {name: 'Claude Haiku 5.5', model: 'anthropic/claude-haiku-5.5', reasoning: 'high',
      cooldownMinutes: 45, readyInSeconds: 0});
    t.ai.ask = async () => null;
    assert.strictEqual((await getJson(t.ai, 'ann', '/collab/ai/presets')).status, 401, 'signed-out visitors get nothing');
  } finally {
    restoreEnv(saved);
  }
});

test('the companion uses the model of its preset: an unknown or missing preset is balanced; AI_MODEL_* change only the model string; OPENROUTER_MODEL is not read', async () => {
  const t = setup([textTurn('a'), textTurn('b'), textTurn('c'), textTurn('d')]);
  const saved = saveEnv();
  try {
    process.env.OPENROUTER_MODEL = 'old/model';
    delete process.env.AI_MODEL_BALANCED;
    await sayTuned(t.ai, 'ann', 'hi');
    process.env.AI_MODEL_FAST = 'other/fast';
    await sayTuned(t.ai, 'ann', 'hi', {preset: 'fast'});
    await sayTuned(t.ai, 'ann', 'hi', {preset: 'smart'});
    await sayTuned(t.ai, 'ann', 'hi', {preset: 'turbo'});
    assert.deepStrictEqual(t.calls.map(c => c.payload.model),
      ['inclusionai/ling-3.1-flash', 'other/fast', 'some/smart', 'inclusionai/ling-3.1-flash']);
  } finally {
    restoreEnv(saved);
  }
});

test('pictures are offered by the model in use: smart takes them, balanced does not; the status check asks about the preset it is given', async () => {
  const models = [{id: 'some/smart', architecture: {input_modalities: ['text', 'image']}},
    {id: 'some/model', architecture: {input_modalities: ['text']}}];
  const t = setup([textTurn('a'), textTurn('b')], {models});
  await sayTuned(t.ai, 'ann', 'look', {preset: 'smart'});
  assert.ok(toolNames(t.calls[0]).includes('view_picture'));
  await sayTuned(t.ai, 'ann', 'look', {preset: 'balanced'});
  assert.ok(!toolNames(t.calls[1]).includes('view_picture'));
  const smart = JSON.parse((await getJson(t.ai, 'ann', '/collab/ai/status?projectId=5&preset=smart')).body);
  const balanced = JSON.parse((await getJson(t.ai, 'ann', '/collab/ai/status?projectId=5&preset=balanced')).body);
  assert.deepStrictEqual([smart.vision, balanced.vision], [true, false]);
});

test('run modes: normal runs one subagent at a time, parallel two and ultracode three; the rest wait in the order they were asked for', async () => {
  for (const [mode, cap] of [['normal', 1], ['parallel', 2], ['ultracode', 3], ['turbo', 1]]) {
    const t = setup(null, {respond: async p => {
      if (isSub(p)) {
        await sleep(15);
        return textTurn('Checked: ' + taskOf(p) + '.');
      }
      if (toolMessages(p).length) return textTurn('All three are checked.');
      return callsTurn([
        {id: 'a', name: 'subagent', args: {task: 'first'}},
        {id: 'b', name: 'subagent', args: {task: 'second', mode: 'smart'}},
        {id: 'c', name: 'subagent', args: {task: 'third'}},
      ]);
    }});
    const evs = await sayTuned(t.ai, 'ann', 'check three things', {runMode: mode});
    assert.deepStrictEqual(evs.filter(e => e.type === 'subagent' && e.state === 'running').map(e => e.id), ['a', 'b', 'c'],
      mode + ': started in the order asked');
    assert.deepStrictEqual(evs.filter(e => e.type === 'subagent' && e.state === 'queued').map(e => e.id), ['a', 'b', 'c'].slice(cap),
      mode + ': the rest are queued');
    let running = 0;
    let most = 0;
    for (const e of evs) {
      if (e.type !== 'subagent') continue;
      if (e.state === 'running') running++;
      if (e.state === 'done' || e.state === 'failed') running--;
      most = Math.max(most, running);
    }
    assert.strictEqual(most, cap, mode + ': no more than ' + cap + ' at once');
    const last = t.calls.filter(c => !isSub(c.payload) && toolMessages(c.payload).length).pop().payload;
    assert.deepStrictEqual(toolMessages(last).map(m => m.tool_call_id), ['a', 'b', 'c'], mode + ': the results come back in the order of the calls');
  }
});

test('the smart subagent is usable once in 45 minutes, for the whole team: a request inside that time is refused at once, with the minutes left', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'Check the layout.', mode: 'smart'}, 'h1'),
    textTurn('Report: the layout is fine.'),
    textTurn('The layout is fine.'),
    toolTurn('subagent', {task: 'Check the colours.', mode: 'smart'}, 'h2'),
    textTurn('The smart one is resting, so I did it myself.'),
  ]);
  const first = await say(t.ai, 'ann', 'check the layout');
  assert.strictEqual(t.calls[1].payload.model, 'anthropic/claude-haiku-5.5');
  assert.deepStrictEqual(first.filter(e => e.type === 'cooldown'), [{type: 'cooldown', smartReadyInSeconds: 2700}], 'the timer starts');
  t.advance(10 * 60 * 1000 + 30 * 1000);   // 34.5 minutes left: 35 when rounded up
  const second = await say(t.ai, 'bob', 'check the colours', '6');
  assert.strictEqual(t.calls.length, 5, 'the refused request calls no model');
  const refusal = toolMessages(t.calls[4].payload).find(m => m.tool_call_id === 'h2').content;
  assert.match(refusal, /another 35 minutes/);
  assert.match(refusal, /mode default/);
  assert.deepStrictEqual(second.filter(e => e.type === 'cooldown'), [{type: 'cooldown', smartReadyInSeconds: 2070}]);
  assert.strictEqual(cardOf(second, 'h2').length, 0, 'a refused request shows no card');
  const presets = JSON.parse((await getJson(t.ai, 'bob', '/collab/ai/presets')).body);
  assert.strictEqual(presets.subagents.smart.readyInSeconds, 2070, 'the same timer is shown to everyone');
});

test('after 45 minutes the smart subagent can be used again', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'one', mode: 'smart'}, 'h1'), textTurn('Report one.'), textTurn('One done.'),
    toolTurn('subagent', {task: 'two', mode: 'smart'}, 'h2'), textTurn('Report two.'), textTurn('Two done.'),
  ]);
  await say(t.ai, 'ann', 'first');
  t.advance(45 * 60 * 1000);
  await say(t.ai, 'ann', 'second');
  assert.strictEqual(t.calls.length, 6);
  assert.strictEqual(t.calls[4].payload.model, 'anthropic/claude-haiku-5.5');
});

test('the smart timer starts when a smart subagent starts running, not when it is queued; a second smart one that had to wait is refused', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      if (taskOf(p) === 'slow') await sleep(20);
      return textTurn('Report on ' + taskOf(p) + '.');
    }
    if (toolMessages(p).length) return textTurn('Done.');
    return callsTurn([
      {id: 'slow', name: 'subagent', args: {task: 'slow'}},
      {id: 's1', name: 'subagent', args: {task: 'first', mode: 'smart'}},
      {id: 's2', name: 'subagent', args: {task: 'second', mode: 'smart'}},
    ]);
  }});
  const evs = await say(t.ai, 'ann', 'three checks');
  const s1Running = evs.findIndex(e => e.type === 'subagent' && e.id === 's1' && e.state === 'running');
  assert.ok(s1Running > 0 && evs.findIndex(e => e.type === 'cooldown') > s1Running, 'the timer starts with s1');
  assert.deepStrictEqual(statesOf(evs, 's1'), ['queued', 'running', 'done']);
  assert.deepStrictEqual(statesOf(evs, 's2'), ['queued', 'failed']);
  assert.strictEqual(cardOf(evs, 's2').at(-1).detail, 'smart in 45 min');
  assert.deepStrictEqual(evs.filter(e => e.type === 'cooldown').map(e => e.smartReadyInSeconds), [2700, 2700]);
  const last = t.calls.filter(c => !isSub(c.payload) && toolMessages(c.payload).length).pop().payload;
  assert.match(toolMessages(last).find(m => m.tool_call_id === 's2').content, /another 45 minutes/);
});

test('subagent requests: the default tier on Ling 3.1 Flash and the smart tier on Claude Haiku 5.5, both with high reasoning and 32000 tokens', async () => {
  const t = setup([
    toolTurn('subagent', {task: 'one'}, 'h1'), textTurn('Report one.'),
    toolTurn('subagent', {task: 'two', mode: 'smart'}, 'h2'), textTurn('Report two.'),
    textTurn('Both done.'),
  ]);
  await say(t.ai, 'ann', 'two pieces');
  assert.strictEqual(t.calls[0].payload.max_tokens, 8000, 'the helper keeps its usual length');
  assert.strictEqual(t.calls[0].payload.reasoning, undefined);
  assert.strictEqual(t.calls[1].payload.model, 'inclusionai/ling-3.1-flash');
  assert.deepStrictEqual(t.calls[1].payload.reasoning, {effort: 'high'});
  assert.strictEqual(t.calls[1].payload.max_tokens, 32000);
  assert.strictEqual(t.calls[3].payload.model, 'anthropic/claude-haiku-5.5');
  assert.deepStrictEqual(t.calls[3].payload.reasoning, {effort: 'high'});
  assert.strictEqual(t.calls[3].payload.max_tokens, 32000);
});

test('the default subagent has no limit: no step or time cap, and its calls do not count against the questions', async () => {
  const saved = saveEnv();
  process.env.AI_DAILY_LIMIT = '1';
  let t;
  try {
    t = setup(null, {respond: async p => {
      if (isSub(p)) {
        t.advance(5 * 60 * 1000);   // five minutes a model answer: far past the old four-minute limit
        const n = toolMessages(p).length;
        if (n < 20) return toolTurn('read_file', {path: 'src/a/Screen1.scm', from: n + 1}, 'r' + n);
        return textTurn('Report on ' + taskOf(p) + '.');
      }
      if (toolMessages(p).length) return textTurn('All six are done.');
      return callsTurn([1, 2, 3, 4, 5, 6].map(k => ({id: 's' + k, name: 'subagent', args: {task: 'piece ' + k}})));
    }});
    const evs = await sayTuned(t.ai, 'ann', 'do six pieces', {runMode: 'ultracode'});
    assert.ok(!evs.some(e => e.type === 'error' || e.type === 'status'), 'nothing stops it');
    for (let k = 1; k <= 6; k++) assert.strictEqual(statesOf(evs, 's' + k).at(-1), 'done', 's' + k);
    assert.strictEqual(cardOf(evs, 's1').at(-1).steps, 21, 'twenty reads and a report');
    assert.match(texts(evs), /All six are done\./);
    assert.ok((await sayTuned(t.ai, 'ann', 'and again?')).some(e => e.type === 'error'),
      'the question limit still applies to the helper\'s own answers');
  } finally {
    restoreEnv(saved);
  }
});

const UNFINISHED = 'The subagent did not finish within 12 answers or 4 minutes. Ask again with a smaller piece of the job.';

test('a smart subagent makes twelve model answers at most: when a thirteenth would be needed, it stops and the helper is told to ask again', async () => {
  const t = setup(null, {respond: async p => {
    // The stub stops after 40 answers, so that a subagent without the limit ends the test with a failure, not a hang.
    if (isSub(p)) {
      if (toolMessages(p).length >= 40) return textTurn('Report.');
      return toolTurn('read_file', {path: 'src/a/Screen1.scm', from: toolMessages(p).length + 1}, 'r' + toolMessages(p).length);
    }
    if (toolMessages(p).length) return textTurn('It did not finish, so I will do the piece myself.');
    return toolTurn('subagent', {task: 'read the project a piece at a time', mode: 'smart'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'read it');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 12, 'twelve model answers, then it stops');
  assert.strictEqual(toolMessages(t.calls.at(-1).payload)[0].content, UNFINISHED);
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.state, card.detail, card.steps], ['failed', 'stopped', 12]);
  assert.match(texts(evs), /I will do the piece myself/);
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown');
});

test('a smart subagent stops once four minutes have passed on the clock, counted from when it starts running', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      if (toolMessages(p).length >= 40) return textTurn('Report.');   // so that a subagent without the limit ends, and fails
      t.advance(90 * 1000);   // each model answer takes 90 seconds on the clock
      return toolTurn('read_file', {path: 'src/a/Screen1.scm', from: toolMessages(p).length + 1}, 'r' + toolMessages(p).length);
    }
    if (toolMessages(p).length) return textTurn('It ran out of time, so I will do the piece myself.');
    return toolTurn('subagent', {task: 'read it slowly', mode: 'smart'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'read it');
  // The answers start at 0, 90 and 180 seconds. The one due at 270 seconds is not made: more than four minutes are up.
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 3, 'three answers, then it stops');
  assert.strictEqual(toolMessages(t.calls.at(-1).payload)[0].content, UNFINISHED);
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.state, card.detail, card.steps], ['failed', 'stopped', 3]);
  assert.match(texts(evs), /I will do the piece myself/);
});

test('a smart subagent\'s answer that starts a second before its deadline is cut off at the deadline, and the run ends with the stop text', async () => {
  // The second answer starts with one second of the four minutes left, and it never ends, so only the deadline can stop
  // it. turnMs (1.5 seconds) is a safety net only: if the deadline did not work, the answer would be cut off at turnMs,
  // and the test would fail on the wrong text rather than wait.
  const t = setup(null, {turnMs: 1500, respond: async p => {
    if (isSub(p)) {
      if (toolMessages(p).length === 0) {
        t.advance(239 * 1000);
        return toolTurn('read_file', {path: 'src/a/Screen1.scm', from: 1}, 'r0');
      }
      return {paced: Infinity, gap: 15};
    }
    if (toolMessages(p).length) return textTurn('I will do the piece myself.');
    return toolTurn('subagent', {task: 'read it', mode: 'smart'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'read it');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 2, 'two model answers: the second is cut off');
  assert.strictEqual(t.calls[1].payload.model, 'anthropic/claude-haiku-5.5');
  assert.strictEqual(t.calls[2].signal.aborted, true, 'the model call is cancelled at the deadline');
  assert.strictEqual(toolMessages(t.calls.at(-1).payload)[0].content, UNFINISHED);
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.state, card.detail, card.steps], ['failed', 'stopped', 2]);
  assert.match(texts(evs), /I will do the piece myself/);
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown');
});

test('a retry that would start after the deadline does not run: nothing is shown as trying again, and the run ends with the stop text', async () => {
  // The first try fails two seconds before the deadline. Its retry would wait five seconds, so it would start after the
  // deadline: it is not made, and the wait is not made either.
  let tries = 0;
  const t = setup(null, {retryWaitMs: 5000, respond: async p => {
    if (isSub(p)) {
      if (tries++ === 0) {
        t.advance(238 * 1000);
        return {status: 500, detail: 'busy'};
      }
      return textTurn('Report: fine.');
    }
    if (toolMessages(p).length) return textTurn('It did not finish, so I will do the piece myself.');
    return toolTurn('subagent', {task: 'check', mode: 'smart'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'check');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 1, 'the retry is not made');
  assert.strictEqual(toolMessages(t.calls.at(-1).payload)[0].content, UNFINISHED);
  assert.deepStrictEqual(statesOf(evs, 'h1'), ['running', 'failed']);
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.detail, card.steps], ['stopped', 1]);
  assert.ok(!evs.some(e => e.type === 'reset' || e.type === 'status'), 'nothing is shown as trying again');
  assert.match(texts(evs), /I will do the piece myself/);
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown');
});

test('a retry that would start before the deadline runs as usual', async () => {
  let tries = 0;
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      if (tries++ === 0) {
        t.advance(230 * 1000);   // the first try fails ten seconds before the deadline; its retry starts well before it
        return {status: 500, detail: 'busy'};
      }
      return textTurn('Report: fine.');
    }
    if (toolMessages(p).length) return textTurn('Checked.');
    return toolTurn('subagent', {task: 'check', mode: 'smart'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'check');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 2, 'the retry is made');
  assert.deepStrictEqual(statesOf(evs, 'h1'), ['running', 'resting', 'running', 'done']);
  assert.strictEqual(cardOf(evs, 'h1').at(-1).steps, 1);
  assert.strictEqual(texts(evs), 'Checked.');
});

test('a default run is not stopped by time: its answers go on past four minutes, and one begun after that is not cut off', async () => {
  // Each answer takes five minutes on the clock, so the default run is past four minutes from its second answer on, and its
  // last answer begins at fifteen minutes. turnMs is short, but it is not applied to the default tier.
  const t = setup(null, {turnMs: 50, respond: async p => {
    if (isSub(p)) {
      t.advance(5 * 60 * 1000);
      const n = toolMessages(p).length;
      if (n < 3) return toolTurn('read_file', {path: 'src/a/Screen1.scm', from: n + 1}, 'r' + n);
      return {paced: 6, gap: 80};
    }
    if (toolMessages(p).length) return textTurn('Checked.');
    return toolTurn('subagent', {task: 'read it all'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'read it');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 4, 'four answers, none of them stopped');
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.state, card.steps], ['done', 4]);
  assert.ok(!evs.some(e => e.type === 'status' || e.type === 'error'), 'nothing stops it');
  assert.strictEqual(texts(evs), 'Checked.');
});

test('the notes on earlier steps are a model call too: they end at the deadline of the run they are for', async () => {
  // The notes would take about two and a half seconds; the deadline is one second away.
  const t = setup([{paced: 30, gap: 80}]);
  await assert.rejects(t.ai.summarizeSteps('anthropic/claude-haiku-5.5', 'Person: read it', null, t.ai.now() + 1000));
  assert.strictEqual(t.calls[0].signal.aborted, true, 'the model call is cancelled at the deadline');
});

test('a default subagent is not stopped at twelve answers: it can make fifteen', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      const n = toolMessages(p).length;
      return n < 14 ? toolTurn('read_file', {path: 'src/a/Screen1.scm', from: n + 1}, 'r' + n) : textTurn('Read all of it.');
    }
    if (toolMessages(p).length) return textTurn('Checked.');
    return toolTurn('subagent', {task: 'read it all'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'read it');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 15, 'fifteen model answers');
  const card = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([card.state, card.steps], ['done', 15]);
  assert.ok(!evs.some(e => e.type === 'status' || e.type === 'error'), 'nothing stops it');
  assert.strictEqual(texts(evs), 'Checked.');
});

test('a subagent that repeats the same step is stopped with a clear message; the helper is told and carries on', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) return toolTurn('list_files', {}, 'L' + toolMessages(p).length);
    if (toolMessages(p).length) return textTurn('It stopped, so I will do the piece myself.');
    return toolTurn('subagent', {task: 'look around'}, 'h1');
  }});
  const evs = await say(t.ai, 'ann', 'look around');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 8, 'the same step eight times, then it stops');
  const told = toolMessages(t.calls.filter(c => !isSub(c.payload) && toolMessages(c.payload).length).pop().payload);
  assert.match(told[0].content, /kept repeating the same step/);
  assert.match(texts(evs), /I will do the piece myself/);
  assert.strictEqual(statesOf(evs, 'h1').at(-1), 'failed');
  assert.ok(!evs.some(e => e.type === 'status' && /repeating/.test(e.text)), 'the person is not told by the helper\'s own loop guard');
});

test('a subagent cut off by the length limit carries on in smaller pieces, and gives up after four cut-offs in a row', async () => {
  const one = setup([toolTurn('subagent', {task: 'write it'}, 'h1'), cutText, textTurn('Written in smaller pieces.'), textTurn('It is written.')]);
  const evs = await say(one.ai, 'ann', 'write it');
  assert.ok(evs.some(e => e.type === 'status' && e.sub === 'h1' && /smaller pieces/.test(e.text)), 'the person is told, with the subagent\'s id');
  assert.strictEqual(texts(evs), 'It is written.', 'the subagent\'s words are not shown');
  assert.strictEqual(one.calls.length, 4);
  assert.match(one.calls[2].payload.messages.at(-1).content, /Do not repeat it/);

  const many = setup([toolTurn('subagent', {task: 'write it'}, 'h1'), cutText, cutText, cutText, cutText, cutText, textTurn('It paused.')]);
  const evs2 = await say(many.ai, 'ann', 'write it');
  assert.strictEqual(many.calls.length, 7, 'five cut-off answers, then the helper is told');
  assert.match(toolMessages(many.calls[6].payload)[0].content, /paused/);
  assert.strictEqual(statesOf(evs2, 'h1').at(-1), 'failed');
});

test('Stop ends a running subagent at once, and one still waiting for its slot too', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) return {paced: Infinity, gap: 15};
    return callsTurn([{id: 'x', name: 'subagent', args: {task: 'forever'}}, {id: 'y', name: 'subagent', args: {task: 'waiting'}}]);
  }});
  const {res, finished} = startAnswer(t.ai, 'ann', 'go');
  await until(() => events(res).some(e => e.type === 'subagent' && e.id === 'x' && e.state === 'running'));
  const stop = await getJson(t.ai, 'ann', '/collab/ai/stop', 'POST', {projectId: '5'});
  assert.deepStrictEqual(JSON.parse(stop.body), {ok: true, stopped: true});
  await finished;
  const evs = events(res);
  assert.strictEqual(evs.at(-1).type, 'done');
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown');
  assert.deepStrictEqual(statesOf(evs, 'x').slice(-1), ['failed']);
  assert.deepStrictEqual(statesOf(evs, 'y'), ['queued', 'failed']);
  assert.strictEqual(t.calls[1].signal.aborted, true, 'the call to the model was cancelled');
});

test('Stop during one call of a subagent\'s step: the calls after it do not start, and the subagent ends at once', async () => {
  const t = setup(null, {respond: async p => {
    if (isSub(p)) return callsTurn([
      {id: 'd1', name: 'draft_replace', args: {path: 'src/a/Screen1.scm', old: 'Score', new: 'Goal'}},
      {id: 'd2', name: 'scm_set_property', args: {screen: 'Screen1', component: 'Label1', property: 'FontSize', value: '20'}},
      {id: 'd3', name: 'scm_set_property', args: {screen: 'Screen1', component: 'Label1', property: 'Visible', value: 'False'}},
    ]);
    return toolTurn('subagent', {task: 'Change the label.'}, 'h1');
  }});
  // Stop is pressed while the first call is loading the project, which is the first thing it does.
  const ask = t.ai.ask;
  let pressed = false;
  t.ai.ask = async (path, ...rest) => {
    if (path.startsWith('/ode/collab/bundle') && !pressed) {
      pressed = true;
      await getJson(t.ai, 'ann', '/collab/ai/stop', 'POST', {projectId: '5'});
    }
    return ask(path, ...rest);
  };
  const evs = await say(t.ai, 'ann', 'change the label');
  assert.ok(pressed, 'Stop was pressed during the first call');
  assert.strictEqual(t.calls.length, 2, 'no model call is made after Stop');
  assert.deepStrictEqual(statesOf(evs, 'h1'), ['running', 'failed']);
  assert.ok(!evs.some(e => e.type === 'tool' && (e.id === 'd2' || e.id === 'd3')), 'the calls after the first one do not start');
  assert.ok(!evs.some(e => e.type === 'error'), 'no error is shown');
  assert.strictEqual(evs.at(-1).type, 'done');
});

test('a default subagent has no time limit on one answer, so a long answer is not cut off; a smart one keeps the limit of an answer', async () => {
  // Each model answer here takes about 480 ms, and one answer may take 50 ms at most.
  const scripted = args => ({turnMs: 50, respond: async p => {
    if (isSub(p)) return {paced: 6, gap: 80};
    if (toolMessages(p).length) return textTurn('Checked.');
    return toolTurn('subagent', args, 'h1');
  }});
  const dflt = setup(null, scripted({task: 'write a long piece'}));
  const evs = await say(dflt.ai, 'ann', 'write it');
  assert.strictEqual(statesOf(evs, 'h1').at(-1), 'done', 'the default subagent finishes its long answer');
  assert.strictEqual(dflt.calls.filter(c => isSub(c.payload)).length, 1);
  assert.strictEqual(texts(evs), 'Checked.');

  const smart = setup(null, scripted({task: 'write a long piece', mode: 'smart'}));
  const evs2 = await say(smart.ai, 'ann', 'write it');
  assert.strictEqual(statesOf(evs2, 'h1').at(-1), 'failed', 'the smart subagent keeps the limit of one answer');
  assert.match(toolMessages(smart.calls[2].payload)[0].content, /^The subagent could not finish: That answer ran past the time limit/);
  assert.strictEqual(smart.calls.filter(c => isSub(c.payload)).length, 1, 'and it is not tried again');
});

test('a subagent whose model stalls is tried again: its card shows resting while it waits, and its status lines carry its id', async () => {
  const t = setup([toolTurn('subagent', {task: 'check'}, 'h1'), STALL, textTurn('Report: fine.'), textTurn('Checked.')], {idleMs: 40});
  const evs = await say(t.ai, 'ann', 'check');
  assert.deepStrictEqual(statesOf(evs, 'h1'), ['running', 'resting', 'running', 'done']);
  assert.ok(evs.some(e => e.type === 'status' && e.sub === 'h1' && /stopped responding; trying again/.test(e.text)));
  assert.deepStrictEqual(evs.filter(e => e.type === 'reset'), [{type: 'reset', sub: 'h1'}],
    'the stalled try is taken back, for this subagent only');
  assert.ok(!evs.some(e => e.type === 'error'), 'no error reaches the person');
  assert.strictEqual(texts(evs), 'Checked.');
});

test('a subagent whose first try fails is tried again: the reset names the subagent, and the helper\'s own words are not reset', async () => {
  const t = setup([toolTurn('subagent', {task: 'check'}, 'h1', 'Let me check. '), {status: 500, detail: 'busy'},
    textTurn('Report: fine.'), textTurn('Checked.')]);
  const evs = await say(t.ai, 'ann', 'check');
  assert.deepStrictEqual(evs.filter(e => e.type === 'reset'), [{type: 'reset', sub: 'h1'}],
    'the failed try is taken back, for this subagent only');
  assert.deepStrictEqual(statesOf(evs, 'h1'), ['running', 'resting', 'running', 'done']);
  assert.strictEqual(texts(evs), 'Let me check. Checked.', 'the helper\'s words before the subagent are still there');
  assert.strictEqual(t.calls.filter(c => isSub(c.payload)).length, 2, 'the subagent\'s model call is tried again');
  assert.ok(!evs.some(e => e.type === 'error'));
});

test('a report goes back to the helper as the tool result (up to 8000 characters); the card shows the first 2000, and the words are never the helper\'s', async () => {
  const t = setup([toolTurn('subagent', {task: 'T'.repeat(300)}, 'h1'), textTurn('R'.repeat(9000)), textTurn('Got it.')]);
  const evs = await say(t.ai, 'ann', 'report');
  const done = cardOf(evs, 'h1').at(-1);
  assert.deepStrictEqual([done.state, done.tier, done.model, done.name, done.reasoning],
    ['done', 'default', 'inclusionai/ling-3.1-flash', 'Ling 3.1 Flash', 'high']);
  assert.strictEqual(done.task.length, 200);
  assert.strictEqual(done.report.length, 2000);
  assert.strictEqual(done.steps, 1);
  assert.strictEqual(toolMessages(t.calls[2].payload)[0].content.length, 8000);
  assert.strictEqual(texts(evs), 'Got it.');
});

test('a subagent\'s tool steps carry its id; the helper\'s own tool steps and the subagent tool call itself do not', async () => {
  const t = setup([toolTurn('subagent', {task: 'check'}, 'h1'), toolTurn('check_project', {}, 'c1'), textTurn('No problems.'), textTurn('Checked.')]);
  const evs = await say(t.ai, 'ann', 'check');
  const steps = evs.filter(e => e.type === 'tool' && e.id === 'c1');
  assert.ok(steps.length >= 2 && steps.every(e => e.sub === 'h1'));
  const own = evs.filter(e => e.type === 'tool' && e.id === 'h1');
  assert.ok(own.length >= 2 && own.every(e => !('sub' in e)));
});

test('reasoning is shown as traces: a subagent\'s carry its id, the helper\'s do not, and neither is part of the text', async () => {
  const t = setup([
    [{choices: [{delta: {reasoning: 'Helper thinking. '}}]},
      {choices: [{delta: {tool_calls: [{index: 0, id: 'h1', type: 'function', function: {name: 'subagent', arguments: JSON.stringify({task: 'check'})}}]}}]},
      '[DONE]'],
    [{choices: [{delta: {reasoning: 'Checking the screen. '}}]},
      {choices: [{delta: {reasoning_details: [{type: 'reasoning.summary', summary: 'Then the labels.', index: 0}]}}]},
      {choices: [{delta: {content: 'Report text.'}}]}, '[DONE]'],
    textTurn('Checked.'),
  ]);
  const evs = await say(t.ai, 'ann', 'check');
  assert.strictEqual(evs.filter(e => e.type === 'reasoning' && e.sub === 'h1').map(e => e.delta).join(''), 'Checking the screen. Then the labels.');
  assert.strictEqual(evs.filter(e => e.type === 'reasoning' && !('sub' in e)).map(e => e.delta).join(''), 'Helper thinking. ');
  assert.strictEqual(texts(evs), 'Checked.');
});

test('two subagents changing the same screen at the same moment: both changes reach the proposal', async () => {
  let arrived = 0;
  let open;
  const together = new Promise(r => { open = r; });
  let helper = 0;
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      if (toolMessages(p).length) return textTurn('Added.');
      arrived++;
      if (arrived === 2) open();
      await together;   // both make their first change at the same moment
      return /Button/.test(taskOf(p))
        ? toolTurn('scm_add_component', {screen: 'Screen1', type: 'Button', name: 'Button1'}, 'w1')
        : toolTurn('scm_add_component', {screen: 'Screen1', type: 'Label', name: 'Label2'}, 'w2');
    }
    helper++;
    if (helper === 1) {
      return callsTurn([{id: 'a', name: 'subagent', args: {task: 'Add Button1 to Screen1.'}},
        {id: 'b', name: 'subagent', args: {task: 'Add Label2 to Screen1.'}}]);
    }
    if (helper === 2) return toolTurn('propose_draft', {summary: 'Adds a button and a label'}, 'pp');
    return textTurn('Press Apply.');
  }});
  const evs = await sayTuned(t.ai, 'ann', 'add two things', {runMode: 'parallel'});
  const proposal = evs.find(e => e.type === 'proposal');
  assert.ok(proposal, 'a proposal is made');
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  const written = JSON.parse(t.asked.find(a => a.path.startsWith('/ode/collab/writefiles')).body).files['src/a/Screen1.scm'];
  const obj = proj.parseScm(written);
  assert.ok(proj.findNode(obj, 'Button1') && proj.findNode(obj, 'Label2') && proj.findNode(obj, 'Label1'), 'no change was lost');
});

test('a proposal in the same step as a subagent waits for it, so the proposal includes what the subagent changed', async () => {
  let helper = 0;
  const t = setup(null, {respond: async p => {
    if (isSub(p)) {
      if (toolMessages(p).length) return textTurn('Font size set.');
      await sleep(20);   // the subagent takes a moment to make its change
      return toolTurn('scm_set_property', {screen: 'Screen1', component: 'Label1', property: 'FontSize', value: '20'}, 'f1');
    }
    helper++;
    if (helper === 1) return toolTurn('scm_set_property', {screen: 'Screen1', component: 'Label1', property: 'Text', value: 'Hello'}, 'p1');
    if (helper === 2) {
      return callsTurn([{id: 'a', name: 'subagent', args: {task: 'Set the font size of Label1 to 20.'}},
        {id: 'pp', name: 'propose_draft', args: {summary: 'Label1 says Hello, in size 20'}}]);
    }
    return textTurn('Press Apply.');
  }});
  const evs = await say(t.ai, 'ann', 'change the label');
  const proposal = evs.find(e => e.type === 'proposal');
  assert.ok(proposal, 'a proposal is made');
  assert.strictEqual((await apply(t.ai, 'ann', proposal.id)).status, 200);
  const written = JSON.parse(t.asked.find(a => a.path.startsWith('/ode/collab/writefiles')).body).files['src/a/Screen1.scm'];
  const label = proj.findNode(proj.parseScm(written), 'Label1').node;
  assert.deepStrictEqual([label.Text, label.FontSize], ['Hello', '20'], 'the change of the subagent is in the proposal');
});

test('a subagent is offered view_picture only when its model takes pictures, and a picture it asks for goes to it in a message of its own', async () => {
  const models = [{id: 'inclusionai/ling-3.1-flash', architecture: {input_modalities: ['text', 'image']}},
    {id: 'anthropic/claude-haiku-5.5', architecture: {input_modalities: ['text']}}];
  const t = setup([
    toolTurn('subagent', {task: 'look at the logo'}, 'h1'),
    toolTurn('view_picture', {path: 'assets/logo.png'}, 'v1'),
    textTurn('The logo is red.'),
    textTurn('Checked the logo.'),
    toolTurn('subagent', {task: 'look again', mode: 'smart'}, 'h2'),
    textTurn('Looked, without pictures.'),
    textTurn('Done.'),
  ], {models});
  await say(t.ai, 'ann', 'look at the logo');
  assert.ok(toolNames(t.calls[1]).includes('view_picture'), 'the default tier can look at pictures');
  const shown = t.calls[2].payload.messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.strictEqual(shown.content[1].type, 'image_url');
  await say(t.ai, 'ann', 'look again');
  assert.ok(!toolNames(t.calls[5]).includes('view_picture'), 'the smart tier cannot');
});

test('a subagent\'s conversation is kept within the room of its own model', async () => {
  const models = [{id: 'anthropic/claude-haiku-5.5', context_length: 100000, architecture: {input_modalities: ['text']}}];
  const files = Object.assign({}, PROJECT_FILES, {'src/a/Screen1.bky': bigBlocks(120)});
  let mode = 'smart';
  const t = setup(null, {files, models, respond: async p => {
    if (isSub(p)) {
      const n = toolMessages(p).length;
      if (n < 5) return toolTurn('read_file', {path: 'src/a/Screen1.bky', from: 1}, 'r' + n);
      return textTurn('Read it.');
    }
    if (toolMessages(p).length) return textTurn('Read.');
    return toolTurn('subagent', {task: 'read the blocks', mode}, 'h1');
  }});
  await say(t.ai, 'ann', 'read the blocks');
  const smartCalls = t.calls.filter(c => isSub(c.payload));
  assert.strictEqual(smartCalls.at(-1).payload.model, 'anthropic/claude-haiku-5.5');
  assert.match(JSON.stringify(smartCalls.at(-1).payload.messages), /shortened to keep the answer small/, 'the smaller room is used');
  mode = 'default';
  await say(t.ai, 'ann', 'read the blocks again');
  const defaultCalls = t.calls.filter(c => isSub(c.payload) && c.payload.model === 'inclusionai/ling-3.1-flash');
  assert.ok(defaultCalls.length >= 5);
  assert.doesNotMatch(JSON.stringify(defaultCalls.at(-1).payload.messages), /shortened to keep/, 'the default tier\'s room is not used up here');
});

test('the log says that a subagent started and how it ended, and never its task or its report', async () => {
  const lines = [];
  const t = setup([toolTurn('subagent', {task: 'private task words'}, 'h1'), textTurn('secret report words'), textTurn('Done.')],
    {log: m => lines.push(m)});
  await say(t.ai, 'ann', 'go');
  const log = lines.join('\n');
  assert.match(log, /a default subagent started/);
  assert.match(log, /a default subagent finished after 1 step\(s\)/);
  assert.doesNotMatch(log, /private task words|secret report words/);
});

// ---- the companion's reasoning ----

test('companion reasoning: smart with max is sent as effort max with 32000 tokens; default sends no reasoning key and keeps the usual length', async () => {
  const t = setup([textTurn('a'), textTurn('b')]);
  await sayTuned(t.ai, 'ann', 'hi', {preset: 'smart', reasoning: 'max'});
  assert.deepStrictEqual(t.calls[0].payload.reasoning, {effort: 'max'});
  assert.strictEqual(t.calls[0].payload.max_tokens, 32000);
  assert.strictEqual(t.calls[0].payload.model, 'some/smart');
  await sayTuned(t.ai, 'ann', 'hi', {reasoning: 'turbo'});
  assert.ok(!('reasoning' in t.calls[1].payload), 'no reasoning key');
  assert.strictEqual(t.calls[1].payload.max_tokens, 8000);
});

test('max is only for Claude Haiku 5.5: on any other preset it is high, and the person is told', async () => {
  const t = setup([textTurn('a')]);
  const evs = await sayTuned(t.ai, 'ann', 'hi', {preset: 'balanced', reasoning: 'max'});
  assert.deepStrictEqual(t.calls[0].payload.reasoning, {effort: 'high'});
  assert.strictEqual(t.calls[0].payload.max_tokens, 32000);
  assert.ok(evs.some(e => e.type === 'status' && e.text === 'Max reasoning is only for Claude Haiku 5.5, so high is used.'));
});

test('a max request the service refuses (a 400 about reasoning) is sent once more with high, and the person is told', async () => {
  const t = setup([{status: 400, detail: 'Invalid value for reasoning effort: max'}, textTurn('Answer with high.')]);
  const evs = await sayTuned(t.ai, 'ann', 'hi', {preset: 'smart', reasoning: 'max'});
  assert.deepStrictEqual(t.calls.map(c => c.payload.reasoning), [{effort: 'max'}, {effort: 'high'}]);
  assert.strictEqual(t.calls[1].payload.max_tokens, 32000);
  assert.ok(evs.some(e => e.type === 'status' && e.text === 'Max reasoning was not accepted for this model, so high was used.'));
  assert.strictEqual(texts(evs), 'Answer with high.');
  assert.ok(!evs.some(e => e.type === 'error'));
});

test('a 400 that does not mention effort or reasoning is not retried', async () => {
  const t = setup([{status: 400, detail: 'bad request'}, textTurn('never reached')]);
  const evs = await sayTuned(t.ai, 'ann', 'hi', {preset: 'smart', reasoning: 'max'});
  assert.strictEqual(t.calls.length, 1);
  assert.ok(evs.some(e => e.type === 'error'));
});

test('reasoning pieces come back with the tool calls in the helper\'s own loop too', async () => {
  const t = setup([
    [{choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'Look at the screen ', index: 0}]}}]},
      {choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'first.', index: 0, signature: 'sig-2'}]}}]},
      {choices: [{delta: {tool_calls: [{index: 0, id: 'r1', type: 'function', function: {name: 'list_files', arguments: '{}'}}]}}]},
      '[DONE]'],
    textTurn('Listed.'),
  ]);
  await sayTuned(t.ai, 'ann', 'what files?', {preset: 'smart', reasoning: 'high'});
  const sent = t.calls[1].payload.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.deepStrictEqual(sent.reasoning_details, [{type: 'reasoning.text', text: 'Look at the screen first.', index: 0, signature: 'sig-2'}]);
});

test('a subagent\'s tool results are capped at 60000 characters, as the helper\'s are', async () => {
  const files = Object.assign({}, PROJECT_FILES, {'src/a/Screen1.bky': bigBlocks(120)});
  const t = setup([
    toolTurn('subagent', {task: 'read it'}, 'h1'),
    toolTurn('read_file', {path: 'src/a/Screen1.bky', from: 1}, 'r1'),
    textTurn('Read.'),
    textTurn('Done.'),
  ], {files});
  await say(t.ai, 'ann', 'read it');
  const result = toolMessages(t.calls[2].payload).find(m => m.tool_call_id === 'r1');
  assert.ok(result.content.length <= 60000 && result.content.length > 50000, 'the result is cut to 60000 characters: ' + result.content.length);
});

test('every model call is sized for the model it sends: its room is that model\'s, and the compactor is given the max_tokens of the request', async () => {
  const compactor = require('../ai-context');
  const real = compactor.compactContext;
  let given = [];   // what the compactor was told at each step of the answer: its window and its maxOutput
  compactor.compactContext = (messages, opts) => {
    given.push({window: opts.window, maxOutput: opts.maxOutput});
    return real(messages, opts);
  };
  // Runs one answer. Each room asked for (contextWindow) is kept with the model it was asked for.
  const run = async (script, options, send) => {
    const t = setup(script, options);
    const roomOf = t.ai.contextWindow.bind(t.ai);
    const asked = [];
    t.ai.contextWindow = async model => {
      const window = await roomOf(model);
      asked.push({model, window});
      return window;
    };
    given = [];
    await send(t);
    return {t, asked, given};
  };
  // Each model call comes right after the step's room was asked for, and the compactor is told the same length it sends.
  const sized = ({t, asked, given: told}) => {
    assert.deepStrictEqual(asked.map(a => a.model), t.calls.map(c => c.payload.model), 'the room is asked for the model that is sent');
    assert.deepStrictEqual(told.map(g => g.window), asked.map(a => a.window), 'the compactor uses the room that was asked for');
    assert.deepStrictEqual(told.map(g => g.maxOutput), t.calls.map(c => c.payload.max_tokens), 'the compactor gets the max_tokens sent');
  };
  try {
    const plain = await run([textTurn('a')], {}, t => sayTuned(t.ai, 'ann', 'hi', {}));
    sized(plain);
    assert.deepStrictEqual(plain.t.calls.map(c => c.payload.max_tokens), [8000], 'the companion without reasoning: 8000');

    const reasoning = await run([textTurn('b')], {}, t => sayTuned(t.ai, 'ann', 'hi', {preset: 'smart', reasoning: 'high'}));
    sized(reasoning);
    assert.deepStrictEqual(reasoning.t.calls.map(c => c.payload.max_tokens), [32000], 'the companion with reasoning: 32000');

    const refused = await run([{status: 400, detail: 'Invalid value for reasoning effort: max'}, textTurn('c')], {},
      t => sayTuned(t.ai, 'ann', 'hi', {preset: 'smart', reasoning: 'max'}));
    assert.deepStrictEqual(refused.t.calls.map(c => c.payload.max_tokens), [32000, 32000], 'max, then high, both with 32000');
    assert.deepStrictEqual(refused.given.map(g => g.maxOutput), [32000], 'the compactor was told the same length');
    assert.deepStrictEqual(refused.asked.map(a => a.model), ['some/smart']);

    const subs = await run([
      toolTurn('subagent', {task: 'one'}, 'h1'), textTurn('Report one.'),
      toolTurn('subagent', {task: 'two', mode: 'smart'}, 'h2'), textTurn('Report two.'),
      textTurn('Both done.'),
    ], {}, t => sayTuned(t.ai, 'ann', 'two pieces'));
    sized(subs);
    const [, defaultSub, , smartSub] = subs.asked;
    assert.deepStrictEqual([defaultSub.model, defaultSub.window], ['inclusionai/ling-3.1-flash', 262144], 'the default subagent: Ling, 256K');
    assert.deepStrictEqual([smartSub.model, smartSub.window], ['anthropic/claude-haiku-5.5', 1000000], 'the smart subagent: Claude 5, 1M');
    assert.deepStrictEqual(subs.t.calls.filter(c => isSub(c.payload)).map(c => c.payload.max_tokens), [32000, 32000], 'subagents: 32000');
  } finally {
    compactor.compactContext = real;
  }
});
