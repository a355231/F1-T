'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Assistant} = require('../ai');
const {Hub} = require('../rooms');

// A test value only: the real PIN is set on the Pi (set-ai.sh --pin) and never goes in the source.
const PIN_VALUE = 'test-pin-42';
const HOUR = 60 * 60 * 1000;

function fakeRes() {
  const res = {status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b; }};
  return res;
}
function fakeReq(url, method, body, cookie = 'AppInventor=ann') {
  const req = {url, method, headers: {cookie}};
  req[Symbol.asyncIterator] = async function* () { if (body) yield JSON.stringify(body); };
  return req;
}

function setup(script) {
  process.env.OPENROUTER_API_KEY = 'sk-test';
  process.env.OPENROUTER_MODEL = 'some/model';
  process.env.AI_OVERRIDE_PIN = PIN_VALUE;
  let now = 1000000000000;
  const asked = [];
  const sent = [];
  const hub = new Hub((id, msg) => sent.push([id, msg]));
  const ask = async (path, cookie, method, body, headers) => {
    asked.push({path, method, body, headers});
    if (path.startsWith('/ode/collab/whoami')) {
      const name = /AppInventor=(\w+)/.exec(cookie)[1];
      return {userId: 'u-' + name, email: name + '@team.local'};
    }
    if (path.startsWith('/ode/collab/access')) return {ok: true, projectName: 'Pong'};
    if (path.startsWith('/ode/collab/files')) return {files: [{path: 'src/Screen1.scm', bytes: 10}]};
    if (path.startsWith('/ode/collab/file?')) return {text: 'file text', bytes: 9};
    if (path.startsWith('/ode/collab/writefiles')) return {ok: true};
    return null;
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({url, headers: opts.headers, payload: JSON.parse(opts.body)});
    return {ok: true, json: async () => script.shift()};
  };
  const ai = new Assistant({ask, hub, fetchImpl, now: () => now});
  return {ai, asked, sent, calls, hub, advance: ms => { now += ms; }};
}
const say = text => ({choices: [{message: {content: text}}]});
const tool = (name, args) => ({choices: [{message: {content: '', tool_calls: [{id: 't1', function: {name, arguments: JSON.stringify(args)}}]}}]});

async function chat(ai, who, text, messages) {
  const res = fakeRes();
  const list = messages || [{role: 'user', content: text}];
  await ai.handle(fakeReq('/collab/ai/chat', 'POST', {projectId: '5', messages: list}, 'AppInventor=' + who), res);
  return {status: res.status, body: JSON.parse(res.body)};
}
async function apply(ai, who, id) {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId: '5', id}, 'AppInventor=' + who), res);
  return res;
}
const systemOf = call => call.payload.messages[0].content;

test('without a key and model the helper says it is not set up and calls nobody', async () => {
  const t = setup([]);
  delete process.env.OPENROUTER_API_KEY;
  const r = await chat(t.ai, 'ann', 'hi');
  assert.match(r.body.reply, /not set up/);
  assert.strictEqual(t.calls.length, 0);
});

test('it reads the project through tools, then answers, using the key and model from the environment', async () => {
  const t = setup([tool('list_files', {}), tool('read_file', {path: 'src/Screen1.scm'}), say('All fine.')]);
  const r = await chat(t.ai, 'ann', 'what is in here?');
  assert.strictEqual(r.body.reply, 'All fine.');
  assert.strictEqual(t.calls.length, 3);
  assert.strictEqual(t.calls[0].headers.authorization, 'Bearer sk-test');
  assert.strictEqual(t.calls[0].payload.model, 'some/model');
  assert.ok(t.calls[2].payload.messages.some(m => m.role === 'tool' && m.content === 'file text'));
  assert.doesNotMatch(JSON.stringify(t.calls[0].payload.messages), /sk-test/, 'the key is never shown to the model');
});

