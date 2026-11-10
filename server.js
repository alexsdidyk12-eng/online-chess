'use strict';
/*
 * Online chess server — no npm dependencies, Node >= 18.
 *
 *  - Serves public/index.html
 *  - Rooms are identified by a 4-digit code. The creator gets a seat + secret token,
 *    the second player joins with the code and gets the other seat.
 *  - Every move is validated here with the SAME rules code that the browser uses:
 *    the <script id="engine-src"> block of index.html is loaded into a vm context.
 *  - Live updates go to the browsers over Server-Sent Events (works on Render as is).
 *  - Rooms live in memory only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const INDEX_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const INDEX_GZ = zlib.gzipSync(INDEX_RAW, { level: 9 });

/* ---------- rules engine: the very same code as in the browser ---------- */
const engineMatch = /<script id="engine-src">([\s\S]*?)<\/script>/.exec(INDEX_RAW.toString('utf8'));
if (!engineMatch) throw new Error('engine-src block not found in public/index.html');
const ctx = vm.createContext({});
vm.runInContext(engineMatch[1], ctx, { filename: 'engine-src' });
const Pos = ctx.Pos, uciToMove = ctx.uciToMove, applyTok = ctx.applyTok, START_FEN = ctx.START_FEN;

/* ---------- rooms ---------- */
const MAX_ROOMS = 9000;
const WAITING_TTL = 30 * 60 * 1000;      // nobody joined / game finished and nobody connected
const GAME_TTL = 3 * 60 * 60 * 1000;     // running game with nobody connected
const rooms = new Map();                 // code -> room

function newCode() {
  if (rooms.size >= MAX_ROOMS) return null;
  for (let i = 0; i < 200; i++) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rooms.has(c)) return c;
  }
  for (let n = 0; n < 10000; n++) {
    const c = String(n).padStart(4, '0');
    if (!rooms.has(c)) return c;
  }
  return null;
}
const newToken = () => crypto.randomBytes(16).toString('hex');
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function liveCount(room, color) {
  let n = 0;
  for (const c of room.clients) if (c.color === color) n++;
  return n;
}
function stateOf(room) {
  return {
    startFen: room.startFen,
    moves: room.moves,
    result: room.result,
    reason: room.reason,
    seats: { w: !!room.tokens[0], b: !!room.tokens[8] },
    live: { w: liveCount(room, 0) > 0, b: liveCount(room, 8) > 0 }
  };
}
function broadcast(room) {
  const data = 'data: ' + JSON.stringify(stateOf(room)) + '\n\n';
  for (const c of room.clients) { try { c.res.write(data); } catch (e) { /* closed */ } }
}
function auth(code, token) {
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return null;
  const room = rooms.get(code);
  if (!room) return null;
  let color = -1;
  if (sameToken(token, room.tokens[0])) color = 0;
  else if (sameToken(token, room.tokens[8])) color = 8;
  if (color < 0) return { room, color: -1 };
  return { room, color };
}

