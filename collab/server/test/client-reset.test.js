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
  // A select's options are the option children it holds.
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
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
  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    node.remove();
    p.children[i] = node;
    node.parentNode = p;
    this.parentNode = null;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  // The listener is kept, so a test can fire it (see fire()).
  addEventListener(type, listener) { this._listeners = this._listeners || {}; this._listeners[type] = listener; }
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

// The page's own HTML: the ids it has, and the tag each one is. The window asks for no other element, so a control
// taken off the page comes back as null here, as it would in a browser.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'ai', 'index.html'), 'utf8');
const PAGE_IDS = new Map();
for (const m of HTML.matchAll(/<(\w+)\b[^>]*?\sid="([^"]+)"/g)) PAGE_IDS.set(m[2], m[1]);

// What GET /collab/ai/presets gives: every service with its models, which of them are locked or not set up, the service in
// use, and the defaults. OpenRouter's Smart model takes max reasoning; the others do not.
const OR_PRESETS = [
  {id: 'smart', label: 'Smart', name: 'Claude Haiku 5.5', model: 'anthropic/claude-haiku-5.5',
    reasoningLevels: ['default', 'low', 'medium', 'high', 'max']},
  {id: 'balanced', label: 'Balanced', name: 'Ling 3.1 Flash', model: 'inclusionai/ling-3.1-flash',
    reasoningLevels: ['default', 'low', 'medium', 'high']},
  {id: 'fast', label: 'Fast', name: 'Ling 3 Flash', model: 'inclusionai/ling-3.0-flash',
    reasoningLevels: ['default', 'low', 'medium', 'high']},
];
const OC_PRESETS = [
  {id: 'smart', label: 'Smart', name: 'Muse Spark 1.3', model: 'muse-spark-1.3-contributor', reasoningLevels: ['default']},
  {id: 'balanced', label: 'Balanced', name: 'Step 5 Preview', model: 'step-5-preview-free', reasoningLevels: ['default']},
  {id: 'fast', label: 'Fast', name: 'DeepSeek V4.1 Flash', model: 'deepseek-v4.1-flash', reasoningLevels: ['default']},
];
const OPENROUTER = {
  service: {id: 'openrouter', name: 'OpenRouter'},
  beta: {on: false, until: 0},
  providers: [
    {id: 'openrouter', name: 'OpenRouter', configured: true, locked: false, presets: OR_PRESETS},
    {id: 'opencode', name: 'OpenCode Go', configured: true, locked: true, presets: OC_PRESETS},
  ],
  presets: OR_PRESETS,
  defaultProvider: 'openrouter',
  defaultPreset: 'balanced',
  defaultReasoning: 'default',
};
const OPENCODE = {
  service: {id: 'opencode', name: 'OpenCode Go'},
  beta: {on: true, until: 1900000000000},
  providers: [
    {id: 'openrouter', name: 'OpenRouter', configured: true, locked: false, presets: OR_PRESETS},
    {id: 'opencode', name: 'OpenCode Go', configured: true, locked: false, presets: OC_PRESETS},
  ],
  presets: OC_PRESETS,
  defaultProvider: 'opencode',
  defaultPreset: 'balanced',
  defaultReasoning: 'default',
};

// What a fetch gives the window back: its status, and the body as JSON or as text.
function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(JSON.parse(text)), text: () => Promise.resolve(text)};
}

