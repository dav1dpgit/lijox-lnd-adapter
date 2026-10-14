// 0.99.0 (S58 — LIJOX's Tatara step 5, slice 4): A POOL'S PRIVATE RELAY (tatara-relay.js), over real sockets.
//   node tatara-relay.test.js
'use strict';
const http = require('http'); const crypto = require('crypto');
const { WebSocket } = require('ws');
const schnorr = require('./schnorr.js');
const { createRelay, MAX_CONTENT, EVENTS_PER_MIN, MAX_SUBS } = require('./tatara-relay');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sk = (s) => crypto.createHash('sha256').update(s).digest();
const pk = (k) => schnorr.pubkey(k).toString('hex');
function ev(k, kind, tags, content, created_at = 1800000000) {
  const pubkey = pk(k);
  const id = crypto.createHash('sha256').update(JSON.stringify([0, pubkey, created_at, kind, tags, content]), 'utf8').digest('hex');
  return { id, pubkey, created_at, kind, tags, content, sig: schnorr.sign(k, Buffer.from(id, 'hex'), crypto.randomBytes(32)).toString('hex') };
}

(async () => {
  const relay = createRelay({ log: () => {} });
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  server.on('upgrade', (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'ws://127.0.0.1:' + server.address().port;
  const POOL = pk(sk('pool')), TOKEN = crypto.randomBytes(32).toString('hex');
  const conn = (url) => new Promise((resolve) => {
    const w = new WebSocket(url); w.got = [];
    w.on('message', (d) => w.got.push(JSON.parse(d.toString())));
    w.on('open', () => resolve(w)); w.on('error', () => resolve(null)); w.on('unexpected-response', () => resolve(null));
  });
  const wait = async (w, pred, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = w.got.find(pred); if (m) return m; await sleep(10); } return null; };

  // X1 — no room, no connection
  check(await conn(base + '/tatara/relay?token=' + TOKEN) === null, 'X1 a token no room holds: refused (404)');
  relay.open(TOKEN, POOL, 'a'.repeat(32));
  check(await conn(base + '/tatara/relay') === null && await conn(base + '/tatara/relay?token=' + 'ab'.repeat(32)) === null, 'X1 no token or another token: refused');
  check(await conn(base + '/other?token=' + TOKEN) === null, 'X1 another path is not the relay\'s');
  // X2 — a member connects and subscribes
  const a = await conn(base + '/tatara/relay?token=' + TOKEN);
  const b = await conn(base + '/tatara/relay?token=' + TOKEN);
  check(!!a && !!b, 'X2 the room\'s token: two members connect');
  a.send(JSON.stringify(['REQ', 's1', { kinds: [4], '#p': [POOL] }]));
  check(!!(await wait(a, (m) => m[0] === 'EOSE' && m[1] === 's1')), 'X2 REQ on an empty room: EOSE');
  // X3 — an event for the pool: OK, and live to the subscriber
  const alice = sk('alice');
  const e1 = ev(alice, 4, [['p', POOL]], 'sealed?iv=AAAA');
  b.send(JSON.stringify(['EVENT', e1]));
  const ok1 = await wait(b, (m) => m[0] === 'OK' && m[1] === e1.id);
  const live = await wait(a, (m) => m[0] === 'EVENT' && m[1] === 's1' && m[2].id === e1.id);
  check(ok1 && ok1[2] === true && !!live, 'X3 a kind-4 event tagged with the pool: OK, and live to the subscriber');
  // X4 — a later REQ gets what is stored
  b.send(JSON.stringify(['REQ', 's2', {}]));
  check(!!(await wait(b, (m) => m[0] === 'EVENT' && m[1] === 's2' && m[2].id === e1.id)) && !!(await wait(b, (m) => m[0] === 'EOSE' && m[1] === 's2')), 'X4 a later REQ: the stored event, then EOSE');
  // X5 — a repeat
  b.got = []; b.send(JSON.stringify(['EVENT', e1]));
  const dup = await wait(b, (m) => m[0] === 'OK' && m[1] === e1.id);
  check(dup && dup[2] === true && /^duplicate:/.test(dup[3]) && !(await wait(a, (m) => m[0] === 'EVENT' && m[2].id === e1.id && a.got.filter((x) => x[0] === 'EVENT').length > 1, 300)), 'X5 the same event again: "duplicate", not sent twice');
  // X6 — refused events
  const refuse = async (e, re, label) => { b.got = []; b.send(JSON.stringify(['EVENT', e])); const m = await wait(b, (x) => x[0] === 'OK' && x[1] === e.id); check(m && m[2] === false && re.test(m[3]), 'X6 ' + label + ' (' + (m && m[3]) + ')'); };
  await refuse(ev(alice, 1, [['p', POOL]], 'x'), /kind 4 only/, 'kind 1: blocked');
  await refuse(ev(alice, 4, [['p', pk(sk('other'))]], 'x'), /not for this pool/, 'tagged with another pool: blocked');
  await refuse(ev(alice, 4, [], 'x'), /not for this pool/, 'untagged: blocked');
  const forged = ev(alice, 4, [['p', POOL]], 'x'); forged.content = 'y';
  await refuse(forged, /id does not match/, 'content changed after signing: invalid');
  const badsig = ev(alice, 4, [['p', POOL]], 'z'); badsig.sig = ev(sk('mallory'), 4, [['p', POOL]], 'z').sig;
  await refuse(badsig, /bad signature/, 'signed by another key: invalid');
  await refuse(ev(alice, 4, [['p', POOL]], 'A'.repeat(MAX_CONTENT + 1)), /too large/, 'content over the cap: invalid');
  // X7 — the per-connection rate
  const c = await conn(base + '/tatara/relay?token=' + TOKEN);
  const many = Array.from({ length: EVENTS_PER_MIN + 1 }, (_, i) => ev(alice, 4, [['p', POOL]], 'm' + i));
  for (const e of many) c.send(JSON.stringify(['EVENT', e]));
  const lastOk = await wait(c, (m) => m[0] === 'OK' && m[1] === many[EVENTS_PER_MIN].id, 5000);
  check(lastOk && lastOk[2] === false && /rate-limited/.test(lastOk[3]), 'X7 the ' + (EVENTS_PER_MIN + 1) + 'th event in a minute from one connection: rate-limited');
  // X8 — subscriptions per connection
  for (let i = 0; i < MAX_SUBS; i++) a.send(JSON.stringify(['REQ', 'x' + i, { kinds: [4] }]));
  a.send(JSON.stringify(['REQ', 'over', {}]));
  check(!!(await wait(a, (m) => m[0] === 'CLOSED' && m[1] === 'over')), 'X8 more than ' + MAX_SUBS + ' subscriptions on one connection: CLOSED');
  // X9 — the room closes: sockets closed, events gone, the token refused
  let closed = 0; a.on('close', () => closed++); b.on('close', () => closed++);
  relay.close(TOKEN, 'test');
  await sleep(200);
  check(closed === 2 && relay.rooms().length === 0, 'X9 the attempt ended: its room closes, every connection with it');
  check(await conn(base + '/tatara/relay?token=' + TOKEN) === null, 'X9 the token is refused afterwards');
  try { c.close(); } catch (_) {}
  server.close();
  console.log(fails ? 'FAIL · tatara-relay · ' + fails + ' failed' : 'PASS · tatara-relay (X1–X9)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · tatara-relay threw: ' + (e && e.stack || e)); process.exit(1); });