test('a proposal is applied only by the person who got it, once, through the size-checked endpoint', async () => {
  const t = setup([tool('propose_change', {summary: 'Rename a label', files: {'src/Screen1.scm': 'new'}}), say('Press Apply.')]);
  const r = await chat(t.ai, 'ann', 'fix it');
  const id = r.body.proposal.id;
  assert.deepStrictEqual(r.body.proposal.files, ['src/Screen1.scm']);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing is written yet');

  const other = await apply(t.ai, 'bob', id);
  assert.strictEqual(other.status, 404, 'bob cannot apply ann\'s suggestion');

  const res = await apply(t.ai, 'ann', id);
  assert.strictEqual(res.status, 200);
  const write = t.asked.find(a => a.path.startsWith('/ode/collab/writefiles'));
  assert.deepStrictEqual(JSON.parse(write.body), {files: {'src/Screen1.scm': 'new'}});
  const again = await apply(t.ai, 'ann', id);
  assert.strictEqual(again.status, 404, 'only once');
});

test('small changes stop at three files', async () => {
  const four = {'a.scm': 'x', 'b.scm': 'x', 'c.bky': 'x', 'd.bky': 'x'};
  const t = setup([tool('propose_change', {summary: 's', files: four}), say('Sorry.')]);
  const r = await chat(t.ai, 'ann', 'rewrite everything');
  assert.strictEqual(r.body.proposal, null);
});

test('a wrong PIN changes nothing, and the model never hears about it', async () => {
  const t = setup([]);
  const r = await chat(t.ai, 'ann', '/override 00000');
  assert.strictEqual(r.body.reply, 'Wrong PIN.');
  assert.strictEqual(t.calls.length, 0);
  assert.ok(!JSON.stringify(t.asked).includes('00000'));
  assert.match((await chat(t.ai, 'ann', '/override')).body.reply, /Full-app mode is off/);
});

test('the right PIN turns on full-app mode for that person and project, for an hour, and no more', async () => {
  const t = setup([say('one'), say('two'), say('three')]);
  const on = await chat(t.ai, 'ann', '/override ' + PIN_VALUE);
  assert.match(on.body.reply, /Full-app mode is on in this project until/);
  assert.doesNotMatch(JSON.stringify(on.body), new RegExp(PIN_VALUE));

  await chat(t.ai, 'ann', 'build me a quiz app');
  assert.match(systemOf(t.calls[0]), /FULL-APP MODE/);
  assert.doesNotMatch(JSON.stringify(t.calls), new RegExp(PIN_VALUE), 'the PIN never reaches the model');

  await chat(t.ai, 'bob', 'build me a quiz app');
  assert.doesNotMatch(systemOf(t.calls[1]), /FULL-APP MODE/, 'bob did not enter the PIN');

  t.advance(HOUR + 60000);
  await chat(t.ai, 'ann', 'and now?');
  assert.doesNotMatch(systemOf(t.calls[2]), /FULL-APP MODE/, 'the hour is over');
});

test('commands never reach the model, even when they are in the earlier messages', async () => {
  const t = setup([say('ok')]);
  await chat(t.ai, 'ann', 'hi', [
    {role: 'user', content: '/override ' + PIN_VALUE},
    {role: 'assistant', content: 'Full-app mode is on.'},
    {role: 'user', content: 'hi'},
  ]);
  assert.doesNotMatch(JSON.stringify(t.calls), new RegExp(PIN_VALUE));
  assert.ok(!t.calls[0].payload.messages.some(m => /^\/override/.test(m.content || '')));
});

test('after a few wrong PINs from anyone, nobody can try for 15 minutes', async () => {
  const t = setup([]);
  for (const who of ['ann', 'bob', 'cal', 'dee', 'eve']) {
    assert.strictEqual((await chat(t.ai, who, '/override 00000')).body.reply, 'Wrong PIN.');
  }
  assert.match((await chat(t.ai, 'fay', '/override ' + PIN_VALUE)).body.reply, /Too many wrong PINs/);
  t.advance(16 * 60 * 1000);
  assert.match((await chat(t.ai, 'fay', '/override ' + PIN_VALUE)).body.reply, /Full-app mode is on/);
});