// A page: the window's script running in its own context, the elements it asks for, and the streams it is given.
// The options: local (what this computer remembers, shared by the pages that are given it), presets (the answer to
// GET /collab/ai/presets; without it the route is not set up), status (the answer to GET /collab/ai/status).
function openPage(options = {}) {
  const elements = Object.create(null);
  const local = options.local || {};
  const page = {answers: [], applyReplies: [], sent: [], applied: [], stored: {}, local, clipboard: [], window: null,
    document: null};
  page.document = {
    createElement: tag => new Elem(tag),
    createTextNode: text => new Elem(null, text),
    getElementById: id => {
      if (!PAGE_IDS.has(id)) return null;
      if (!elements[id]) elements[id] = Object.assign(new Elem(PAGE_IDS.get(id)), {id});
      return elements[id];
    },
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
    localStorage: {
      getItem: key => (Object.prototype.hasOwnProperty.call(local, key) ? local[key] : null),
      setItem: (key, value) => { local[key] = String(value); },
      removeItem: key => { delete local[key]; },
    },
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
      if (url === '/collab/ai/stream') {
        page.sent.push(JSON.parse(init.body));
        const next = page.answers.shift();
        if (!next) return Promise.reject(new Error('the window asked for an answer that was not set up'));
        return Promise.resolve(next);
      }
      if (url === '/collab/ai/apply') {
        page.applied.push(JSON.parse(init.body));
        return Promise.resolve(page.applyReplies.length ? page.applyReplies.shift() : reply(200, {ok: true}));
      }
      if (url === '/collab/ai/presets') {
        return Promise.resolve(options.presets ? reply(200, options.presets) : reply(404, {}));
      }
      if (url.indexOf('/collab/ai/status') === 0) {
        return Promise.resolve(reply(200, Object.assign({configured: true, search: false, vision: false, name: 'Ana',
          fullUntil: 0, running: false, question: '', beta: {on: false, until: 0}}, options.status)));
      }
      return Promise.resolve(reply(404, {}));   // the stop route, and anything else: not set up here
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
  {type: 'subagent', id, state, model: 'm1', name: 'Model one', reasoning: 'high', task, steps: 1},
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

test('(j) /beta: its PIN is hidden on screen, and kept out of the conversation the window sends next, like /override', async () => {
  const page = openPage();
  const answer = startAnswer(page, '/beta 12345');
  await answer.push({type: 'text', delta: 'OpenCode Go models are on for you until 10:00.'});
  await answer.end();
  assert.deepStrictEqual(page.sent[0].messages, [{role: 'user', content: '/beta 12345'}], 'the server gets the command itself');
  const rows = page.document.getElementById('messages').querySelectorAll('.msg.user');
  assert.strictEqual(rows[rows.length - 1].querySelector('.bubble').textContent, '/beta (PIN hidden)');
  const next = startAnswer(page, 'hi');
  await next.push({type: 'text', delta: 'Hello.'});
  await next.end();
  assert.deepStrictEqual(page.sent[1].messages, [{role: 'user', content: 'hi'}], 'the PIN is not in the history');
});

// The reasoning list's options, as the person sees them.
function reasoningOptions(page) {
  return page.document.getElementById('pickReasoning').options.map(o => o.textContent);
}

// The person picks a reasoning effort, or ticks or unticks the fast subagent box (the page's own change handlers run).
function chooseReasoning(page, level) {
  const select = page.document.getElementById('pickReasoning');
  select.value = level;
  select.onchange();
}

function setFastSub(page, on) {
  const box = page.document.getElementById('fastSub');
  box.checked = on;
  box.onchange();
}

// Fires a listener the page set on an element (the box's 'input' event, say).
function fire(el, type) {
  el._listeners[type]();
}

test('(k) the question is sent with the service, model, effort, reasoning and fast subagent choice, and no run mode', async () => {
  const page = openPage({presets: OPENROUTER});
  await flush();
  const answer = startAnswer(page, 'Question');
  await answer.end();
  assert.deepStrictEqual(Object.keys(page.sent[0]).sort(),
    ['effort', 'fastSubagent', 'messages', 'preset', 'projectId', 'provider', 'reasoning']);
  assert.strictEqual(page.sent[0].projectId, '5');
  assert.strictEqual(page.sent[0].provider, 'openrouter');
  assert.strictEqual(page.sent[0].preset, 'balanced');
  assert.strictEqual(page.sent[0].effort, 'medium');
  assert.strictEqual(page.sent[0].reasoning, 'default');
  assert.strictEqual(page.sent[0].fastSubagent, false);
});

test('(l) the mode, smart and ultracode controls are not on the page; the service, model and effort are', () => {
  const page = openPage();
  ['pickMode', 'smartBtn', 'smartLine'].forEach(id => {
    assert.strictEqual(page.document.getElementById(id), null, id + ' is not on the page');
  });
  ['pickProvider', 'pickModel', 'pickReasoning', 'effort', 'effortOut', 'fastSub'].forEach(id => {
    assert.ok(page.document.getElementById(id), id + ' is on the page');
  });
  assert.doesNotMatch(HTML, /smart|ultracode|parallel|id="pickMode"/i);
  assert.match(HTML, /<span>Service:<\/span>/);
  assert.match(HTML, /<span>Model:<\/span>/);
  const input = page.document.getElementById('input');
  input.value = '/';
  fire(input, 'input');
  const shown = page.document.getElementById('slash').children.map(row => row.children[0].textContent);
  assert.deepStrictEqual(shown,
    ['/goal', '/plan', '/check', '/explain', '/fix', '/reasoning', '/model', '/effort', '/override', '/beta', '/discard', '/new', '/help']);
});

test('(m) /reasoning takes default, low, medium or high; max only on the Smart model; /help lists the commands that remain', () => {
  const page = openPage();
  page.window.__aiHelper.send('/reasoning max');
  assert.strictEqual(page.sent.length, 0, 'a local command never reaches the model');
  assert.match(lastAnswer(page).querySelector('.md').textContent, /Max reasoning is only for the Smart model\./);
  page.window.__aiHelper.send('/reasoning medium');
  assert.match(lastAnswer(page).querySelector('.md').textContent, /Reasoning effort is now \*\*Medium\*\*\./);
  assert.strictEqual(page.local['aihelper.reasoning'], 'medium');
  page.window.__aiHelper.send('/help');
  const help = lastAnswer(page).querySelector('.md').textContent;
  assert.match(help, /`\/reasoning default`, `low`, `medium` or `high`/);
  assert.match(help, /\/model smart/);
  assert.match(help, /\/effort low/);
  assert.doesNotMatch(help, /\/mode\b|\/smart\b/);
  assert.strictEqual(page.sent.length, 0);
});

test('(n) the reasoning list offers only the levels of the model in use, and is labelled Reasoning effort', async () => {
  const page = openPage({presets: OPENROUTER});
  await flush();
  const picker = page.document.getElementById('pickReasoning');
  assert.deepStrictEqual(reasoningOptions(page), ['Default', 'Low', 'Medium', 'High', 'Max']);
  assert.deepStrictEqual(picker.options.map(o => !o.disabled), [true, true, true, true, false], 'Max is for the Smart model');
  assert.strictEqual(picker.value, 'default');
  assert.match(HTML, /<span>Reasoning effort:<\/span>\s*<select id="pickReasoning" aria-label="Reasoning effort">/);
  const other = openPage({presets: OPENCODE});
  await flush();
  assert.deepStrictEqual(other.document.getElementById('pickReasoning').options.filter(o => !o.disabled).map(o => o.textContent),
    ['Default'], 'OpenCode Go offers no reasoning levels');
});

test('(o) the reasoning picked is sent and remembered; a service that offers only Default sends Default and keeps the pick', async () => {
  const local = {};
  const page = openPage({presets: OPENROUTER, local});
  await flush();
  chooseReasoning(page, 'high');
  assert.strictEqual(local['aihelper.reasoning'], 'high');
  const first = startAnswer(page, 'Question one');
  await first.end();
  assert.strictEqual(page.sent[0].reasoning, 'high');

  const other = openPage({presets: OPENCODE, local});
  await flush();
  const second = startAnswer(other, 'Question two');
  await second.end();
  assert.strictEqual(other.sent[0].reasoning, 'default');
  assert.strictEqual(local['aihelper.reasoning'], 'high', 'the pick is kept for when the service offers it again');
});

test('(p) the fast subagent box is unchecked by default, is sent as fastSubagent, is remembered, and its tooltip names the model it picks', async () => {
  const local = {};
  const page = openPage({presets: OPENROUTER, local});
  await flush();
  const box = page.document.getElementById('fastSub');
  const tip = page.document.getElementById('fastPick');
  assert.strictEqual(box.checked, false, 'unchecked by default');
  assert.strictEqual(tip.title,
    'Subagents use Ling 3.1 Flash, the balanced model of OpenRouter, the same model as the answers.');
  const first = startAnswer(page, 'Question one');
  await first.end();
  assert.strictEqual(page.sent[0].fastSubagent, false);

  setFastSub(page, true);
  assert.strictEqual(local['aihelper.fastSub'], 'true');
  assert.strictEqual(tip.title, 'Subagents use Ling 3 Flash, the fast model of OpenRouter.');
  const second = startAnswer(page, 'Question two');
  await second.end();
  assert.strictEqual(page.sent[1].fastSubagent, true);

  // The choice stays on this computer: a window opened again starts checked, and names the fast model of its service.
  const again = openPage({presets: OPENCODE, local});
  await flush();
  assert.strictEqual(again.document.getElementById('fastSub').checked, true);
  assert.strictEqual(again.document.getElementById('fastPick').title,
    'Subagents use DeepSeek V4.1 Flash, the fast model of OpenCode Go.');
});

test('(p2) before the presets answer, the fast subagent tooltip names no model', () => {
  const page = openPage();
  assert.strictEqual(page.document.getElementById('fastPick').title,
    'Subagents use the balanced model, the same as the answers.');
});

test('(q) an Apply the server refuses shows the server reason; a later Apply that works clears it', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'Make the label blue');
  await answer.push({type: 'proposal', id: 'p1', summary: 'Blue label', files: [{path: 'Screen1.scm', isNew: false}],
    media: []});
  await answer.end();
  const row = lastAnswer(page);
  const button = row.querySelector('.apply');
  const note = row.querySelector('.note');
  page.applyReplies.push(reply(409, {error: 'No file would change, so nothing was applied. Ask again for a real change.'}));
  button.onclick();
  await flush();
  assert.deepStrictEqual(page.applied[0], {projectId: '5', id: 'p1'});
  assert.strictEqual(note.textContent, 'No file would change, so nothing was applied. Ask again for a real change.');
  assert.strictEqual(note.classList.contains('err'), true);
  assert.strictEqual(button.disabled, false, 'Apply can be pressed again');
  assert.strictEqual(button.textContent, 'Apply');

  page.applyReplies.push(reply(502, 'Bad Gateway'));   // a plain-text answer still says what happened
  button.onclick();
  await flush();
  assert.strictEqual(note.textContent, 'The server did not apply this change (error 502).');

  button.onclick();   // no reply set: the server applies it
  await flush();
  assert.strictEqual(note.textContent, 'The App Inventor tab reloads by itself to show it');
  assert.strictEqual(note.classList.contains('err'), false, 'the error is not shown any more');
  assert.strictEqual(row.querySelector('.card.proposal').classList.contains('applied'), true);
  assert.strictEqual(row.querySelector('.done-tag').textContent, '✓ Applied');
});