/* ---------- helpers ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const key = bucket + ':' + ip, now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  return ++h.n > max;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}
function touch(room) { room.last = Date.now(); }

/* ---------- API ---------- */
function apiCreate(req, res, body) {
  if (limited(clientIp(req), 'create', 10, 60000)) return send(res, 429, { error: 'Too many requests, try again in a minute' });
  const code = newCode();
  if (!code) return send(res, 503, { error: 'Server is full, try again later' });
  let host = body.color === 'b' ? 8 : body.color === 'w' ? 0 : (crypto.randomInt(0, 2) ? 8 : 0);
  const token = newToken();
  const room = { code, hostColor: host, tokens: { 0: null, 8: null }, startFen: START_FEN, pos: new Pos(), moves: [], result: null, reason: null, clients: new Set(), last: Date.now() };
  room.tokens[host] = token;
  rooms.set(code, room);
  send(res, 200, { code, token, color: host, state: stateOf(room) });
}
function apiJoin(req, res, body) {
  if (limited(clientIp(req), 'join', 15, 60000)) return send(res, 429, { error: 'Too many attempts, try again in a minute' });
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{4}$/.test(code)) return send(res, 400, { error: 'The code is 4 digits' });
  const room = rooms.get(code);
  if (!room) return send(res, 404, { error: 'No game with this code' });
  const guest = room.hostColor ^ 8;
  if (room.tokens[guest]) return send(res, 409, { error: 'This game already has two players' });
  const token = newToken();
  room.tokens[guest] = token;
  touch(room);
  send(res, 200, { code, token, color: guest, state: stateOf(room) });
  broadcast(room);
}
function apiMove(req, res, body) {
  const a = auth(body.code, body.token);
  if (!a || a.color < 0) return send(res, 403, { error: 'Not a player of this game' });
  const room = a.room;
  if (room.result) return send(res, 409, { error: 'The game is over' });
  if (!room.tokens[a.color ^ 8]) return send(res, 409, { error: 'Waiting for an opponent' });
  if (room.pos.side !== a.color) return send(res, 409, { error: 'Not your turn' });
  if (typeof body.move !== 'string' || !/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(body.move)) return send(res, 400, { error: 'Bad move' });
  const m = uciToMove(room.pos, body.move);
  if (!m) return send(res, 400, { error: 'Illegal move' });
  room.pos.make(m);
  room.moves.push(body.move);
  const st = room.pos.status();
  if (st.over) { room.result = st.result; room.reason = st.reason; }
  touch(room);
  send(res, 200, { ok: true });
  broadcast(room);
}
function resignRoom(room, color) {
  room.result = color === 0 ? '0-1' : '1-0';
  room.reason = 'resign';
  touch(room);
  broadcast(room);
}
// The hidden board-editing extras rewrite the whole game on the client: accept a new start position + history
// (history may contain '0000' = forfeited turn). It only has to be loadable; the client decides what is allowed.
function apiSetState(req, res, body) {
  const a = auth(body.code, body.token);
  if (!a || a.color < 0) return send(res, 403, { error: 'Not a player of this game' });
  const room = a.room, fen = body.startFen, moves = body.moves;
  if (typeof fen !== 'string' || fen.length > 100 || !Array.isArray(moves) || moves.length > 2000 ||
      !moves.every((m) => typeof m === 'string' && /^([a-h][1-8][a-h][1-8][nbrq]?|0000)$/.test(m))) return send(res, 400, { error: 'Bad state' });
  let p;
  try {
    p = new Pos(fen, true);
    for (const m of moves) if (!applyTok(p, m)) throw new Error('illegal');
  } catch (e) { return send(res, 400, { error: 'Bad state' }); }
  room.startFen = fen; room.moves = moves.slice(); room.pos = p;
  if (body.reason === 'kingcap' && body.result === (a.color === 0 ? '1-0' : '0-1')) { room.result = body.result; room.reason = 'kingcap'; }
  else { const st = p.status(); room.result = st.over ? st.result : null; room.reason = st.over ? st.reason : null; }
  touch(room);
  send(res, 200, { ok: true });
  broadcast(room);
}
function apiResign(req, res, body) {
  const a = auth(body.code, body.token);
  if (!a || a.color < 0) return send(res, 403, { error: 'Not a player of this game' });
  const room = a.room;
  if (!room.result && room.tokens[a.color ^ 8]) resignRoom(room, a.color);
  send(res, 200, { ok: true });
}
function apiLeave(req, res, body) {
  const a = auth(body.code, body.token);
  if (!a || a.color < 0) return send(res, 200, { ok: true });
  const room = a.room;
  if (!room.tokens[a.color ^ 8]) {                    // alone in the room: just close it
    for (const c of room.clients) { try { c.res.end(); } catch (e) {} }
    rooms.delete(room.code);
  } else if (!room.result) resignRoom(room, a.color);
  send(res, 200, { ok: true });
}
function apiState(res, url) {
  const a = auth(url.searchParams.get('code') || '', url.searchParams.get('token') || '');
  if (!a || a.color < 0) return send(res, 404, { error: 'Game not found' });
  send(res, 200, { color: a.color, state: stateOf(a.room) });
}
function apiEvents(req, res, url) {
  const a = auth(url.searchParams.get('code') || '', url.searchParams.get('token') || '');
  if (!a || a.color < 0) return send(res, 404, { error: 'Game not found' });
  const room = a.room, client = { res, color: a.color };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  room.clients.add(client);
  touch(room);
  broadcast(room);
  req.on('close', () => {
    room.clients.delete(client);
    touch(room);
    if (rooms.get(room.code) === room) broadcast(room);
  });
}

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/' || p === '/index.html') {
        const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
        const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
        if (gz) h['Content-Encoding'] = 'gzip';
        res.writeHead(200, h);
        return res.end(req.method === 'HEAD' ? undefined : (gz ? INDEX_GZ : INDEX_RAW));
      }
      if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (p === '/api/state') return apiState(res, url);
      if (p === '/api/events') return apiEvents(req, res, url);
    } else if (req.method === 'POST' && p.startsWith('/api/')) {
      const body = await readJson(req);
      if (p === '/api/create') return apiCreate(req, res, body);
      if (p === '/api/join') return apiJoin(req, res, body);
      if (p === '/api/move') return apiMove(req, res, body);
      if (p === '/api/setstate') return apiSetState(req, res, body);
      if (p === '/api/resign') return apiResign(req, res, body);
      if (p === '/api/leave') return apiLeave(req, res, body);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' }); else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

/* ---------- housekeeping ---------- */
setInterval(() => {                       // keep SSE connections alive through proxies
  for (const room of rooms.values()) for (const c of room.clients) { try { c.res.write(': ping\n\n'); } catch (e) {} }
}, 15000).unref();
setInterval(() => {                       // drop abandoned rooms and stale rate-limit entries
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size) continue;
    const ttl = (!room.tokens[room.hostColor ^ 8] || room.result) ? WAITING_TTL : GAME_TTL;
    if (now - room.last > ttl) rooms.delete(code);
  }
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 5 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('Chess server listening on port ' + PORT));
  const bye = () => process.exit(0);
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
module.exports = { server, rooms };
