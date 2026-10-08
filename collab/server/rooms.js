'use strict';

// Room, presence and leader logic for the collaboration hub. Transport-free so it can be unit
// tested: the hub calls these methods and passes a send(clientId, message) function.

// Each person gets red, blue or yellow (the first one nobody online is using); a fourth person
// online at the same time would have to share a colour.
const COLORS = ['#e53935', '#1e88e5', '#fdd835'];
const CURSOR_MIN_GAP_MS = 1000;
const NOTICE_MIN_GAP_MS = 5000;

// Ops are kept so that someone who opens the project late can replay what the main client has
// not saved yet. The main client autosaves within 30s, so old ops are only trimmed once the log
// is large, and only if they are much older than that.
const LOG_SOFT_LIMIT = 5000;
const LOG_MIN_AGE_MS = 10 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

// The persistent syncer: every SYNC_MS the hub asks everybody for a fingerprint of the screens
// people are on. A follower whose fingerprint differs from the main client's twice in a row (and
// nothing was being edited at the time) gets the main client's copy.
const SYNC_MS = 30 * 1000;
const CHAT_KEEP = 50;
const CHAT_MAX_CHARS = 500;
const CHAT_MIN_GAP_MS = 500;
const ACTIVITY_KEEP = 30;
const LOCK_MS = 60 * 1000;
const SEL_MIN_GAP_MS = 400;
const DIGEST_FRESH_MS = 90 * 1000;
const QUIET_MS = 5 * 1000;
const RESYNC_MIN_GAP_MS = 60 * 1000;

class Hub {
  constructor(send, now = Date.now) {
    this.send = send;
    this.now = now;
    this.clients = new Map();
    this.rooms = new Map();
    this.nextClient = 1;
    this.flushWaits = new Map();   // applyId -> {waiting: Set of client ids, finish}
  }

  addClient({userId, email}) {
    const id = 'c' + (this.nextClient++);
    const color = this.pickColor(userId);
    const name = (email || 'user').split('@')[0];
    const client = {id, userId, email, name, color, projectId: null, projectName: '',
      screen: '', editor: '', companion: false, joinedAt: 0, cursor: null,
      cursorAt: -Infinity, noticeAt: -Infinity, digests: {}, strikes: {}, counted: {},
      resyncAt: -Infinity, selAt: -Infinity, chatAt: -Infinity, sel: null};
    this.clients.set(id, client);
    return client;
  }

  // Called once the transport can deliver messages to the new client.
  welcome(id) {
    const client = this.clients.get(id);
    if (!client) return;
    this.send(id, {t: 'hello', you: this.publicClient(client)});
    this.broadcastRoster();
  }

  pickColor(userId) {
    for (const c of this.clients.values()) {
      if (c.userId === userId) return c.color;
    }
    const used = new Set([...this.clients.values()].map(c => c.color));
    return COLORS.find(c => !used.has(c)) || COLORS[this.clients.size % COLORS.length];
  }

  removeClient(id) {
    const client = this.clients.get(id);
    if (!client) return;
    this.leave(id, false);
    this.clients.delete(id);
    this.broadcastRoster();
  }

  // access = {projectName, ownerEmail} from App Inventor's /ode/collab/access check.
  join(id, projectId, access) {
    const client = this.clients.get(id);
    if (!client) return;
    projectId = String(projectId);
    if (client.projectId === projectId) {
      const current = this.rooms.get(projectId);
      this.send(id, this.joinedMessage(current, id));
      return;
    }
    this.leave(id, false);
    let room = this.rooms.get(projectId);
    if (!room) {
      room = {projectId, projectName: access.projectName || '', ownerEmail: access.ownerEmail || '',
        members: new Set(), leader: null, log: [], seq: 0, emptySince: null, lastOpAt: -Infinity,
        backedSeq: 0, chat: [], activity: [], locks: new Map(),
        epoch: this.now().toString(36) + Math.random().toString(36).slice(2, 8)};
      this.rooms.set(projectId, room);
    }
    room.emptySince = null;
    room.members.add(id);
    client.projectId = projectId;
    client.projectName = room.projectName;
    client.joinedAt = this.now();
    client.screen = '';
    client.editor = '';
    client.digests = {};
    client.strikes = {};
    client.counted = {};
    this.electLeader(room, id);
    this.send(id, this.joinedMessage(room, id));
    this.broadcastRoster();
  }

