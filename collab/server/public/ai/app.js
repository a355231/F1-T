// The AI helper's window. The server streams its answer as events (see collab/server/ai.js); this file
// shows each one as it arrives: text as it is written, tool steps as chips, pictures, proposals with
// Apply, the plan for a goal, and notices. Everything the model writes is sanitised before it is shown.
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
  // questions the window sends to the model for the person.
  var COMMANDS = [
    {cmd: '/goal', help: 'Work toward a goal in steps, with a plan'},
    {cmd: '/plan', help: 'Plan a change, without changing anything'},
    {cmd: '/check', help: 'Check the project and say what is wrong'},
    {cmd: '/explain', help: 'Explain how the project works'},
    {cmd: '/fix', help: 'Make the smallest change that fixes one problem'},
    {cmd: '/effort', help: 'How hard the helper works: low, medium or high'},
    {cmd: '/override', help: 'Full-app mode, with the PIN'},
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

  function render(md) {
    var html = marked.parse(md || '', {breaks: true, gfm: true});
    return DOMPurify.sanitize(html, {FORBID_TAGS: ['img', 'style', 'form', 'input'], FORBID_ATTR: ['style']});
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

    var api = {row: row, turn: turn, thinking: thinking, cur: null, raw: '', full: '', chips: {}, planEl: null, scheduled: false};

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
    // The service was tried again: what the failed try showed is taken back.
    api.resetText = function () {
      if (api.cur) {
        api.full = api.full.slice(0, api.full.length - api.raw.length);
        api.cur.remove();
        api.cur = null;
        api.raw = '';
      }
      Object.keys(api.chips).forEach(function (id) {   // a step still marked as running belongs to the failed try
        var c = api.chips[id];
        if (c.classList.contains('running')) {
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
      api.block(c);
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
    btn.onclick = function () {
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Applying…';
      fetch('/collab/ai/apply', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'},
        body: JSON.stringify({projectId: projectId, id: ev.id})})
        .then(function (r) { return r.json().then(function (d) { return {ok: r.ok, data: d}; }); })
        .then(function (x) {
          if (x.ok && x.data.ok) {
            card.classList.add('applied');
            btn.replaceWith(el('span', 'done-tag', '✓ Applied'));
            note.textContent = 'The App Inventor tab reloads by itself to show it';
            // The App Inventor window that opened this one reloads too, in case the team server's message did not come.
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({t: 'aicollab-applied', projectId: projectId}, location.origin);
            }
          } else {
            btn.disabled = false;
            btn.textContent = 'Apply';
            note.textContent = x.data.error || 'Could not apply this change.';
            note.classList.add('err');
          }
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Apply';
          note.textContent = 'Could not reach the team server.';
          note.classList.add('err');
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
      case 'tool': chip(api, ev); break;
      case 'artifact': picture(api, ev); break;
      case 'proposal': proposal(api, ev); break;
      case 'plan': plan(api, ev.steps || []); break;
      case 'status': notice(api, ev.text, false); break;
      case 'question': question(api, ev.text); break;
      case 'reset': api.resetText(); break;
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
    var kept = localStorage.getItem('aihelper.effort');
    if (EFFORTS.indexOf(kept) >= 0) effort = kept;
  } catch (e) {
    // no storage here: medium
  }

  function setEffort(level) {
    effort = level;
    effortInput.value = String(EFFORTS.indexOf(level));
    effortInput.setAttribute('aria-valuetext', EFFORT_TEXT[level]);
    effortInput.title = EFFORT_WHAT[level];
    effortOut.textContent = EFFORT_TEXT[level];
    try {
      localStorage.setItem('aihelper.effort', level);
    } catch (e) {
      // not remembered
    }
  }
  effortInput.oninput = function () { setEffort(EFFORTS[Number(effortInput.value)] || 'medium'); };
  setEffort(effort);

  // ---- commands ----

  var HELP = [
    '**Commands** (type `/` to see them)',
    '',
    '- `/goal <goal>`: work toward a goal in steps, with a plan and a Stop button',
    '- `/plan <idea>`: plan a change, without changing anything',
    '- `/check [focus]`: check the project and say what is wrong',
    '- `/explain [focus]`: explain how the project works',
    '- `/fix <problem>`: make the smallest change that fixes one problem',
    '- `/effort low`, `medium` or `high`: how hard the helper works (the slider does the same)',
    '- `/override <PIN>`: full-app mode for an hour; `/override off` turns it off',
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

  // The commands the window does itself: they never reach the model.
  function runLocal(name, arg, typed) {
    input.value = '';
    autosize();
    if (name === 'new' || name === 'clear') {
      newConversation();
      return;
    }
    addUser(typed);
    if (name === 'help') {
      showLocal(HELP);
    } else if (!arg) {
      showLocal('Effort is **' + EFFORT_TEXT[effort] + '**. Move the slider under the box, or type `/effort low`, `/effort medium` or `/effort high`.');
    } else if (EFFORTS.indexOf(arg.toLowerCase()) < 0) {
      showLocal('Choose `low`, `medium` or `high`, for example `/effort high`.');
    } else {
      setEffort(arg.toLowerCase());
      showLocal('Effort is now **' + EFFORT_TEXT[effort] + '**. ' + EFFORT_WHAT[effort]);
    }
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
    if (name === 'help' || name === 'effort' || name === 'new' || name === 'clear') {
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
    var isOverride = name === 'override';
    var isGoal = name === 'goal';
    var images = isOverride ? [] : pending.slice();
    if (!text && images.length) {
      text = images.length > 1 ? 'What is in these pictures?' : 'What is in this picture?';
      question = text;
    }
    if (!text || controller || !projectId) return;
    var shown = text;
    if (isOverride) {
      shown = /^\/override\s+off\b/i.test(text) ? '/override off'
        : /^\/override\s+\S/.test(text) ? '/override (PIN hidden)' : '/override';
    }
    var row = addUser(shown, images);
    if (!isOverride) history.push({role: 'user', content: question});
    input.value = '';
    pending = [];
    renderThumbs();
    autosize();
    var api = newAssistant();
    if (isGoal) startGoal(text.replace(/^\/goal\s*/i, ''));
    var body = {projectId: projectId, effort: effort, messages: isOverride ? [{role: 'user', content: text}] : history.slice(-20)};
    if (images.length) body.images = images.map(function (p) { return {name: p.name, mime: p.mime, data: p.data}; });
    runStream(api, body, {goal: isGoal, override: isOverride, row: row});
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
      if (!opts.override && api.full) {
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
    runStream(api, null, {goal: false, override: false, row: row});
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
        fullUntil = s.fullUntil || 0;
        visionOn = !!s.vision;
        attach.hidden = !visionOn;
        showMode();
        $('sub').textContent = 'Signed in as ' + s.name + (s.search ? ' · web search on' : '');
        if (!s.configured) $('notSet').hidden = false;
        if (s.running) attachRun(s.question);
      })
      .catch(function () { $('sub').textContent = 'Could not reach the team server'; });
  }

  // ---- start ----

  restore();
  if (!list.children.length) empty.hidden = false;
  loadStatus();
  setInterval(showMode, 30000);
  setBusy(false);
  autosize();
  input.focus();
  window.__aiHelper = {send: send};   // for the tests
})();
