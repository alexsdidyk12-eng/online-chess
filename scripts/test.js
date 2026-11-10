'use strict';
// Smoke test of the server API:  npm test
const assert = require('assert');
const { server } = require('../server');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, j: await r.json().catch(() => null) }; };

  // SSE listener: keeps the latest state
  function listen(code, token) {
    const ac = new AbortController(); const box = { last: null, n: 0 };
    fetch(base + '/api/events?code=' + code + '&token=' + token, { signal: ac.signal }).then(async (r) => {
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (ev.startsWith('data: ')) { box.last = JSON.parse(ev.slice(6)); box.n++; }
        }
      }
    }).catch(() => {});
    box.close = () => ac.abort();
    return box;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert((await page.text()).includes('Play online'));
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/server.js')).status, 404);

  // create / join
  const c = await post('/api/create', { color: 'w' });
  assert.equal(c.s, 200); assert(/^\d{4}$/.test(c.j.code)); assert.equal(c.j.color, 0);
  const code = c.j.code, W = c.j.token;
  assert.equal((await post('/api/join', { code: '12ab' })).s, 400);
  assert.equal((await post('/api/move', { code, token: W, move: 'e2e4' })).s, 409);          // no opponent yet
  const j = await post('/api/join', { code });
  assert.equal(j.s, 200); assert.equal(j.j.color, 8);
  const B = j.j.token;
  assert.equal((await post('/api/join', { code })).s, 409);                                  // room is full
  assert.equal((await post('/api/move', { code, token: 'x'.repeat(32), move: 'e2e4' })).s, 403);
  assert.equal((await get('/api/events?code=' + code + '&token=bad')).s, 404);

  const sw = listen(code, W), sb = listen(code, B);
  await wait(150);
  assert(sw.last.live.w && sw.last.live.b);

  assert.equal((await post('/api/move', { code, token: B, move: 'e7e5' })).s, 409);          // not black's turn
  assert.equal((await post('/api/move', { code, token: W, move: 'e2e5' })).s, 400);          // illegal
  assert.equal((await post('/api/move', { code, token: W, move: 'e2e4' })).s, 200);
  assert.equal((await post('/api/move', { code, token: W, move: 'd2d4' })).s, 409);          // white twice
  // scholar's mate
  for (const [t, m] of [[B, 'e7e5'], [W, 'f1c4'], [B, 'b8c6'], [W, 'd1h5'], [B, 'g8f6'], [W, 'h5f7']]) {
    const r = await post('/api/move', { code, token: t, move: m }); assert.equal(r.s, 200, m);
  }
  await wait(150);
  assert.equal(sb.last.result, '1-0'); assert.equal(sb.last.reason, 'checkmate');
  assert.equal(sw.last.moves.length, 7);
  assert.equal((await post('/api/move', { code, token: W, move: 'a2a3' })).s, 409);          // game over
  const st = await get('/api/state?code=' + code + '&token=' + B);
  assert.equal(st.j.color, 8); assert.equal(st.j.state.result, '1-0');

  // reconnect shows the opponent as offline, then online again
  sb.close(); await wait(150); assert.equal(sw.last.live.b, false);
  const sb2 = listen(code, B); await wait(150); assert.equal(sw.last.live.b, true);

  // promotion, castling-free sanity: play a quick pawn promotion line via resign instead
  const c2 = await post('/api/create', { color: 'b' });
  assert.equal(c2.j.color, 8);
  const j2 = await post('/api/join', { code: c2.j.code });
  assert.equal(j2.j.color, 0);
  assert.equal((await post('/api/resign', { code: c2.j.code, token: j2.j.token })).s, 200);  // white resigns
  const s2 = await get('/api/state?code=' + c2.j.code + '&token=' + c2.j.token);
  assert.equal(s2.j.state.result, '0-1'); assert.equal(s2.j.state.reason, 'resign');

  // cheats: a rewritten game (new start position, kingcap result) is accepted and broadcast
  const c4 = await post('/api/create', { color: 'w' });
  const j4 = await post('/api/join', { code: c4.j.code });
  const o4 = listen(c4.j.code, j4.j.token); await wait(100);
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: c4.j.token, startFen: 'nonsense', moves: [] })).s, 400);
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: c4.j.token, startFen: '8/8/8/8/8/8/8/R3K3 w Q - 0 1', moves: [] })).s, 400);   // no black king
  const fen = '7k/8/6K1/8/8/8/8/R7 w - - 0 1';
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: c4.j.token, startFen: fen, moves: [] })).s, 200);
  await wait(100); assert.equal(o4.last.startFen, fen);
  assert.equal((await post('/api/move', { code: c4.j.code, token: c4.j.token, move: 'a1a8' })).s, 200);
  await wait(100); assert.equal(o4.last.result, '1-0'); assert.equal(o4.last.reason, 'checkmate');
  // lifting the mate: same position again without the mating piece, plus a forfeited turn
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: j4.j.token, startFen: fen, moves: ['0000'] })).s, 200);
  await wait(100); assert.equal(o4.last.result, null); assert.equal(o4.last.moves[0], '0000');
  assert.equal((await post('/api/move', { code: c4.j.code, token: j4.j.token, move: 'h8g8' })).s, 200);   // black to move after the forfeit
  // king capture: only the sender can win by it
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: j4.j.token, startFen: fen, moves: [], result: '1-0', reason: 'kingcap' })).s, 200);
  await wait(100); assert.equal(o4.last.reason === 'kingcap', false);
  assert.equal((await post('/api/setstate', { code: c4.j.code, token: j4.j.token, startFen: fen, moves: [], result: '0-1', reason: 'kingcap' })).s, 200);
  await wait(100); assert.equal(o4.last.result, '0-1'); assert.equal(o4.last.reason, 'kingcap');
  o4.close();

  // leaving an empty room removes it
  const c3 = await post('/api/create', { color: 'r' });
  await post('/api/leave', { code: c3.j.code, token: c3.j.token });
  assert.equal((await post('/api/join', { code: c3.j.code })).s, 404);

  // join rate limit (15 per minute per IP)
  let limited = false;
  for (let i = 0; i < 20; i++) if ((await post('/api/join', { code: '0000' })).s === 429) limited = true;
  assert(limited, 'rate limit did not trigger');

  sw.close(); sb2.close();
  console.log('all server tests passed');
  server.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