  joinedMessage(room, id) {
    return {t: 'joined', projectId: room.projectId, epoch: room.epoch, leaderId: room.leader,
      log: room.log, cursors: this.cursorsInRoom(room, id), chat: room.chat,
      activity: room.activity, locks: this.lockList(room), sels: this.selsInRoom(room, id)};
  }

  leave(id, rosterUpdate = true) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return;
    const room = this.rooms.get(client.projectId);
    client.projectId = null;
    client.projectName = '';
    client.screen = '';
    client.editor = '';
    client.companion = false;
    client.cursor = null;
    client.sel = null;
    if (room) {
      room.members.delete(id);
      for (const [key, lock] of room.locks) if (lock.by === id) room.locks.delete(key);
      this.broadcastLocks(room);
      for (const m of room.members) this.send(m, {t: 'sel', id, blockId: null});
      for (const m of room.members) this.send(m, {t: 'cursor', id, x: null, y: null});
      if (room.members.size === 0) {
        room.leader = null;
        room.emptySince = this.now();
      } else if (room.leader === id) {
        this.electLeader(room, null);
      }
    }
    if (rosterUpdate) this.broadcastRoster();
  }

  // The project owner is the main client whenever they are present, otherwise whoever has been
  // in the project the longest.
  electLeader(room, joinedId) {
    const members = [...room.members].map(m => this.clients.get(m));
    const owner = members.find(c => room.ownerEmail && c.email === room.ownerEmail);
    let leader = this.clients.get(room.leader);
    if (!leader || !room.members.has(leader.id)) {
      leader = owner || members.sort((a, b) => a.joinedAt - b.joinedAt)[0] || null;
    } else if (owner && joinedId === owner.id && leader.id !== owner.id) {
      leader = owner;
    }
    const newLeader = leader ? leader.id : null;
    if (newLeader !== room.leader) {
      room.leader = newLeader;
      for (const m of room.members) {
        if (m !== joinedId) this.send(m, {t: 'leader', projectId: room.projectId, leaderId: newLeader});
      }
    }
  }

  presence(id, {screen, editor, companion}) {
    const client = this.clients.get(id);
    if (!client) return;
    const next = {screen: String(screen || ''), editor: String(editor || ''), companion: !!companion};
    if (next.screen === client.screen && next.editor === client.editor &&
        next.companion === client.companion) {
      return;
    }
    Object.assign(client, next);
    this.broadcastRoster();
  }

  // Where this person's mouse is, for the others in the same project. x and y are null when the
  // mouse is not over the blocks or designer area. For blocks they are workspace coordinates; for
  // the designer they are pixels from the top-left of the phone preview.
  cursor(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return;
    const room = this.rooms.get(client.projectId);
    if (!room) return;
    const hidden = msg.x === null || msg.x === undefined;
    let cursor = null;
    if (!hidden) {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7 ||
          (msg.editor !== 'blocks' && msg.editor !== 'designer') || typeof msg.screen !== 'string') {
        return;
      }
      if (this.now() - client.cursorAt < CURSOR_MIN_GAP_MS) return;
      cursor = {screen: msg.screen.slice(0, 100), editor: msg.editor, x: Math.round(x),
        y: Math.round(y)};
    } else if (!client.cursor) {
      return;  // already hidden
    }
    client.cursor = cursor;
    if (cursor) client.cursorAt = this.now();
    const out = cursor ? Object.assign({t: 'cursor', id}, cursor) : {t: 'cursor', id, x: null, y: null};
    for (const m of room.members) {
      if (m !== id) this.send(m, out);
    }
  }

  cursorsInRoom(room, exceptId) {
    const list = [];
    for (const m of room.members) {
      const c = this.clients.get(m);
      if (m !== exceptId && c && c.cursor) list.push(Object.assign({id: m}, c.cursor));
    }
    return list;
  }

  // Tells everyone online that something happened that they should know about (the team code was
  // changed). The text is composed here, from the sender's name, so it cannot be spoofed.
  codeChanged(id, signedOut) {
    const client = this.clients.get(id);
    if (!client || this.now() - client.noticeAt < NOTICE_MIN_GAP_MS) return false;
    client.noticeAt = this.now();
    const text = client.name + ' changed the team code' +
      (signedOut ? ' and signed everyone out' : '') + '. Ask them for the new code.';
    for (const other of this.clients.keys()) {
      if (other !== id) this.send(other, {t: 'notice', text});
    }
    return true;
  }

  op(id, {projectId, screen, kind, data}) {
    const client = this.clients.get(id);
    if (!client || !client.projectId || client.projectId !== String(projectId)) return;
    if (kind !== 'blocks' && kind !== 'designer' && kind !== 'tree') return;
    const room = this.rooms.get(client.projectId);
    const entry = {seq: ++room.seq, from: id, name: client.name, color: client.color,
      screen: String(screen), kind, data, at: this.now()};
    room.log.push(entry);
    room.lastOpAt = entry.at;
    this.recordActivity(room, client, entry);
    this.trim(room);
    for (const m of room.members) {
      if (m !== id) this.send(m, {t: 'op', projectId: room.projectId, op: entry});
    }
  }

  // ---- persistent syncer ----

  // Called every SYNC_MS. Everyone answers with {t:'digest'} for the screens listed.
  syncTick() {
    for (const room of this.rooms.values()) {
      if (room.members.size === 0) continue;
      const screens = [...new Set([...room.members]
        .map(m => this.clients.get(m).screen).filter(Boolean))].slice(0, 10);
      for (const m of room.members) {
        this.send(m, {t: 'sync', projectId: room.projectId, epoch: room.epoch, seq: room.seq,
          screens});
      }
    }
  }

  // A fingerprint of one screen: {screen, blocks, designer} (short strings; '' = not loaded).
  digest(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId || typeof msg.screen !== 'string') return;
    const room = this.rooms.get(client.projectId);
    if (!room) return;
    const screen = msg.screen.slice(0, 100);
    const clip = v => (typeof v === 'string' ? v.slice(0, 64) : '');
    const entry = {blocks: clip(msg.blocks), designer: clip(msg.designer), at: this.now()};
    if (!entry.blocks && !entry.designer) return;
    client.digests[screen] = entry;
    this.compare(room, screen);
  }

  // Compares each follower's latest fingerprint of a screen with the main client's, once per
  // report, when both come from the same round and nothing was being edited.
  compare(room, screen) {
    const leader = this.clients.get(room.leader);
    const ld = leader && leader.digests[screen];
    if (!ld) return;
    for (const m of room.members) {
      const f = this.clients.get(m);
      const fd = f && m !== room.leader && f.digests[screen];
      if (!fd || f.counted[screen] === fd.at || Math.abs(fd.at - ld.at) > 2 * QUIET_MS ||
          this.now() - Math.max(fd.at, ld.at) > DIGEST_FRESH_MS) {
        continue;
      }
      if (this.now() - room.lastOpAt < QUIET_MS) continue;  // try again with the next report
      f.counted[screen] = fd.at;
      const blocksDiffer = !!(fd.blocks && ld.blocks && fd.blocks !== ld.blocks);
      const designerDiffer = !!(fd.designer && ld.designer && fd.designer !== ld.designer);
      if (!blocksDiffer && !designerDiffer) {
        f.strikes[screen] = 0;
        continue;
      }
      f.strikes[screen] = (f.strikes[screen] || 0) + 1;
      if (f.strikes[screen] >= 2 && this.now() - f.resyncAt >= RESYNC_MIN_GAP_MS) {
        f.strikes[screen] = 0;
        f.resyncAt = this.now();
        this.send(room.leader, {t: 'snapshot-request', screen, forId: m, blocks: blocksDiffer,
          designer: designerDiffer});
      }
    }
  }

  // The main client's answer to a snapshot-request, passed on to the client that needs it.
  snapshot(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return false;
    const room = this.rooms.get(client.projectId);
    if (!room || room.leader !== id || !room.members.has(msg.forId)) return false;
    this.send(msg.forId, {t: 'resync', screen: String(msg.screen || '').slice(0, 100),
      blocks: typeof msg.blocks === 'string' ? msg.blocks : null, designer: !!msg.designer});
    return true;
  }

  // ---- recent changes, chat, selections and block locks ----

  describeOp(entry) {
    const d = entry.data || {};
    const screen = entry.screen;
    if (entry.kind === 'tree') return 'changed the screens or media';
    if (entry.kind === 'designer') {
      if (d.op === 'addmove') {
        let name = '';
        try { name = JSON.parse(d.b).$Name || ''; } catch (e) { /* not JSON */ }
        return name ? 'added ' + name + ' on ' + screen : 'added or moved a component on ' + screen;
      }
      if (d.op === 'remove') return 'removed a component on ' + screen;
      if (d.op === 'rename') return 'renamed a component to ' + String(d.a || '').slice(0, 40);
      return 'changed ' + String(d.a || 'a property').slice(0, 40) + ' on ' + screen;
    }
    const type = d.type;
    if (type === 'create') return 'added blocks on ' + screen;
    if (type === 'delete') return 'deleted blocks on ' + screen;
    if (type === 'move') return 'moved blocks on ' + screen;
    return 'edited blocks on ' + screen;
  }

  recordActivity(room, client, entry) {
    const text = this.describeOp(entry);
    const last = room.activity[room.activity.length - 1];
    if (last && last.name === client.name && last.text === text && entry.at - last.at < 30000) {
      last.at = entry.at;
      last.count = (last.count || 1) + 1;
      return;   // repeats are folded into one line, and are not re-sent one by one
    }
    const item = {name: client.name, color: client.color, text, at: entry.at, count: 1};
    room.activity.push(item);
    if (room.activity.length > ACTIVITY_KEEP) room.activity.shift();
    for (const m of room.members) this.send(m, {t: 'activity', item});
  }

  chat(id, text) {
    const client = this.clients.get(id);
    if (!client || !client.projectId || typeof text !== 'string') return;
    text = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX_CHARS);
    if (!text || this.now() - client.chatAt < CHAT_MIN_GAP_MS) return;
    client.chatAt = this.now();
    const room = this.rooms.get(client.projectId);
    const item = {name: client.name, color: client.color, text, at: this.now()};
    room.chat.push(item);
    if (room.chat.length > CHAT_KEEP) room.chat.shift();
    for (const m of room.members) this.send(m, {t: 'chat', item});
  }

  // What this person has selected in the blocks editor (a block id), or null.
  select(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return;
    const room = this.rooms.get(client.projectId);
    if (!room) return;
    const blockId = typeof msg.blockId === 'string' ? msg.blockId.slice(0, 80) : null;
    if (blockId && this.now() - client.selAt < SEL_MIN_GAP_MS) return;
    client.selAt = this.now();
    client.sel = blockId ? {screen: String(msg.screen || '').slice(0, 100), blockId,
      typing: !!msg.typing} : null;
    const out = client.sel ? Object.assign({t: 'sel', id}, client.sel) : {t: 'sel', id, blockId: null};
    for (const m of room.members) if (m !== id) this.send(m, out);
  }

  selsInRoom(room, exceptId) {
    const list = [];
    for (const m of room.members) {
      const c = this.clients.get(m);
      if (m !== exceptId && c && c.sel) list.push(Object.assign({id: m}, c.sel));
    }
    return list;
  }

  // A claim on a top-level block for a minute (renewed while it stays selected).
  lock(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return false;
    const room = this.rooms.get(client.projectId);
    const key = String(msg.screen || '').slice(0, 100) + '/' + String(msg.blockId || '').slice(0, 80);
    if (!msg.blockId) return false;
    this.expireLocks(room);
    const held = room.locks.get(key);
    if (held && held.by !== id) {
      this.send(id, {t: 'lock-denied', key, name: this.clients.get(held.by).name});
      return false;
    }
    const fresh = !held;
    room.locks.set(key, {by: id, until: this.now() + LOCK_MS});
    if (fresh) this.broadcastLocks(room);
    return true;
  }

  unlock(id, msg) {
    const client = this.clients.get(id);
    if (!client || !client.projectId) return;
    const room = this.rooms.get(client.projectId);
    const key = String(msg.screen || '').slice(0, 100) + '/' + String(msg.blockId || '').slice(0, 80);
    const held = room.locks.get(key);
    if (held && held.by === id) {
      room.locks.delete(key);
      this.broadcastLocks(room);
    }
  }

  expireLocks(room) {
    let changed = false;
    for (const [key, lock] of room.locks) {
      if (lock.until <= this.now()) { room.locks.delete(key); changed = true; }
    }
    if (changed) this.broadcastLocks(room);
  }

  lockList(room) {
    return [...room.locks].map(([key, lock]) => ({key, by: lock.by,
      name: (this.clients.get(lock.by) || {}).name}));
  }

  broadcastLocks(room) {
    const msg = {t: 'locks', list: this.lockList(room)};
    for (const m of room.members) this.send(m, msg);
  }

  // ---- backups ----

  // Projects that have changed since their last backup and who can make the backup (the main
  // client's account). The caller reports success with backedUp().
  backupsDue() {
    const due = [];
    for (const room of this.rooms.values()) {
      if (room.members.size > 0 && room.leader && room.seq !== room.backedSeq) {
        due.push({projectId: room.projectId, clientId: room.leader, seq: room.seq});
      }
    }
    return due;
  }

  backedUp(projectId, seq) {
    const room = this.rooms.get(String(projectId));
    if (room) room.backedSeq = seq;
  }

  // A backup was restored: start the project's session over and send everyone's page to reload. Returns how many
  // open tabs were told.
  restored(projectId, byName) {
    const room = this.rooms.get(String(projectId));
    if (!room) return 0;
    room.log = [];
    room.seq = 0;
    room.backedSeq = 0;
    room.epoch = this.now().toString(36) + Math.random().toString(36).slice(2, 8);
    for (const m of room.members) this.send(m, {t: 'reload', by: byName});
    return room.members.size;
  }

  // Before an AI change goes in, every open tab saves what it has and says so (ackFlush). Resolves when all of
  // them have, or after ms, whichever comes first. A tab that is not open cannot hold anything unsaved.
  awaitFlush(projectId, applyId, ms) {
    const room = this.rooms.get(String(projectId));
    const waiting = new Set(room ? room.members : []);
    if (!waiting.size) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.flushWaits.delete(applyId);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.flushWaits.set(applyId, {waiting, finish});
    });
  }

  ackFlush(clientId, applyId) {
    const wait = this.flushWaits.get(applyId);
    if (!wait) return;
    wait.waiting.delete(clientId);
    if (!wait.waiting.size) wait.finish();
  }

  // Tell everyone in a project something that makes their page start over (a restored backup).
  broadcastToProject(projectId, msg) {
    const room = this.rooms.get(String(projectId));
    if (!room) return 0;
    for (const m of room.members) this.send(m, msg);
    return room.members.size;
  }

  trim(room) {
    if (room.log.length <= LOG_SOFT_LIMIT) return;
    const cutoff = this.now() - LOG_MIN_AGE_MS;
    let drop = 0;
    while (drop < room.log.length - LOG_SOFT_LIMIT && room.log[drop].at < cutoff) drop++;
    if (drop) room.log.splice(0, drop);
  }

  sweep() {
    const now = this.now();
    for (const room of this.rooms.values()) this.expireLocks(room);
    for (const [pid, room] of this.rooms) {
      if (room.members.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(pid);
      }
    }
  }

  publicClient(c) {
    const room = c.projectId ? this.rooms.get(c.projectId) : null;
    return {id: c.id, name: c.name, email: c.email, color: c.color, projectId: c.projectId,
      projectName: c.projectName, screen: c.screen, editor: c.editor, companion: c.companion,
      main: !!room && room.leader === c.id};
  }

  roster() {
    return [...this.clients.values()].map(c => this.publicClient(c));
  }

  broadcastRoster() {
    const msg = {t: 'roster', clients: this.roster()};
    for (const id of this.clients.keys()) this.send(id, msg);
  }

  status() {
    return {
      clients: this.roster(),
      rooms: [...this.rooms.values()].map(r => ({projectId: r.projectId, projectName: r.projectName,
        members: [...r.members], leader: r.leader, ops: r.log.length, seq: r.seq}))
    };
  }
}

module.exports = {Hub, SYNC_MS, LOG_SOFT_LIMIT, EMPTY_ROOM_TTL_MS};
