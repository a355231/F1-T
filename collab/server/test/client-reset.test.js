'use strict';

// The companion's reset, in the window's own code (public/ai/app.js). The file is loaded into a node:vm context with a
// small DOM stub. The events the server sends go in one at a time through the window's own stream reader, so the screen
// can be checked between them. Then the history the page sends with the next question, the saved conversation and the
// copy button, which all come from the answer's words, are checked too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'public', 'ai', 'app.js');
const SOURCE = fs.readFileSync(APP, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const STATUS_2 = 'The AI service had a problem; trying again (2 of 3).';
const STATUS_3 = 'The AI service had a problem; trying again (3 of 3).';

// The DOM the window uses: elements with classes, children, text and attributes. A selector is a tag and classes only.
function matches(el, selector) {
  const m = /^([a-z]*)((?:\.[\w-]+)*)$/i.exec(selector);
  if (!m) throw new Error('the DOM stub does not know the selector ' + selector);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  return m[2].split('.').filter(Boolean).every(c => el.classList.contains(c));
}

class Elem {
  constructor(tag, text) {
    this.tagName = tag ? String(tag).toUpperCase() : '#TEXT';
    this.children = [];
    this.parentNode = null;
    this._text = text === undefined ? '' : String(text);
    this._attrs = {};
    this.className = '';
    this.dataset = {};
    this.style = {setProperty() {}};
    this.hidden = false;
    this.options = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.offsetHeight = 0;
    this.onclick = null;
    this.classList = {
      add: c => { if (!this.classList.contains(c)) this.className = this._classes().concat(c).join(' '); },
      remove: c => { this.className = this._classes().filter(x => x !== c).join(' '); },
      contains: c => this._classes().indexOf(c) >= 0,
      toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); },
    };
  }
  _classes() { return this.className.split(/\s+/).filter(Boolean); }
  _detach() {
    this.children.forEach(c => { c.parentNode = null; });
    this.children = [];
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) {
    this._detach();
    this._text = v === null || v === undefined ? '' : String(v);
  }
  // The window gives its own text as HTML: the stub keeps the words and drops the tags.
  set innerHTML(v) {
    this._detach();
    this._text = String(v).replace(/<[^>]*>/g, '');
  }
  get innerHTML() { return this.textContent; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    const p = this.parentNode;
    if (p) {
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
    }
    this.parentNode = null;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  addEventListener() {}
  focus() {}
  querySelectorAll(selector) {
    const found = [];
    const walk = el => el.children.forEach(c => {
      if (matches(c, selector)) found.push(c);
      walk(c);
    });
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// A page: the window's script running in its own context, the elements it asks for, and the streams it is given.
function openPage() {
  const elements = Object.create(null);
  const page = {answers: [], sent: [], stored: {}, clipboard: [], window: null, document: null};
  page.document = {
    createElement: tag => new Elem(tag),
    createTextNode: text => new Elem(null, text),
    getElementById: id => elements[id] || (elements[id] = Object.assign(new Elem('div'), {id})),
    querySelectorAll: () => [],   // the [data-fill] buttons of the empty screen: none here
    documentElement: new Elem('html'),
    body: new Elem('body'),
  };
  page.window = {addEventListener() {}, removeEventListener() {},
    __aiHelperConfig: {silenceMs: 60000, reconnects: 0}};
  const sandbox = {
    window: page.window,
    document: page.document,
    location: {search: '?projectId=5', origin: 'http://helper.test', pathname: '/collab/ai/'},
    navigator: {clipboard: {writeText: text => { page.clipboard.push(text); return Promise.resolve(); }}},
    localStorage: {getItem: () => null, setItem() {}},
    sessionStorage: {
      getItem: key => (Object.prototype.hasOwnProperty.call(page.stored, key) ? page.stored[key] : null),
      setItem: (key, value) => { page.stored[key] = String(value); },
    },
    // A frame runs at once, so the screen is up to date after each event. No timer of the window is left running.
    requestAnimationFrame: callback => { callback(); return 0; },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (callback, ms) => { const t = setTimeout(callback, ms); t.unref(); return t; },
    clearTimeout,
    fetch: (url, init) => {
      if (url !== '/collab/ai/stream') {
        return Promise.resolve({ok: false, status: 404, json: () => Promise.resolve({})});
      }
      page.sent.push(JSON.parse(init.body));
      const next = page.answers.shift();
      if (!next) return Promise.reject(new Error('the window asked for an answer that was not set up'));
      return Promise.resolve(next);
    },
    DOMPurify: {addHook() {}, sanitize: html => html},
    marked: {parse: text => text},
    URLSearchParams, AbortController, TextEncoder, TextDecoder, ReadableStream,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, {filename: APP});
  return page;
}

// Sends a question and returns its answer, fed in one event at a time as the server sends it. push() gives the next
// event and lets the window show it; end() gives the done event and waits until the window has finished the answer.
function startAnswer(page, question) {
  let controller = null;
  let id = 0;
  const stream = new ReadableStream({start(c) { controller = c; }});
  page.answers.push({ok: true, status: 200, body: stream});
  page.window.__aiHelper.send(question);
  assert.strictEqual(sendLabel(page), 'Stop', 'the window is busy with the answer');
  const put = event => {
    id++;
    controller.enqueue(new TextEncoder().encode('id: ' + id + '\ndata: ' + JSON.stringify(event) + '\n\n'));
  };
  return {
    async push(event) {
      put(event);
      await flush();
    },
    async end() {
      put({type: 'done'});
      controller.close();
      for (let i = 0; i < 200 && sendLabel(page) !== 'Send'; i++) await flush();
      assert.strictEqual(sendLabel(page), 'Send', 'the answer ended');
    },
  };
}

function sendLabel(page) {
  return page.document.getElementById('send').getAttribute('aria-label');
}

// The newest answer's row, and what the person sees in it, block by block, in order.
function lastAnswer(page) {
  const rows = page.document.getElementById('messages').querySelectorAll('.msg.assistant');
  return rows[rows.length - 1];
}

function block(el) {
  if (el.classList.contains('think')) return 'reasoning: ' + el.querySelector('.think-text').textContent;
  if (el.classList.contains('chip')) {
    return 'step ' + el.querySelector('.label').textContent + ' (' + el.className.replace('chip ', '') + ')';
  }
  if (el.classList.contains('subagent')) return 'subagent: ' + el.querySelector('.sa-task').textContent;
  if (el.classList.contains('notice')) return 'notice: ' + el.textContent;
  return 'words: ' + el.textContent;
}

function screen(page) {
  return lastAnswer(page).querySelector('.turn').children
    .filter(el => !el.classList.contains('thinking') && !el.classList.contains('row-actions'))
    .map(el => block(el));
}

// What the copy button of the newest answer copies.
function copyLastAnswer(page) {
  lastAnswer(page).querySelector('.row-actions').children[0].onclick();
  return page.clipboard[page.clipboard.length - 1];
}

// The messages the page sent with the question at index n (0 is the first question).
function sentMessages(page, n) {
  return page.sent[n].messages;
}

function saved(page) {
  return JSON.parse(page.stored['aihelper.5']);
}

// A subagent's card, by its task, and what is in it.
function subCard(page, task) {
  return lastAnswer(page).querySelector('.turn').children
    .find(el => el.classList.contains('subagent') && el.querySelector('.sa-task').textContent === task);
}

function cardSteps(card) {
  return card.querySelector('.sa-chips').children
    .map(s => s.querySelector('.label').textContent + ' (' + s.className.replace('chip ', '') + ')');
}

// The reasoning and the report are the card's two sections, in that order; a hidden section reads as null.
function cardReasoning(card) {
  const box = card.querySelectorAll('.sa-section')[0];
  return box.hidden ? null : box.querySelector('.sa-body').textContent;
}

function cardReport(card) {
  const box = card.querySelectorAll('.sa-section')[1];
  return box.hidden ? null : box.querySelector('.sa-body').textContent;
}

function cardLines(card) {
  return card.querySelector('.sa-lines').children.map(l => l.textContent);
}

const subagent = (id, state, task, report) => Object.assign(
  {type: 'subagent', id, state, tier: 'default', model: 'm1', name: 'Model one', reasoning: 'high', task, steps: 1},
  report ? {report} : {});

test('(a) failed try is taken back; the words, steps and retry before it stay, on screen and in history', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Earlier words. '});
  await answer.push({type: 'tool', id: 't1', name: 'read_file', state: 'running', label: 'Read Screen1'});
  await answer.push({type: 'tool', id: 't1', name: 'read_file', state: 'done', label: 'Read Screen1'});
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Failed try. '});
  await answer.push({type: 'reset'});
  assert.deepStrictEqual(screen(page), ['words: Earlier words. ', 'step Read Screen1 (done)']);
  await answer.push({type: 'status', text: STATUS_2});
  await answer.push({type: 'text', delta: 'Retried words.'});
  await answer.end();
  assert.deepStrictEqual(screen(page), [
    'words: Earlier words. ',
    'step Read Screen1 (done)',
    'notice: ' + STATUS_2,
    'words: Retried words.',
  ]);
  assert.strictEqual(copyLastAnswer(page), 'Earlier words. Retried words.');
  const next = startAnswer(page, 'Second question');
  await next.push({type: 'text', delta: 'Next answer.'});
  await next.end();
  const history = [
    {role: 'user', content: 'First question'},
    {role: 'assistant', content: 'Earlier words. Retried words.'},
    {role: 'user', content: 'Second question'},
  ];
  assert.deepStrictEqual(sentMessages(page, 1), history);
  assert.deepStrictEqual(saved(page).history, history.concat({role: 'assistant', content: 'Next answer.'}));
  assert.deepStrictEqual(saved(page).rows.map(r => r.text),
    ['First question', 'Earlier words. Retried words.', 'Second question', 'Next answer.']);
});

test('(b) a retry that writes nothing keeps the earlier words, and the answer stays in the history', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Earlier words. '});
  await answer.push({type: 'step'});   // the earlier words are still open when this call starts
  await answer.push({type: 'text', delta: 'Failed try. '});
  await answer.push({type: 'reset'});
  await answer.push({type: 'status', text: STATUS_2});
  await answer.end();
  assert.deepStrictEqual(screen(page), ['words: Earlier words. ', 'notice: ' + STATUS_2]);
  assert.strictEqual(copyLastAnswer(page), 'Earlier words. ');
  const next = startAnswer(page, 'Second question');
  await next.push({type: 'text', delta: 'Next answer.'});
  await next.end();
  assert.deepStrictEqual(sentMessages(page, 1), [
    {role: 'user', content: 'First question'},
    {role: 'assistant', content: 'Earlier words. '},
    {role: 'user', content: 'Second question'},
  ]);
});

