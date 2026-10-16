// tatara-nostr.js — 0.106.0 (S59 Thu, Phase 2b): a small nostr CLIENT to one public relay, for the host of a public room.
// Publishes events, keeps subscriptions, reconnects with a backoff and re-subscribes; delivers ["EVENT", sub, ev] to
// the subscription's handler. Messages are capped at MAX_MSG_BYTES before they are parsed. Nothing is decrypted here.
'use strict';

const MAX_MSG_BYTES = 128 * 1024;        // a message past this is dropped unread
const MAX_FRAME_BYTES = 2 * 1024 * 1024;   // the socket's own cap, well above any relay's (review 2b #6: a stored oversized event must not close the connection on every reconnect)
const BACKOFF_MS = [5000, 10000, 20000, 60000];

function createNostrClient({ url, log = () => {}, now = () => Date.now(), WebSocketImpl = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const WS = WebSocketImpl || require('ws').WebSocket;
  const subs = new Map();   // id → { filter, onEvent }
  let ws = null, open = false, tries = 0, timer = null, closed = false, queue = [];
  const stats = { sent: 0, received: 0, dropped: 0, connects: 0, last_error: '' };

  function send(arr) {
    const s = JSON.stringify(arr);
    if (!open) { if (queue.length < 200) queue.push(s); else stats.dropped++; return; }
    try { ws.send(s); stats.sent++; } catch (e) { stats.last_error = e.message; }
  }
  function connect() {
    if (closed) return;
    try { ws = new WS(url, { maxPayload: MAX_FRAME_BYTES }); } catch (e) { stats.last_error = e.message; schedule(); return; }
    ws.on('open', () => {
      open = true; tries = 0; stats.connects++;
      log(`[Tatara] the public relay ${url} is connected`);
      for (const [id, s] of subs) send(['REQ', id, s.filter]);
      const q = queue.splice(0); for (const s of q) { try { ws.send(s); stats.sent++; } catch (_) {} }
    });
    ws.on('message', (raw) => {
      let txt; try { txt = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw); } catch (_) { return; }
      if (txt.length > MAX_MSG_BYTES) { stats.dropped++; return; }
      let m; try { m = JSON.parse(txt); } catch (_) { return; }
      if (!Array.isArray(m)) return;
      stats.received++;
      if (m[0] === 'EVENT' && typeof m[1] === 'string' && m[2] && typeof m[2] === 'object') {
        const s = subs.get(m[1]);
        if (s) { try { s.onEvent(m[2]); } catch (e) { log(`[Tatara] a relay event was not handled: ${e.message}`); } }
      } else if (m[0] === 'NOTICE') log(`[Tatara] the public relay says: ${String(m[1] || '').slice(0, 120)}`);
      else if (m[0] === 'OK' && m[2] === false) log(`[Tatara] the public relay refused an event: ${String(m[3] || '').slice(0, 120)}`);
    });
    const down = (why) => { if (!open && !ws) return; open = false; ws = null; if (!closed) { stats.last_error = why; schedule(); } };
    ws.on('close', () => down('closed'));
    ws.on('error', (e) => { stats.last_error = e.message; try { ws.close(); } catch (_) {} down(e.message); });
  }
  function schedule() {
    if (closed || timer) return;
    const wait = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]; tries++;
    timer = setTimer(() => { timer = null; connect(); }, wait);
  }
  function publish(ev) { send(['EVENT', ev]); }
  function subscribe(id, filter, onEvent) { subs.set(id, { filter, onEvent }); if (open) send(['REQ', id, filter]); }
  function unsubscribe(id) { if (subs.delete(id) && open) send(['CLOSE', id]); }
  /// The subscription's `since` moves up as events arrive, so a reconnect re-opens it from the last event seen, not from
  /// the room's start (review 2b #2/#6).
  function since(id, createdAt) { const s = subs.get(id); if (s && Number.isInteger(createdAt) && createdAt > (s.filter.since || 0)) s.filter = Object.assign({}, s.filter, { since: createdAt }); }
  function close() { closed = true; if (timer) { clearTimer(timer); timer = null; } try { if (ws) ws.close(); } catch (_) {} ws = null; open = false; }
  connect();
  return { publish, subscribe, unsubscribe, since, close, connected: () => open, stats: () => Object.assign({ subs: subs.size, url }, stats) };
}

module.exports = { createNostrClient, MAX_MSG_BYTES };
