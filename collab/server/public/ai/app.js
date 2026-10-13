// The AI helper's window. The server streams its answer as events (see collab/server/ai.js); this file
// shows each one as it arrives: text as it is written, the model's reasoning, tool steps as chips,
// subagents as cards, pictures, proposals with Apply, the plan for a goal, and notices. Everything the
// model writes is sanitised before it is shown; text from the server is shown as text.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var projectId = params.get('projectId') || '';
  var STORE = 'aihelper.' + projectId;
  var CFG = window.__aiHelperConfig || {};
  var SILENCE_MS = CFG.silenceMs || 30000;      // nothing at all from the server for this long: reconnect
  var MAX_RECONNECTS = CFG.reconnects || 40;
  var $ = function (id) { return document.getElementById(id); };
  var chat = $('chat');
  var list = $('messages');
  var empty = $('empty');
  var input = $('input');
  var sendBtn = $('send');
  var jump = $('jump');
  var modeBtn = $('modeBtn');
  var goalBar = $('goalBar');
  var slash = $('slash');
  var STAR = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';
  var COPY = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var RETRY = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/></svg>';
  // The slash menu. Some commands are handled here, some by the server, and /check, /explain and /fix are
  // questions the window sends to the model for the person. /reasoning sets the choice under the box.
  var COMMANDS = [
    {cmd: '/goal', help: 'Work toward a goal in steps, with a plan'},
    {cmd: '/plan', help: 'Plan a change, without changing anything'},
    {cmd: '/check', help: 'Check the project and say what is wrong'},
    {cmd: '/explain', help: 'Explain how the project works'},
    {cmd: '/fix', help: 'Make the smallest change that fixes one problem'},
    {cmd: '/reasoning', help: 'How hard the model thinks: default, low, medium or high'},
    {cmd: '/model', help: 'Which model answers: smart, balanced or fast'},
    {cmd: '/effort', help: 'How hard the helper works: low, medium or high'},
    {cmd: '/override', help: 'Full-app mode, with the PIN'},
    {cmd: '/beta', help: 'OpenCode Go models, with the same PIN'},
    {cmd: '/discard', help: 'Throw away an unfinished full app'},
    {cmd: '/new', help: 'Start a new conversation'},
    {cmd: '/help', help: 'List the commands'},
  ];

  var history = [];       // what the model sees: {role, content}
  var controller = null;  // the running answer, if any
  var stick = true;       // keep the newest text in view
  var fullUntil = 0;
  var goalStarted = 0;
  var goalTimer = null;
  var goalSteps = null;
  var slashIndex = 0;

  DOMPurify.addHook('afterSanitizeAttributes', function (node) {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Raw HTML in the model's words is sanitised: scripts, event handlers and javascript: links go. Pictures and
  // drawings are not written inline (they come as picture cards), so img, svg and math are dropped too.
  function render(md) {
    var html = marked.parse(md || '', {breaks: true, gfm: true});
    return DOMPurify.sanitize(html, {FORBID_TAGS: ['img', 'style', 'form', 'input', 'svg', 'math'], FORBID_ATTR: ['style']});
  }

  function enhanceCode(root) {
    root.querySelectorAll('pre').forEach(function (pre) {
      if (pre.parentNode.classList.contains('codebox')) return;
      var box = el('div', 'codebox');
      var head = el('div', 'codehead');
      var code = pre.querySelector('code');
      var lang = code && /language-(\S+)/.exec(code.className);
      head.appendChild(el('span', '', lang ? lang[1] : 'code'));
      var copy = el('button', 'copy', 'Copy');
      copy.type = 'button';
      copy.onclick = function () {
        if (navigator.clipboard) navigator.clipboard.writeText(pre.innerText);
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1400);
      };
      head.appendChild(copy);
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(head);
      box.appendChild(pre);
    });
  }

  function renderInto(node, md) {
    node.innerHTML = render(md);
    enhanceCode(node);
  }

  function keepBottom() {
    if (stick) {
      chat.scrollTop = chat.scrollHeight;
    } else {
      jump.hidden = false;
    }
  }

  chat.addEventListener('scroll', function () {
    stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    if (stick) jump.hidden = true;
  });
  // The "New messages" pill sits just above the box, whatever the box's height (it grows with the pickers).
  var composerBox = $('composer');
  function placeJump() {
    document.documentElement.style.setProperty('--composer-h', composerBox.offsetHeight + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(placeJump).observe(composerBox);
  window.addEventListener('resize', placeJump);
  placeJump();
  jump.onclick = function () {
    stick = true;
    chat.scrollTo({top: chat.scrollHeight, behavior: 'smooth'});
    jump.hidden = true;
  };

  function hideEmpty() {
    empty.hidden = true;
  }

  function addUser(text, images) {
    hideEmpty();
    var row = el('div', 'msg user');
    if (images && images.length) {
      var strip = el('div', 'thumbs');
      images.forEach(function (p) {
        var t = el('div', 'thumb');
        var img = document.createElement('img');
        img.alt = p.name;
        img.src = p.url;
        t.appendChild(img);
        strip.appendChild(t);
      });
      row.appendChild(strip);
    }
    row.appendChild(el('div', 'bubble', text));
    list.appendChild(row);
    keepBottom();
    return row;
  }

  // One assistant answer, built up as its events arrive.
  function newAssistant() {
    hideEmpty();
    var row = el('div', 'msg assistant');
    var av = el('div', 'avatar');
    av.innerHTML = STAR;
    var turn = el('div', 'turn');
    var thinking = el('div', 'thinking');
    thinking.innerHTML = '<i></i><i></i><i></i>';
    turn.appendChild(thinking);
    row.appendChild(av);
    row.appendChild(turn);
    list.appendChild(row);
    keepBottom();

    // mark: where the answer stood before the model call being written (see api.step). Until the first step, it is the
    // start of the answer.
    var api = {row: row, turn: turn, thinking: thinking, cur: null, raw: '', full: '', chips: Object.create(null),
      subs: Object.create(null), think: null, thinkText: null, reasonText: '', planEl: null, scheduled: false,
      texts: [], mark: {full: 0, reason: 0, blocks: 0, chips: []}};

    function closeText() {
      if (api.cur) {
        renderInto(api.cur, api.raw);
        api.cur.classList.remove('streaming');
        api.cur = null;
      }
    }
    api.block = function (node) {
      closeText();
      turn.appendChild(node);
      keepBottom();
    };
    api.text = function (delta) {
      if (thinking.parentNode) thinking.remove();
      if (!api.cur) {
        api.cur = el('div', 'md streaming');
        api.raw = '';
        turn.appendChild(api.cur);
        api.texts.push(api.cur);   // every block of this answer's words, open or closed by a step or a card since
      }
      api.raw += delta;
      api.full += delta;
      if (!api.scheduled) {
        api.scheduled = true;
        requestAnimationFrame(function () {
          api.scheduled = false;
          if (api.cur) renderInto(api.cur, api.raw);
          keepBottom();
        });
      }
    };
    // The model's own reasoning, in a block above the answer. The block is made when the first of it arrives.
    api.reason = function (delta) {
      if (!api.think) {
        api.think = el('details', 'think');
        api.think.appendChild(el('summary', '', 'Thinking'));
        api.thinkText = el('div', 'think-text');
        api.think.appendChild(api.thinkText);
        turn.insertBefore(api.think, turn.firstChild);
      }
      api.reasonText += delta;
      api.thinkText.appendChild(document.createTextNode(delta));
      keepBottom();
    };
    // Before each model call of the companion (the server's step event): where the answer stands. The words so far are
    // closed into their block first, so the words of the call that follows go into blocks of their own.
    api.step = function () {
      closeText();
      api.mark = {full: api.full.length, reason: api.reasonText.length, blocks: api.texts.length,
        chips: Object.keys(api.chips)};
    };
    // The service was tried again. What the failed try showed is taken back, and only that: the words written since the
    // step (also those in blocks a step or a card has closed since, so the retry is not shown twice), its reasoning, and
    // its steps still running. What earlier model calls of this answer wrote stays. The mark is not dropped: it still
    // stands where the answer now ends, so a try that fails again takes back only what that try wrote.
    api.resetText = function () {
      var m = api.mark;
      api.texts.splice(m.blocks).forEach(function (t) { t.remove(); });
      api.cur = null;
      api.raw = '';
      api.full = api.full.slice(0, m.full);
      api.reasonText = api.reasonText.slice(0, m.reason);
      if (api.think) {
        if (api.reasonText) {
          api.thinkText.textContent = api.reasonText;
        } else {
          api.think.remove();
          api.think = null;
          api.thinkText = null;
        }
      }
      Object.keys(api.chips).forEach(function (id) {   // a step still running that the failed try began
        var c = api.chips[id];
        if (c.parentNode === turn && c.classList.contains('running') && m.chips.indexOf(id) < 0) {
          c.remove();
          delete api.chips[id];
        }
      });
    };
    // A long quiet stretch (the model is thinking, or writing something big) says so, instead of looking stuck.
    var quietSince = Date.now();
    var hint = null;
    var ticker = setInterval(function () {
      var s = Math.floor((Date.now() - quietSince) / 1000);
      if (s < 12) return;
      if (!hint) {
        hint = el('div', 'waiting');
        turn.appendChild(hint);
        keepBottom();
      }
      hint.textContent = 'Still working… ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }, 1000);
    api.alive = function () {
      quietSince = Date.now();
      if (hint) {
        hint.remove();
        hint = null;
      }
    };
    api.finish = function () {
      clearInterval(ticker);
      if (hint) hint.remove();
      if (thinking.parentNode) thinking.remove();
      closeText();
      Object.keys(api.subs).forEach(function (id) {   // a subagent still going when the answer ends was stopped
        var s = api.subs[id];
        if (s.ended) return;
        s.card.className = 'card subagent stopped';
        s.state.textContent = 'Stopped';
      });
      var acts = el('div', 'row-actions keep');
      var copy = el('button', 'iconbtn');
      copy.type = 'button';
      copy.title = 'Copy the answer';
      copy.innerHTML = COPY;
      copy.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(api.full); };
      acts.appendChild(copy);
      if (api.full) turn.appendChild(acts);
      api.acts = acts;
    };
    return api;
  }

  function chip(api, ev) {
    var c = api.chips[ev.id];
    if (!c) {
      c = el('div', 'chip');
      c.appendChild(el('span', 'ico'));
      c.appendChild(el('span', 'label'));
      c.appendChild(el('span', 'detail'));
      api.chips[ev.id] = c;
      if (ev.sub) subCard(api, ev.sub).chips.appendChild(c);   // a step of a subagent: inside its card
      else api.block(c);
    }
    c.className = 'chip ' + ev.state;
    c.querySelector('.label').textContent = ev.label;
    c.querySelector('.detail').textContent = ev.detail ? '· ' + ev.detail : '';
    c.querySelector('.ico').innerHTML = ev.state === 'error' ? CROSS : ev.state === 'done' ? CHECK : '';
  }

  function picture(api, ev) {
    var fig = el('figure', 'art');
    var box = el('div', 'checker');
    var img = document.createElement('img');
    img.alt = ev.title || 'picture';
    img.src = '/collab/ai/artifact?id=' + encodeURIComponent(ev.id);
    if (ev.width) img.width = Math.min(ev.width, 280);
    box.appendChild(img);
    var cap = el('figcaption');
    var what = ev.kind === 'svg' ? 'SVG' : ev.kind === 'png' ? 'PNG' : 'picture';
    cap.appendChild(el('span', '', (ev.title || 'Picture') + (ev.width ? ' · ' + ev.width + ' × ' + ev.height : '') + ' · ' + what));
    var link = el('a', '', 'Open');
    link.href = img.src;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    cap.appendChild(link);
    fig.appendChild(box);
    fig.appendChild(cap);
    api.block(fig);
  }

  function proposal(api, ev) {
    var card = el('div', 'card proposal');
    card.appendChild(el('div', 'ctitle', 'Suggested change'));
    card.appendChild(el('div', 'csum', ev.summary));
    var ul = el('ul', 'files');
    ev.files.forEach(function (f) {
      var li = el('li');
      li.appendChild(el('span', 'badge ' + (f.isNew ? 'new' : 'edit'), f.isNew ? 'new' : 'edit'));
      li.appendChild(el('span', '', f.path));
      ul.appendChild(li);
    });
    ev.media.forEach(function (m) {
      var li = el('li');
      li.appendChild(el('span', 'badge picture', 'picture'));
      li.appendChild(el('span', '', m.name + ' · ' + m.width + ' × ' + m.height));
      ul.appendChild(li);
    });
    card.appendChild(ul);
    var actions = el('div', 'actions');
    var btn = el('button', 'apply', 'Apply');
    btn.type = 'button';
    var note = el('span', 'note', 'Backed up first · App Inventor reloads by itself');
    // A failed Apply shows the server's reason, so the person can see why nothing changed.
    function failed(reason) {
      btn.disabled = false;
      btn.textContent = 'Apply';
      note.textContent = reason;
      note.classList.add('err');
    }
    btn.onclick = function () {
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Applying…';
      note.classList.remove('err');
      fetch('/collab/ai/apply', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'},
        body: JSON.stringify({projectId: projectId, id: ev.id})})
        .then(function (r) {
          // The reason may come as JSON or, from a proxy in front of the server, as plain text: both are read.
          return r.text().then(function (t) {
            var d = {};
            try { d = JSON.parse(t) || {}; } catch (e) { d = {}; }
            return {ok: r.ok, status: r.status, data: d};
          });
        })
        .then(function (x) {
          if (!(x.ok && x.data.ok === true)) {
            failed(typeof x.data.error === 'string' && x.data.error ? x.data.error
              : 'The server did not apply this change (error ' + x.status + ').');
            return;
          }
          card.classList.add('applied');
          btn.replaceWith(el('span', 'done-tag', '✓ Applied'));
          note.textContent = 'The App Inventor tab reloads by itself to show it';
          // The App Inventor window that opened this one reloads too, in case the team server's message did not come.
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({t: 'aicollab-applied', projectId: projectId}, location.origin);
          }
        }, function () {
          failed('Could not reach the team server.');
        });
    };
    actions.appendChild(btn);
    actions.appendChild(note);
    card.appendChild(actions);
    api.block(card);
  }

  var PLAN_ICON = {done: CHECK, doing: '', todo: ''};
  function plan(api, steps) {
    if (!api.planEl) {
      api.planEl = el('div', 'card plan');
      api.planEl.appendChild(el('div', 'ctitle', 'Plan'));
      api.planEl.appendChild(el('ol'));
      api.block(api.planEl);
    }
    var ol = api.planEl.querySelector('ol');
    ol.textContent = '';
    steps.forEach(function (s) {
      var li = el('li', s.status === 'done' ? 'done' : '');
      var ps = el('span', 'ps ' + s.status);
      ps.innerHTML = PLAN_ICON[s.status] || '';
      li.appendChild(ps);
      li.appendChild(el('span', 't', s.text));
      ol.appendChild(li);
    });
    goalUpdate(steps);
  }

  // ---- subagents: a card each, with its steps as chips, its reasoning and its report ----

  var SUB_STATES = {running: 'Running', resting: 'Resting', done: 'Done', failed: 'Failed'};

  function hasOwn(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  // A part of a card that opens and shuts: a summary and a box, hidden until something goes in it.
  function section(title) {
    var box = el('details', 'sa-section');
    box.hidden = true;
    box.appendChild(el('summary', '', title));
    var body = el('div', 'sa-body');
    box.appendChild(body);
    return {box: box, body: body};
  }

  // The card of one subagent, made the first time anything about it arrives. Its text is shown as text only.
  function subCard(api, id) {
    if (api.subs[id]) return api.subs[id];
    var card = el('div', 'card subagent');
    var head = el('div', 'sa-head');
    head.appendChild(el('span', 'ctitle', 'Subagent'));
    var state = el('span', 'sa-state');
    head.appendChild(state);
    var meta = el('div', 'sa-meta');
    var model = el('span', 'sa-model');
    var eff = el('span', 'sa-eff');
    meta.appendChild(model);
    meta.appendChild(eff);
    var task = el('div', 'sa-task');
    var info = el('div', 'sa-info');
    var chips = el('div', 'sa-chips');
    var lines = el('div', 'sa-lines');
    var reason = section('Reasoning');
    var report = section('Report');
    [head, meta, task, info, chips, lines, reason.box, report.box].forEach(function (n) { card.appendChild(n); });
    api.block(card);
    api.subs[id] = {card: card, state: state, model: model, eff: eff, task: task, info: info,
      chips: chips, lines: lines, reason: reason, report: report, ended: false, reasonText: '', mark: null};
    return api.subs[id];
  }

  // The subagent's own event: its model, state and task, and its report once it is done.
  function subagent(api, ev) {
    var s = subCard(api, ev.id);
    var known = hasOwn(SUB_STATES, ev.state) ? ev.state : '';
    s.ended = ev.state === 'done' || ev.state === 'failed';
    s.card.className = 'card subagent' + (known ? ' ' + known : '');
    s.state.textContent = known ? SUB_STATES[known] : '';
    s.model.textContent = ev.name || ev.model || '';
    s.model.title = ev.model || '';
    s.eff.textContent = 'reasoning ' + (ev.reasoning || 'high');
    if (typeof ev.task === 'string') s.task.textContent = ev.task;
    var info = [];
    if (typeof ev.steps === 'number') info.push(ev.steps + (ev.steps === 1 ? ' step' : ' steps'));
    if (ev.detail) info.push(String(ev.detail));
    s.info.textContent = info.join(' · ');
    if (ev.state === 'done' && typeof ev.report === 'string' && ev.report) {
      s.report.body.textContent = ev.report;
      s.report.box.hidden = false;
    }
    keepBottom();
  }

  function subReason(api, ev) {
    var s = subCard(api, ev.sub);
    s.reason.box.hidden = false;
    s.reasonText += String(ev.delta);
    s.reason.body.appendChild(document.createTextNode(String(ev.delta)));
    keepBottom();
  }

  function subStatus(api, ev) {
    subCard(api, ev.sub).lines.appendChild(el('div', 'sa-line', ev.text));
    keepBottom();
  }

  // The ids of the steps of a card that are running now.
  function runningIn(api, s) {
    return Object.keys(api.chips).filter(function (id) {
      return api.chips[id].parentNode === s.chips && api.chips[id].classList.contains('running');
    });
  }

  // Before each model call of a subagent (its step event): the card's reasoning so far and its running steps are
  // recorded, so that a try of this call that fails takes back only what it wrote.
  function subStep(api, ev) {
    var s = subCard(api, ev.sub);
    s.mark = {reason: s.reasonText.length, chips: runningIn(api, s)};
  }

  // A subagent's try was tried again: the reasoning it wrote and the steps still running from it are taken back,
  // so the retry starts clean. The record taken at its step event says where the call began. What its earlier model
  // calls wrote stays, and so do its finished steps, its status lines and every other card. The record is kept: a
  // retry sends no step of its own, so a try that fails again takes back only what that retry wrote.
  function subReset(api, ev) {
    var s = api.subs[ev.sub];
    if (!s) return;
    var m = s.mark || {reason: 0, chips: []};   // no step was recorded: the call began with nothing
    s.reasonText = s.reasonText.slice(0, m.reason);
    s.reason.body.textContent = s.reasonText;
    s.reason.box.hidden = !s.reasonText;
    runningIn(api, s).forEach(function (id) {
      if (m.chips.indexOf(id) < 0) {
        api.chips[id].remove();
        delete api.chips[id];
      }
    });
  }

  function notice(api, text, isError) {
    api.block(el('div', 'notice' + (isError ? ' error' : ''), text));
  }

  // A question the helper asks: the person answers in their next message.
  function question(api, text) {
    var card = el('div', 'notice question');
    card.appendChild(el('strong', '', 'The helper asks: '));
    card.appendChild(document.createTextNode(text));
    api.block(card);
  }

  function onEvent(api, ev) {
    api.alive();
    switch (ev.type) {
      case 'text': api.text(ev.delta); break;
      case 'reasoning':
        if (ev.delta) {
          if (ev.sub) subReason(api, ev);
          else api.reason(String(ev.delta));
        }
        break;
      case 'tool': chip(api, ev); break;
      case 'subagent': subagent(api, ev); break;
      case 'artifact': picture(api, ev); break;
      case 'proposal': proposal(api, ev); break;
      case 'plan': plan(api, ev.steps || []); break;
      case 'status': if (ev.sub) subStatus(api, ev); else notice(api, ev.text, false); break;
      case 'question': question(api, ev.text); break;
      case 'step': if (ev.sub) subStep(api, ev); else api.step(); break;
      case 'reset': if (ev.sub) subReset(api, ev); else api.resetText(); break;
      case 'error': notice(api, ev.message, true); break;
      default: break;
    }
  }

  // Sends the question and reads the answer's events. The answer is worked out on the server, so if the
  // connection drops, or goes silent for SILENCE_MS (the server pings every few seconds, so silence means
  // the connection is dead), the rest of the answer is asked for again, from the last event seen.
  // With no body, an answer that is already being written is picked up from its start.
  function streamRequest(body, signal, onEv, onLink) {
    var lastSeq = 0;
    var finished = false;
    var started = !body;     // has the server taken the question?
    var failures = 0;
    var lost = false;
    var conn = null;
    var quiet = null;

    function aborted() {
      var e = new Error('aborted');
      e.name = 'AbortError';
      return e;
    }
    // Stop means stop: the server keeps working when a connection drops, so it is told.
    signal.addEventListener('abort', function () {
      clearTimeout(quiet);
      if (conn) conn.abort();
      try {
        fetch('/collab/ai/stop', {method: 'POST', credentials: 'same-origin', keepalive: true,
          headers: {'content-type': 'application/json'}, body: JSON.stringify({projectId: projectId})});
      } catch (e) { /* nothing to stop */ }
    });

    function listen() {
      clearTimeout(quiet);
      quiet = setTimeout(function () { if (conn) conn.abort(); }, SILENCE_MS);
    }

    function handle(block) {
      var seq = 0;
      var data = null;
      block.split('\n').forEach(function (line) {
        if (line.indexOf('id:') === 0) seq = parseInt(line.slice(3), 10) || 0;
        else if (line.indexOf('data:') === 0) data = line.slice(5);
      });
      if (data === null || (seq && seq <= lastSeq)) return;
      var ev;
      try { ev = JSON.parse(data); } catch (e) { return; }   // a malformed event is skipped
      if (seq) lastSeq = seq;
      failures = 0;
      if (lost) {
        lost = false;
        onLink('back');
      }
      if (ev.type === 'done') finished = true;
      if (ev.type !== 'ping') onEv(ev);
    }

    function read(response) {
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      listen();
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          listen();
          buf += decoder.decode(chunk.value, {stream: true});
          var cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            handle(block);
          }
          return pump();
        });
      }
      return pump().then(function () { clearTimeout(quiet); }, function (e) { clearTimeout(quiet); throw e; });
    }

    function check(r) {
      if (r.ok) {
        started = true;
        return read(r);
      }
      return r.json().catch(function () { return {}; }).then(function (d) {
        var err = new Error(r.status === 404 ? 'The answer was lost (the server may have restarted). Please ask again.'
          : d.error || 'The helper could not answer.');
        err.fatal = true;   // the server has answered; asking again would not change that
        throw err;
      });
    }

    function first() {
      conn = new AbortController();
      return fetch('/collab/ai/stream', {method: 'POST', credentials: 'same-origin', signal: conn.signal,
        headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(check);
    }

    function resume() {
      conn = new AbortController();
      return fetch('/collab/ai/resume?projectId=' + encodeURIComponent(projectId) + '&after=' + lastSeq,
        {credentials: 'same-origin', signal: conn.signal}).then(check);
    }

    function again() {
      failures++;
      if (!lost) {
        lost = true;
        onLink('lost');
      }
      if (failures > MAX_RECONNECTS) {
        throw new Error('Lost the connection to the helper. Please ask again.');
      }
      return new Promise(function (resolve) { setTimeout(resolve, Math.min(4000, 400 * failures)); }).then(function () {
        if (signal.aborted) throw aborted();
        return run(resume);
      });
    }

    function run(step) {
      return step().then(function () {
        if (finished) return undefined;
        return again();   // the stream ended with no done event: the connection was cut
      }, function (e) {
        if (signal.aborted) throw aborted();
        if (finished) return undefined;
        if ((e && e.fatal) || !started) throw e;
        return again();
      });
    }

    return run(body ? first : resume);
  }

  function setBusy(on) {
    sendBtn.classList.toggle('stop', on);
    sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    sendBtn.disabled = false;
    $('gstop').hidden = !on;
  }

  // ---- /goal progress ----

  function startGoal(text) {
    goalBar.hidden = false;
    goalBar.classList.remove('finished');
    goalBar.querySelector('.gstate').textContent = 'Working toward the goal';
    goalBar.querySelector('.gtext').textContent = text;
    goalBar.querySelector('.gprog').textContent = '';
    $('gfill').style.width = '0%';
    goalStarted = Date.now();
    goalSteps = null;
    clearInterval(goalTimer);
    goalTimer = setInterval(tickGoal, 1000);
    tickGoal();
  }

  function tickGoal() {
    var s = Math.floor((Date.now() - goalStarted) / 1000);
    goalBar.querySelector('.gtime').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function goalUpdate(steps) {
    goalSteps = steps;
    var done = steps.filter(function (s) { return s.status === 'done'; }).length;
    goalBar.querySelector('.gprog').textContent = done + ' of ' + steps.length + ' steps';
    $('gfill').style.width = steps.length ? Math.round(done / steps.length * 100) + '%' : '0%';
  }

  function finishGoal() {
    clearInterval(goalTimer);
    goalBar.classList.add('finished');
    goalBar.querySelector('.gstate').textContent = 'Goal finished';
    $('gfill').style.width = '100%';
    setTimeout(function () { if (!controller) goalBar.hidden = true; }, 9000);
  }

  // ---- sending ----

  function save() {
    try {
      var rows = [];
      list.querySelectorAll('.msg').forEach(function (row) {
        if (row.classList.contains('user')) rows.push({role: 'user', text: row.textContent});
        else if (row.dataset.text) rows.push({role: 'assistant', text: row.dataset.text});
      });
      sessionStorage.setItem(STORE, JSON.stringify({rows: rows.slice(-40), history: history.slice(-40)}));
    } catch (e) {
      // no storage here: the window still works
    }
  }

  function restore() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (!saved || !saved.rows || !saved.rows.length) return;
      hideEmpty();
      saved.rows.forEach(function (r) {
        if (r.role === 'user') {
          addUser(r.text);
        } else {
          var api = newAssistant();
          api.thinking.remove();
          api.full = r.text;
          var md = el('div', 'md');
          api.block(md);
          renderInto(md, r.text);
          api.row.dataset.text = r.text;
          api.finish();
        }
      });
      history = saved.history || [];
      stick = true;
      keepBottom();
    } catch (e) {
      // a damaged saved conversation is ignored
    }
  }

  // ---- effort: how hard the helper works, from the slider under the box (remembered on this computer) ----

  var EFFORTS = ['low', 'medium', 'high'];
  var EFFORT_TEXT = {low: 'Low', medium: 'Medium', high: 'High'};
  var EFFORT_WHAT = {
    low: 'Quick changes, checked once.',
    medium: 'The usual care.',
    high: 'It reads and checks more before it proposes.',
  };
  var effortInput = $('effort');
  var effortOut = $('effortOut');
  var effort = 'medium';
  try {
    var keptEffort = localStorage.getItem('aihelper.effort');
    if (EFFORTS.indexOf(keptEffort) >= 0) effort = keptEffort;
  } catch (e) {
    // no storage here: medium
  }

  function setEffort(level) {
    effort = level;
    effortInput.value = String(EFFORTS.indexOf(level));
    effortInput.setAttribute('aria-valuetext', EFFORT_TEXT[level]);
    effortInput.title = EFFORT_WHAT[level];
    effortOut.textContent = EFFORT_TEXT[level];
    store('aihelper.effort', level);
  }
  effortInput.oninput = function () { setEffort(EFFORTS[Number(effortInput.value)] || 'medium'); };
  setEffort(effort);

  // ---- service, model, reasoning and fast subagent under the box, remembered on this computer. The lists come from
  // GET /collab/ai/presets; the lists here are used only until that call has answered. ----

  var PRESET_IDS = ['smart', 'balanced', 'fast'];
  var REASONS = ['default', 'low', 'medium', 'high', 'max'];
  var REASON_TEXT = {default: 'Default', low: 'Low', medium: 'Medium', high: 'High', max: 'Max'};
  var pickProvider = $('pickProvider');
  var pickModel = $('pickModel');
  var pickReasoning = $('pickReasoning');
  var fastPick = $('fastPick');
  var fastBox = $('fastSub');
  var providers = [];          // every service, as the server lists it: its presets, and whether it is configured or locked
  var provider = 'openrouter'; // the service the answers use
  var preset = 'balanced';     // the model that writes the answers
  var reasoning = 'default';   // the reasoning level the answers use
  var serverDefaults = {provider: 'openrouter', preset: 'balanced', reasoning: 'default'};
  var serviceName = '';        // the name of the service in use, for the tooltip
  var keptProvider = keptChoice('aihelper.provider', ['openrouter', 'opencode']);
  var keptPreset = keptChoice('aihelper.model', PRESET_IDS);
  var keptReasoning = keptChoice('aihelper.reasoning', REASONS);
  var fastSub = readFlag('aihelper.fastSub');

  function keptChoice(key, ids) {
    try {
      var v = localStorage.getItem(key);
      if (ids.indexOf(v) >= 0) return v;
    } catch (e) {
      // no storage here: the default is used
    }
    return null;
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // not remembered
    }
  }

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === 'true';
    } catch (e) {
      return false;   // no storage here: unchecked
    }
  }

  function hasId(x) {
    return !!x && typeof x.id === 'string';
  }

  // The services the person may pick: configured, and open to them (OpenCode Go only with /beta).
  function serviceList() {
    return providers.filter(function (p) { return p.configured && !p.locked; });
  }

  function providerOf(id) {
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === id) return providers[i];
    }
    return null;
  }

  function presetsOf(id) {
    var p = providerOf(id);
    return p && Array.isArray(p.presets) ? p.presets.filter(hasId) : [];
  }

  // The preset of the service in use, by id.
  function presetFor(id) {
    var list = presetsOf(provider);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  // The reasoning levels a model offers, of the ones this window knows. Only the four or five known ones count.
  function reasoningLevelsOf(id) {
    var p = presetFor(id);
    var levels = p && Array.isArray(p.reasoningLevels)
      ? p.reasoningLevels.filter(function (l) { return REASONS.indexOf(l) >= 0; }) : [];
    return levels.length ? levels : ['default', 'low', 'medium', 'high'];
  }

  // Max is only for the preset that lists it (the Smart one).
  function reasonAllowed(level) {
    return reasoningLevelsOf(preset).indexOf(level) >= 0;
  }

  function reasoningInUse() {
    return reasoning;
  }

  function presetText(id) {
    var p = presetFor(id);
    return p ? p.name + ' (' + p.label + ')' : id;
  }

  // The tooltip of the fast subagent box names the model it picks, from the presets response. Until that has
  // answered, it names no model.
  function fastTip() {
    var of = serviceName ? ' of ' + serviceName : '';
    var fast = presetFor('fast');
    var balanced = presetFor('balanced');
    if (fastSub) {
      return fast && fast.name ? 'Subagents use ' + fast.name + ', the fast model' + of + '.' : 'Subagents use the fast model.';
    }
    return balanced && balanced.name
      ? 'Subagents use ' + balanced.name + ', the balanced model' + of + ', the same model as the answers.'
      : 'Subagents use the balanced model, the same as the answers.';
  }

  // Sets the options of a picker. They are only written when their text changes, so a list that is open is not reset
  // when the presets are fetched again.
  function fillPicker(sel, items) {
    var same = sel.options.length === items.length;
    for (var i = 0; same && i < items.length; i++) {
      same = sel.options[i].value === items[i].value && sel.options[i].textContent === items[i].text;
    }
    if (same) return;
    sel.textContent = '';
    items.forEach(function (it) {
      var o = el('option', '', it.text);
      o.value = it.value;
      sel.appendChild(o);
    });
  }

  function syncPickers() {
    var offered = serviceList();
    fillPicker(pickProvider, offered.map(function (p) { return {value: p.id, text: p.name}; }));
    pickProvider.value = provider;
    if (pickProvider.parentNode) pickProvider.parentNode.hidden = offered.length < 2;
    fillPicker(pickModel, presetsOf(provider).map(function (p) { return {value: p.id, text: presetText(p.id)}; }));
    pickModel.value = preset;
    fillPicker(pickReasoning, REASONS.map(function (r) { return {value: r, text: REASON_TEXT[r]}; }));
    pickReasoning.value = reasoning;
    Array.prototype.forEach.call(pickReasoning.options, function (o) { o.disabled = !reasonAllowed(o.value); });
    pickReasoning.title = reasonAllowed('max') ? 'How hard the model thinks'
      : 'How hard the model thinks. Max is only for the Smart model.';
    fastBox.checked = fastSub;
    fastPick.title = fastTip();
  }

  // The choice on this computer wins; then the server's default; then the built-in one.
  function chosen(saved, ids, serverDefault, fallback) {
    if (ids.indexOf(saved) >= 0) return saved;
    return ids.indexOf(serverDefault) >= 0 ? serverDefault : fallback;
  }

  // The reasoning the model in use does not offer is replaced by High when it offers it, Default otherwise.
  function fallbackReasoning() {
    return reasonAllowed('high') ? 'high' : 'default';
  }

  function setReasoning(level) {
    reasoning = level;
    store('aihelper.reasoning', level);
    syncPickers();
  }

  // Returns true when Max was given up because the model changed away from Smart: High is used instead.
  function setPreset(id) {
    preset = id;
    store('aihelper.model', id);
    var clamped = !reasonAllowed(reasoning);
    if (clamped) setReasoning(fallbackReasoning());
    else syncPickers();
    refreshStatus();
    return clamped;
  }

  // Changes the service the answers come from. Its models are the ones listed for it, and the reasoning is set again
  // when the service does not offer the one in use.
  function setProvider(id) {
    provider = id;
    store('aihelper.provider', id);
    var p = providerOf(id);
    serviceName = p ? p.name : '';
    var names = presetsOf(id).map(function (x) { return x.id; });
    if (names.indexOf(preset) < 0) preset = chosen(null, names, serverDefaults.preset, names[0] || 'balanced');
    if (!reasonAllowed(reasoning)) reasoning = fallbackReasoning();
    syncPickers();
    refreshStatus();
  }

  pickProvider.onchange = function () { setProvider(pickProvider.value); };
  pickModel.onchange = function () {
    if (setPreset(pickModel.value)) flash('Max reasoning is only for the Smart model, so high is used.');
  };
  pickReasoning.onchange = function () {
    if (reasonAllowed(pickReasoning.value)) setReasoning(pickReasoning.value);
    else syncPickers();
  };
  fastBox.onchange = function () {
    fastSub = fastBox.checked;
    store('aihelper.fastSub', fastSub ? 'true' : 'false');
    fastPick.title = fastTip();
  };

  // The pictures button and the full-app pill follow the server's status. It is asked for on start and after each
  // answer, since /beta and the pickers change the service and the model (and so the picture answer), and /override
  // turns full-app mode on.
  function applyStatus(s) {
    visionOn = !!s.vision;
    attach.hidden = !visionOn;
    fullUntil = s.fullUntil || 0;
    showMode();
  }

  function refreshStatus() {
    if (!projectId) return;
    fetch('/collab/ai/status?projectId=' + encodeURIComponent(projectId) + '&provider=' + encodeURIComponent(provider) +
      '&preset=' + encodeURIComponent(preset), {credentials: 'same-origin'})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (s) applyStatus(s);
      })
      .catch(function () {
        // the picture button and the pill stay as they are
      });
  }

  // The services, their models and the server's defaults. The choice on this computer is used when the service and the
  // model still offer it.
  function applyPresets(d) {
    providers = (Array.isArray(d.providers) ? d.providers : []).filter(hasId);
    serverDefaults = {provider: d.defaultProvider, preset: d.defaultPreset, reasoning: d.defaultReasoning};
    var offered = serviceList().map(function (p) { return p.id; });
    provider = chosen(keptProvider, offered, serverDefaults.provider, offered.length ? offered[0] : 'openrouter');
    var models = presetsOf(provider).map(function (p) { return p.id; });
    preset = chosen(keptPreset, models, serverDefaults.preset, 'balanced');
    var inUse = providerOf(provider);
    serviceName = inUse ? inUse.name : '';
    reasoning = chosen(keptReasoning, reasoningLevelsOf(preset), serverDefaults.reasoning, 'default');
    if (!reasonAllowed(reasoning)) reasoning = fallbackReasoning();
    syncPickers();
    refreshStatus();
  }

  // Fetched on start, after each answer and every 30 seconds. If it fails, the lists and defaults stay as they are.
  function loadPresets() {
    fetch('/collab/ai/presets', {credentials: 'same-origin'})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && Array.isArray(d.providers) && d.providers.length) applyPresets(d);
      })
      .catch(function () {
        // the lists and defaults stay as they are
      });
  }

  // ---- commands ----

  var HELP = [
    '**Commands** (type `/` to see them)',
    '',
    '- `/goal <goal>`: work toward a goal in steps, with a plan and a Stop button',
    '- `/plan <idea>`: plan a change, without changing anything',
    '- `/check [focus]`: check the project and say what is wrong',
    '- `/explain [focus]`: explain how the project works',
    '- `/fix <problem>`: make the smallest change that fixes one problem',
    '- `/reasoning default`, `low`, `medium` or `high`: how hard the model thinks; `max` is only for the Smart model (the menu under the box does the same)',
    '- `/model smart`, `balanced` or `fast`: which model writes the helper\'s answers (the menu under the box does the same)',
    '- `/effort low`, `medium` or `high`: how hard the helper works (the slider does the same)',
    '- `/override <PIN>`: full-app mode for an hour; `/override off` turns it off',
    '- `/beta <PIN>`: the OpenCode Go models for an hour, with the same PIN; `/beta off` turns them off',
    '- `/discard`: throw away an unfinished full app',
    '- `/new`: start a new conversation (also `/clear`)',
    '- `/help`: this list',
  ].join('\n');

  // A reply from the window itself, not from the model: it is shown as an answer, and kept out of the conversation.
  function showLocal(md) {
    var api = newAssistant();
    api.thinking.remove();
    api.full = md;
    var body = el('div', 'md');
    api.block(body);
    renderInto(body, md);
    api.row.dataset.text = md;
    api.finish();
    keepBottom();
    save();
  }

  // /new (also /clear) starts again. An unfinished full app stays until /discard or /override off.
  function newConversation() {
    if (controller) {
      showLocal('Wait for the answer to finish, or press Stop, before you start a new conversation.');
      return;
    }
    list.innerHTML = '';
    history = [];
    pending = [];
    renderThumbs();
    goalBar.hidden = true;
    clearInterval(goalTimer);
    jump.hidden = true;
    stick = true;
    empty.hidden = false;
    save();
  }

  // /reasoning sets the choice the menu under the box shows. The levels are the ones the service offers.
  function effortCommand(arg) {
    var level = arg.toLowerCase();
    if (!arg) {
      showLocal('Effort is **' + EFFORT_TEXT[effort] + '**. Move the slider under the box, or type `/effort low`, `/effort medium` or `/effort high`.');
      return;
    }
    if (EFFORTS.indexOf(level) < 0) {
      showLocal('Choose `low`, `medium` or `high`, for example `/effort high`.');
      return;
    }
    setEffort(level);
    showLocal('Effort is now **' + EFFORT_TEXT[effort] + '**. ' + EFFORT_WHAT[effort]);
  }

  function modelCommand(arg) {
    var id = arg.toLowerCase();
    if (!arg) {
      showLocal('Model is **' + presetText(preset) + '**. Choose it in the menu under the box, or type `/model smart`, `/model balanced` or `/model fast`.');
      return;
    }
    if (PRESET_IDS.indexOf(id) < 0) {
      showLocal('Choose `smart`, `balanced` or `fast`, for example `/model smart`.');
      return;
    }
    var clamped = setPreset(id);
    showLocal('Model is now **' + presetText(preset) + '**.' + (clamped ? ' Max reasoning is only for the Smart model, so high is used.' : ''));
  }

  function reasoningCommand(arg) {
    var level = arg.toLowerCase();
    if (!arg) {
      showLocal('Reasoning effort is **' + REASON_TEXT[reasoningInUse()] + '**. Type `/reasoning default`, `low`, `medium`, `high` or `max` to change it.');
    } else if (REASONS.indexOf(level) < 0) {
      showLocal('Choose `default`, `low`, `medium`, `high` or `max`, for example `/reasoning high`.');
    } else if (!reasonAllowed(level)) {
      showLocal('Max reasoning is only for the Smart model. Type `/model smart` first, or choose `/reasoning high`.');
    } else {
      setReasoning(level);
      showLocal('Reasoning effort is now **' + REASON_TEXT[reasoningInUse()] + '**.');
    }
  }

  // The commands the window does itself: they never reach the model.
  function runLocal(name, arg, typed) {
    input.value = '';
    autosize();
    if (name === 'new' || name === 'clear') {
      newConversation();
      return;
    }
    addUser(typed);
    if (name === 'help') showLocal(HELP);
    else if (name === 'effort') effortCommand(arg);
    else if (name === 'model') modelCommand(arg);
    else reasoningCommand(arg);
  }

  function focusOn(focus) {
    return focus ? ' Focus on: ' + focus + '.' : '';
  }

  function send(text, opts) {
    text = String(text || '').trim();
    closeSlash();
    var m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(text);
    var name = m ? m[1].toLowerCase() : '';
    var arg = m ? m[2].trim() : '';
    if (['help', 'effort', 'model', 'reasoning', 'new', 'clear'].indexOf(name) >= 0) {
      runLocal(name, arg, text);
      return;
    }
    // Some commands are a question for the model: the person sees the command, and the model gets the question.
    var question = text;
    if (name === 'check') {
      question = 'Check the open project with check_project and the outlines, and tell me what is wrong, in plain words. ' +
        'Change nothing yet.' + focusOn(arg);
    } else if (name === 'explain') {
      question = 'Explain how the open project works, screen by screen.' + focusOn(arg);
    } else if (name === 'fix') {
      if (!arg) {
        showLocal('Tell me what to fix after `/fix`, for example: `/fix the score does not reset`.');
        return;
      }
      question = 'Make a small fix in the open project for this: ' + arg + '. Make the smallest change that fixes it, ' +
        'check it, and propose it.';
    }
    var hidesPin = name === 'override' || name === 'beta';
    var isGoal = name === 'goal';
    var images = hidesPin ? [] : pending.slice();
    if (!text && images.length) {
      text = images.length > 1 ? 'What is in these pictures?' : 'What is in this picture?';
      question = text;
    }
    if (!text || controller || !projectId) return;
    var shown = text;
    if (hidesPin) {
      shown = /^\/(override|beta)\s+off\b/i.test(text) ? '/' + name + ' off'
        : /^\/(override|beta)\s+\S/.test(text) ? '/' + name + ' (PIN hidden)' : '/' + name;
    }
    var row = addUser(shown, images);
    if (!hidesPin) history.push({role: 'user', content: question});
    input.value = '';
    pending = [];
    renderThumbs();
    autosize();
    var api = newAssistant();
    if (isGoal) startGoal(text.replace(/^\/goal\s*/i, ''));
    var body = {projectId: projectId, provider: provider, preset: preset, effort: effort, reasoning: reasoningInUse(),
      fastSubagent: fastSub,
      messages: hidesPin ? [{role: 'user', content: text}] : history.slice(-20)};
    if (images.length) body.images = images.map(function (p) { return {name: p.name, mime: p.mime, data: p.data}; });
    runStream(api, body, {goal: isGoal, secret: hidesPin, row: row});
  }

  // Shows an answer as its events arrive, and keeps the window busy until the answer is over. With no body,
  // it picks up an answer that is already being written.
  function runStream(api, body, opts) {
    controller = new AbortController();
    setBusy(true);
    streamRequest(body, controller.signal, function (ev) {
      onEvent(api, ev);
      keepBottom();
    }, linkChanged).catch(function (e) {
      if (e && e.name === 'AbortError') {
        notice(api, 'Stopped.', false);
      } else {
        notice(api, (e && e.message) || 'The helper could not answer.', true);
      }
    }).then(function () {
      controller = null;
      setBusy(false);
      linkChanged('back');
      api.finish();
      if (opts.goal) finishGoal();
      if (!opts.secret && api.full) {
        history.push({role: 'assistant', content: api.full});
        api.row.dataset.text = api.full;
        if (opts.row) {
          var retry = el('button', 'iconbtn');
          retry.type = 'button';
          retry.title = 'Try again';
          retry.innerHTML = RETRY;
          retry.onclick = function () { retryFrom(opts.row); };
          api.acts.appendChild(retry);
        }
      }
      save();
      loadPresets();     // /beta may have changed the service in use
      refreshStatus();   // and /override may have turned full-app mode on or off
    });
  }

  // While the connection is down the header says so; the answer itself carries on at the server.
  var subKept = null;
  function linkChanged(what) {
    var sub = $('sub');
    if (what === 'lost' && subKept === null) {
      subKept = sub.textContent;
      sub.textContent = 'Connection lost. Reconnecting…';
      sub.classList.add('warn');
    } else if (what === 'back' && subKept !== null) {
      sub.textContent = subKept;
      sub.classList.remove('warn');
      subKept = null;
    }
  }

  // The window was opened, or reloaded, while an answer was still being written: pick it up from its start.
  function attachRun(question) {
    if (controller) return;
    var row = null;
    if (question) {
      row = addUser(question);
      history.push({role: 'user', content: question});
    }
    var api = newAssistant();
    notice(api, 'Reconnected to the answer that was still being written.', false);
    runStream(api, null, {goal: false, secret: false, row: row});
  }

  // "Try again": drop the last exchange and ask again.
  function retryFrom(userRow) {
    if (controller) return;
    var last = history.length >= 2 ? history[history.length - 2] : null;
    if (!last || last.role !== 'user') return;
    var assistantRow = userRow.nextElementSibling;
    if (assistantRow) assistantRow.remove();
    userRow.remove();
    history = history.slice(0, -2);
    send(last.content);
  }

  sendBtn.addEventListener('click', function (e) {
    if (controller) {
      e.preventDefault();
      controller.abort();
    }
  });
  $('gstop').onclick = function () { if (controller) controller.abort(); };

  // ---- the composer ----

  // Pictures the person attaches (only when the model in use can look at pictures).
  var MAX_PICTURES = 3;
  var MAX_PICTURE_BYTES = 1536 * 1024;
  var PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  var HINT = $('hint').textContent;
  var pending = [];
  var visionOn = false;
  var attach = $('attach');
  var fileInput = $('file');
  var thumbs = $('thumbs');

  function renderThumbs() {
    thumbs.innerHTML = '';
    pending.forEach(function (p, i) {
      var t = el('div', 'thumb');
      var img = document.createElement('img');
      img.alt = p.name;
      img.src = p.url;
      t.appendChild(img);
      var x = el('button', '', '\u00d7');
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove ' + p.name);
      x.onclick = function () {
        URL.revokeObjectURL(p.url);
        pending.splice(i, 1);
        renderThumbs();
      };
      t.appendChild(x);
      thumbs.appendChild(t);
    });
    thumbs.hidden = !pending.length;
  }

  function flash(text) {
    var h = $('hint');
    h.textContent = text;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () { h.textContent = HINT; }, 4000);
  }

  function addFiles(list) {
    if (!visionOn) {
      flash('This model cannot look at pictures.');
      return;
    }
    Array.prototype.forEach.call(list || [], function (file) {
      if (pending.length >= MAX_PICTURES) {
        flash('Up to ' + MAX_PICTURES + ' pictures at a time.');
      } else if (PICTURE_TYPES.indexOf(file.type) < 0) {
        flash(file.name + ' is not a PNG, JPEG, GIF or WebP picture.');
      } else if (file.size > MAX_PICTURE_BYTES) {
        flash(file.name + ' is too big (over 1.5 MB).');
      } else {
        var reader = new FileReader();
        reader.onload = function () {
          var m = /^data:[^;]+;base64,(.*)$/.exec(String(reader.result));
          if (!m || pending.length >= MAX_PICTURES) return;
          pending.push({name: file.name.slice(0, 80), mime: file.type, data: m[1], url: URL.createObjectURL(file)});
          renderThumbs();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  attach.onclick = function () { fileInput.click(); };
  fileInput.onchange = function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  };
  input.addEventListener('paste', function (e) {
    var files = [];
    Array.prototype.forEach.call((e.clipboardData && e.clipboardData.items) || [], function (it) {
      if (it.kind === 'file' && /^image\//.test(it.type)) files.push(it.getAsFile());
    });
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  $('composer').addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault();
  });
  $('composer').addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }

  function slashItems() {
    var v = input.value;
    if (v.charAt(0) !== '/' || /\s/.test(v)) return [];
    return COMMANDS.filter(function (c) { return c.cmd.indexOf(v.toLowerCase()) === 0; });
  }

  function drawSlash() {
    var items = slashItems();
    if (!items.length) {
      closeSlash();
      return;
    }
    slashIndex = Math.min(slashIndex, items.length - 1);
    slash.textContent = '';
    items.forEach(function (c, i) {
      var row = el('div', i === slashIndex ? 'on' : '');
      row.appendChild(el('b', '', c.cmd));
      row.appendChild(el('span', '', c.help));
      row.onmousedown = function (e) {
        e.preventDefault();
        pickSlash(c);
      };
      slash.appendChild(row);
    });
    slash.hidden = false;
  }

  function closeSlash() {
    slash.hidden = true;
    slashIndex = 0;
  }

  function pickSlash(c) {
    input.value = c.cmd + ' ';
    closeSlash();
    autosize();
    input.focus();
  }

  input.addEventListener('input', function () {
    autosize();
    slashIndex = 0;
    drawSlash();
  });

  input.addEventListener('keydown', function (e) {
    if (!slash.hidden) {
      var items = slashItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        drawSlash();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length && input.value.trim() !== items[slashIndex].cmd) {
        e.preventDefault();
        pickSlash(items[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    } else if (e.key === 'Escape' && controller) {
      e.preventDefault();
      controller.abort();
    }
  });

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    if (controller) controller.abort();
    else send(input.value);
  });

  document.querySelectorAll('[data-fill]').forEach(function (b) {
    b.onclick = function () {
      input.value = b.getAttribute('data-fill');
      autosize();
      input.focus();
    };
  });

  modeBtn.onclick = function () {
    input.value = '/override ';
    autosize();
    input.focus();
  };

  // ---- status: who you are, whether search is on, and whether full-app mode is on ----

  function showMode() {
    var left = fullUntil - Date.now();
    if (left > 0) {
      modeBtn.classList.add('full');
      var m = Math.ceil(left / 60000);
      modeBtn.textContent = 'Full apps · ' + m + ' min';
      modeBtn.title = 'Full-app mode is on in this project. Type /override off to turn it off.';
    } else {
      modeBtn.classList.remove('full');
      modeBtn.textContent = 'Small fixes';
      modeBtn.title = 'Full-app mode: type /override and the PIN';
    }
  }

  function loadStatus() {
    if (!projectId) {
      $('sub').textContent = 'Open a project in App Inventor first';
      return;
    }
    fetch('/collab/ai/status?projectId=' + encodeURIComponent(projectId), {credentials: 'same-origin'})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) {
          $('sub').textContent = 'Sign in to App Inventor first';
          return;
        }
        applyStatus(s);
        $('sub').textContent = 'Signed in as ' + s.name + (s.search ? ' · web search on' : '');
        if (!s.configured) $('notSet').hidden = false;
        if (s.running) attachRun(s.question);
      })
      .catch(function () { $('sub').textContent = 'Could not reach the team server'; });
  }

  // ---- start ----

  restore();
  if (!list.children.length) empty.hidden = false;
  syncPickers();
  loadStatus();
  loadPresets();
  setInterval(function () { showMode(); loadPresets(); }, 30000);
  setBusy(false);
  autosize();
  input.focus();
  // for the tests
  window.__aiHelper = {
    send: send,
    choices: function () { return {provider: provider, preset: preset, effort: effort, reasoning: reasoningInUse(), fastSubagent: fastSub}; },
  };
})();