test('(c) reasoning of the failed try is taken back; reasoning of an earlier model call stays', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'reasoning', delta: 'Plan one. '});
  await answer.push({type: 'text', delta: 'Earlier words. '});
  await answer.push({type: 'tool', id: 't1', name: 'read_file', state: 'done', label: 'Read Screen1'});
  await answer.push({type: 'step'});
  await answer.push({type: 'reasoning', delta: 'Failed plan. '});
  await answer.push({type: 'text', delta: 'Failed try.'});
  await answer.push({type: 'reset'});
  assert.deepStrictEqual(screen(page), ['reasoning: Plan one. ', 'words: Earlier words. ', 'step Read Screen1 (done)']);
  await answer.push({type: 'status', text: STATUS_2});
  await answer.push({type: 'reasoning', delta: 'Retry plan. '});
  await answer.push({type: 'text', delta: 'Retried words.'});
  await answer.end();
  assert.deepStrictEqual(screen(page), [
    'reasoning: Plan one. Retry plan. ',
    'words: Earlier words. ',
    'step Read Screen1 (done)',
    'notice: ' + STATUS_2,
    'words: Retried words.',
  ]);
});

test('(c) a failed try with no reasoning before it: its reasoning goes, and the retry shows its own', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Earlier words.'});
  await answer.push({type: 'step'});
  await answer.push({type: 'reasoning', delta: 'Failed plan. '});
  await answer.push({type: 'text', delta: 'Failed try.'});
  await answer.push({type: 'reset'});
  assert.deepStrictEqual(screen(page), ['words: Earlier words.']);
  await answer.push({type: 'status', text: STATUS_2});
  await answer.push({type: 'reasoning', delta: 'Retry plan. '});
  await answer.push({type: 'text', delta: 'Retried words.'});
  await answer.end();
  assert.deepStrictEqual(screen(page), [
    'reasoning: Retry plan. ',
    'words: Earlier words.',
    'notice: ' + STATUS_2,
    'words: Retried words.',
  ]);
});

