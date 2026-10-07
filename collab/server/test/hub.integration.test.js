'use strict';

// Starts the real hub.js against a stand-in for App Inventor and talks to it over WebSockets, so
// that every message type the browsers send is exercised through the transport code too.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const WebSocket = require('ws');

let upstream, hubProcess, hubPort, lastCodeChange;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test.before(async () => {
  lastCodeChange = {at: 0, by: '', signedOut: false};
  // The stand-in's cookie is just "AppInventor=<name>"; "AppInventor=gone" is a signed-out login.
  upstream = http.createServer((req, res) => {
    const name = (/AppInventor=([a-z0-9]+)/.exec(req.headers.cookie || '') || [])[1];
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (!name || name === 'gone') {
      res.statusCode = 412;
      return res.end('{}');
    }
    if (url.pathname === '/ode/collab/whoami') {
      return res.end(JSON.stringify({userId: 'u-' + name, email: name + '@team.local'}));
    }
    if (url.pathname === '/ode/collab/access') {
      return res.end(JSON.stringify({ok: true, projectName: 'Pong', ownerEmail: 'ann@team.local'}));
    }
    if (url.pathname === '/ode/collab/lastcodechange') {
      return res.end(JSON.stringify(lastCodeChange));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  hubPort = 20000 + Math.floor(Math.random() * 20000);
  hubProcess = spawn('node', [path.join(__dirname, '..', 'hub.js')], {
    env: Object.assign({}, process.env, {PORT: String(hubPort), HOST: '127.0.0.1',
      AI_UPSTREAM: 'http://127.0.0.1:' + upstreamPort}),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    hubProcess.stdout.on('data', d => String(d).includes('collaboration hub') && resolve());
    hubProcess.on('exit', code => reject(new Error('hub exited with ' + code)));
  });
});

test.after(() => {
  hubProcess.kill();
  upstream.close();
});

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + hubPort + '/collab/ws', {headers: {cookie: 'AppInventor=' + name}});
    const got = [];
    ws.on('message', d => got.push(JSON.parse(d)));
    ws.on('unexpected-response', (req, res) => reject(new Error('rejected ' + res.statusCode)));
    ws.on('error', reject);
    ws.on('open', () => resolve({ws, got, name,
      send: m => ws.send(JSON.stringify(m)),
      has: (t, pred = () => true) => got.some(m => m.t === t && pred(m)),
      last: t => got.filter(m => m.t === t).pop()}));
  });
}

async function until(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

test('people who are not signed in cannot connect', async () => {
  await assert.rejects(connect('gone'), /rejected 401/);
});

test('join, edits, cursors, presence and companion state all reach the other person', async () => {
  const ann = await connect('ann');
  const bob = await connect('bob' + Date.now().toString(36));
  assert.ok(await until(() => ann.has('hello') && bob.has('hello')));

  ann.send({t: 'join', projectId: '42'});
  bob.send({t: 'join', projectId: '42'});
  assert.ok(await until(() => ann.has('joined') && bob.has('joined')), 'both joined');
  assert.strictEqual(bob.last('joined').leaderId, ann.last('hello').you.id, 'the owner is main');

  ann.send({t: 'op', projectId: '42', screen: 'Screen1', kind: 'designer',
    data: {op: 'addmove', uuid: 'u1'}});
  assert.ok(await until(() => bob.has('op', m => m.op.data.uuid === 'u1' && m.op.kind === 'designer')),
    'a designer edit is relayed');
  ann.send({t: 'op', projectId: '42', screen: 'Screen1', kind: 'blocks', data: {type: 'create'}});
  assert.ok(await until(() => bob.has('op', m => m.op.kind === 'blocks')), 'a blocks edit is relayed');
  assert.ok(!ann.has('op'), 'the sender does not get its own edit back');

  ann.send({t: 'cursor', screen: 'Screen1', editor: 'blocks', x: 12, y: 34});
  assert.ok(await until(() => bob.has('cursor', m => m.x === 12 && m.y === 34 && m.id === ann.last('hello').you.id)),
    'a cursor is relayed');
  assert.ok(!ann.has('cursor'));

  ann.send({t: 'presence', screen: 'Screen2', editor: 'designer', companion: true});
  assert.ok(await until(() => bob.has('roster', m => m.clients.some(c => c.screen === 'Screen2' && c.companion))),
    'presence and companion use are relayed');

  ann.ws.close();
  assert.ok(await until(() => bob.has('cursor', m => m.x === null)), 'a leaving person\'s cursor is removed');
  bob.ws.close();
});

test('a "the code changed" announcement is only believed if App Inventor confirms it', async () => {
  const ann = await connect('ann');
  const bob = await connect('bob' + Date.now().toString(36));
  await until(() => ann.has('hello') && bob.has('hello'));

  lastCodeChange = {at: 0, by: '', signedOut: false};
  ann.send({t: 'codechanged'});
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!bob.has('notice'), 'no change on record: ignored');

  lastCodeChange = {at: Date.now(), by: 'u-someoneelse', signedOut: false};
  ann.send({t: 'codechanged'});
  await new Promise(r => setTimeout(r, 400));
  assert.ok(!bob.has('notice'), 'changed by somebody else: ignored');

  lastCodeChange = {at: Date.now(), by: 'u-ann', signedOut: false};
  ann.send({t: 'codechanged', signedOut: true});   // the browser's claim about sign-out is not used
  assert.ok(await until(() => bob.has('notice')), 'a confirmed change is announced');
  assert.match(bob.last('notice').text, /^ann changed the team code\. /);
  assert.ok(!/signed everyone out/.test(bob.last('notice').text));
  ann.ws.close();
  bob.ws.close();
});