test('full-app mode allows twelve files and new screens; small mode does not', async () => {
  const files = {'src/a/Screen2.scm': '#|', 'src/a/Screen2.bky': '<xml/>', 'src/a/Screen3.scm': '#|',
    'src/a/Screen3.bky': '<xml/>'};
  const t = setup([tool('propose_change', {summary: 'Two new screens', files}), say('Press Apply.')]);
  await chat(t.ai, 'ann', '/override ' + PIN_VALUE);
  const r = await chat(t.ai, 'ann', 'build a two screen app');
  assert.deepStrictEqual(r.body.proposal.files, Object.keys(files));

  const small = setup([tool('propose_change', {summary: 'Two new screens', files}), say('Sorry.')]);
  const s = await chat(small.ai, 'bob', 'build a two screen app');
  assert.strictEqual(s.body.proposal, null);
  assert.match(JSON.stringify(small.calls[1].payload.messages), /propose 1 to 3/);
});

test('applying a full-app change sends the header that allows it; a small change does not', async () => {
  const t = setup([
    tool('propose_change', {summary: 'New screen', files: {'src/x/Screen2.scm': '#|', 'src/x/Screen2.bky': '<xml/>'}}), say('Press Apply.'),
    tool('propose_change', {summary: 'Small', files: {'src/x/Screen1.scm': 'y'}}), say('Press Apply.'),
  ]);
  await chat(t.ai, 'ann', '/override ' + PIN_VALUE);
  const full = await chat(t.ai, 'ann', 'add a screen');
  const small = await chat(t.ai, 'bob', 'fix the label');

  assert.strictEqual((await apply(t.ai, 'ann', full.body.proposal.id)).status, 200);
  const wa = t.asked.filter(x => x.path.startsWith('/ode/collab/writefiles')).pop();
  assert.deepStrictEqual(wa.headers, {'x-collab-ai-mode': 'full'});

  assert.strictEqual((await apply(t.ai, 'bob', small.body.proposal.id)).status, 200);
  const wb = t.asked.filter(x => x.path.startsWith('/ode/collab/writefiles')).pop();
  assert.deepStrictEqual(wb.headers, {});
});

test('a full-app change is refused if full-app mode was turned off before pressing Apply', async () => {
  const t = setup([tool('propose_change', {summary: 'New screen', files: {'src/x/Screen2.scm': '#|', 'src/x/Screen2.bky': '<xml/>'}}), say('Press Apply.')]);
  await chat(t.ai, 'ann', '/override ' + PIN_VALUE);
  const r = await chat(t.ai, 'ann', 'add a screen');
  await chat(t.ai, 'ann', '/override off');
  const res = await apply(t.ai, 'ann', r.body.proposal.id);
  assert.strictEqual(res.status, 403);
  assert.ok(!t.asked.some(a => a.path.startsWith('/ode/collab/writefiles')), 'nothing was written');
});

test('questions are rate limited per person', async () => {
  const script = [];
  for (let i = 0; i < 20; i++) script.push(say('ok'));
  const t = setup(script);
  let limited = 0;
  for (let i = 0; i < 15; i++) if ((await chat(t.ai, 'ann', 'q')).status === 429) limited++;
  assert.ok(limited >= 3, 'limited ' + limited);
  assert.strictEqual((await chat(t.ai, 'bob', 'q')).status, 200, 'bob is not affected');
});

test('with no PIN set, the override says full-app mode is not set up', async () => {
  const t = setup([]);
  delete process.env.AI_OVERRIDE_PIN;
  const r = await chat(t.ai, 'ann', '/override ' + PIN_VALUE);
  assert.match(r.body.reply, /not set up/);
});

test('signed-out visitors and people without access get nothing', async () => {
  const t = setup([say('x')]);
  t.ai.ask = async () => null;
  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/chat', 'POST', {projectId: '5', messages: []}, ''), res);
  assert.strictEqual(res.status, 401);
});
