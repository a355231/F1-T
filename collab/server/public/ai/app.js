// The AI helper's window. The server streams its answer as events (see collab/server/ai.js); this file
// shows each one as it arrives: text as it is written, tool steps as chips, pictures, proposals with
// Apply, the plan for a goal, and notices. Everything the model writes is sanitised before it is shown.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var projectId = params.get('projectId') || '';
  var STORE = 'aihelper.' + projectId;
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
  var COMMANDS = [
    {cmd: '/goal', help: 'Work toward a goal in steps, with a plan', example: '/goal Check every screen for problems'},
    {cmd: '/override', help: 'Full-app mode, with the PIN', example: '/override <PIN>'},
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
    api.finish = function () {
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
    var note = el('span', 'note', 'Backed up first · everyone reloads');
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
            note.textContent = 'Everyone is reloading their page';
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
    switch (ev.type) {
      case 'text': api.text(ev.delta); break;
      case 'tool': chip(api, ev); break;
      case 'artifact': picture(api, ev); break;
      case 'proposal': proposal(api, ev); break;
      case 'plan': plan(api, ev.steps || []); break;
      case 'status': notice(api, ev.text, false); break;
      case 'question': question(api, ev.text); break;
      case 'error': notice(api, ev.message, true); break;
      default: break;
    }
  }

  function streamRequest(body, signal, onEv) {
    return fetch('/collab/ai/stream', {method: 'POST', credentials: 'same-origin', signal: signal,
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw new Error(d.error || 'The helper could not answer.');
          });
        }
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            buf += decoder.decode(chunk.value, {stream: true});
            var cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              var block = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              block.split('\n').forEach(function (line) {
                if (line.indexOf('data:') === 0) {
                  try { onEv(JSON.parse(line.slice(5))); } catch (e) { /* a malformed event is skipped */ }
                }
              });
            }
            return pump();
          });
        }
        return pump();
      });
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

  function send(text, opts) {
    text = String(text || '').trim();
    var isOverride = /^\/override\b/i.test(text);
    var isGoal = /^\/goal\b/i.test(text);
    var images = isOverride ? [] : pending.slice();
    if (!text && images.length) text = images.length > 1 ? 'What is in these pictures?' : 'What is in this picture?';
    if (!text || controller || !projectId) return;
    closeSlash();
    var shown = text;
    if (isOverride) {
      shown = /^\/override\s+off\b/i.test(text) ? '/override off'
        : /^\/override\s+\S/.test(text) ? '/override (PIN hidden)' : '/override';
    }
    var row = addUser(shown, images);
    if (!isOverride) history.push({role: 'user', content: text});
    input.value = '';
    pending = [];
    renderThumbs();
    autosize();
    var api = newAssistant();
    controller = new AbortController();
    setBusy(true);
    if (isGoal) startGoal(text.replace(/^\/goal\s*/i, ''));
    var body = {projectId: projectId, messages: isOverride ? [{role: 'user', content: text}] : history.slice(-20)};
    if (images.length) body.images = images.map(function (p) { return {name: p.name, mime: p.mime, data: p.data}; });
    streamRequest(body, controller.signal, function (ev) {
      onEvent(api, ev);
      keepBottom();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') {
        notice(api, 'Stopped.', false);
      } else {
        notice(api, (e && e.message) || 'The helper could not answer.', true);
      }
    }).then(function () {
      controller = null;
      setBusy(false);
      api.finish();
      if (isGoal) finishGoal();
      if (!isOverride && api.full) {
        history.push({role: 'assistant', content: api.full});
        api.row.dataset.text = api.full;
        var retry = el('button', 'iconbtn');
        retry.type = 'button';
        retry.title = 'Try again';
        retry.innerHTML = RETRY;
        retry.onclick = function () { retryFrom(row); };
        api.acts.appendChild(retry);
      }
      save();
    });
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
