'use strict';

// Collaboration hub for MIT App Inventor.
//
// Browsers (and the Cloudflare tunnel) talk only to this process:
//   * every normal HTTP request is reverse-proxied to the App Inventor dev server, unchanged;
//   * /collab/ws is a WebSocket that relays blocks/designer edits and presence between clients;
//   * /collab/status shows who is connected (for troubleshooting).
// WebSocket users are authenticated with their App Inventor session cookie, and project access is
// checked with App Inventor before a client may join a project's room.

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const {WebSocketServer} = require('ws');
const {Hub, SYNC_MS} = require('./rooms');
const perf = require('./perf');
const staticCache = new perf.StaticCache();
const {Assistant} = require('./ai');

// The hub's own calls to App Inventor (sign-in, project access, backups) use their own connections, so that
// slow downloads through the proxy cannot starve them.
const askAgent = new http.Agent({keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000});
const ASK_MS = 30 * 1000;   // an answer that takes longer than this counts as no answer
// A backup zips the whole project, which can take minutes on a Pi.
const BACKUP_ASK_MS = parseInt(process.env.BACKUP_TIMEOUT_MS || String(5 * 60 * 1000), 10);
// A proxied reply from App Inventor that sends nothing for this long is given up.
const PROXY_IDLE_MS = 2 * 60 * 1000;
const BACKUP_FAILS_ALERT = 3;   // this many failed backups in a row are reported to the team

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
// A second listener for tunnels that connect from this machine (Tailscale Funnel). Everything that
// arrives on it counts as coming from the internet, so the Pi-only pages stay closed.
const EXTERNAL_PORT = parseInt(process.env.EXTERNAL_PORT || '0', 10);
const UPSTREAM = new URL(process.env.AI_UPSTREAM || 'http://127.0.0.1:8888');
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const BACKUP_MS = parseInt(process.env.BACKUP_MS || '60000', 10);
const VERSION_FILE = process.env.AI_VERSION_FILE || '/opt/appinventor/version';
const DATA_DIR = process.env.AI_DATA_DIR || '/opt/appinventor';
const STARTED_AT = Date.now();
// A promise that fails with nobody waiting for it would otherwise end the process, and with it every
// editor's live connection. Log it and carry on.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.stack || err));

