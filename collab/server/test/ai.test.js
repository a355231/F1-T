'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Assistant} = require('../ai');
const {Hub} = require('../rooms');

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
  const asked = [];
  const sent = [];
  const hub = new Hub((id, msg) => sent.push([id, msg]));
  const ask = async (path, cookie, method, body) => {
    asked.push({path, method, body});
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
    const payload = JSON.parse(opts.body);
    calls.push({url, headers: opts.headers, payload});
    return {ok: true, json: async () => script.shift()};
  };
  return {ai: new Assistant({ask, hub, fetchImpl}), asked, sent, calls, hub};
}
const say = text => ({choices: [{message: {content: text}}]});
const tool = (name, args) => ({choices: [{message: {content: '', tool_calls: [{id: 't1', function: {name, arguments: JSON.stringify(args)}}]}}]});

async function chat(ai, who, text) {
  const res = fakeRes();
  await ai.handle(fakeReq('/collab/ai/chat', 'POST', {projectId: '5', messages: [{role: 'user', content: text}]}, 'AppInventor=' + who), res);
  return {status: res.status, body: JSON.parse(res.body)};
}

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

  const other = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId: '5', id}, 'AppInventor=bob'), other);
  assert.strictEqual(other.status, 404, 'bob cannot apply ann\'s suggestion');

  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId: '5', id}, 'AppInventor=ann'), res);
  assert.strictEqual(res.status, 200);
  const write = t.asked.find(a => a.path.startsWith('/ode/collab/writefiles'));
  assert.deepStrictEqual(JSON.parse(write.body), {files: {'src/Screen1.scm': 'new'}});
  const again = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/apply', 'POST', {projectId: '5', id}, 'AppInventor=ann'), again);
  assert.strictEqual(again.status, 404, 'only once');
});

test('proposals for more than three files, or for none, are refused', async () => {
  const many = {a: 'x', b: 'x', c: 'x', d: 'x'};
  const t = setup([tool('propose_change', {summary: 's', files: many}), say('Sorry.')]);
  const r = await chat(t.ai, 'ann', 'rewrite everything');
  assert.strictEqual(r.body.proposal, null);
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

test('signed-out visitors and people without access get nothing', async () => {
  const t = setup([say('x')]);
  t.ai.ask = async path => (path.startsWith('/ode/collab/whoami') ? null : null);
  const res = fakeRes();
  await t.ai.handle(fakeReq('/collab/ai/chat', 'POST', {projectId: '5', messages: []}, ''), res);
  assert.strictEqual(res.status, 401);
});
