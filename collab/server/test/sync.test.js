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
