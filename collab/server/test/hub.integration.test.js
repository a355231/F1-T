'use strict';

// Starts the real hub.js against a stand-in for App Inventor and talks to it over WebSockets, so
// that every message type the browsers send is exercised through the transport code too.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const WebSocket = require('ws');

let upstream, hubProcess, hubPort, externalPort, lastCodeChange;
const backupCalls = [];
const kicked = [];
const hits = {};
const BIG = 'function f(){return 1;}\n'.repeat(2000);

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
    if (url.pathname === '/ode/collab/backup' && req.method === 'POST') {
      backupCalls.push({project: url.searchParams.get('projectId'), user: name});
      return res.end(JSON.stringify({ok: true, enabled: true, id: '1-aaaaaaaa'}));
    }
    if (url.pathname === '/ode/collab/kick' && req.method === 'POST') {
      kicked.push(url.searchParams.get('name'));
      return res.end(JSON.stringify({ok: true, userId: 'u-' + url.searchParams.get('name')}));
    }
    if (url.pathname === '/static/js/big.js' || url.pathname === '/ode/0123456789ABCDEF0123456789ABCDEF.cache.js') {
      hits[url.pathname] = (hits[url.pathname] || 0) + 1;
      res.setHeader('content-type', 'application/javascript');
      return res.end(BIG);
    }
    if (url.pathname === '/ode/dynamic') {
      hits[url.pathname] = (hits[url.pathname] || 0) + 1;
      return res.end(JSON.stringify({rows: BIG}));
    }
    if (url.pathname === '/echo-headers') {
      return res.end(JSON.stringify(req.headers));
    }
    if (url.pathname === '/_ah/admin') {
      return res.end('{"admin":true}');
    }
    if (url.pathname === '/ode/collab/lastcodechange') {
      return res.end(JSON.stringify(lastCodeChange));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  hubPort = 20000 + Math.floor(Math.random() * 10000);
  externalPort = hubPort + 10000;
  hubProcess = spawn('node', [path.join(__dirname, '..', 'hub.js')], {
    env: Object.assign({}, process.env, {PORT: String(hubPort), HOST: '127.0.0.1',
      EXTERNAL_PORT: String(externalPort), BACKUP_MS: '300', AI_DATA_DIR: '/nonexistent',
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

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path, headers}, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({status: res.statusCode, body}));
    }).on('error', reject);
  });
}

test('the second port treats everyone as coming from the internet', async () => {
  assert.strictEqual((await get(hubPort, '/_ah/admin', {cookie: 'AppInventor=ann'})).status, 200, 'the Pi itself may');
  assert.strictEqual((await get(externalPort, '/_ah/admin')).status, 403, 'a tunnel may not');
  assert.strictEqual((await get(externalPort, '/login/google')).status, 403);
  assert.strictEqual((await get(externalPort, '/collab/status')).status, 200);
});

test('a project with changes is backed up with the main client\'s login', async () => {
  const ann = await connect('ann');
  const bob = await connect('bob');
  ann.send({t: 'join', projectId: '77'});
  bob.send({t: 'join', projectId: '77'});
  assert.ok(await until(() => ann.has('joined') && bob.has('joined')));
  backupCalls.length = 0;
  bob.send({t: 'op', projectId: '77', screen: 'Screen1', kind: 'blocks', data: {type: 'create'}});
  assert.ok(await until(() => backupCalls.some(c => c.project === '77')), 'backup was requested');
  assert.strictEqual(backupCalls.find(c => c.project === '77').user, 'ann');   // ann owns it: main
  const count = backupCalls.length;
  await new Promise(r => setTimeout(r, 900));
  assert.strictEqual(backupCalls.length, count, 'no change, no new backup');
  ann.ws.close();
  bob.ws.close();
});

test('the admin page lists people and can sign one out', async () => {
  const ann = await connect('ann');
  const cal = await connect('cal');
  const cookie = {cookie: 'AppInventor=ann'};
  assert.strictEqual((await get(hubPort, '/collab/admin/data', {})).status, 401);
  const data = JSON.parse((await get(hubPort, '/collab/admin/data', cookie)).body);
  assert.deepStrictEqual(data.online.map(c => c.name).sort(), ['ann', 'cal']);
  assert.strictEqual(data.online.find(c => c.name === 'ann').me, true);
  const closed = new Promise(resolve => cal.ws.on('close', code => resolve(code)));
  await new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: hubPort, method: 'POST',
      path: '/collab/admin/kick?name=cal', headers: cookie}, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(await closed, 4001);
  assert.deepStrictEqual(kicked, ['cal']);
  ann.ws.close();
});

test('fingerprints, chat and block locks go through the real transport', async () => {
  const ann = await connect('ann');
  ann.send({t: 'join', projectId: '78'});
  ann.send({t: 'presence', screen: 'Screen1', editor: 'blocks', companion: false});
  assert.ok(await until(() => ann.has('joined')));
  ann.send({t: 'digest', screen: 'Screen1', blocks: 'abc', designer: 'def'});   // accepted silently
  ann.send({t: 'chat', text: 'hi'});
  assert.ok(await until(() => ann.has('chat', m => m.item.text === 'hi')));
  ann.send({t: 'lock', screen: 'Screen1', blockId: 'x'});
  assert.ok(await until(() => ann.has('locks', m => m.list.length === 1)));
  ann.ws.close();
});

function fetchRaw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port: hubPort, path, headers: Object.assign({cookie: 'AppInventor=ann'}, headers)}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    }).on('error', reject);
  });
}

test('scripts are compressed, kept in memory and answered with 304 when unchanged', async () => {
  const zlib = require('node:zlib');
  const first = await fetchRaw('/static/js/big.js', {'accept-encoding': 'br, gzip'});
  assert.strictEqual(first.headers['content-encoding'], 'br');
  assert.ok(first.body.length < BIG.length / 10, 'much smaller: ' + first.body.length);
  assert.strictEqual(zlib.brotliDecompressSync(first.body).toString(), BIG);
  const gz = await fetchRaw('/static/js/big.js', {'accept-encoding': 'gzip'});
  assert.strictEqual(zlib.gunzipSync(gz.body).toString(), BIG);
  const plain = await fetchRaw('/static/js/big.js');
  assert.strictEqual(plain.body.toString(), BIG);
  assert.strictEqual(hits['/static/js/big.js'], 1, 'App Inventor was asked only once');
  const again = await fetchRaw('/static/js/big.js', {'accept-encoding': 'gzip', 'if-none-match': first.headers.etag});
  assert.strictEqual(again.status, 304);
});

test('files with a hash in their name are cached for a year; dynamic replies are compressed but not kept', async () => {
  const zlib = require('node:zlib');
  const hashed = await fetchRaw('/ode/0123456789ABCDEF0123456789ABCDEF.cache.js', {'accept-encoding': 'gzip'});
  assert.match(hashed.headers['cache-control'], /immutable/);
  const d1 = await fetchRaw('/ode/dynamic', {'accept-encoding': 'gzip'});
  assert.strictEqual(d1.headers['content-encoding'], 'gzip');
  assert.ok(zlib.gunzipSync(d1.body).toString().includes('function f'));
  await fetchRaw('/ode/dynamic', {'accept-encoding': 'gzip'});
  assert.strictEqual(hits['/ode/dynamic'], 2, 'dynamic replies always go to App Inventor');
});

test('a browser cannot ask App Inventor for full-app changes; the hub removes that header', async () => {
  const r = await fetchRaw('/echo-headers', {'x-collab-ai-mode': 'full'});
  assert.strictEqual(JSON.parse(r.body.toString())['x-collab-ai-mode'], undefined);
});
