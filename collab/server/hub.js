'use strict';

// Collaboration hub for MIT App Inventor.
//
// Browsers (and the Cloudflare tunnel) talk only to this process:
//   * every normal HTTP request is reverse-proxied to the App Inventor dev server, unchanged;
//   * /collab/ws is a WebSocket that relays blocks/designer edits and presence between clients;
//   * /collab/status shows who is connected (for troubleshooting).
// WebSocket users are authenticated with their App Inventor session cookie, and project access is
// checked with App Inventor before a client may join a project's room.

const http = require('http');
const {WebSocketServer} = require('ws');
const {Hub} = require('./rooms');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = new URL(process.env.AI_UPSTREAM || 'http://127.0.0.1:8888');
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const sockets = new Map();
const hub = new Hub((id, msg) => {
  const ws = sockets.get(id);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
});
setInterval(() => hub.sweep(), 60 * 1000).unref();

function forwardedProto(req) {
  const p = req.headers['x-forwarded-proto'];
  return p ? String(p).split(',')[0].trim() : 'http';
}

// App Inventor builds absolute redirects from the Host header; behind Cloudflare the browser is
// on https, so rewrite http:// redirects for the public host back to https://.
function fixLocation(location, req) {
  if (forwardedProto(req) !== 'https' || !req.headers.host) return location;
  const plain = 'http://' + req.headers.host;
  return location.startsWith(plain) ? 'https://' + location.slice('http://'.length) : location;
}

function proxy(req, res) {
  const headers = Object.assign({}, req.headers);
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = forwardedProto(req);
  const upstreamReq = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, upstreamRes => {
    const outHeaders = Object.assign({}, upstreamRes.headers);
    if (outHeaders.location) outHeaders.location = fixLocation(outHeaders.location, req);
    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, outHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, {'content-type': 'text/plain'});
    }
    res.end('App Inventor server is not reachable: ' + err.message);
  });
  req.pipe(upstreamReq);
}

function askAppInventor(path, cookie) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      method: 'GET',
      path,
      headers: {cookie: cookie || '', accept: 'application/json'},
      timeout: 10000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// The App Engine dev server's admin console (/_ah/admin) and its Google sign-in emulation, which
// lets anyone sign in as anyone, must only be usable from the Pi itself, never through the LAN or
// the Cloudflare tunnel (cloudflared runs on the Pi, so tunnel requests carry cf-connecting-ip).
function isFromPiItself(req) {
  const addr = req.socket.remoteAddress || '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}

function isPiOnlyPath(url) {
  const path = url.split('?')[0].toLowerCase();
  return path.startsWith('/_ah/') || path === '/_ah' || path.startsWith('/login/google');
}

const server = http.createServer((req, res) => {
  if (isPiOnlyPath(req.url) && !isFromPiItself(req)) {
    res.writeHead(403, {'content-type': 'text/plain'});
    res.end('This page is only available on the Raspberry Pi itself.');
    return;
  }
  if (req.url === '/collab/status') {
    res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
    const s = hub.status();
    // Room logs and emails stay private; this page is reachable through the tunnel.
    res.end(JSON.stringify({
      online: s.clients.map(c => ({name: c.name, projectName: c.projectName, screen: c.screen,
        editor: c.editor, companion: c.companion, main: c.main})),
      rooms: s.rooms.map(r => ({members: r.members.length, ops: r.ops})),
    }, null, 2));
    return;
  }
  proxy(req, res);
});

const wss = new WebSocketServer({noServer: true, maxPayload: MAX_MESSAGE_BYTES});

server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/collab/ws')) {
    socket.destroy();
    return;
  }
  const cookie = req.headers.cookie || '';
  const me = await askAppInventor('/ode/collab/whoami', cookie);
  if (!me || !me.userId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => onConnection(ws, me, cookie));
});

function onConnection(ws, me, cookie) {
  const client = hub.addClient({userId: me.userId, email: me.email});
  sockets.set(client.id, ws);
  hub.welcome(client.id);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    switch (msg.t) {
      case 'join': {
        const projectId = String(msg.projectId || '');
        if (!/^\d+$/.test(projectId)) return;
        const access = await askAppInventor('/ode/collab/access?projectId=' + projectId, cookie);
        if (!access || !access.ok) {
          ws.send(JSON.stringify({t: 'error', error: 'no-access', projectId}));
          return;
        }
        hub.join(client.id, projectId, access);
        break;
      }
      case 'leave':
        hub.leave(client.id);
        break;
      case 'presence':
        hub.presence(client.id, msg);
        break;
      case 'op':
        hub.op(client.id, msg);
        break;
      case 'ping':
        ws.send(JSON.stringify({t: 'pong'}));
        break;
      default:
        break;
    }
  });
  ws.on('close', () => {
    sockets.delete(client.id);
    hub.removeClient(client.id);
  });
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000).unref();

server.listen(PORT, HOST, () => {
  console.log(`App Inventor collaboration hub on http://${HOST}:${PORT} -> ${UPSTREAM.href}`);
});