test('(d) a subagent reset clears only its own card; the companion words, steps and other card stay', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Companion words. '});
  await answer.push({type: 'tool', id: 'c1', name: 'check_project', state: 'done', label: 'Check project'});
  await answer.push(subagent('s1', 'running', 'Check Screen2'));
  await answer.push(subagent('s2', 'running', 'Check Screen3'));
  await answer.push({type: 'tool', id: 'a1', name: 'read_file', state: 'done', label: 'Read Screen2', sub: 's1'});
  await answer.push({type: 'tool', id: 'a2', name: 'read_file', state: 'running', label: 'Read Screen2 again',
    sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Sub plan. ', sub: 's1'});
  await answer.push({type: 'tool', id: 'b1', name: 'read_file', state: 'running', label: 'Read Screen3', sub: 's2'});
  await answer.push({type: 'reasoning', delta: 'Other plan.', sub: 's2'});
  const otherStep = subCard(page, 'Check Screen3').querySelector('.sa-chips').children[0];
  await answer.push({type: 'reset', sub: 's1'});
  assert.deepStrictEqual(screen(page),
    ['words: Companion words. ', 'step Check project (done)', 'subagent: Check Screen2', 'subagent: Check Screen3']);
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (done)']);
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen2')), null);
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen3')), ['Read Screen3 (running)']);
  assert.strictEqual(subCard(page, 'Check Screen3').querySelector('.sa-chips').children[0], otherStep);
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen3')), 'Other plan.');
  await answer.push({type: 'status', text: 'The subagent had a problem; trying again.', sub: 's1'});
  await answer.push({type: 'tool', id: 'b1', name: 'read_file', state: 'done', label: 'Read Screen3', sub: 's2'});
  await answer.push(subagent('s2', 'done', 'Check Screen3', 'Screen3 is fine.'));
  await answer.push(subagent('s1', 'done', 'Check Screen2', 'Screen2 is fine.'));
  await answer.end();
  assert.deepStrictEqual(screen(page),
    ['words: Companion words. ', 'step Check project (done)', 'subagent: Check Screen2', 'subagent: Check Screen3']);
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (done)']);
  assert.deepStrictEqual(cardLines(subCard(page, 'Check Screen2')), ['The subagent had a problem; trying again.']);
  assert.strictEqual(cardReport(subCard(page, 'Check Screen2')), 'Screen2 is fine.');
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen3')), ['Read Screen3 (done)']);
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen3')), 'Other plan.');
  assert.strictEqual(cardReport(subCard(page, 'Check Screen3')), 'Screen3 is fine.');
  assert.strictEqual(copyLastAnswer(page), 'Companion words. ');
  const next = startAnswer(page, 'Second question');
  await next.push({type: 'text', delta: 'Next answer.'});
  await next.end();
  assert.deepStrictEqual(sentMessages(page, 1)[1], {role: 'assistant', content: 'Companion words. '});
});

test('(e) a second failed try takes back only what it wrote: its words and the step it began', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Earlier words. '});
  await answer.push({type: 'step'});
  await answer.push({type: 'text', delta: 'Failed one. '});
  await answer.push({type: 'reset'});
  await answer.push({type: 'status', text: STATUS_2});
  await answer.push({type: 'text', delta: 'Failed two. '});
  await answer.push({type: 'tool', id: 't2', name: 'read_file', state: 'running', label: 'Read Screen2'});
  await answer.push({type: 'reset'});
  assert.deepStrictEqual(screen(page), ['words: Earlier words. ', 'notice: ' + STATUS_2]);
  await answer.push({type: 'status', text: STATUS_3});
  await answer.push({type: 'text', delta: 'Retried words.'});
  await answer.end();
  assert.deepStrictEqual(screen(page), [
    'words: Earlier words. ',
    'notice: ' + STATUS_2,
    'notice: ' + STATUS_3,
    'words: Retried words.',
  ]);
  assert.strictEqual(copyLastAnswer(page), 'Earlier words. Retried words.');
});