const sockets = new Map();
const cookies = new Map();
const now = Date.now;
let alerts = [];
// A socket that is closing or closed takes no messages, and the hub does not wait for it.
function socketOpen(id) {
  const ws = sockets.get(id);
  return !!ws && ws.readyState === ws.OPEN;
}
// A message to several people is the same object each time, so it is turned into text once, not once per person.
let lastMsg = null;
let lastText = '';
function encode(msg) {
  if (msg !== lastMsg) {
    lastMsg = msg;
    lastText = JSON.stringify(msg);
  }
  return lastText;
}
const hub = new Hub((id, msg) => {
  if (socketOpen(id)) sockets.get(id).send(encode(msg));
}, Date.now, socketOpen);
setInterval(() => hub.sweep(), 10 * 1000).unref();

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

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// The browser's real address, for App Inventor's limit on wrong team codes. A client cannot set
// it: X-Forwarded-For is replaced, and Cloudflare's header is only believed when the request came
// from cloudflared on this machine.
function clientAddress(req) {
  const addr = req.socket.remoteAddress || '';
  const viaTunnel = req.headers['cf-connecting-ip'];
  if (isLoopback(addr) && viaTunnel) return String(viaTunnel).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (isLoopback(addr) && fwd && req.socket.server && req.socket.server.external) {
    return String(fwd).split(',')[0].trim();
  }
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

// After a failed update, update.sh leaves a notice in DATA_DIR/update-failed. Every page of App
// Inventor shows it, to whoever opens the link, until a later update succeeds.
function updateNotice() {
  try {
    return fs.readFileSync(DATA_DIR + '/update-failed', 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function withNotice(html, text) {
  const banner = '<div id="aicollab-update-notice" style="position:fixed;left:0;right:0;top:0;z-index:99999;' +
    'background:#b00020;color:#fff;padding:10px 14px;font:14px/1.4 sans-serif;text-align:center;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.3)">' + escapeHtml(text) + '</div>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => banner + '</body>') : html + banner;
}

function proxy(req, res) {
  // Only the hub itself may ask App Inventor for full-app changes (see ai.js), so a browser's copy
  // of this header is dropped here.
  delete req.headers['x-collab-ai-mode'];
  const cacheable = perf.isCacheable(req);
  if (cacheable) {
    const entry = staticCache.get(req.url);
    if (entry) {
      staticCache.hits++;
      staticCache.serve(req, res, entry).catch(() => res.destroy());
      return;
    }
  }
  const headers = Object.assign({}, req.headers);
  headers['x-forwarded-for'] = clientAddress(req);
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = forwardedProto(req);
  // The hub does the compressing, so App Inventor's replies come plain.
  headers['accept-encoding'] = 'identity';
  if (cacheable) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  const upstreamReq = http.request({
    agent: perf.agent,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, upstreamRes => {
    // A reply cut off part way (App Inventor restarting) must end the browser's reply too, not leave it waiting.
    upstreamRes.on('close', () => { if (!upstreamRes.complete) res.destroy(); });
    const outHeaders = Object.assign({}, upstreamRes.headers);
    if (outHeaders.location) outHeaders.location = fixLocation(outHeaders.location, req);
    // Only a reply with a known length is kept; a chunked one would be held whole in memory first.
    if (cacheable && upstreamRes.statusCode === 200 && !outHeaders['set-cookie'] &&
        outHeaders['content-length'] !== undefined &&
        parseInt(outHeaders['content-length'], 10) <= perf.MAX_ENTRY_BYTES) {
      // Keep it for next time, and answer from the copy.
      staticCache.misses++;
      const chunks = [];
      let size = 0;
      upstreamRes.on('data', c => { chunks.push(c); size += c.length; });
      upstreamRes.on('end', () => {
        const body = Buffer.concat(chunks, size);
        const entry = staticCache.put(req.url, outHeaders, body);
        if (entry) {
          staticCache.serve(req, res, entry).catch(() => res.destroy());
        } else {
          delete outHeaders['content-encoding'];
          outHeaders['content-length'] = body.length;
          res.writeHead(200, outHeaders);
          res.end(body);
        }
      });
      upstreamRes.on('error', () => res.destroy());
      return;
    }
    const notice = upstreamRes.statusCode === 200 && /text\/html/i.test(String(outHeaders['content-type'] || ''))
      ? updateNotice() : '';
    if (notice) {
      const chunks = [];
      upstreamRes.on('data', c => chunks.push(c));
      upstreamRes.on('end', () => {
        const page = Buffer.from(withNotice(Buffer.concat(chunks).toString('utf8'), notice), 'utf8');
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = page.length;
        res.writeHead(200, outHeaders);
        res.end(page);
      });
      upstreamRes.on('error', () => res.destroy());
      return;
    }
    const compressor = perf.compressStream(req, upstreamRes, outHeaders);
    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, outHeaders);
    if (compressor) {
      upstreamRes.pipe(compressor).pipe(res);
      compressor.on('error', () => res.destroy());
    } else {
      upstreamRes.pipe(res);
    }
  });
  // App Inventor that stops answering is given up on, and so is a browser that has gone (a download closed part way),
  // so neither keeps a connection to App Inventor open for nothing.
  upstreamReq.setTimeout(PROXY_IDLE_MS, () => upstreamReq.destroy(new Error('App Inventor stopped answering')));
  res.on('close', () => { if (!res.writableFinished) upstreamReq.destroy(); });
  upstreamReq.on('error', () => {
    if (res.destroyed || res.writableEnded) return;   // the browser has already gone
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(502, {'content-type': 'text/plain'});
      res.end('App Inventor is not reachable. It may be restarting.');
    }
  });
  req.pipe(upstreamReq);
}

// One call from the hub to App Inventor. Resolves to:
//   * the JSON reply, for a 200;
//   * for any other status with a JSON body, that body plus {ok: false, status} (so a 403 "no access to project" is
//     told apart from a failure);
//   * null when App Inventor did not answer: no reply, a reply cut off part way, unreadable JSON, or no answer
//     within ms (the wait for a free connection counts too).
function askAppInventor(path, cookie, method = 'GET', body = null, extraHeaders = {}, ms = ASK_MS) {
  return new Promise(resolve => {
    let req = null;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const deadline = setTimeout(() => {
      finish(null);
      if (req) req.destroy();
    }, ms);
    req = http.request({
      agent: askAgent,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      method,
      path,
      headers: Object.assign({cookie: cookie || '', accept: 'application/json'},
        method === 'GET' ? {} : body === null ? {'content-length': '0'} :
          {'content-length': Buffer.byteLength(body), 'content-type': 'application/json'},
        extraHeaders),
      timeout: ms,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      // A reply cut off part way never reaches 'end', but it does close.
      res.on('close', () => finish(null));
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return finish(null);
        }
        if (res.statusCode === 200) return finish(data);
        finish(data && typeof data === 'object' ? Object.assign({}, data, {ok: false, status: res.statusCode}) : null);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(null));
    req.end(body === null ? undefined : body);
  });
}

// The App Engine dev server's admin console (/_ah/admin) and its Google sign-in emulation, which
// lets anyone sign in as anyone, must only be usable from the Pi itself, never through the LAN or
// the Cloudflare tunnel (cloudflared runs on the Pi, so tunnel requests carry cf-connecting-ip).
function isFromPiItself(req) {
  if (req.socket.server && req.socket.server.external) return false;
  return isLoopback(req.socket.remoteAddress || '') && !req.headers['cf-connecting-ip'] &&
    !req.headers['x-forwarded-for'];
}

// The path as the App Engine dev server will route it: percent-escapes decoded (it decodes them before it matches a
// servlet path), ';' parameters and dot segments removed, repeated slashes folded, lower-cased. The Pi-only checks
// test this, not the raw URL, so /%5Fah/admin is refused just like /_ah/admin. null when the escapes do not decode.
function routedPath(url) {
  let path = url.split('?')[0];
  try {
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch (e) {
    return null;
  }
  const parts = [];
  for (const segment of path.split(/[?#]/)[0].replace(/\\/g, '/').split('/')) {
    const name = segment.split(';')[0];
    if (name === '' || name === '.') continue;
    if (name === '..') parts.pop();
    else parts.push(name);
  }
  return ('/' + parts.join('/')).toLowerCase();
}

function isPiOnlyPath(path) {
  return path === '/_ah' || path.startsWith('/_ah/') || path.startsWith('/login/google');
}

const ai = new Assistant({ask: askAppInventor, hub});

const server = http.createServer((req, res) => {
  req.socket.setNoDelay(true);
  const path = routedPath(req.url);
  if (path === null) {
    res.writeHead(400, {'content-type': 'text/plain'});
    res.end('Bad request.');
    return;
  }
  if (isPiOnlyPath(path) && !isFromPiItself(req)) {
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
      version: readVersion(),
      cache: {entries: staticCache.entries.size, mb: Math.round(staticCache.bytes / 104857.6) / 10,
        hits: staticCache.hits, misses: staticCache.misses},
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      alerts,
      updateFailed: updateNotice() || null,
    }, null, 2));
    return;
  }
  if (req.url.split('?')[0].startsWith('/collab/ai')) {
    // An error in the helper must never take the whole hub down with it: everyone's editor depends on it.
    ai.handle(req, res).catch(err => {
      console.error('AI helper error:', err && err.stack || err);
      if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json'});
      if (!res.writableEnded) res.end(JSON.stringify({error: 'The helper had a problem. Try again.'}));
    });
    return;
  }
  if (req.url.split('?')[0].startsWith('/collab/admin')) {
    handleAdmin(req, res);
    return;
  }
  proxy(req, res);
});

const wss = new WebSocketServer({noServer: true, maxPayload: MAX_MESSAGE_BYTES});

async function onUpgrade(req, socket, head) {
  // Until ws takes the socket, nothing else listens for its errors: a connection reset while it waits for App
  // Inventor's answer must close that socket, not end the hub.
  socket.on('error', () => socket.destroy());
  if (!req.url.startsWith('/collab/ws')) {
    socket.destroy();
    return;
  }
  const cookie = req.headers.cookie || '';
  const me = await askAppInventor('/ode/collab/whoami', cookie);
  if (socket.destroyed) return;
  if (!me || !me.userId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => onConnection(ws, me, cookie));
}
server.on('upgrade', onUpgrade);

function onConnection(ws, me, cookie) {
  const client = hub.addClient({userId: me.userId, email: me.email});
  client.restoreAt = 0;
  client.joinAttempt = 0;   // counts joins and leaves, so that a slow answer to an old join is ignored
  sockets.set(client.id, ws);
  cookies.set(client.id, cookie);
  hub.welcome(client.id);
  ws.send(JSON.stringify({t: 'alerts', list: alerts}));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A frame that is too big or breaks the protocol is an error on this socket only. Without a listener it would
  // end the whole hub, and with it everyone's live connection.
  ws.on('error', err => {
    console.error('Connection error:', err.message);
    ws.terminate();
  });
  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'join': {
        const projectId = String(msg.projectId || '');
        if (!/^\d+$/.test(projectId)) return;
        const attempt = ++client.joinAttempt;
        const stale = () => attempt !== client.joinAttempt;   // a later join or a leave has overtaken this one
        // A check that did not go through (no answer, or a failure other than a refusal) is tried once more.
        const failed = a => !a || (!a.ok && a.status !== 403);
        const check = () => askAppInventor('/ode/collab/access?projectId=' + projectId, cookie);
        let access = await check();
        if (stale()) return;
        if (failed(access)) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (stale()) return;
          access = await check();
          if (stale()) return;
          if (failed(access)) {
            // The page tries again in a few seconds (see tick in collab.js).
            ws.send(JSON.stringify({t: 'error', error: 'retry', projectId}));
            return;
          }
        }
        // 403 is App Inventor saying this person has no access to the project.
        if (!access.ok) {
          ws.send(JSON.stringify({t: 'error', error: 'no-access', projectId}));
          return;
        }
        hub.join(client.id, projectId, access);
        break;
      }
      case 'leave':
        client.joinAttempt++;
        hub.leave(client.id);
        break;
      case 'presence':
        hub.presence(client.id, msg);
        break;
      case 'cursor':
        hub.cursor(client.id, msg);
        break;
      case 'sync-all': {
        // A manual sync of the project (see Hub.syncAll in rooms.js). When it does not go through, the person who asked
        // is told why; when it does, every page reloads. Two in quick succession would reload everyone twice, so the
        // second waits. (A restore is not limited: a refused restore would leave the other tabs out of date.)
        const projectId = String(msg.projectId || '');
        if (hub.reloadTooSoon(projectId)) {
          hub.send(client.id, {t: 'notice', text: 'Everyone on this project was just reloaded. Try again in a moment.'});
          break;
        }
        const result = await hub.syncAll(client.id, projectId);
        if (!result.ok) hub.send(client.id, {t: 'notice', text: result.message});
        break;
      }
      case 'flushed':
        // This tab has saved what it had, ready for an AI change (see Assistant.apply in ai.js). ok false means
        // its save failed, so the change must not go in.
        hub.ackFlush(client.id, String(msg.applyId || ''), msg.ok !== false);
        break;
      case 'codechanged': {
        // Do not take the browser's word for it: ask App Inventor whether this person really just
        // changed the code, and whether everyone was signed out.
        const last = await askAppInventor('/ode/collab/lastcodechange', cookie);
        if (last && last.by === me.userId && Date.now() - last.at < 60 * 1000 &&
            hub.codeChanged(client.id, !!last.signedOut) && last.signedOut) {
          setTimeout(() => revalidateEveryone(client.id), 500);
        }
        break;
      }
      case 'op':
        hub.op(client.id, msg);
        break;
      case 'chat':
        hub.chat(client.id, msg.text);
        break;
      case 'sel':
        hub.select(client.id, msg);
        break;
      case 'lock':
        hub.lock(client.id, msg);
        break;
      case 'unlock':
        hub.unlock(client.id, msg);
        break;
      case 'digest':
        hub.digest(client.id, msg);
        break;
      case 'snapshot':
        hub.snapshot(client.id, msg);
        break;
      case 'restoring':
      case 'restored': {
        // Someone is putting an older backup back (they need access to the project to do so):
        // everyone with the project open stops saving, then reloads.
        const projectId = String(msg.projectId || '');
        if (!/^\d+$/.test(projectId)) return;
        if (msg.t === 'restoring' && now() - client.restoreAt < 2000) return;
        const access = await askAppInventor('/ode/collab/access?projectId=' + projectId, cookie);
        if (!access || !access.ok) return;
        if (msg.t === 'restoring') {
          client.restoreAt = now();
          hub.freezeForRestore(projectId, client.name);
        } else if (msg.failed) {
          // The restore did not go through (the page that asked says so): everyone carries on as before.
          hub.unfreezeProject(projectId);
        } else {
          hub.restored(projectId, client.name);
        }
        break;
      }
      default:
        break;
    }
  });
  ws.on('close', () => {
    sockets.delete(client.id);
    cookies.delete(client.id);
    hub.removeClient(client.id);
  });
}

