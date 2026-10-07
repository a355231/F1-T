// -*- mode: javascript; js-indent-level: 2; -*-
// Released under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0
//
// More team features, on top of collab.js (see collab/README.md):
//   * the persistent syncer: every 30 seconds the hub asks for a fingerprint of your screens and
//     fixes a screen that has drifted from the main client's copy
//   * live companion updates, "Load teammates' changes"
//   * backups: right-click a project to go back to an earlier version
//   * new screens and media appearing for teammates
//   * following a teammate, selection outlines, block locks, recent changes, chat, alerts

(function() {
  'use strict';

  var C = window.AICollab;
  if (!C) {
    return;
  }

  var COMPANION_PUSH_MS = 5000;
  var LOCK_RENEW_MS = 20000;
  var FUSE_WINDOW_MS = 10 * 60 * 1000;
  var FUSE_REST_MS = 30 * 60 * 1000;

  C.activity = [];
  C.chat = [];
  C.locks = [];
  C.sels = {};            // client id -> {screen, blockId, typing}
  C.alerts = [];
  C.following = null;     // client id
  C.livePush = true;      // push teammates' changes to your companion every 5 seconds
  C.locksOn = true;
  C.syncStats = {digestsSent: 0, resyncs: 0, pushes: 0};

  var chatDraft = '';
  var chatFocused = false;
  var chatSeen = 0;
  var unread = 0;
  var followKey = '';
  var followAt = 0;
  var mySel = null;
  var lockTimer = null;
  var stuck = {};
  var treeTimer = null;

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

  function store(key, value) {
    try {
      if (value === undefined) {
        return window.sessionStorage.getItem(key);
      }
      window.sessionStorage.setItem(key, value);
    } catch (e) {
      // storage unavailable: the feature works without it
    }
    return null;
  }

  function hash(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) + ':' + text.length;
  }

  function context() {
    return C.context ? C.context() : null;
  }

  function companionOn() {
    return !!(C.companionConnected && C.companionConnected());
  }

  function clientById(id) {
    for (var i = 0; i < C.roster.length; i++) {
      if (C.roster[i].id === id) {
        return C.roster[i];
      }
    }
    return null;
  }

  // ---- messages from the hub ----

  C.onExtra = function(msg) {
    switch (msg.t) {
      case 'joined':
        C.activity = msg.activity || [];
        C.chat = msg.chat || [];
        C.locks = msg.locks || [];
        C.sels = {};
        (msg.sels || []).forEach(function(s) { C.sels[s.id] = s; });
        chatSeen = C.chat.length;
        unread = 0;
        break;
      case 'activity':
        C.activity.push(msg.item);
        if (C.activity.length > 30) {
          C.activity.shift();
        }
        break;
      case 'chat':
        C.chat.push(msg.item);
        if (C.chat.length > 50) {
          C.chat.shift();
        }
        if (!C.chatOpen) {
          unread++;
        }
        break;
      case 'locks':
        C.locks = msg.list || [];
        break;
      case 'lock-denied':
        toast(msg.name + ' is editing that block right now.');
        break;
      case 'sel':
        if (msg.blockId) {
          C.sels[msg.id] = msg;
        } else {
          delete C.sels[msg.id];
        }
        break;
      case 'alerts':
        C.alerts = msg.list || [];
        showBanner();
        break;
      case 'sync':
        onSync(msg);
        break;
      case 'snapshot-request':
        onSnapshotRequest(msg);
        break;
      case 'resync':
        onResync(msg);
        break;
      case 'freeze':
        window.AICollab_frozen = true;
        banner('restore', (msg.by || 'A teammate') + ' is going back to an earlier version of ' +
            'this project. Saving is paused; the page reloads in a moment.');
        break;
      case 'reload':
        window.AICollab_frozen = true;
        banner('restore', 'Loading the restored version…');
        setTimeout(function() { window.location.reload(); }, 1200);
        break;
      default:
        return;
    }
    C.render();
    drawMarks();
  };

  // ---- banners and toasts ----

  var banners = {};
  function banner(id, text) {
    if (text) {
      banners[id] = text;
    } else {
      delete banners[id];
    }
    var box = document.getElementById('aicollab-banner');
    if (!box) {
      box = el('div');
      box.id = 'aicollab-banner';
      document.body.appendChild(box);
    }
    box.textContent = '';
    Object.keys(banners).forEach(function(k) {
      box.appendChild(el('div', 'aic-banner-line', banners[k]));
    });
    box.style.display = Object.keys(banners).length ? 'block' : 'none';
  }

  function showBanner() {
    banner('alerts', C.alerts.length ? 'Team server: ' + C.alerts.join(' ') : '');
  }

  var toastTimer = null;
  function toast(text) {
    var t = document.getElementById('aicollab-toast');
    if (!t) {
      t = el('div');
      t.id = 'aicollab-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.display = 'none'; }, 3500);
  }
  C.toast = toast;

  // ---- the persistent syncer ----

  function blocksDigest(workspace) {
    try {
      var dom = Blockly.Xml.workspaceToDom(workspace, true);
      var parts = [];
      for (var n = dom.firstChild; n; n = n.nextSibling) {
        parts.push(Blockly.Xml.domToText(n));
      }
      parts.sort();
      return hash(parts.join('\n'));
    } catch (e) {
      return '';
    }
  }

  function digestFor(projectId, screen) {
    var ws = C.workspaces[projectId + '_' + screen];
    if (!ws || !window.AICollab_isScreenReady || !window.AICollab_isScreenReady(projectId, screen)) {
      return null;
    }
    if (ws.isDragging && ws.isDragging()) {
      return null;
    }
    var designer = '';
    try {
      designer = hash(window.AICollab_designerContent(projectId, screen) || '');
    } catch (e) {
      designer = '';
    }
    return {blocks: blocksDigest(ws), designer: designer};
  }

  function onSync(msg) {
    if (!C.joined || String(msg.projectId) !== C.joined) {
      return;
    }
    if (msg.epoch !== C.epoch) {
      C.send({t: 'join', projectId: C.joined});   // the team server started over: start with it
      return;
    }
    // A queue that has not moved since the last round is stuck: replay from the hub's log.
    var replay = false;
    Object.keys(C.queues).forEach(function(screen) {
      var q = C.queues[screen];
      var first = q.length ? q[0].seq : 0;
      if (first && stuck[screen] === first && C.workspaces[C.joined + '_' + screen]) {
        replay = true;
      }
      stuck[screen] = first;
    });
    if (replay) {
      C.syncStats.replays = (C.syncStats.replays || 0) + 1;
      C.queues = {};
      stuck = {};
      C.send({t: 'join', projectId: C.joined});
    }
    var screens = (msg.screens || []).slice();
    var ctx = context();
    if (ctx && ctx.screen && screens.indexOf(ctx.screen) < 0) {
      screens.push(ctx.screen);
    }
    screens.forEach(function(screen) {
      var d = digestFor(C.joined, screen);
      if (d) {
        C.syncStats.digestsSent++;
        C.send({t: 'digest', screen: screen, blocks: d.blocks, designer: d.designer});
      }
    });
  }

  function onSnapshotRequest(msg) {
    if (!C.joined) {
      return;
    }
    var out = {t: 'snapshot', screen: msg.screen, forId: msg.forId, designer: !!msg.designer};
    if (msg.blocks) {
      var ws = C.workspaces[C.joined + '_' + msg.screen];
      if (ws) {
        try {
          out.blocks = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws, true));
        } catch (e) {
          out.blocks = null;
        }
      }
    }
    if (msg.designer && window.AICollab_saveNow) {
      window.AICollab_saveNow();      // the teammate reloads the saved copy
    }
    C.send(out);
  }

  // Not more than twice per FUSE_WINDOW_MS per screen; after that, leave the screen alone for a
  // while (something makes the two copies look different without being different).
  function fuseOk(screen, kind) {
    var key = 'aicollab.fuse.' + kind + '.' + C.joined + '.' + screen;
    var now = Date.now();
    var list = [];
    try {
      list = JSON.parse(store(key) || '[]');
    } catch (e) {
      list = [];
    }
    list = list.filter(function(t) { return now - t < FUSE_REST_MS; });
    var recent = list.filter(function(t) { return now - t < FUSE_WINDOW_MS; });
    if (recent.length >= 2) {
      store(key, JSON.stringify(list));
      return false;
    }
    list.push(now);
    store(key, JSON.stringify(list));
    return true;
  }

  function onResync(msg) {
    if (!C.joined) {
      return;
    }
    if (typeof msg.blocks === 'string' && fuseOk(msg.screen, 'blocks')) {
      var ws = C.workspaces[C.joined + '_' + msg.screen];
      if (ws) {
        applyBlocksSnapshot(ws, msg.blocks);
        C.syncStats.resyncs++;
        toast('Your blocks on ' + msg.screen + ' were out of sync and were updated.');
      }
    }
    if (msg.designer && fuseOk(msg.screen, 'designer')) {
      banner('resync', 'Your designer on ' + msg.screen + ' was out of sync. Reloading from the ' +
          'saved copy…');
      setTimeout(function() { window.location.reload(); }, 5000);
    }
  }

  function applyBlocksSnapshot(ws, xml) {
    var previous = Blockly.Events.getGroup();
    Blockly.Events.setGroup('collab:resync');
    var undo = Blockly.Events.getRecordUndo ? Blockly.Events.getRecordUndo() : true;
    if (Blockly.Events.setRecordUndo) {
      Blockly.Events.setRecordUndo(false);
    }
    try {
      var dom = Blockly.utils.xml.textToDom('<xml>' + xml.replace(/^<xml[^>]*>|<\/xml>$/g, '') +
          '</xml>');
      Blockly.Xml.clearWorkspaceAndLoadFromXml(dom, ws);
    } catch (e) {
      console.warn('Could not apply the main client\'s blocks', e);
    } finally {
      if (Blockly.Events.setRecordUndo) {
        Blockly.Events.setRecordUndo(undo);
      }
      Blockly.Events.setGroup(previous || false);
    }
  }

  // ---- new screens and media ----

  C.onTreeOp = function() {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(function() {
      if (window.AICollab_refreshTree && C.joined) {
        window.AICollab_refreshTree(C.joined);
      }
    }, 1500);
  };

  // ---- the companion ----

  function heldTotal() {
    var count = 0;
    Object.keys(C.workspaces).forEach(function(k) {
      if (C.joined && k.indexOf(C.joined + '_') === 0) {
        count += Object.keys(C.workspaces[k].collabHeld || {}).length;
      }
    });
    var ps = window.top.ReplState && window.top.ReplState.phoneState;
    return count + (ps && ps.collabFormPending ? 1 : 0);
  }

  C.loadTeammatesChanges = function() {
    var ctx = context();
    if (!C.joined || !ctx || !window.AICollab_pushCompanion) {
      return;
    }
    C.clearHolds();
    C.syncStats.pushes++;
    window.AICollab_pushCompanion(C.joined, ctx.screen);
  };

  setInterval(function() {
    if (C.livePush && C.joined && heldTotal() > 0 && !document.hidden) {
      C.loadTeammatesChanges();
    }
  }, COMPANION_PUSH_MS);

  // ---- backups: right-click a project ----

  function closeMenu() {
    var m = document.getElementById('aicollab-menu');
    if (m) {
      m.remove();
    }
  }

  document.addEventListener('click', closeMenu, true);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeMenu();
    }
  }, true);

  document.addEventListener('contextmenu', function(e) {
    // The row's style name changes with its highlight, so look for it by pattern.
    var row = e.target;
    while (row && !(row.className && /ode-ProjectRow(Un)?[Hh]ighlighted|\bode-ProjectRow\b/.test(
        String(row.className)))) {
      row = row.parentElement;
    }
    if (!row || !window.AICollab_projectIdByName) {
      return;
    }
    var label = row.querySelector('.ode-ProjectNameLabel');
    var name = label ? label.textContent.trim() : '';
    var projectId = name ? window.AICollab_projectIdByName(name) : '';
    if (!projectId) {
      return;
    }
    e.preventDefault();
    closeMenu();
    var menu = el('div');
    menu.id = 'aicollab-menu';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 260) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 90) + 'px';
    var back = el('div', 'aic-menu-item', 'Go back to an earlier version…');
    back.onclick = function() {
      closeMenu();
      versionsDialog(projectId, name);
    };
    var now = el('div', 'aic-menu-item', 'Back up now');
    now.onclick = function() {
      closeMenu();
      postJson('/ode/collab/backup?projectId=' + projectId).then(function(r) {
        toast(r && r.enabled === false ? 'Backups are not set up on this server.' :
            r && r.id ? 'Backed up ' + name + '.' : name + ' has not changed since its last backup.');
      });
    };
    menu.appendChild(back);
    menu.appendChild(now);
    document.body.appendChild(menu);
  }, true);

  function postJson(url) {
    return fetch(url, {method: 'POST', credentials: 'same-origin'}).then(function(r) {
      return r.json().catch(function() { return null; });
    }).catch(function() { return null; });
  }

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) { return s + ' s ago'; }
    if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
    if (s < 129600) { return Math.round(s / 3600) + ' h ago'; }
    return Math.round(s / 86400) + ' days ago';
  }

  function versionsDialog(projectId, name) {
    var back = el('div');
    back.id = 'aicollab-dialog';
    var card = el('div', 'aic-card');
    card.appendChild(el('h3', '', 'Go back to an earlier version'));
    card.appendChild(el('p', '', name));
    var list = el('div', 'aic-versions');
    list.textContent = 'Loading…';
    card.appendChild(list);
    var error = el('div', 'aic-error');
    card.appendChild(error);
    var buttons = el('div', 'aic-buttons');
    var close = el('button', '', 'Close');
    close.onclick = function() { back.remove(); };
    buttons.appendChild(close);
    card.appendChild(buttons);
    back.appendChild(card);
    document.body.appendChild(back);

    fetch('/ode/collab/backups?projectId=' + projectId, {credentials: 'same-origin'})
        .then(function(r) { return r.json(); }).then(function(data) {
          list.textContent = '';
          if (!data.enabled) {
            list.textContent = 'This server keeps no backups.';
            return;
          }
          if (!data.backups.length) {
            list.textContent = 'No backups yet. They are made every minute while the project is ' +
                'being worked on.';
            return;
          }
          data.backups.forEach(function(b) {
            var row = el('div', 'aic-version');
            row.appendChild(el('span', '', new Date(b.at).toLocaleString() + '  (' + ago(b.at) + ')'));
            var go = el('button', '', 'Restore');
            go.onclick = function() {
              if (!window.confirm('Put "' + name + '" back to ' + new Date(b.at).toLocaleString() +
                  '? Everyone who has it open will reload. A backup of the current version is ' +
                  'made first, so you can undo this.')) {
                return;
              }
              restore(projectId, b.id, error, back);
            };
            row.appendChild(go);
            list.appendChild(row);
          });
        }).catch(function() { list.textContent = 'Could not load the list.'; });
  }

  function restore(projectId, id, error, dialog) {
    error.textContent = 'Restoring…';
    C.send({t: 'restoring', projectId: projectId});
    window.AICollab_frozen = true;
    fetch('/ode/collab/restore?projectId=' + projectId + '&id=' + encodeURIComponent(id),
        {method: 'POST', credentials: 'same-origin'})
        .then(function(r) { return r.json(); }).then(function(res) {
          if (!res.ok) {
            throw new Error(res.error || 'failed');
          }
          C.send({t: 'restored', projectId: projectId});
          setTimeout(function() { window.location.reload(); }, 1500);
          dialog.remove();
        }).catch(function(e) {
          window.AICollab_frozen = false;
          error.textContent = 'Could not restore: ' + e.message;
        });
  }

  // ---- following a teammate ----

  C.follow = function(id) {
    C.following = C.following === id ? null : id;
    followKey = '';
    C.render();
  };

  function followTick() {
    if (!C.following) {
      return;
    }
    var target = clientById(C.following);
    if (!target) {
      C.following = null;
      return;
    }
    if (!target.projectId) {
      return;
    }
    var key = [target.projectId, target.screen, target.editor].join('|');
    if (key === followKey || Date.now() - followAt < 1500) {
      return;
    }
    followKey = key;
    followAt = Date.now();
    if (C.joined !== target.projectId) {
      window.location.hash = target.projectId;
    } else if (target.screen && window.AICollab_goTo) {
      window.AICollab_goTo(target.projectId, target.screen, target.editor);
    }
  }

  // ---- selections and block locks ----

  function rootOf(workspace, blockId) {
    var block = workspace.getBlockById(blockId);
    return block ? block.getRootBlock().id : null;
  }

  function screenOf(workspace) {
    var m = /^\d+_(.+)$/.exec(workspace.formName || '');
    return m ? m[1] : '';
  }

  C.onUiEvent = function(workspace, e) {
    if (!C.joined) {
      return;
    }
    var screen = screenOf(workspace);
    if (e.oldElementId) {
      var oldRoot = rootOf(workspace, e.oldElementId);
      if (oldRoot && mySel && mySel.root === oldRoot) {
        C.send({t: 'unlock', screen: screen, blockId: oldRoot});
      }
    }
    if (e.newElementId && workspace.getBlockById(e.newElementId)) {
      var root = rootOf(workspace, e.newElementId);
      mySel = {screen: screen, blockId: e.newElementId, root: root};
      C.send({t: 'sel', screen: screen, blockId: e.newElementId, typing: false});
      if (C.locksOn && root) {
        C.send({t: 'lock', screen: screen, blockId: root});
      }
    } else if (!e.newElementId) {
      mySel = null;
      C.send({t: 'sel', blockId: null});
    }
  };

  setInterval(function() {
    if (mySel && C.locksOn && C.joined) {
      C.send({t: 'lock', screen: mySel.screen, blockId: mySel.root});
    }
  }, LOCK_RENEW_MS);

  function lockedByOther(screen, root) {
    var key = screen + '/' + root;
    for (var i = 0; i < C.locks.length; i++) {
      if (C.locks[i].key === key && C.me && C.locks[i].by !== C.me.id) {
        return C.locks[i];
      }
    }
    return null;
  }

  // Looking is fine; clicking into a block a teammate has claimed is blocked.
  function guard(e) {
    if (!C.locksOn || !C.joined || !C.locks.length) {
      return;
    }
    var g = e.target.closest && e.target.closest('.blocklyDraggable[data-id]');
    if (!g) {
      return;
    }
    var id = g.getAttribute('data-id');
    var found = null;
    Object.keys(C.workspaces).some(function(k) {
      var ws = C.workspaces[k];
      if (ws.getBlockById && ws.getBlockById(id)) {
        found = ws;
        return true;
      }
      return false;
    });
    if (!found) {
      return;
    }
    var lock = lockedByOther(screenOf(found), rootOf(found, id));
    if (lock) {
      e.stopPropagation();
      e.preventDefault();
      toast(lock.name + ' is editing this block. Try again in a minute, or ask them.');
    }
  }
  ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'contextmenu'].forEach(function(type) {
    document.addEventListener(type, guard, true);
  });
  document.addEventListener('keydown', function(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && mySel && C.locksOn) {
      var lock = lockedByOther(mySel.screen, mySel.root);
      if (lock) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
  }, true);

  // Teammates' selections and locks: coloured outline and a name tag on the block.
  var marks = {};
  var layer = null;

  function drawMarks() {
    if (!C.joined) {
      Object.keys(marks).forEach(function(k) { marks[k].remove(); delete marks[k]; });
      return;
    }
    if (!layer) {
      layer = el('div');
      layer.id = 'aicollab-marks';
      document.body.appendChild(layer);
    }
    var want = {};
    var ctx = context();
    var shown = ctx && ctx.editor === 'blocks' ? ctx.screen : null;
    Object.keys(C.sels).forEach(function(id) {
      var s = C.sels[id];
      var who = clientById(id);
      if (!who || s.screen !== shown) {
        return;
      }
      var ws = C.workspaces[C.joined + '_' + s.screen];
      var block = ws && ws.getBlockById(s.blockId);
      var svg = block && block.getSvgRoot && block.getSvgRoot();
      if (!svg) {
        return;
      }
      var r = svg.getBoundingClientRect();
      if (!r.width) {
        return;
      }
      var locked = C.locks.some(function(l) { return l.by === id &&
          l.key === s.screen + '/' + block.getRootBlock().id; });
      var key = id;
      want[key] = true;
      var m = marks[key];
      if (!m) {
        m = marks[key] = el('div', 'aic-mark');
        m.appendChild(el('span', 'aic-mark-tag'));
        layer.appendChild(m);
      }
      m.style.borderColor = who.color;
      m.style.left = r.left - 3 + 'px';
      m.style.top = r.top - 3 + 'px';
      m.style.width = r.width + 6 + 'px';
      m.style.height = r.height + 6 + 'px';
      var tag = m.firstChild;
      tag.style.background = who.color;
      tag.textContent = who.name + (s.typing ? ' is typing…' : locked ? ' is editing' : '');
    });
    Object.keys(marks).forEach(function(k) {
      if (!want[k]) {
        marks[k].remove();
        delete marks[k];
      }
    });
  }

  // Tell teammates when a field editor is open on your selected block.
  var lastTyping = false;
  setInterval(function() {
    if (!mySel || !C.joined) {
      return;
    }
    var w = document.querySelector('.blocklyWidgetDiv');
    var typing = !!(w && w.style.display !== 'none' && w.querySelector('input, textarea') &&
        document.activeElement && w.contains(document.activeElement));
    if (typing !== lastTyping) {
      lastTyping = typing;
      C.send({t: 'sel', screen: mySel.screen, blockId: mySel.blockId, typing: typing});
    }
  }, 1000);

  setInterval(function() {
    followTick();
    drawMarks();
  }, 700);

  // ---- the Team panel's extra sections ----

  C.extraKey = function() {
    return JSON.stringify([C.activity.length && C.activity[C.activity.length - 1].at,
      C.activity.length && C.activity[C.activity.length - 1].count, C.chat.length, unread,
      C.chatOpen, C.locks.length, C.following, C.livePush, C.locksOn, C.alerts, heldTotal(),
      companionOn()]);
  };

  function when(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  C.extraBody = function(body) {
    // Follow links beside names
    var rows = body.querySelectorAll('.aic-row');
    var others = C.roster.slice().sort(function(a, b) {
      return (a.projectId === C.joined ? 0 : 1) - (b.projectId === C.joined ? 0 : 1);
    });
    others.forEach(function(c, i) {
      if (!rows[i] || (C.me && c.id === C.me.id) || !c.projectId) {
        return;
      }
      var link = el('a', 'aic-follow', C.following === c.id ? 'stop following' : 'follow');
      link.title = 'Go to whatever ' + c.name + ' is looking at, and stay with them';
      link.onclick = function(ev) {
        ev.stopPropagation();
        C.follow(c.id);
      };
      rows[i].lastChild.firstChild.appendChild(link);
    });

    if (C.joined) {
      var sec = el('div', 'aic-section');
      var live = el('label', 'aic-opt');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = C.livePush;
      cb.onchange = function() {
        C.livePush = cb.checked;
        C.render();
      };
      live.appendChild(cb);
      live.appendChild(document.createTextNode(' Update my companion with teammates\' changes ' +
          'every 5 seconds'));
      sec.appendChild(live);
      if (!C.livePush && companionOn()) {
        var load = el('a', '', 'Load teammates\' changes now');
        load.onclick = function(ev) {
          ev.stopPropagation();
          C.loadTeammatesChanges();
          toast('Sent teammates\' changes to your companion.');
        };
        sec.appendChild(load);
      }
      var lockLabel = el('label', 'aic-opt');
      var lcb = el('input');
      lcb.type = 'checkbox';
      lcb.checked = C.locksOn;
      lcb.onchange = function() {
        C.locksOn = lcb.checked;
        C.render();
      };
      lockLabel.appendChild(lcb);
      lockLabel.appendChild(document.createTextNode(' Block locks (a selected block is yours for ' +
          'about a minute)'));
      sec.appendChild(lockLabel);
      body.appendChild(sec);

      var recent = el('div', 'aic-section');
      recent.appendChild(el('b', '', 'Recent changes'));
      if (!C.activity.length) {
        recent.appendChild(el('div', 'aic-where', 'Nothing yet.'));
      }
      C.activity.slice(-6).reverse().forEach(function(a) {
        var line = el('div', 'aic-where');
        var dot = el('span', 'aic-dot');
        dot.style.background = a.color;
        line.appendChild(dot);
        line.appendChild(document.createTextNode(' ' + a.name + ' ' + a.text +
            (a.count > 1 ? ' (' + a.count + '×)' : '') + ' · ' + when(a.at)));
        recent.appendChild(line);
      });
      body.appendChild(recent);

      var chat = el('div', 'aic-section');
      var title = el('a', '', (C.chatOpen ? '▾ ' : '▸ ') + 'Chat' + (unread ? ' (' + unread + ' new)' : ''));
      title.onclick = function(ev) {
        ev.stopPropagation();
        C.chatOpen = !C.chatOpen;
        unread = 0;
        C.render();
      };
      chat.appendChild(title);
      if (C.chatOpen) {
        var log = el('div', 'aic-chatlog');
        C.chat.forEach(function(m) {
          var line = el('div');
          var who = el('b', '', m.name + ': ');
          who.style.color = m.color === '#fdd835' ? '#a08400' : m.color;
          line.appendChild(who);
          line.appendChild(document.createTextNode(m.text));
          log.appendChild(line);
        });
        chat.appendChild(log);
        var input = el('input', 'aic-chatinput');
        input.placeholder = 'Message your teammates…';
        input.maxLength = 500;
        input.value = chatDraft;
        input.oninput = function() { chatDraft = input.value; };
        input.onfocus = function() { chatFocused = true; };
        input.onblur = function() { chatFocused = false; };
        input.onkeydown = function(ev) {
          ev.stopPropagation();
          if (ev.key === 'Enter' && input.value.trim()) {
            C.send({t: 'chat', text: input.value});
            chatDraft = '';
            input.value = '';
          }
        };
        chat.appendChild(input);
        setTimeout(function() {
          log.scrollTop = log.scrollHeight;
          if (chatFocused) {
            input.focus();
          }
        }, 0);
      }
      body.appendChild(chat);
    }
    var ai = el('div', 'aic-section');
    var aiLink = el('a', '', 'AI helper (Ctrl+I+M)');
    aiLink.onclick = function(ev) {
      ev.stopPropagation();
      C.openAiHelper();
    };
    ai.appendChild(aiLink);
    body.appendChild(ai);
  };

  // ---- AI helper: Ctrl+I+M opens it in its own window ----

  var iDown = false;
  C.openAiHelper = function() {
    var ctx = context();
    var id = ctx ? ctx.projectId : '';
    var win = window.open('/collab/ai?projectId=' + encodeURIComponent(C.joined || id), 'aihelper',
        'popup=yes,width=460,height=720');
    if (!win) {
      toast('Your browser blocked the AI helper window. Allow pop-ups for this site.');
    } else {
      win.focus();
    }
  };
  document.addEventListener('keydown', function(e) {
    if (e.code === 'KeyI') {
      iDown = true;
    } else if (e.code === 'KeyM' && e.ctrlKey && iDown) {
      e.preventDefault();
      e.stopPropagation();
      C.openAiHelper();
    }
  }, true);
  document.addEventListener('keyup', function(e) {
    if (e.code === 'KeyI') {
      iDown = false;
    }
  }, true);
  window.addEventListener('blur', function() { iDown = false; });

  // ---- styles ----

  var style = el('style');
  style.textContent =
    '#aicollab-banner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:1100;' +
    'max-width:min(640px,calc(100vw - 16px));background:#fff3cd;color:#5c4400;border:1px solid ' +
    '#e0c36a;border-radius:0 0 8px 8px;padding:6px 12px;font:13px/1.35 sans-serif;display:none;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
    '#aicollab-toast{position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:1100;' +
    'background:#333;color:#fff;padding:8px 14px;border-radius:6px;font:13px sans-serif;' +
    'display:none;max-width:calc(100vw - 32px)}' +
    '#aicollab-menu{position:fixed;z-index:1200;background:#fff;color:#222;border:1px solid #999;' +
    'border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.3);font:14px sans-serif;min-width:240px}' +
    '#aicollab-menu .aic-menu-item{padding:8px 14px;cursor:pointer}' +
    '#aicollab-menu .aic-menu-item:hover{background:#e8f0fe}' +
    '#aicollab .aic-section{margin-top:8px;padding-top:6px;border-top:1px solid #ddd}' +
    '#aicollab .aic-opt{display:block;margin:3px 0}' +
    '#aicollab .aic-follow{margin-left:6px;font-size:11px}' +
    '#aicollab .aic-chatlog{max-height:110px;overflow:auto;margin:4px 0;word-break:break-word}' +
    '#aicollab .aic-chatinput{width:100%;box-sizing:border-box;padding:4px;font-size:12px}' +
    '#aicollab-dialog .aic-version{display:flex;justify-content:space-between;align-items:center;' +
    'padding:5px 0;border-bottom:1px solid #eee}' +
    '#aicollab-dialog .aic-versions{max-height:300px;overflow:auto}' +
    '#aicollab-marks{position:fixed;left:0;top:0;width:0;height:0;z-index:940;pointer-events:none}' +
    '.aic-mark{position:fixed;border:3px solid;border-radius:6px;pointer-events:none}' +
    '.aic-mark-tag{position:absolute;left:-3px;top:-20px;color:#111;font:bold 11px/1.2 sans-serif;' +
    'padding:2px 6px;border-radius:8px 8px 8px 0;white-space:nowrap;' +
    'box-shadow:0 1px 3px rgba(0,0,0,.4)}';
  document.head.appendChild(style);
})();
