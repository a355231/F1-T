'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Hub} = require('../rooms');

function setup() {
  let now = 1000000;
  const inbox = {};
  const hub = new Hub((id, msg) => (inbox[id] = inbox[id] || []).push(msg), () => now);
  const all = (id, type) => (inbox[id] || []).filter(m => m.t === type);
  const pair = () => {
    const a = hub.addClient({userId: 'u1', email: 'a@team.local'});
    const b = hub.addClient({userId: 'u2', email: 'b@team.local'});
    hub.join(a.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
    hub.join(b.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
    hub.presence(a.id, {screen: 'Screen1', editor: 'blocks', companion: false});
    hub.presence(b.id, {screen: 'Screen1', editor: 'blocks', companion: false});
    return {a, b};
  };
  return {hub, inbox, all, pair, advance: ms => { now += ms; }};
}

test('syncTick asks every member for fingerprints of the screens people are on', () => {
  const {hub, all, pair} = setup();
  const {a, b} = pair();
  hub.syncTick();
  assert.deepStrictEqual(all(a.id, 'sync').pop().screens, ['Screen1']);
  assert.strictEqual(all(b.id, 'sync').length, 1);
});

test('a follower that differs twice in a row gets a snapshot from the main client', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  const round = (leaderHash, followerHash) => {
    hub.digest(a.id, {screen: 'Screen1', blocks: leaderHash, designer: 'd1'});
    hub.digest(b.id, {screen: 'Screen1', blocks: followerHash, designer: 'd1'});
  };
  round('x', 'y');
  assert.strictEqual(all(a.id, 'snapshot-request').length, 0, 'one difference is not enough');
  advance(30000);
  round('x', 'y');
  const req = all(a.id, 'snapshot-request');
  assert.strictEqual(req.length, 1);
  assert.strictEqual(req[0].forId, b.id);
  assert.strictEqual(req[0].blocks, true);
  assert.strictEqual(req[0].designer, false);
  hub.snapshot(a.id, {screen: 'Screen1', forId: b.id, blocks: '<xml/>', designer: false});
  assert.strictEqual(all(b.id, 'resync')[0].blocks, '<xml/>');
});

test('a matching round resets the count; edits in progress are never compared', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  hub.digest(a.id, {screen: 'Screen1', blocks: 'x'});
  hub.digest(b.id, {screen: 'Screen1', blocks: 'y'});
  advance(30000);
  hub.digest(a.id, {screen: 'Screen1', blocks: 'x'});
  hub.digest(b.id, {screen: 'Screen1', blocks: 'x'});      // agrees now
  advance(30000);
  hub.digest(a.id, {screen: 'Screen1', blocks: 'x'});
  hub.digest(b.id, {screen: 'Screen1', blocks: 'y'});      // first difference again
  advance(30000);
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {}});
  hub.digest(a.id, {screen: 'Screen1', blocks: 'x'});
  hub.digest(b.id, {screen: 'Screen1', blocks: 'y'});      // busy: not counted
  assert.strictEqual(all(a.id, 'snapshot-request').length, 0);
});

test('only the main client may answer with a snapshot, and only to its own project', () => {
  const {hub, all, pair} = setup();
  const {a, b} = pair();
  assert.strictEqual(hub.snapshot(b.id, {screen: 'Screen1', forId: a.id, blocks: 'evil'}), false);
  assert.strictEqual(all(a.id, 'resync').length, 0);
});

test('backups are due only for projects with changes since the last backup', () => {
  const {hub, pair} = setup();
  const {a, b} = pair();
  assert.deepStrictEqual(hub.backupsDue(), []);
  hub.op(b.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {}});
  const due = hub.backupsDue();
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].clientId, a.id);      // made with the main client's account
  hub.backedUp('5', due[0].seq);
  assert.deepStrictEqual(hub.backupsDue(), []);
});

test('an AI change waits until every open tab has saved, or for a few seconds, whichever is first', async () => {
  const {hub, pair} = setup();
  const {a, b} = pair();
  const answered = hub.awaitFlush('5', 'f1', 5000);
  hub.ackFlush(a.id, 'f1');
  hub.ackFlush(b.id, 'f1');
  await answered;
  const started = Date.now();
  await hub.awaitFlush('5', 'f2', 40);   // nobody answers
  assert.ok(Date.now() - started >= 30);
  await hub.awaitFlush('404', 'f3', 5000);   // nobody has that project open: nothing to wait for
});

