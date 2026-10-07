'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Hub, EMPTY_ROOM_TTL_MS} = require('../rooms');

function setup() {
  let now = 1000;
  const inbox = {};
  const hub = new Hub((id, msg) => (inbox[id] = inbox[id] || []).push(msg), () => now);
  const last = (id, type) => (inbox[id] || []).filter(m => m.t === type).pop();
  const all = (id, type) => (inbox[id] || []).filter(m => m.t === type);
  return {hub, inbox, last, all, advance: ms => { now += ms; }};
}

const ACCESS = {projectName: 'Pong', ownerEmail: 'owner@school.org'};

test('first person in a project is main; the owner takes over when they arrive', () => {
  const {hub, last, advance} = setup();
  const bob = hub.addClient({userId: 'u2', email: 'bob@school.org'});
  advance(10);
  hub.join(bob.id, '42', ACCESS);
  assert.strictEqual(last(bob.id, 'joined').leaderId, bob.id);

  const owner = hub.addClient({userId: 'u1', email: 'owner@school.org'});
  advance(10);
  hub.join(owner.id, '42', ACCESS);
  assert.strictEqual(last(owner.id, 'joined').leaderId, owner.id);
  assert.strictEqual(last(bob.id, 'leader').leaderId, owner.id);

  const roster = last(bob.id, 'roster').clients;
  assert.deepStrictEqual(roster.filter(c => c.main).map(c => c.name), ['owner']);
});

test('ops go to everyone else in the project and are replayed to late joiners', () => {
  const {hub, last, all} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  const outsider = hub.addClient({userId: 'u3', email: 'c@x.org'});
  hub.join(a.id, '7', ACCESS);
  hub.join(b.id, '7', ACCESS);
  hub.join(outsider.id, '8', ACCESS);

  hub.op(a.id, {projectId: '7', screen: 'Screen1', kind: 'blocks', data: {type: 'create'}});
  assert.strictEqual(all(a.id, 'op').length, 0, 'sender does not get its own op back');
  assert.strictEqual(last(b.id, 'op').op.data.type, 'create');
  assert.strictEqual(all(outsider.id, 'op').length, 0, 'other projects are not affected');

  hub.op(a.id, {projectId: '8', screen: 'Screen1', kind: 'blocks', data: {}});
  assert.strictEqual(all(outsider.id, 'op').length, 0, 'cannot send ops to a project you are not in');
  hub.op(a.id, {projectId: '7', screen: 'Screen1', kind: 'evil', data: {}});
  assert.strictEqual(all(b.id, 'op').length, 1, 'unknown op kinds are dropped');

  const late = hub.addClient({userId: 'u4', email: 'd@x.org'});
  hub.join(late.id, '7', ACCESS);
  const joined = last(late.id, 'joined');
  assert.strictEqual(joined.log.length, 1);
  assert.strictEqual(joined.log[0].seq, 1);
  assert.ok(joined.epoch);
});

