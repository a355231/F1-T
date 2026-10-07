'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {execFileSync} = require('node:child_process');
const {Assistant, toolsFor} = require('../ai');
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
const events = res => res.text.split('\n\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5)));

function setup(script, options = {}) {
  process.env.OPENROUTER_API_KEY = 'sk-test';
  process.env.OPENROUTER_MODEL = 'some/model';
  process.env.AI_OVERRIDE_PIN = PIN_VALUE;
  delete process.env.BRAVE_API_KEY;
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
    if (path.startsWith('/ode/collab/files')) return {files: [{path: 'src/a/Screen1.scm', bytes: 10}]};
    if (path.startsWith('/ode/collab/file?')) return {text: 'file text', bytes: 9};
    if (path.startsWith('/ode/collab/writefiles') || path.startsWith('/ode/collab/writemedia')) return {ok: true};
    return null;
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({url, headers: opts.headers, payload: JSON.parse(opts.body), signal: opts.signal});
    const next = script.shift();
    // A script step may be a function of the request, so that it can use ids the tools just made.
    const turn = typeof next === 'function' ? next(JSON.parse(opts.body)) : (next || textTurn('(no more script)'));
    return {ok: true, body: sseBody(turn)};
  };
  const ai = new Assistant(Object.assign({ask, hub, fetchImpl, now: () => now}, options));
  return {ai, asked, calls, hub, advance: ms => { now += ms; }};
}

async function say(ai, who, text, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/stream', 'POST', {projectId, messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return events(res);
}
async function apply(ai, who, id, projectId = '5') {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId, id}, 'AppInventor=' + who), res);
  return res;
}
const systemOf = call => call.payload.messages[0].content;
const texts = evs => evs.filter(e => e.type === 'text').map(e => e.delta).join('');

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
  const t = setup([toolTurn('read_file', {path: 'src/a/Screen1.scm'}, 'call_9', 'Let me look. '), textTurn('All fine.')]);
  const evs = await say(t.ai, 'ann', 'what is in here?');
  assert.strictEqual(texts(evs), 'Let me look. All fine.');
  const toolEvents = evs.filter(e => e.type === 'tool');
  assert.deepStrictEqual(toolEvents.map(e => e.state), ['running', 'done']);
  assert.strictEqual(toolEvents[0].name, 'read_file');
  assert.strictEqual(toolEvents[0].label, 'Reading Screen1.scm');
  assert.ok(t.calls[1].payload.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_9' && m.content === 'file text'));
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
  const failed = evs.find(e => e.type === 'tool' && e.state === 'error');
  assert.match(failed.detail, /propose 1 to 3/);
});

const idOf = (payload, kind) => {
  const text = payload.messages.map(m => m.content || '').join('\n');
  const m = new RegExp('id (' + kind + '_[0-9a-f]+)').exec(text);
  return m ? m[1] : 'missing';
};

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
  assert.match(evs.find(e => e.type === 'tool' && e.state === 'error').detail, /not allowed/);
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

test('a picture name that is not a PNG or JPG name is refused', async () => {
  const t = setup([toolTurn('propose_change', {summary: 'x', media: [{name: '../evil.svg', picture_id: 'nope'}]}), textTurn('Sorry.')]);
  const evs = await say(t.ai, 'ann', 'add a file');
  assert.match(evs.find(e => e.type === 'tool' && e.state === 'error').detail, /picture names/);
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
  assert.ok(toolsFor({full: false, search: false, goal: true}).some(x => x.function.name === 'update_plan'));
  assert.ok(!toolsFor({full: false, search: false, goal: false}).some(x => x.function.name === 'update_plan'));
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
  assert.ok(t.calls[0].payload.tools.some(x => x.function.name === 'web_search'));
  assert.strictEqual(evs.find(e => e.type === 'tool' && e.name === 'web_search' && e.state === 'done').detail, '1 results');
  assert.ok(toolsFor({full: false, search: false, goal: false}).every(x => x.function.name !== 'web_search'));
});

test('applying a full-app change sends the header that allows it; a small change does not', async () => {
  const t = setup([
    toolTurn('propose_change', {summary: 'New screen', files: {'src/a/Screen2.scm': '#|', 'src/a/Screen2.bky': '<xml/>'}}), textTurn('Press Apply.'),
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
  const t = setup([toolTurn('propose_change', {summary: 'New screen', files: {'src/a/Screen2.scm': '#|', 'src/a/Screen2.bky': '<xml/>'}}), textTurn('Press Apply.')]);
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
