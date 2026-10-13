'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Hub, EMPTY_ROOM_TTL_MS} = require('../rooms');

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

test('an AI change waits until every open tab has saved; a tab that stays silent stops it after the wait', async () => {
  const {hub, pair} = setup();
  const {a, b} = pair();
  const answered = hub.awaitFlush('5', 'f1', 5000);
  hub.ackFlush(a.id, 'f1');
  hub.ackFlush(b.id, 'f1');
  assert.deepStrictEqual(await answered, {ok: true});
  const started = Date.now();
  assert.deepStrictEqual(await hub.awaitFlush('5', 'f2', 40), {ok: false});   // nobody answers
  assert.ok(Date.now() - started >= 30);
  assert.deepStrictEqual(await hub.awaitFlush('404', 'f3', 5000), {ok: true},
    'nobody has that project open: nothing to wait for');
});

test('a tab that says its save failed stops an AI change at once', async () => {
  const {hub, pair} = setup();
  const {a, b} = pair();
  const started = Date.now();
  const failed = hub.awaitFlush('5', 'f4', 5000);
  hub.ackFlush(a.id, 'f4', false);
  assert.deepStrictEqual(await failed, {ok: false});
  assert.ok(Date.now() - started < 1000, 'it did not wait for the timer');
  hub.ackFlush(b.id, 'f4');   // late, and nothing is waiting any more
});

