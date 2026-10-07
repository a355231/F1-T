// -*- mode: javascript; js-indent-level: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0
//
// Real-time collaboration client for App Inventor (see collab/README.md).
//
// Connects to the collaboration hub at /collab/ws on the same host, tells it which project and
// screen this user is on, sends this user's block and designer edits, and applies teammates'
// edits. Teammates' edits are kept off this user's companion until the companion is reset.

(function() {
  'use strict';

  var BLOCK_EVENT_TYPES = ['create', 'delete', 'change', 'move', 'var_create', 'var_delete',
    'var_rename', 'comment_create', 'comment_delete', 'comment_change', 'comment_move'];
  var TICK_MS = 700;
  var CURSOR_MS = 5000;          // how often your mouse position is shared
  var CURSOR_GLIDE_MS = 1200;    // a teammate's cursor glides to its new spot over this long
  var OPS_PER_TICK = 300;

  var C = window.AICollab = {
    me: null,
    roster: [],
    connected: false,
    wanted: null,      // project id we asked the hub to join
    joined: null,      // project id the hub confirmed
    epoch: null,       // changes when the hub starts a fresh session for the project
    mainId: null,
    workspaces: {},    // "<projectId>_<screen>" -> Blockly workspace
    queues: {},        // screen -> teammate ops waiting to be applied, in order
    applied: {},       // "<projectId>:<epoch>" -> {screen: last applied seq}
    presence: '',
    notice: '',
    expanded: false,
    cursors: {},       // client id -> {screen, editor, x, y, fresh}
    stats: {cursorsSent: 0, cursorsReceived: 0},
  };

  var ws = null;
  var failures = 0;
  var lastWhere = '';
  var lastCursorKey = 'none';

  // ---- hub connection ----

  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/collab/ws';
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function() {
      failures = 0;
      C.connected = true;
      C.notice = '';
      render();
    };
    ws.onmessage = function(ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      onMessage(msg);
    };
    ws.onclose = function() {
      var wasJoined = C.joined;
      C.connected = false;
      ws = null;
      if (wasJoined) {
        setMain(wasJoined, true);  // without the hub, save your own work again
      }
      C.joined = null;
      C.wanted = null;
      C.presence = '';
      C.queues = {};
      C.roster = [];
      C.cursors = {};
      lastCursorKey = 'none';
      renderCursors();
      render();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    failures++;
    setTimeout(connect, Math.min(15000, 1000 * failures));
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function onMessage(msg) {
    if (C.onExtra) {
      C.onExtra(msg);
    }
    switch (msg.t) {
      case 'hello':
        C.me = msg.you;
        if (C.announceAfterReconnect) {
          C.announceAfterReconnect = false;
          send({t: 'codechanged'});
        }
        break;
      case 'roster':
        C.roster = msg.clients || [];
        Object.keys(C.cursors).forEach(function(id) {
          if (!C.roster.some(function(c) { return c.id === id && c.projectId === C.joined; })) {
            delete C.cursors[id];
          }
        });
        renderCursors();
        break;
      case 'joined':
        if (String(msg.projectId) !== C.wanted) {
          return;
        }
        C.joined = C.wanted;
        C.epoch = msg.epoch;
        C.mainId = msg.leaderId;
        C.queues = {};
        C.cursors = {};
        (msg.cursors || []).forEach(setCursor);
        updateRole();
        (msg.log || []).forEach(enqueue);
        processQueues();
        break;
      case 'cursor':
        C.stats.cursorsReceived++;
        setCursor(msg);
        renderCursors();
        break;
      case 'notice':
        showNotice(msg.text);
        break;
      case 'leader':
        if (String(msg.projectId) === C.joined) {
          C.mainId = msg.leaderId;
          updateRole();
        }
        break;
      case 'op':
        if (String(msg.projectId) === C.joined) {
          enqueue(msg.op);
          processQueues();
        }
        break;
      case 'error':
        if (msg.error === 'no-access') {
          C.notice = 'The team server could not confirm your access to this project.';
        }
        break;
      default:
        break;
    }
    render();
  }

  function updateRole() {
    if (C.joined && C.me) {
      setMain(C.joined, C.mainId === C.me.id);
    }
  }

  function setMain(projectId, main) {
    if (window.AICollab_setMain) {
      window.AICollab_setMain(String(projectId), !!main);
    }
  }

  // ---- where this user is ----

  function context() {
    if (!window.AICollab_getContext) {
      return null;
    }
    var raw = window.AICollab_getContext();
    if (!raw) {
      return null;
    }
    var parts = String(raw).split('\n');
    return {projectId: parts[0], projectName: parts[1], screen: parts[2], editor: parts[3]};
  }

  function companionConnected() {
    try {
      return !!(window.Blockly && Blockly.ReplMgr && Blockly.ReplMgr.isConnected());
    } catch (e) {
      return false;
    }
  }

  function tick() {
    var ctx = context();
    var projectId = ctx ? ctx.projectId : null;
    if (C.connected) {
      if (projectId !== C.wanted) {
        if (C.wanted) {
          send({t: 'leave'});
          if (C.joined) {
            setMain(C.joined, true);
          }
        }
        C.joined = null;
        C.queues = {};
        C.cursors = {};
        lastCursorKey = 'none';
        C.wanted = projectId;
        if (projectId) {
          send({t: 'join', projectId: projectId});
        }
      }
      var presence = ctx ? [ctx.screen, ctx.editor, companionConnected()].join('|') : '';
      if (C.joined && presence !== C.presence) {
        C.presence = presence;
        send({t: 'presence', screen: ctx.screen, editor: ctx.editor,
          companion: companionConnected()});
      }
      // Moving to another screen or editor: say so now instead of waiting up to 5 seconds.
      var where = ctx ? [ctx.projectId, ctx.screen, ctx.editor].join('|') : '';
      if (where !== lastWhere) {
        lastWhere = where;
        sendCursor();
      }
    }
    processQueues();
    renderCursors();
    render();
  }

  // ---- teammates' edits ----

  function appliedFor(screen) {
    var key = C.joined + ':' + C.epoch;
    C.applied[key] = C.applied[key] || {};
    return C.applied[key][screen] || 0;
  }

  function markApplied(screen, seq) {
    var key = C.joined + ':' + C.epoch;
    C.applied[key] = C.applied[key] || {};
    C.applied[key][screen] = Math.max(C.applied[key][screen] || 0, seq);
  }

  function enqueue(op) {
    if (op.kind === 'tree') {
      if (C.onTreeOp) {
        C.onTreeOp(op);
      }
      return;
    }
    if (op.seq <= appliedFor(op.screen)) {
      return;
    }
    (C.queues[op.screen] = C.queues[op.screen] || []).push(op);
  }

  function processQueues() {
    if (!C.joined || !window.AICollab_isScreenReady) {
      return;
    }
    Object.keys(C.queues).forEach(function(screen) {
      var queue = C.queues[screen];
      if (!queue.length || !C.workspaces[C.joined + '_' + screen] ||
          !window.AICollab_isScreenReady(C.joined, screen)) {
        return;
      }
      var budget = OPS_PER_TICK;
      while (queue.length && budget-- > 0) {
        var op = queue[0];
        var result = 'ok';
        if (!C.me || op.from !== C.me.id) {
          result = op.kind === 'blocks' ? applyBlocks(op) : applyDesigner(op);
        }
        if (result === 'wait') {
          break;
        }
        queue.shift();
        markApplied(screen, op.seq);
      }
    });
  }

  function applyDesigner(op) {
    var d = op.data || {};
    var str = function(v) { return v === undefined || v === null ? null : String(v); };
    // Renaming or deleting a component also changes its blocks here; those block changes are part
    // of the teammate's edit, so they are grouped as remote and not sent back out.
    var previousGroup = window.Blockly ? Blockly.Events.getGroup() : '';
    if (window.Blockly) {
      Blockly.Events.setGroup('collab:' + op.seq);
    }
    try {
      return window.AICollab_applyDesignerOp(C.joined, op.screen, str(d.op), str(d.uuid),
        str(d.a), str(d.b), str(d.c), d.index | 0);
    } finally {
      if (window.Blockly) {
        Blockly.Events.setGroup(previousGroup || false);
      }
    }
  }

  function rootId(workspace, blockId) {
    var block = blockId && workspace.getBlockById(blockId);
    return block ? block.getRootBlock().id : null;
  }

  function touchedRoots(workspace, json) {
    return [rootId(workspace, json.blockId), rootId(workspace, json.oldParentId),
      rootId(workspace, json.newParentId)].filter(Boolean);
  }

  function hasComment(workspace, id) {
    return !!(id && workspace.getCommentById && workspace.getCommentById(id));
  }

  // Ops are replayed to people who open the project late, on top of what the main client already
  // saved, so every op must be safe to apply to a workspace that may already contain it.
  function alreadyApplied(workspace, json) {
    var block = json.blockId ? workspace.getBlockById(json.blockId) : null;
    switch (json.type) {
      case 'create':
        return !!block;
      case 'delete':
      case 'move':
      case 'change':
        return !block;
      case 'var_create':
        return !!workspace.getVariableById(json.varId);
      case 'var_delete':
      case 'var_rename':
        return !workspace.getVariableById(json.varId);
      case 'comment_create':
        return hasComment(workspace, json.commentId);
      case 'comment_delete':
      case 'comment_change':
      case 'comment_move':
        return !hasComment(workspace, json.commentId);
      default:
        return false;
    }
  }

  function applyBlocks(op) {
    var workspace = C.workspaces[C.joined + '_' + op.screen];
    if (!workspace) {
      return 'wait';
    }
    var json = op.data || {};
    if (alreadyApplied(workspace, json)) {
      return 'ok';
    }
    var hold = companionConnected();
    var roots = hold ? touchedRoots(workspace, json) : [];
    var previousGroup = Blockly.Events.getGroup();
    var recordUndo = Blockly.Events.getRecordUndo ? Blockly.Events.getRecordUndo() : true;
    Blockly.Events.setGroup('collab:' + op.seq);
    if (Blockly.Events.setRecordUndo) {
      Blockly.Events.setRecordUndo(false);  // Ctrl+Z only undoes your own edits
    }
    try {
      Blockly.Events.fromJson(json, workspace).run(true);
    } catch (e) {
      console.warn('Could not apply teammate\'s block change', json.type, e);
    } finally {
      if (Blockly.Events.setRecordUndo) {
        Blockly.Events.setRecordUndo(recordUndo);
      }
      Blockly.Events.setGroup(previousGroup || false);
    }
    if (hold) {
      workspace.collabHeld = workspace.collabHeld || {};
      roots.concat(touchedRoots(workspace, json)).forEach(function(id) {
        workspace.collabHeld[id] = true;
      });
    }
    return 'ok';
  }

  // ---- this user's edits ----

  function splitFormName(formName) {
    var m = /^(\d+)_(.+)$/.exec(String(formName || ''));
    return m ? {projectId: m[1], screen: m[2]} : null;
  }

  C.isJoined = function(projectId) {
    return C.connected && C.joined !== null && C.joined === String(projectId);
  };

  C.registerWorkspace = function(workspace) {
    if (workspace && workspace.formName) {
      C.workspaces[workspace.formName] = workspace;
    }
  };

  C.onBlocklyEvent = function(workspace, e) {
    if (C.onUiEvent && e && e.type === 'selected') {
      C.onUiEvent(workspace, e);
    }
    if (!workspace || !e || e.isUiEvent || e.type === 'ui' ||
        BLOCK_EVENT_TYPES.indexOf(e.type) < 0) {
      return;
    }
    if (typeof e.group === 'string' && e.group.indexOf('collab:') === 0) {
      return;  // applying a teammate's change
    }
    C.registerWorkspace(workspace);
    var where = splitFormName(workspace.formName);
    if (!where || !C.isJoined(where.projectId)) {
      return;
    }
    if (workspace.collabHeld) {
      // Your own edit to a block a teammate changed sends the whole handler to your companion.
      touchedRoots(workspace, e).concat([e.blockId]).forEach(function(id) {
        delete workspace.collabHeld[id];
      });
    }
    var json;
    try {
      json = e.toJson();
    } catch (err) {
      return;
    }
    send({t: 'op', projectId: where.projectId, screen: where.screen, kind: 'blocks', data: json});
  };

  C.sendDesignerOp = function(projectId, screen, op) {
    if (C.isJoined(projectId)) {
      send({t: 'op', projectId: String(projectId), screen: screen, kind: 'designer', data: op});
    }
  };

  C.sendTreeChanged = function(projectId) {
    if (C.isJoined(projectId)) {
      send({t: 'op', projectId: String(projectId), screen: '', kind: 'tree', data: {}});
    }
  };

  C.send = send;
  C.context = context;
  C.companionConnected = function() { return companionConnected(); };
  C.render = function() {
    lastRender = '';
    render();
  };

  C.clearHolds = function() {
    Object.keys(C.workspaces).forEach(function(k) {
      C.workspaces[k].collabHeld = {};
    });
    if (window.top.ReplState && window.top.ReplState.phoneState) {
      window.top.ReplState.phoneState.collabFormPending = false;
    }
  };

  C.bridgeReady = function() {
    render();
  };

  function heldCount() {
    if (!C.joined || !companionConnected()) {
      return 0;
    }
    var count = 0;
    Object.keys(C.workspaces).forEach(function(k) {
      if (k.indexOf(C.joined + '_') === 0) {
        count += Object.keys(C.workspaces[k].collabHeld || {}).length;
      }
    });
    var phoneState = window.top.ReplState && window.top.ReplState.phoneState;
    if (phoneState && phoneState.collabFormPending) {
      count++;
    }
    return count;
  }

  // ---- mouse cursors ----
  //
  // Your mouse position is shared every CURSOR_MS while the mouse is over the blocks workspace
  // (as workspace coordinates, so the cursor stays on the same block when someone scrolls) or over
  // the designer's phone preview (as pixels from its top-left corner).

  var lastMouse = null;
  var cursorLayer = null;
  var cursorEls = {};

  document.addEventListener('mousemove', function(e) {
    lastMouse = {x: e.clientX, y: e.clientY};
  }, true);
  document.addEventListener('mouseout', function(e) {
    if (!e.relatedTarget) {
      lastMouse = null;   // the mouse left the window
    }
  }, true);

  function inside(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function visibleForm() {
    var forms = document.querySelectorAll('.ode-SimpleMockForm');
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].offsetWidth > 0 && forms[i].offsetHeight > 0) {
        return forms[i];
      }
    }
    return null;
  }

  function workspaceBox(workspace) {
    var div = workspace.getInjectionDiv ? workspace.getInjectionDiv() :
      workspace.getParentSvg().parentNode;
    return div.getBoundingClientRect();
  }

  function sampleCursor() {
    var ctx = context();
    if (!ctx || !C.joined || ctx.projectId !== C.joined || !lastMouse || document.hidden) {
      return null;
    }
    var x = lastMouse.x;
    var y = lastMouse.y;
    if (ctx.editor === 'blocks') {
      var workspace = C.workspaces[C.joined + '_' + ctx.screen];
      if (!workspace || !inside(workspaceBox(workspace), x, y)) {
        return null;
      }
      var p = Blockly.utils.svgMath.screenToWsCoordinates(workspace,
        new Blockly.utils.Coordinate(x, y));
      return {screen: ctx.screen, editor: 'blocks', x: Math.round(p.x), y: Math.round(p.y)};
    }
    var form = visibleForm();
    if (!form) {
      return null;
    }
    var box = form.getBoundingClientRect();
    if (!inside(box, x, y)) {
      return null;
    }
    return {screen: ctx.screen, editor: 'designer', x: Math.round(x - box.left),
      y: Math.round(y - box.top)};
  }

  function sendCursor() {
    if (!C.connected || !C.joined) {
      return;
    }
    var spot = sampleCursor();
    var key = spot ? [spot.screen, spot.editor, spot.x, spot.y].join('|') : 'none';
    if (key === lastCursorKey) {
      return;   // nothing new to say
    }
    lastCursorKey = key;
    C.stats.cursorsSent++;
    send(spot ? {t: 'cursor', screen: spot.screen, editor: spot.editor, x: spot.x, y: spot.y} :
      {t: 'cursor', x: null, y: null});
  }

  function setCursor(msg) {
    if (!msg || !msg.id) {
      return;
    }
    if (msg.x === null || msg.x === undefined) {
      delete C.cursors[msg.id];
    } else {
      C.cursors[msg.id] = {screen: msg.screen, editor: msg.editor, x: msg.x, y: msg.y,
        fresh: Date.now()};
    }
  }

  function cursorScreenPosition(c) {
    if (c.editor === 'blocks') {
      var workspace = C.workspaces[C.joined + '_' + c.screen];
      if (!workspace) {
        return null;
      }
      var p = Blockly.utils.svgMath.wsToScreenCoordinates(workspace,
        new Blockly.utils.Coordinate(c.x, c.y));
      return inside(workspaceBox(workspace), p.x, p.y) ? {x: p.x, y: p.y} : null;
    }
    var form = visibleForm();
    if (!form) {
      return null;
    }
    var box = form.getBoundingClientRect();
    var pos = {x: box.left + c.x, y: box.top + c.y};
    return inside(box, pos.x, pos.y) ? pos : null;
  }

  function makeCursorEl() {
    var wrap = el('div', 'aic-cursor');
    wrap.innerHTML = '<svg width="20" height="26" viewBox="0 0 20 26" aria-hidden="true">' +
      '<path d="M1.5 1.5 L1.5 20 L6.2 15.6 L9.6 23.6 L13 22.2 L9.7 14.4 L16.4 14.2 Z" ' +
      'stroke="#222" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    wrap.appendChild(el('span', 'aic-cursor-name', ''));
    return wrap;
  }

  function renderCursors() {
    if (!document.body) {
      return;
    }
    var ctx = context();
    var wanted = {};
    if (ctx && C.joined && ctx.projectId === C.joined && !document.hidden) {
      Object.keys(C.cursors).forEach(function(id) {
        var c = C.cursors[id];
        var who = C.roster.filter(function(r) { return r.id === id; })[0];
        if (!who || who.projectId !== C.joined || c.screen !== ctx.screen ||
            c.editor !== ctx.editor || (C.me && id === C.me.id)) {
          return;
        }
        var pos = cursorScreenPosition(c);
        if (pos) {
          wanted[id] = {pos: pos, who: who, c: c};
        }
      });
    }
    if (!cursorLayer && Object.keys(wanted).length) {
      cursorLayer = el('div');
      cursorLayer.id = 'aicollab-cursors';
      document.body.appendChild(cursorLayer);
    }
    Object.keys(cursorEls).forEach(function(id) {
      if (!wanted[id]) {
        cursorEls[id].remove();
        delete cursorEls[id];
      }
    });
    Object.keys(wanted).forEach(function(id) {
      var w = wanted[id];
      var wrap = cursorEls[id];
      var fresh = false;
      if (!wrap) {
        wrap = cursorEls[id] = makeCursorEl();
        cursorLayer.appendChild(wrap);
        wrap.style.transition = 'none';
      } else {
        fresh = Date.now() - w.c.fresh < CURSOR_GLIDE_MS + 100;
        wrap.style.transition = fresh ? 'transform ' + CURSOR_GLIDE_MS + 'ms ease' : 'none';
      }
      var x = Math.max(0, Math.min(window.innerWidth - 24, w.pos.x));
      var y = Math.max(0, Math.min(window.innerHeight - 30, w.pos.y));
      wrap.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
      wrap.setAttribute('data-name', w.who.name);
      wrap.querySelector('path').setAttribute('fill', w.who.color);
      var label = wrap.querySelector('.aic-cursor-name');
      label.textContent = w.who.name;
      label.style.background = w.who.color;
      label.style.color = w.who.color === '#fdd835' ? '#222' : '#fff';
    });
  }

  // ---- changing the team code while everyone is working ----

  function randomCode() {
    var letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var bytes = new Uint8Array(1);
    while (out.length < 12) {
      crypto.getRandomValues(bytes);
      if (bytes[0] < 252) {   // 252 = 7 * 36, so every letter is equally likely
        out += letters.charAt(bytes[0] % 36);
      }
    }
    return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
  }

  function showNotice(text) {
    C.notice = text;
    C.expanded = true;
    render();
    setTimeout(function() {
      if (C.notice === text) {
        C.notice = '';
        render();
      }
    }, 5 * 60 * 1000);
  }

  function changeCodeDialog() {
    if (document.getElementById('aicollab-dialog')) {
      return;
    }
    var backdrop = el('div');
    backdrop.id = 'aicollab-dialog';
    var card = el('div', 'aic-card');
    backdrop.appendChild(card);

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        close();
      }
    }
    document.addEventListener('keydown', onKey, true);

    function field(label, type) {
      var row = el('label', 'aic-field');
      row.appendChild(el('span', '', label));
      var input = el('input');
      input.type = type;
      input.autocomplete = 'off';
      input.spellcheck = false;
      row.appendChild(input);
      card.appendChild(row);
      return input;
    }

    card.appendChild(el('h3', '', 'Change team code'));
    card.appendChild(el('p', '', 'Anyone who signs in from now on needs the new code. ' +
      'People who are already signed in stay signed in, unless you tick the box below.'));
    var current = field('Current team code', 'password');
    var fresh = field('New team code (8 or more characters)', 'text');
    var make = el('a', 'aic-link', 'Make one up');
    make.onclick = function() {
      fresh.value = randomCode();
    };
    card.appendChild(make);
    var signoutRow = el('label', 'aic-check');
    var signout = el('input');
    signout.type = 'checkbox';
    signoutRow.appendChild(signout);
    signoutRow.appendChild(el('span', '', ' Also sign everyone else out right now (use this if ' +
      'the old code leaked)'));
    card.appendChild(signoutRow);
    var message = el('div', 'aic-error');
    card.appendChild(message);
    var buttons = el('div', 'aic-buttons');
    var cancel = el('button', '', 'Cancel');
    var go = el('button', 'aic-primary', 'Change code');
    buttons.appendChild(cancel);
    buttons.appendChild(go);
    card.appendChild(buttons);
    cancel.onclick = close;

    function done(newCode, signedOut) {
      card.textContent = '';
      card.appendChild(el('h3', '', 'Team code changed'));
      card.appendChild(el('p', '', 'The new team code is:'));
      var shown = el('div', 'aic-newcode', newCode);
      card.appendChild(shown);
      card.appendChild(el('p', '', 'Tell your teammates. ' + (signedOut ?
        'Everyone else was signed out and must sign in again with it.' :
        'The next person to sign in needs it.')));
      var row = el('div', 'aic-buttons');
      var copy = el('button', '', 'Copy');
      copy.onclick = function() {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(newCode).then(function() { copy.textContent = 'Copied'; });
        }
      };
      var ok = el('button', 'aic-primary', 'Done');
      ok.onclick = close;
      row.appendChild(copy);
      row.appendChild(ok);
      card.appendChild(row);
    }

    function submit() {
      message.textContent = '';
      var newCode = fresh.value;
      go.disabled = true;
      var body = 'current=' + encodeURIComponent(current.value) + '&new=' +
        encodeURIComponent(newCode) + '&signout=' + (signout.checked ? 'true' : 'false');
      fetch('/ode/collab/teamcode', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: body
      }).then(function(r) {
        return r.json().catch(function() { return {ok: false, error: 'Unexpected answer.'}; });
      }).then(function(result) {
        go.disabled = false;
        if (result.ok) {
          if (result.signedOut && ws) {
            // Everyone's login was just replaced, including the one this connection was opened
            // with. Reconnect with the new one first; the hub then checks and announces the change.
            C.announceAfterReconnect = true;
            ws.close();
          } else {
            send({t: 'codechanged'});
          }
          done(newCode, !!result.signedOut);
        } else {
          message.textContent = result.error || 'The team code could not be changed.';
        }
      }, function() {
        go.disabled = false;
        message.textContent = 'Could not reach the App Inventor server.';
      });
    }
    go.onclick = submit;
    [current, fresh].forEach(function(input) {
      input.onkeydown = function(e) {
        if (e.key === 'Enter') {
          submit();
        }
      };
    });
    document.body.appendChild(backdrop);
    current.focus();
  }

  // ---- sharing ----

  function share() {
    var ctx = context();
    if (!ctx) {
      return;
    }
    var name = window.prompt('Share "' + ctx.projectName + '" with (the name they sign in with):');
    if (!name) {
      return;
    }
    var body = 'projectId=' + encodeURIComponent(ctx.projectId) + '&name=' +
      encodeURIComponent(name.trim());
    fetch('/ode/collab/share', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: body
    }).then(function(r) {
      return r.json().catch(function() { return {ok: false}; });
    }).then(function(result) {
      window.alert(result.ok ?
        '"' + ctx.projectName + '" is now in ' + result.name + '\'s My Projects. ' +
        'They may need to reload App Inventor to see it.' :
        'Could not share the project: ' + (result.error || 'unknown error'));
    }, function() {
      window.alert('Could not reach the App Inventor server.');
    });
  }

  // ---- team panel ----

  var panel = null;
  var lastRender = '';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    if (text !== undefined) {
      e.textContent = text;
    }
    return e;
  }

  function installStyles() {
    var css =
      '#aicollab{position:fixed;left:8px;bottom:3px;z-index:900;font:12px/1.35 sans-serif;' +
      'color:#222;background:rgba(255,255,255,.96);border:1px solid #bbb;border-radius:6px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.2);max-width:300px}' +
      '#aicollab .aic-head{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;' +
      'user-select:none}' +
      '#aicollab .aic-title{font-weight:bold}' +
      '#aicollab .aic-dot{width:10px;height:10px;border-radius:50%;display:inline-block;' +
      'flex:none}' +
      '#aicollab .aic-body{border-top:1px solid #ddd;padding:6px 8px;max-height:260px;' +
      'overflow:auto}' +
      '#aicollab .aic-row{display:flex;gap:6px;align-items:flex-start;margin:3px 0}' +
      '#aicollab .aic-where{color:#555}' +
      '#aicollab .aic-badge{font-size:10px;border:1px solid #888;border-radius:3px;padding:0 3px;' +
      'margin-left:4px;color:#444}' +
      '#aicollab .aic-hold{margin-top:6px;padding:4px 6px;background:#fff4cc;border-radius:4px}' +
      '#aicollab .aic-note{margin-top:6px;color:#a33}' +
      '#aicollab a{color:#1a6dd6;cursor:pointer}' +
      'body.dark #aicollab,.dark-theme #aicollab{background:rgba(40,40,40,.96);color:#eee;' +
      'border-color:#555}' +
      '#aicollab-cursors{position:fixed;left:0;top:0;width:0;height:0;z-index:950;' +
      'pointer-events:none}' +
      '.aic-cursor{position:fixed;left:0;top:0;pointer-events:none;will-change:transform}' +
      '.aic-cursor svg{display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}' +
      '.aic-cursor-name{position:absolute;left:14px;top:20px;white-space:nowrap;font:bold 12px/1.2 ' +
      'sans-serif;padding:2px 7px;border-radius:9px;box-shadow:0 1px 3px rgba(0,0,0,.4);' +
      'border:1px solid rgba(0,0,0,.35)}' +
      '#aicollab-dialog{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);' +
      'display:flex;align-items:center;justify-content:center;font:14px/1.4 sans-serif}' +
      '#aicollab-dialog .aic-card{background:#fff;color:#222;border-radius:8px;padding:18px 20px;' +
      'width:min(420px,calc(100vw - 32px));box-shadow:0 8px 30px rgba(0,0,0,.4)}' +
      '#aicollab-dialog h3{margin:0 0 8px;font-size:18px}' +
      '#aicollab-dialog p{margin:0 0 10px}' +
      '#aicollab-dialog .aic-field{display:block;margin:8px 0}' +
      '#aicollab-dialog .aic-field span{display:block;font-size:12px;color:#555;margin-bottom:2px}' +
      '#aicollab-dialog .aic-field input{width:100%;box-sizing:border-box;padding:7px;font-size:15px;' +
      'border:1px solid #999;border-radius:4px}' +
      '#aicollab-dialog .aic-link{color:#1a6dd6;cursor:pointer;font-size:13px}' +
      '#aicollab-dialog .aic-check{display:block;margin:10px 0;font-size:13px}' +
      '#aicollab-dialog .aic-error{color:#b00020;min-height:18px;margin:4px 0}' +
      '#aicollab-dialog .aic-buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}' +
      '#aicollab-dialog button{padding:7px 14px;font-size:14px;border-radius:4px;' +
      'border:1px solid #888;background:#f3f3f3;cursor:pointer}' +
      '#aicollab-dialog button.aic-primary{background:#7fb400;border-color:#6a9900;color:#fff}' +
      '#aicollab-dialog button:disabled{opacity:.5}' +
      '#aicollab-dialog .aic-newcode{font:bold 22px/1.3 monospace;background:#f0f0f0;' +
      'padding:10px;border-radius:6px;text-align:center;user-select:all}';
    var style = el('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function describe(c) {
    if (!c.projectId) {
      return 'in My Projects';
    }
    var where = c.projectName || 'a project';
    if (c.screen) {
      where += ' › ' + c.screen + ' · ' + (c.editor === 'blocks' ? 'Blocks' : 'Designer');
    }
    return where;
  }

  function render() {
    if (!document.body) {
      return;
    }
    if (!panel) {
      installStyles();
      panel = el('div');
      panel.id = 'aicollab';
      document.body.appendChild(panel);
    }
    var others = C.roster.filter(function(c) { return !C.me || c.id !== C.me.id; });
    var here = others.filter(function(c) { return C.joined && c.projectId === C.joined; });
    var held = heldCount();
    var waiting = Object.keys(C.queues).filter(function(s) {
      return C.queues[s].length && !C.workspaces[C.joined + '_' + s];
    });
    var key = JSON.stringify([C.connected, C.roster, C.me && C.me.id, C.joined, C.expanded, held,
      waiting, C.notice, C.extraKey ? C.extraKey() : '']);
    if (key === lastRender) {
      return;
    }
    lastRender = key;
    panel.textContent = '';

    var head = el('div', 'aic-head');
    head.title = C.expanded ? 'Hide team panel' : 'Show who is working on what';
    head.onclick = function() {
      C.expanded = !C.expanded;
      render();
    };
    var status = el('span', 'aic-dot');
    status.style.background = C.connected ? '#2a2' : '#aaa';
    head.appendChild(status);
    head.appendChild(el('span', 'aic-title', 'Team'));
    head.appendChild(el('span', '', C.connected ?
      (here.length ? here.length + ' here' : others.length + ' online') : 'offline'));
    here.forEach(function(c) {
      var dot = el('span', 'aic-dot');
      dot.style.background = c.color;
      dot.title = c.name;
      head.appendChild(dot);
    });
    if (held) {
      head.appendChild(el('span', 'aic-badge', held + ' waiting'));
    }
    panel.appendChild(head);

    if (!C.expanded) {
      return;
    }
    var body = el('div', 'aic-body');
    if (!C.connected) {
      body.appendChild(el('div', '', 'Not connected to the team server. Your work is saved ' +
        'normally; teammates will not see it live until the connection is back.'));
    }
    var everyone = C.roster.slice().sort(function(a, b) {
      return (a.projectId === C.joined ? 0 : 1) - (b.projectId === C.joined ? 0 : 1);
    });
    everyone.forEach(function(c) {
      var row = el('div', 'aic-row');
      var dot = el('span', 'aic-dot');
      dot.style.background = c.color;
      dot.style.marginTop = '3px';
      row.appendChild(dot);
      var text = el('div');
      var name = el('div');
      name.appendChild(el('b', '', c.name + (C.me && c.id === C.me.id ? ' (you)' : '')));
      if (c.main) {
        name.appendChild(el('span', 'aic-badge', 'main'));
      }
      if (c.companion) {
        name.appendChild(el('span', 'aic-badge', 'testing on companion'));
      }
      text.appendChild(name);
      text.appendChild(el('div', 'aic-where', describe(c)));
      row.appendChild(text);
      body.appendChild(row);
    });
    if (held) {
      body.appendChild(el('div', 'aic-hold', 'Teammates\' changes are not on your companion ' +
        'yet. Use Connect › Reset Connection, then connect again to load them.'));
    }
    if (waiting.length) {
      body.appendChild(el('div', 'aic-note', 'A teammate is editing ' + waiting.join(', ') +
        ', which is not open here yet. Reopen the project to get new screens.'));
    }
    if (C.notice) {
      body.appendChild(el('div', 'aic-note', C.notice));
    }
    if (C.extraBody) {
      C.extraBody(body);
    }
    var actions = el('div');
    actions.style.marginTop = '6px';
    if (C.joined) {
      var link = el('a', '', 'Share this project with a teammate…');
      link.onclick = function(ev) {
        ev.stopPropagation();
        share();
      };
      actions.appendChild(link);
      actions.appendChild(el('br'));
    }
    var codeLink = el('a', '', 'Change team code…');
    codeLink.onclick = function(ev) {
      ev.stopPropagation();
      changeCodeDialog();
    };
    actions.appendChild(codeLink);
    body.appendChild(actions);
    panel.appendChild(body);
  }

  connect();
  setInterval(tick, TICK_MS);
  setInterval(sendCursor, CURSOR_MS);
  window.addEventListener('resize', renderCursors);
})();