test('(r) a subagent card shows its model and reasoning, with no tier label, and a queued card shows no state', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'Question');
  await answer.push({type: 'step'});
  // An older server may still send a tier and the queued state: neither is shown.
  await answer.push({type: 'subagent', id: 's1', state: 'queued', tier: 'smart', name: 'Model one', model: 'm1',
    reasoning: 'high', task: 'Check Screen2', steps: 0});
  const card = subCard(page, 'Check Screen2');
  assert.strictEqual(card.querySelector('.sa-tier'), null, 'no tier label');
  assert.strictEqual(card.className, 'card subagent', 'queued is not a state any more');
  assert.strictEqual(card.querySelector('.sa-state').textContent, '');
  assert.strictEqual(card.querySelector('.sa-model').textContent, 'Model one');
  assert.strictEqual(card.querySelector('.sa-eff').textContent, 'reasoning high');
  await answer.end();
});

test('(s) a cooldown event from an older server is ignored', async () => {
  const page = openPage();
  const answer = startAnswer(page, 'Question');
  await answer.push({type: 'text', delta: 'Words.'});
  await answer.push({type: 'cooldown', smartReadyInSeconds: 600});
  await answer.end();
  assert.deepStrictEqual(screen(page), ['words: Words.']);
});

test('(t) the choices kept on this computer are used again; the run mode key is no longer read', async () => {
  const local = {'aihelper.model': 'fast', 'aihelper.mode': 'ultracode', 'aihelper.provider': 'openrouter',
    'aihelper.effort': 'high', 'aihelper.reasoning': 'low'};
  const page = openPage({presets: OPENROUTER, local});
  await flush();
  assert.strictEqual(page.document.getElementById('pickModel').value, 'fast');
  assert.strictEqual(page.document.getElementById('pickProvider').value, 'openrouter');
  const answer = startAnswer(page, 'Question');
  await answer.end();
  assert.strictEqual(page.sent[0].reasoning, 'low');
  assert.strictEqual(page.sent[0].preset, 'fast');
  assert.strictEqual(page.sent[0].effort, 'high');
  assert.strictEqual('runMode' in page.sent[0], false);
});

test('(u) the full-app pill and the picture button follow the status', async () => {
  const page = openPage({status: {vision: true, fullUntil: Date.now() + 10 * 60000}});
  await flush();
  const pill = page.document.getElementById('modeBtn');
  assert.strictEqual(pill.textContent, 'Full apps · 10 min');
  assert.strictEqual(pill.classList.contains('full'), true);
  assert.strictEqual(page.document.getElementById('attach').hidden, false, 'the model takes pictures');
  assert.strictEqual(page.document.getElementById('sub').textContent, 'Signed in as Ana');
});