test('(f) a subagent retried in its second model call keeps its first call: reasoning and finished step', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push(subagent('s1', 'running', 'Check Screen2'));
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Plan A. ', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:1:call_1', name: 'read_file', state: 'done', label: 'Read Screen2',
    sub: 's1'});
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Plan B. ', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:2:call_1', name: 'read_file', state: 'running', label: 'Read Screen3',
    sub: 's1'});
  await answer.push({type: 'reset', sub: 's1'});
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen2')), 'Plan A. ');
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (done)']);
  await answer.push({type: 'status', text: STATUS_2, sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Plan B again. ', sub: 's1'});
  await answer.push(subagent('s1', 'done', 'Check Screen2', 'Screen2 is fine.'));
  await answer.end();
  const card = subCard(page, 'Check Screen2');
  assert.strictEqual(cardReasoning(card), 'Plan A. Plan B again. ');
  assert.deepStrictEqual(cardSteps(card), ['Read Screen2 (done)']);
  assert.deepStrictEqual(cardLines(card), [STATUS_2]);
  assert.strictEqual(cardReport(card), 'Screen2 is fine.');
});

test('(g) a reset with a sub leaves the companion reasoning and steps alone, a running one included', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push({type: 'reasoning', delta: 'Companion plan. '});
  await answer.push({type: 'text', delta: 'Companion words. '});
  await answer.push({type: 'tool', id: 's2:call_1', name: 'check_project', state: 'done', label: 'Check project'});
  await answer.push({type: 'tool', id: 's2:call_2', name: 'read_file', state: 'running', label: 'Read Screen1'});
  await answer.push(subagent('s1', 'running', 'Check Screen2'));
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Sub plan. ', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:1:call_1', name: 'read_file', state: 'running', label: 'Read Screen2',
    sub: 's1'});
  await answer.push({type: 'reset', sub: 's1'});
  assert.deepStrictEqual(screen(page), [
    'reasoning: Companion plan. ',
    'words: Companion words. ',
    'step Check project (done)',
    'step Read Screen1 (running)',
    'subagent: Check Screen2',
  ]);
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen2')), null);
  await answer.push({type: 'tool', id: 's2:call_2', name: 'read_file', state: 'done', label: 'Read Screen1'});
  await answer.push(subagent('s1', 'done', 'Check Screen2', 'Screen2 is fine.'));
  await answer.push({type: 'text', delta: 'Done.'});
  await answer.end();
  assert.deepStrictEqual(screen(page), [
    'reasoning: Companion plan. ',
    'words: Companion words. ',
    'step Check project (done)',
    'step Read Screen1 (done)',
    'subagent: Check Screen2',
    'words: Done.',
  ]);
});

