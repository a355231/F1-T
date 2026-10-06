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
  };

  var ws = null;
  var failures = 0;

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
    switch (msg.t) {
      case 'hello':
        C.me = msg.you;
        break;
      case 'roster':
        C.roster = msg.clients || [];
        break;
      case 'joined':
        if (String(msg.projectId) !== C.wanted) {
          return;
        }
        C.joined = C.wanted;
        C.epoch = msg.epoch;
        C.mainId = msg.leaderId;
        C.queues = {};
        updateRole();
        (msg.log || []).forEach(enqueue);
        processQueues();
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
    }
    processQueues();
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
      'border-color:#555}';
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
      waiting, C.notice]);
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
    if (C.joined) {
      var actions = el('div');
      actions.style.marginTop = '6px';
      var link = el('a', '', 'Share this project with a teammate…');
      link.onclick = function(ev) {
        ev.stopPropagation();
        share();
      };
      actions.appendChild(link);
      body.appendChild(actions);
    }
    panel.appendChild(body);
  }

  connect();
  setInterval(tick, TICK_MS);
})();