test('a tab whose socket is down is not waited for by an AI change', async () => {
  const inbox = {};
  const closed = new Set();
  const hub = new Hub((id, msg) => (inbox[id] = inbox[id] || []).push(msg), () => 1000,
    id => !closed.has(id));
  const a = hub.addClient({userId: 'u1', email: 'a@team.local'});
  const b = hub.addClient({userId: 'u2', email: 'b@team.local'});
  hub.join(a.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  hub.join(b.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  closed.add(b.id);
  const done = hub.awaitFlush('5', 'f5', 5000);
  hub.ackFlush(a.id, 'f5');
  assert.deepStrictEqual(await done, {ok: true});
});

test('a tab that drops out during an AI change is not waited for any more', async () => {
  const {hub, pair} = setup();
  const {a, b} = pair();
  const done = hub.awaitFlush('5', 'f6', 5000);
  hub.ackFlush(a.id, 'f6');
  hub.removeClient(b.id);
  assert.deepStrictEqual(await done, {ok: true});
});

test('a restore moves the write count up, and a tab that joins afterwards is told the count', () => {
  const {hub, all, pair} = setup();
  const {a, b} = pair();
  assert.strictEqual(all(b.id, 'joined')[0].writes, 0, 'nothing written yet');
  hub.removeClient(a.id);
  hub.removeClient(b.id);
  hub.restored('5', 'a');   // nobody has the project open now
  const c = hub.addClient({userId: 'u3', email: 'c@team.local'});
  hub.join(c.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  assert.ok(all(c.id, 'joined').pop().writes > 0, 'a tab that was away sees the change');
  hub.restored('9', 'a');   // a project nobody has ever had open still counts
  const d = hub.addClient({userId: 'u4', email: 'd@team.local'});
  hub.join(d.id, '9', {projectName: 'Q', ownerEmail: 'a@team.local'});
  assert.ok(all(d.id, 'joined').pop().writes > 0);
});

test('the write count only goes up, even when the clock stands still, and outlives the room', () => {
  const {hub, advance} = setup();
  const first = hub.written('5');
  assert.strictEqual(hub.written('5'), first + 1);
  const a = hub.addClient({userId: 'u1', email: 'a@team.local'});
  hub.join(a.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  hub.leave(a.id);
  advance(EMPTY_ROOM_TTL_MS + 1);
  hub.sweep();
  assert.ok(!hub.rooms.has('5'), 'the room is forgotten');
  const b = hub.addClient({userId: 'u2', email: 'b@team.local'});
  hub.join(b.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  assert.ok(hub.rooms.get('5').members.has(b.id));
  assert.ok(hub.writes.get('5') > first, 'the count is still there');
});

test('an edit made on a copy from before a restore is dropped; an edit with no epoch still goes in', () => {
  const {hub, pair} = setup();
  const {a} = pair();
  const oldEpoch = hub.rooms.get('5').epoch;
  hub.restored('5', 'a');
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {}, epoch: oldEpoch});
  assert.strictEqual(hub.rooms.get('5').log.length, 0, 'the old copy cannot write into the new log');
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {},
    epoch: hub.rooms.get('5').epoch});
  assert.strictEqual(hub.rooms.get('5').log.length, 1);
  hub.op(a.id, {projectId: '5', screen: 'Screen1', kind: 'blocks', data: {}});
  assert.strictEqual(hub.rooms.get('5').log.length, 2, 'a client that sends no epoch is as before');
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

// Two people with the project open, and what each open page was sent.
function openTwo() {
  const inbox = {};
  const hub = new Hub((id, msg) => (inbox[id] = inbox[id] || []).push(msg), () => 1000);
  const a = hub.addClient({userId: 'u1', email: 'a@team.local'});
  const b = hub.addClient({userId: 'u2', email: 'b@team.local'});
  hub.join(a.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  hub.join(b.id, '5', {projectName: 'P', ownerEmail: 'a@team.local'});
  return {hub, a, b, inbox};
}

test('a manual sync: every open page saves first, then all of them reload from the saved project', async () => {
  const {hub, a, b, inbox} = openTwo();
  const synced = hub.syncAll(a.id, '5', 5000);
  const freeze = inbox[a.id].find(m => m.t === 'freeze');
  assert.ok(freeze && freeze.flush && freeze.sync, 'the pages are asked to save, and told it is a sync');
  assert.ok(inbox[b.id].some(m => m.t === 'freeze' && m.applyId === freeze.applyId), 'b is asked too');
  assert.ok(!inbox[a.id].some(m => m.t === 'reload'), 'nothing reloads before the saves are in');
  hub.ackFlush(a.id, freeze.applyId);
  hub.ackFlush(b.id, freeze.applyId);
  const result = await synced;
  assert.strictEqual(result.ok, true);
  for (const id of [a.id, b.id]) {
    assert.deepStrictEqual(inbox[id].filter(m => m.t === 'reload').map(m => m.kind), ['sync'], 'each page reloads once');
  }
});

test('a sync stops when a page cannot save: nothing reloads, the pages are unfrozen, and the person is told why', async () => {
  const {hub, a, b, inbox} = openTwo();
  const synced = hub.syncAll(a.id, '5', 40);
  const freeze = inbox[a.id].find(m => m.t === 'freeze');
  hub.ackFlush(a.id, freeze.applyId);   // b stays silent
  const result = await synced;
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /could not save/);
  for (const id of [a.id, b.id]) {
    assert.ok(inbox[id].some(m => m.t === 'unfreeze' && m.applyId === freeze.applyId), 'every page is unfrozen');
    assert.ok(!inbox[id].some(m => m.t === 'reload'), 'no page reloads');
  }
});

test('a sync is refused while a save is waiting on the project, and for someone who does not have it open', async () => {
  const {hub, a, b, inbox} = openTwo();
  const first = hub.syncAll(a.id, '5', 5000);
  const applyId = inbox[a.id].find(m => m.t === 'freeze').applyId;
  assert.match((await hub.syncAll(b.id, '5', 5000)).message, /still saving/, 'a second sync waits its turn');
  const outsider = hub.addClient({userId: 'u3', email: 'c@team.local'});
  assert.match((await hub.syncAll(outsider.id, '5', 5000)).message, /Open this project first/);
  hub.ackFlush(a.id, applyId);
  hub.ackFlush(b.id, applyId);
  assert.strictEqual((await first).ok, true);
});

test('an AI change and a sync do not overlap: while one is saving, the other is refused', async () => {
  const {hub, a, b} = openTwo();
  const aiSave = hub.awaitFlush('5', 'ai1', 5000);
  assert.strictEqual(hub.flushing('5'), true);
  assert.match((await hub.syncAll(a.id, '5', 5000)).message, /still saving/);
  hub.ackFlush(a.id, 'ai1');
  hub.ackFlush(b.id, 'ai1');
  await aiSave;
  assert.strictEqual(hub.flushing('5'), false);
});