// After a sign-out, close the connections of people whose App Inventor login is no longer valid.
async function revalidateEveryone(exceptId) {
  for (const [id, ws] of sockets) {
    if (id === exceptId) continue;
    const me = await askAppInventor('/ode/collab/whoami', cookies.get(id));
    if (!me || !me.userId) ws.close(4001, 'signed out');
  }
}

setInterval(() => revalidateEveryone(), 2 * 60 * 1000).unref();

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


// ---- admin page: who is online, kick a person ----

const ADMIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Team admin</title>
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:20px auto;padding:0 12px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}
button{cursor:pointer}.warn{background:#fff3cd;padding:8px;margin:8px 0;border-radius:4px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}</style>
<h2>Team admin</h2><div id=alerts></div><div id=info></div>
<table id=t><thead><tr><th>Name<th>Where<th>Companion<th></tr></thead><tbody></tbody></table>
<h3>Sign everyone out</h3>
<p>Asks everyone to sign in again with the same team code. You stay signed in.
<form id=so><input id=code type=password placeholder="Current team code" autocomplete=off>
<button>Sign everyone out</button></form><p id=msg></p>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function load(){
  const r=await fetch('/collab/admin/data',{cache:'no-store'});
  if(!r.ok){document.body.innerHTML='<p>Sign in to App Inventor first, then reload this page.';return}
  const d=await r.json();
  document.getElementById('alerts').innerHTML=d.alerts.map(a=>'<div class=warn>'+esc(a)+'</div>').join('');
  document.getElementById('info').textContent='Version '+d.version+' - up '+Math.floor(d.uptimeSeconds/60)+' min';
  document.querySelector('#t tbody').innerHTML=d.online.map(c=>'<tr><td><span class=dot style="background:'+esc(c.color)+'"></span>'+esc(c.name)+(c.me?' (you)':'')
   +'<td>'+esc(c.projectName?c.projectName+' / '+(c.screen||'-')+' / '+(c.editor||'-'):'not in a project')
   +'<td>'+(c.companion?'yes':'')+'<td>'+(c.me?'':'<button data-n="'+esc(c.name)+'">Sign out</button>')+'</tr>').join('');
}
document.addEventListener('click',async e=>{const n=e.target.dataset&&e.target.dataset.n;if(!n)return;
  if(!confirm('Sign '+n+' out? They can sign back in with the team code.'))return;
  await fetch('/collab/admin/kick?name='+encodeURIComponent(n),{method:'POST'});load()});
document.getElementById('so').onsubmit=async e=>{e.preventDefault();
  const r=await fetch('/ode/collab/teamcode',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'signout=true&new=&current='+encodeURIComponent(document.getElementById('code').value)});
  if(r.ok)await fetch('/collab/admin/revalidate',{method:'POST'});
  document.getElementById('msg').textContent=r.ok?'Everyone else was signed out.':(await r.json()).error||'Failed';document.getElementById('code').value='';load()};
