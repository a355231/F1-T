'use strict';

// The team page's extra behaviour (collab-extra.js) runs here in a bare VM with stand-ins for the browser, so what a
// page takes from the team server when it joins a project can be checked without a browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', '..', 'appinventor', 'appengine', 'war', 'static', 'js', 'collab-extra.js');

function loadPage() {
  const sent = [];
  // collab.js provides these to collab-extra.js when it is loaded in a page.
  const C = {wanted: '42', joined: '42', me: {id: 'c1', name: 'ann'}, sent, send: m => sent.push(m),
    isJoined: () => true, epoch: 'e1', roster: [], cursors: {}, render() {}, renderCursors() {}, processQueues() {}};
  const element = () => ({style: {}, dataset: {}, appendChild() {}, setAttribute() {}, addEventListener() {},
    classList: {add() {}, remove() {}}});
  const location = {origin: 'https://team.example', href: 'https://team.example/', reload() {}};
  const window = {AICollab: C, location, addEventListener() {}, sessionStorage: {getItem: () => null, setItem() {}}};
  const document = {createElement: element, head: {appendChild() {}}, body: {appendChild() {}},
    getElementById: () => null, querySelector: () => null, addEventListener() {}};
  // Timers the page starts do not keep this test running.
  const later = (...args) => { const t = setTimeout(...args); t.unref(); return t; };
  const every = (...args) => { const t = setInterval(...args); t.unref(); return t; };
  const ctx = {window, document, console, setTimeout: later, clearTimeout, setInterval: every, clearInterval, JSON, Math,
    Date, String, Number, Object, Array, Promise, Set, Map};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, {filename: 'collab-extra.js'});
  return {C, window};
}

test('a page that joins a project takes the chat, activity, locks and selections the team server sends', () => {
  const {C, window} = loadPage();
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 0,
    chat: [{name: 'bob', text: 'hi', at: 5}], activity: [{name: 'bob', text: 'added blocks on Screen1', at: 4}],
    locks: [{key: 'Screen1/b1', by: 'c2', name: 'bob'}], sels: [{id: 'c2', screen: 'Screen1', blockId: 'b1', typing: false}]});
  assert.deepStrictEqual(C.chat.map(m => m.text), ['hi']);
  assert.strictEqual(C.activity.length, 1);
  assert.strictEqual(C.locks.length, 1);
  assert.strictEqual(C.sels.c2.blockId, 'b1');
});

test('a late answer for a project this page has left does not change what it shows', () => {
  const {C, window} = loadPage();
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 0, chat: [{name: 'bob', text: 'hi', at: 5}]});
  window.AICollab.onExtra({t: 'joined', projectId: '7', epoch: 'e9', writes: 3, chat: [], locks: []});
  assert.deepStrictEqual(C.chat.map(m => m.text), ['hi']);
});

test('a change made while this page was away freezes it, so it reloads before it saves anything', () => {
  const {window} = loadPage();
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 2});
  assert.ok(!window.AICollab_frozen, 'nothing is frozen on the first join');
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 3});
  assert.strictEqual(window.AICollab_frozen, true);
});

test('a freeze or unfreeze for another project is not for this page', () => {
  const {window} = loadPage();
  window.AICollab.onExtra({t: 'freeze', projectId: '7', by: 'bob'});
  assert.ok(!window.AICollab_frozen, 'a freeze for project 7 does not freeze project 42');
});

test('a page frozen by the team server that loses its connection unfreezes when it rejoins, unless a save or restore is still going on', () => {
  const {window} = loadPage();
  window.AICollab.onExtra({t: 'freeze', projectId: '42', by: 'bob'});
  assert.strictEqual(window.AICollab_frozen, true);
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 0, frozen: true, flushing: false});
  assert.strictEqual(window.AICollab_frozen, true, 'a restore is still going on: stay frozen');
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 0, frozen: false, flushing: true});
  assert.strictEqual(window.AICollab_frozen, true, 'a save for an AI change is still going on: stay frozen');
  window.AICollab.onExtra({t: 'joined', projectId: '42', epoch: 'e1', writes: 0, frozen: false, flushing: false});
  assert.ok(!window.AICollab_frozen, 'nothing is pending: the page may save again');
});