test('restoring starts the session over and tells everyone to reload', () => {
  const {hub, all, pair} = setup();
  const {a, b} = pair();
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {}});
  hub.restored('5', 'a');
  assert.strictEqual(all(b.id, 'reload').length, 1);
  const c = hub.addClient({userId: 'u3', email: 'c@team.local'});
  hub.join(c.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  assert.deepStrictEqual(all(c.id, 'joined').pop().log, []);
});

test('chat is cleaned up, rate limited, kept for late joiners and only for the project', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  const outsider = hub.addClient({userId: 'u9', email: 'z@team.local'});
  hub.chat(a.id, '  hello\u0007 there  ');
  assert.strictEqual(all(b.id, 'chat')[0].item.text, 'hello  there');
  assert.strictEqual(all(outsider.id, 'chat').length, 0);
  hub.chat(a.id, 'too fast');
  assert.strictEqual(all(b.id, 'chat').length, 1);
  advance(1000);
  hub.chat(a.id, 'x'.repeat(2000));
  assert.strictEqual(all(b.id, 'chat')[1].item.text.length, 500);
  const c = hub.addClient({userId: 'u3', email: 'c@team.local'});
  hub.join(c.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  assert.strictEqual(all(c.id, 'joined').pop().chat.length, 2);
});

test('recent changes name what happened and fold repeats together', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'designer',
    data: {op: 'addmove', uuid: '1', b: JSON.stringify({$Name: 'Button2', $Type: 'Button'})}});
  assert.strictEqual(all(b.id, 'activity')[0].item.text, 'added Button2 on Screen1');
  for (let i = 0; i < 3; i++) {
    advance(1000);
    hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {type: 'move'}});
  }
  const lines = all(b.id, 'activity');
  assert.strictEqual(lines.length, 2, 'three moves are one line');
  const room = hub.rooms.get('5');
  assert.strictEqual(room.activity[1].count, 3);
  hub.op(a.id, {projectId: '5', screen: '', kind: 'tree', data: {}});
  assert.match(room.activity[2].text, /screens or media/);
});

test('a block can be claimed by one person at a time, and is freed when they let go or leave', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  assert.strictEqual(hub.lock(a.id, {screen: 'Screen1', blockId: 'blk1'}), true);
  assert.strictEqual(hub.lock(b.id, {screen: 'Screen1', blockId: 'blk1'}), false);
  assert.strictEqual(all(b.id, 'lock-denied')[0].name, 'a');
  assert.strictEqual(hub.lock(b.id, {screen: 'Screen1', blockId: 'blk2'}), true);
  hub.unlock(b.id, {screen: 'Screen1', blockId: 'blk1'});          // not b's: ignored
  assert.strictEqual(hub.lock(b.id, {screen: 'Screen1', blockId: 'blk1'}), false);
  advance(30000);
  assert.strictEqual(hub.lock(a.id, {screen: 'Screen1', blockId: 'blk1'}), true);   // renewed
  advance(45000);
  assert.strictEqual(hub.lock(b.id, {screen: 'Screen1', blockId: 'blk1'}), false, 'still a\'s');
  advance(30000);
  assert.strictEqual(hub.lock(b.id, {screen: 'Screen1', blockId: 'blk1'}), true, 'expired');
  hub.removeClient(b.id);
  assert.deepStrictEqual(hub.lockList(hub.rooms.get('5')), []);
});

test('selections reach the others, are rate limited and vanish when the person leaves', () => {
  const {hub, all, pair, advance} = setup();
  const {a, b} = pair();
  hub.select(a.id, {screen: 'Screen1', blockId: 'b1', typing: true});
  assert.deepStrictEqual(all(b.id, 'sel')[0].blockId, 'b1');
  assert.strictEqual(all(b.id, 'sel')[0].typing, true);
  hub.select(a.id, {screen: 'Screen1', blockId: 'b2'});
  assert.strictEqual(all(b.id, 'sel').length, 1, 'too soon');
  advance(1000);
  hub.select(a.id, {screen: 'Screen1', blockId: 'b2'});
  hub.leave(a.id);
  assert.strictEqual(all(b.id, 'sel').pop().blockId, null);
});