load();setInterval(load,5000);
</script>`;

async function handleAdmin(req, res) {
  const path = req.url.split('?')[0];
  const cookie = req.headers.cookie || '';
  const me = await askAppInventor('/ode/collab/whoami', cookie);
  const json = (code, body) => {
    res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  };
  if (!me || !me.userId) {
    if (path === '/collab/admin') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<p>Sign in to App Inventor first, then reload this page.');
    } else {
      json(401, {error: 'not signed in'});
    }
    return;
  }
  if (path === '/collab/admin' && req.method === 'GET') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(ADMIN_PAGE);
  } else if (path === '/collab/admin/data') {
    json(200, {
      version: readVersion(), uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000), alerts,
      online: hub.roster().map(c => ({name: c.name, color: c.color, projectName: c.projectName,
        screen: c.screen, editor: c.editor, companion: c.companion, me: c.email === me.email})),
    });
  } else if (path === '/collab/admin/kick' && req.method === 'POST') {
    const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
    const out = await askAppInventor('/ode/collab/kick?name=' + encodeURIComponent(name), cookie, 'POST');
    if (!out || !out.ok) return json(400, {error: 'Could not sign that person out.'});
    for (const [id, ws] of sockets) {
      const c = hub.clients.get(id);
      if (c && c.userId === out.userId) ws.close(4001, 'signed out');
    }
    json(200, {ok: true});
  } else if (path === '/collab/admin/revalidate' && req.method === 'POST') {
    // After a sign-out made through /ode/collab/teamcode: drop everyone whose login stopped working.
    json(200, {ok: true});
    setTimeout(() => revalidateEveryone(), 500);
  } else {
    json(404, {error: 'unknown'});
  }
}

// ---- persistent syncer, backups, health ----

setInterval(() => hub.syncTick(), SYNC_MS).unref();

let backingUp = false;
let backupsOff = false;          // App Inventor keeps no backups here: stop asking until a restart
const backupFails = new Map();   // projectId -> backups that failed in a row
async function runBackups() {
  if (backingUp || backupsOff) return;
  backingUp = true;
  try {
    for (const due of hub.backupsDue()) {
      const cookie = cookies.get(due.clientId);
      if (!cookie) continue;
      const result = await askAppInventor('/ode/collab/backup?projectId=' + due.projectId, cookie,
        'POST', null, {}, BACKUP_ASK_MS);
      // enabled=false means this server keeps no backups. Recording that as a backup would be a lie.
      if (result && result.ok && result.enabled === false) {
        backupsOff = true;
        break;
      }
      if (result && result.ok) {
        backupFails.delete(due.projectId);
        hub.backedUp(due.projectId, due.seq, due.epoch);
      } else {
        backupFails.set(due.projectId, (backupFails.get(due.projectId) || 0) + 1);
      }
    }
  } finally {
    backingUp = false;
  }
}
setInterval(runBackups, BACKUP_MS).unref();

function readVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch (e) {
    return 'unknown';
  }
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.connect({port, host});
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => resolve(false));
  });
}

// Things worth telling the team about: a full disk, little memory, App Inventor not answering.
async function checkHealth() {
  const list = [];
  try {
    const st = fs.statfsSync(DATA_DIR);
    const freeMb = Math.floor(st.bavail * st.bsize / 1048576);
    if (freeMb < 300) list.push('The Raspberry Pi is almost out of disk space (' + freeMb + ' MB left).');
  } catch (e) { /* not available here */ }
  const freeMem = os.freemem() / 1048576;
  if (freeMem < 120) list.push('The Raspberry Pi is low on memory (' + Math.floor(freeMem) + ' MB free).');
  if (!(await portOpen(UPSTREAM.port || 80, UPSTREAM.hostname))) {
    list.push('App Inventor is not answering. It may be restarting; saving is paused.');
  }
  if (backupsOff) {
    list.push('Backups are switched off on this Pi, so changes are not being kept. Whoever runs the Pi should set the backup folder.');
  }
  if ([...backupFails.values()].some(n => n >= BACKUP_FAILS_ALERT)) {
    list.push('Project backups keep failing, so recent changes may not be kept. Whoever runs the Pi should check it.');
  }
  try {
    const upd = fs.readFileSync(DATA_DIR + '/update-available', 'utf8').trim();
    if (upd) list.push('A newer version is available (' + upd + '). Whoever runs the Pi can update it.');
  } catch (e) { /* none */ }
  if (JSON.stringify(list) !== JSON.stringify(alerts)) {
    alerts = list;
    for (const ws of sockets.values()) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({t: 'alerts', list}));
    }
  }
}
setInterval(checkHealth, parseInt(process.env.HEALTH_MS || '30000', 10)).unref();
setTimeout(checkHealth, 3000).unref();

if (EXTERNAL_PORT) {
  const external = http.createServer(server.listeners('request')[0]);
  external.external = true;
  external.on('upgrade', onUpgrade);
  external.listen(EXTERNAL_PORT, '127.0.0.1');
}

server.listen(PORT, HOST, () => {
  console.log(`App Inventor collaboration hub on http://${HOST}:${PORT} -> ${UPSTREAM.href}`);
});