test('when main leaves, the longest-present teammate becomes main', () => {
  const {hub, last, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  const c = hub.addClient({userId: 'u3', email: 'c@x.org'});
  hub.join(a.id, '1', ACCESS);
  advance(5);
  hub.join(b.id, '1', ACCESS);
  advance(5);
  hub.join(c.id, '1', ACCESS);
  hub.removeClient(a.id);
  assert.strictEqual(last(b.id, 'leader').leaderId, b.id);
  assert.strictEqual(last(c.id, 'leader').leaderId, b.id);
});

test('a new client learns who it is and who else is online', () => {
  const {hub, last} = setup();
  const a = hub.addClient({userId: 'u1', email: 'ann@x.org'});
  hub.welcome(a.id);
  const b = hub.addClient({userId: 'u2', email: 'ben@x.org'});
  hub.welcome(b.id);
  assert.strictEqual(last(b.id, 'hello').you.id, b.id);
  assert.strictEqual(last(b.id, 'hello').you.name, 'ben');
  assert.deepStrictEqual(last(b.id, 'roster').clients.map(c => c.name), ['ann', 'ben']);
  assert.deepStrictEqual(last(a.id, 'roster').clients.map(c => c.name), ['ann', 'ben']);
  assert.notStrictEqual(last(a.id, 'hello').you.color, last(b.id, 'hello').you.color);
});

test('presence shows screen, editor and companion use', () => {
  const {hub, last} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.presence(a.id, {screen: 'Screen2', editor: 'blocks', companion: true});
  const me = last(b.id, 'roster').clients.find(c => c.id === a.id);
  assert.deepStrictEqual([me.projectName, me.screen, me.editor, me.companion],
    ['Pong', 'Screen2', 'blocks', true]);
});

test('an empty project session is forgotten after the grace period', () => {
  const {hub, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.op(a.id, {projectId: '1', screen: 'Screen1', kind: 'designer', data: {}});
  hub.leave(a.id);
  hub.sweep();
  assert.ok(hub.rooms.has('1'), 'kept for a while so a quick rejoin still replays');
  advance(EMPTY_ROOM_TTL_MS + 1);
  hub.sweep();
  assert.ok(!hub.rooms.has('1'));
});

test('switching projects leaves the old room', () => {
  const {hub, last} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.join(b.id, '1', ACCESS);
  hub.join(a.id, '2', ACCESS);
  assert.deepStrictEqual([...hub.rooms.get('1').members], [b.id]);
  assert.strictEqual(last(b.id, 'leader').leaderId, b.id);
});

test('three people online get red, blue and yellow; a returning person keeps their colour', () => {
  const {hub} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  const c = hub.addClient({userId: 'u3', email: 'c@x.org'});
  assert.deepStrictEqual([a.color, b.color, c.color], ['#e53935', '#1e88e5', '#fdd835']);
  const again = hub.addClient({userId: 'u2', email: 'b@x.org'});
  assert.strictEqual(again.color, b.color, 'a second tab of the same person is the same colour');
  hub.removeClient(a.id);
  const d = hub.addClient({userId: 'u4', email: 'd@x.org'});
  assert.strictEqual(d.color, '#e53935', 'a free colour is reused');
});

test('cursors go to the others in the project only, are not echoed, and are throttled', () => {
  const {hub, all, last, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  const outsider = hub.addClient({userId: 'u3', email: 'c@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.join(b.id, '1', ACCESS);
  hub.join(outsider.id, '2', ACCESS);

  hub.cursor(a.id, {screen: 'Screen1', editor: 'blocks', x: 10.4, y: -20.6});
  assert.deepStrictEqual(last(b.id, 'cursor'),
    {t: 'cursor', id: a.id, screen: 'Screen1', editor: 'blocks', x: 10, y: -21});
  assert.strictEqual(all(a.id, 'cursor').length, 0, 'not echoed to the sender');
  assert.strictEqual(all(outsider.id, 'cursor').length, 0, 'other projects never see it');

  advance(200);
  hub.cursor(a.id, {screen: 'Screen1', editor: 'blocks', x: 50, y: 50});
  assert.strictEqual(all(b.id, 'cursor').length, 1, 'faster than once a second is dropped');
  advance(5000);
  hub.cursor(a.id, {screen: 'Screen1', editor: 'designer', x: 50, y: 60});
  assert.strictEqual(last(b.id, 'cursor').editor, 'designer');
});

test('cursor input is validated, and hiding works without waiting', () => {
  const {hub, all, last, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.join(b.id, '1', ACCESS);
  for (const bad of [{x: 'a', y: 1}, {x: 1, y: NaN}, {x: 1e9, y: 0}, {x: 1, y: 1, editor: 'x'},
    {x: 1, y: 1, screen: 5}]) {
    hub.cursor(a.id, Object.assign({screen: 'Screen1', editor: 'blocks'}, bad));
  }
  hub.cursor(a.id, {screen: 'Screen1', editor: 'blocks', x: 'a', y: 1});
  assert.strictEqual(all(b.id, 'cursor').length, 0);

  hub.cursor(a.id, {screen: 'Screen1', editor: 'blocks', x: 5, y: 5});
  hub.cursor(a.id, {x: null, y: null});
  assert.deepStrictEqual(last(b.id, 'cursor'), {t: 'cursor', id: a.id, x: null, y: null});
  const before = all(b.id, 'cursor').length;
  hub.cursor(a.id, {x: null, y: null});
  assert.strictEqual(all(b.id, 'cursor').length, before, 'hiding twice sends nothing');
});

test('a late joiner is shown where everybody is, and leaving removes the cursor', () => {
  const {hub, all, last, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'a@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'b@x.org'});
  hub.join(a.id, '1', ACCESS);
  hub.join(b.id, '1', ACCESS);
  hub.cursor(a.id, {screen: 'Screen2', editor: 'designer', x: 7, y: 8});
  advance(10);
  const late = hub.addClient({userId: 'u3', email: 'c@x.org'});
  hub.join(late.id, '1', ACCESS);
  assert.deepStrictEqual(last(late.id, 'joined').cursors,
    [{id: a.id, screen: 'Screen2', editor: 'designer', x: 7, y: 8}]);
  hub.leave(a.id);
  assert.deepStrictEqual(last(b.id, 'cursor'), {t: 'cursor', id: a.id, x: null, y: null});
  assert.deepStrictEqual(last(late.id, 'cursor'), {t: 'cursor', id: a.id, x: null, y: null});
});

test('a team code change is announced to everyone else by name, and not spammable', () => {
  const {hub, all, last, advance} = setup();
  const a = hub.addClient({userId: 'u1', email: 'ann@x.org'});
  const b = hub.addClient({userId: 'u2', email: 'ben@x.org'});
  assert.ok(hub.codeChanged(a.id, true));
  assert.strictEqual(last(b.id, 'notice').text,
    'ann changed the team code and signed everyone out. Ask them for the new code.');
  assert.strictEqual(all(a.id, 'notice').length, 0);
  assert.ok(!hub.codeChanged(a.id, false), 'a second notice right away is ignored');
  advance(6000);
  assert.ok(hub.codeChanged(a.id, false));
  assert.ok(!/signed everyone out/.test(all(b.id, 'notice')[1].text));
});
