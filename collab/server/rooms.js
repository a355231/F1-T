'use strict';

// Room, presence and leader logic for the collaboration hub. Transport-free so it can be unit
// tested: the hub calls these methods and passes a send(clientId, message) function.

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324',
  '#800000', '#808000', '#000075'];

// Ops are kept so that someone who opens the project late can replay what the main client has
// not saved yet. The main client autosaves within 30s, so old ops are only trimmed once the log
// is large, and only if they are much older than that.
const LOG_SOFT_LIMIT = 5000;
const LOG_MIN_AGE_MS = 10 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

class Hub {
  constructor(send, now = Date.now) {
    this.send = send;
    this.now = now;
    this.clients = new Map();
    this.rooms = new Map();
    this.nextClient = 1;
  }

  addClient({userId, email}) {
    const id = 'c' + (this.nextClient++);
    const color = this.pickColor(userId);
    const name = (email || 'user').split('@')[0];
    const client = {id, userId, email, name, color, projectId: null, projectName: '',
      screen: '', editor: '', companion: false, joinedAt: 0};
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
      this.send(id, {t: 'joined', projectId, epoch: current.epoch, leaderId: current.leader,
        log: current.log});
      return;
    }
    this.leave(id, false);
    let room = this.rooms.get(projectId);
    if (!room) {
      room = {projectId, projectName: access.projectName || '', ownerEmail: access.ownerEmail || '',
        members: new Set(), leader: null, log: [], seq: 0, emptySince: null,
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
    this.electLeader(room, id);
    this.send(id, {t: 'joined', projectId, epoch: room.epoch, leaderId: room.leader, log: room.log});
    this.broadcastRoster();
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
    if (room) {
      room.members.delete(id);
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

  op(id, {projectId, screen, kind, data}) {
    const client = this.clients.get(id);
    if (!client || !client.projectId || client.projectId !== String(projectId)) return;
    if (kind !== 'blocks' && kind !== 'designer') return;
    const room = this.rooms.get(client.projectId);
    const entry = {seq: ++room.seq, from: id, name: client.name, color: client.color,
      screen: String(screen), kind, data, at: this.now()};
    room.log.push(entry);
    this.trim(room);
    for (const m of room.members) {
      if (m !== id) this.send(m, {t: 'op', projectId: room.projectId, op: entry});
    }
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

module.exports = {Hub, LOG_SOFT_LIMIT, EMPTY_ROOM_TTL_MS};