test('(h) a second failed try of a subagent takes back only its own reasoning and steps', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push(subagent('s1', 'running', 'Check Screen2'));
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Plan A. ', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:1:call_1', name: 'read_file', state: 'done', label: 'Read Screen2',
    sub: 's1'});
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Plan B. ', sub: 's1'});
  await answer.push({type: 'reset', sub: 's1'});
  await answer.push({type: 'status', text: STATUS_2, sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Retry one. ', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:2:call_1', name: 'read_file', state: 'running', label: 'Read Screen3',
    sub: 's1'});
  await answer.push({type: 'reset', sub: 's1'});
  assert.strictEqual(cardReasoning(subCard(page, 'Check Screen2')), 'Plan A. ');
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (done)']);
  await answer.push({type: 'status', text: STATUS_3, sub: 's1'});
  await answer.push({type: 'reasoning', delta: 'Retry two. ', sub: 's1'});
  await answer.push(subagent('s1', 'done', 'Check Screen2', 'Screen2 is fine.'));
  await answer.end();
  const card = subCard(page, 'Check Screen2');
  assert.strictEqual(cardReasoning(card), 'Plan A. Retry two. ');
  assert.deepStrictEqual(cardSteps(card), ['Read Screen2 (done)']);
  assert.deepStrictEqual(cardLines(card), [STATUS_2, STATUS_3]);
  assert.strictEqual(cardReport(card), 'Screen2 is fine.');
});

test('(i) a step running when a subagent model call begins is not taken back by a reset of that call', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'First question');
  await answer.push({type: 'step'});
  await answer.push(subagent('s1', 'running', 'Check Screen2'));
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:1:call_1', name: 'read_file', state: 'running', label: 'Read Screen2',
    sub: 's1'});
  await answer.push({type: 'step', sub: 's1'});
  await answer.push({type: 'tool', id: 's1:2:call_1', name: 'read_file', state: 'running', label: 'Read Screen3',
    sub: 's1'});
  await answer.push({type: 'reset', sub: 's1'});
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (running)']);
  await answer.push({type: 'tool', id: 's1:1:call_1', name: 'read_file', state: 'done', label: 'Read Screen2',
    sub: 's1'});
  await answer.push(subagent('s1', 'done', 'Check Screen2', 'Screen2 is fine.'));
  await answer.end();
  assert.deepStrictEqual(cardSteps(subCard(page, 'Check Screen2')), ['Read Screen2 (done)']);
});
