// tatara-relay.js — 0.99.0 (S58 — LIJOX's Tatara step 5, slice 4): A POOL'S PRIVATE RELAY (spec v0.10 §4.9; design
// tatara-adapter-r1.md §5). A websocket at /tatara/relay on the API server (an Upgrade, as /nwc — the same tunnel, no new
// ingress). One room per live attempt, opened when its pool is announced: the room knows the pool's public key and its
// posting token. A connection names the token in its URL (/tatara/relay?token=<64 hex>) and is refused unless a room
// holds it (constant-time compare). NIP-01 subset: EVENT — kind 4 only, tagged with the room's pool key, its id
// re-hashed and its BIP-340 signature checked (nwc.js's checkEvent), content within the size cap, a repeat ignored;
// REQ — that room's events, then EOSE, then each new one; CLOSE; OK; NOTICE; CLOSED. Memory only: a room's events go
// when it closes. Caps: events per connection per minute, events and bytes per room, subscriptions per connection,
// connections per room. The relay reads nothing (every message is sealed to the pool key) and serves only its rooms.
'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { checkEvent, matches } = require('./nwc.js');

const KIND = 4;
const MAX_CONTENT = Math.floor((32768 + 16) * 4 / 3) + 64;   // a capped message (32 KB), NIP-04 base64 + "?iv=" (lij-core tatara::wire)
const MAX_MSG_BYTES = 64 * 1024;
const EVENTS_PER_MIN = 120;
const ROOM_MAX_EVENTS = 2000;
const ROOM_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SUBS = 8;
const MAX_CONNS_PER_ROOM = 24;
const isHex = (x, n) => typeof x === 'string' && x.length === n && /^[0-9a-f]+$/.test(x);
const sameToken = (a, b) => { try { const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex'); return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y); } catch (_) { return false; } };

function createRelay(deps) {
  const { path: RELAY_PATH = '/tatara/relay', log = () => {}, now = () => Date.now(), enabled = () => true } = deps || {};
  const rooms = new Map();     // token → { token, pool_pk, attempt_id, events: [], ids: Set, bytes, sockets: Set, opened_at }
  let wss = null;

  function open(token, poolPk, attemptId) {
    if (!isHex(token, 64) || !isHex(poolPk, 64)) return false;
    if (rooms.has(token)) return true;
    rooms.set(token, { token, pool_pk: poolPk, attempt_id: attemptId, events: [], ids: new Set(), bytes: 0, sockets: new Set(), opened_at: now() });
    log(`[Tatara] relay room open for attempt ${String(attemptId).slice(0, 8)} (pool ${poolPk.slice(0, 8)})`);
    return true;
  }
  function close(token, why) {
    const r = rooms.get(token);
    if (!r) return;
    rooms.delete(token);
    for (const s of r.sockets) { try { s.ws.close(1000, 'the pool ended'); } catch (_) {} }
    log(`[Tatara] relay room closed for attempt ${String(r.attempt_id).slice(0, 8)}: ${why || 'ended'} (${r.events.length} event(s) wiped)`);
  }
  const roomFor = (token) => { for (const r of rooms.values()) if (sameToken(r.token, token)) return r; return null; };

  const send = (s, msg) => { try { if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg)); } catch (_) {} };

  function onMessage(s, raw) {
    let m;
    try { m = JSON.parse(raw); } catch (_) { send(s, ['NOTICE', 'not JSON']); return; }
    if (!Array.isArray(m) || typeof m[0] !== 'string') { send(s, ['NOTICE', 'not a NIP-01 message']); return; }
    const r = rooms.get(s.token);
    if (!r) { send(s, ['NOTICE', 'the pool ended']); try { s.ws.close(); } catch (_) {} return; }
    if (m[0] === 'EVENT') {
      const ev = m[1];
      const id = ev && typeof ev.id === 'string' ? ev.id : '';
      const t = now();
      s.sent = s.sent.filter((x) => t - x < 60000);
      if (s.sent.length >= EVENTS_PER_MIN) { send(s, ['OK', id, false, 'rate-limited: too many events']); return; }
      s.sent.push(t);
      const bad = checkEvent(ev);
      if (bad) { send(s, ['OK', id, false, 'invalid: ' + bad]); return; }
      if (ev.kind !== KIND) { send(s, ['OK', id, false, 'blocked: kind 4 only']); return; }
      if (!ev.tags.some((x) => x.length >= 2 && x[0] === 'p' && x[1] === r.pool_pk)) { send(s, ['OK', id, false, 'blocked: not for this pool']); return; }
      if (ev.content.length > MAX_CONTENT) { send(s, ['OK', id, false, 'invalid: too large']); return; }
      if (r.ids.has(ev.id)) { send(s, ['OK', id, true, 'duplicate:']); return; }
      const size = JSON.stringify(ev).length;
      if (r.events.length >= ROOM_MAX_EVENTS || r.bytes + size > ROOM_MAX_BYTES) { send(s, ['OK', id, false, 'blocked: the pool\'s room is full']); return; }
      r.events.push(ev); r.ids.add(ev.id); r.bytes += size;
      send(s, ['OK', id, true, '']);
      for (const o of r.sockets) for (const [sub, filters] of o.subs) if (filters.some((f) => matches(f, ev))) send(o, ['EVENT', sub, ev]);
      return;
    }
    if (m[0] === 'REQ') {
      const sub = m[1];
      if (typeof sub !== 'string' || !sub || sub.length > 64) { send(s, ['NOTICE', 'bad subscription id']); return; }
      const filters = m.slice(2).filter((f) => f && typeof f === 'object' && !Array.isArray(f));
      if (!s.subs.has(sub) && s.subs.size >= MAX_SUBS) { send(s, ['CLOSED', sub, 'blocked: too many subscriptions']); return; }
      s.subs.set(sub, filters.length ? filters : [{}]);
      for (const ev of r.events) if (s.subs.get(sub).some((f) => matches(f, ev))) send(s, ['EVENT', sub, ev]);
      send(s, ['EOSE', sub]);
      return;
    }
    if (m[0] === 'CLOSE') { s.subs.delete(m[1]); return; }
    send(s, ['NOTICE', 'unsupported: ' + String(m[0]).slice(0, 16)]);
  }

  /// An Upgrade at the relay's path: taken only for a room's token; anything else on that path is refused.
  /// Answers true when the path is the relay's (handled, either way), false for another path.
  function handleUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url || '', 'http://lsp.local'); } catch (_) { return false; }
    if (u.pathname !== RELAY_PATH) return false;
    const token = String(u.searchParams.get('token') || '');
    const r = enabled() && isHex(token, 64) ? roomFor(token) : null;
    if (!r || r.sockets.size >= MAX_CONNS_PER_ROOM) { try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch (_) {} socket.destroy(); return true; }
    if (!wss) wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = { ws, token: r.token, subs: new Map(), sent: [] };
      r.sockets.add(s);
      ws.on('message', (data) => { try { onMessage(s, data.toString('utf8')); } catch (e) { log(`[Tatara] relay message error: ${e.message}`); } });
      const gone = () => { const rr = rooms.get(s.token); if (rr) rr.sockets.delete(s); };
      ws.on('close', gone);
      ws.on('error', gone);
    });
    return true;
  }

  return {
    open, close, handleUpgrade,
    rooms: () => Array.from(rooms.values()).map((r) => ({ attempt_id: r.attempt_id, pool_pk: r.pool_pk, events: r.events.length, sockets: r.sockets.size, opened_at: r.opened_at })),
    tokens: () => Array.from(rooms.keys()),
    attemptOfToken: (token) => { const r = rooms.get(token); return r ? r.attempt_id : null; },
  };
}

module.exports = { createRelay, KIND, MAX_CONTENT, EVENTS_PER_MIN, ROOM_MAX_EVENTS, MAX_SUBS };
