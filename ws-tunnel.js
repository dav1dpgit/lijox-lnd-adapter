// 0.96.0 (S58, DP 2026-10-12 20:18 "Go on Proposals 1, 2, and 3"): A WALLET'S TUNNEL TO LND, as its own piece.
// A browser wallet cannot open a TCP connection, so its WebSocket is piped to LND's peer port (BOLT 8 bytes, untouched
// and unread). Two changes from the proxy as it was written inside lij-adapter.js:
//  (proposal 2) THE CONNECTION TO LND OPENS ON THE WALLET'S FIRST BYTES, not when the WebSocket opens. Engine v322
//      opens its WebSocket while the page's start-up checks run and may hold it a few seconds before it speaks. LND
//      drops a connection whose handshake has not begun within 5 s (brontide's handshakeReadTimeout), so a socket
//      opened early must hold nothing at LND until the wallet speaks. Bytes are written in the order they came;
//      those that come while TCP is still connecting are held by the socket and sent once it connects.
//      A WebSocket that never speaks is closed after QUIET_MS (the engine keeps a pre-opened socket 60 s at most).
//  (proposal 3) ONCE THE WALLET'S HANDSHAKE HAS PASSED — act one (50 bytes) and act three (66 bytes) are the
//      wallet's only handshake bytes, so 116 bytes written means LND has the whole handshake — the tunnel tells its
//      caller its own local address and port: LND names an inbound peer by the address it connected from, so the
//      caller can find the wallet's node key in ListPeers and send the first chain data unasked (findPeerOn).
// Nothing here reads, keeps or changes the bytes; the noise handshake makes them unreadable to the tunnel anyway.

'use strict';

const net = require('net');

const HANDSHAKE_BYTES = 116;   // BOLT 8: act one 50 + act three 66, the initiator's handshake
const QUIET_MS = 90000;        // a WebSocket that says nothing this long is closed

// Pipe one wallet WebSocket to LND. opts: { host, port, onHandshake(local), log, quietMs }.
// local = { address, port, alive() } — the tunnel's own end of the TCP connection; alive() is false once either side
// has closed. Returns a small view for tests and logs.
function tunnel(ws, opts) {
  const { host, port, onHandshake, log = console, quietMs = QUIET_MS } = opts || {};
  const openedAt = Date.now();
  let tcp = null, sent = 0, told = false, closed = false;

  const quiet = setTimeout(() => {
    if (!tcp && !closed) {
      log.log(`[WS] the wallet said nothing in ${Math.round(quietMs / 1000)} s — its socket is closed (nothing reached LND)`);
      try { ws.close(); } catch (_) {}
    }
  }, quietMs);
  if (quiet.unref) quiet.unref();

  const tell = () => {
    if (told || closed || !tcp || sent < HANDSHAKE_BYTES || !tcp.localPort) return;
    told = true;
    if (typeof onHandshake !== 'function') return;
    try { onHandshake({ address: tcp.localAddress, port: tcp.localPort, alive: () => !closed }); } catch (_) {}
  };

  const open = () => {
    const spokeAfter = Date.now() - openedAt;
    tcp = net.createConnection({ host, port });
    tcp.on('connect', () => {
      log.log(`[WS] TCP tunnel open to ${host}:${port} (the wallet spoke ${spokeAfter} ms after its socket opened)`);
      tell();
    });
    tcp.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    tcp.on('close', () => {
      closed = true;
      if (ws.readyState === ws.OPEN) ws.close();
    });
    tcp.on('error', (err) => {
      log.error(`[WS] TCP error: ${err.message}`);
      if (ws.readyState === ws.OPEN) ws.close();
    });
  };

  ws.on('message', (data) => {
    if (closed) return;
    const buf = Buffer.isBuffer(data) ? data
      : Array.isArray(data) ? Buffer.concat(data)
      : (data instanceof ArrayBuffer) ? Buffer.from(new Uint8Array(data))
      : Buffer.from(data);
    if (!tcp) { clearTimeout(quiet); open(); }
    if (tcp.destroyed) return;
    tcp.write(buf);
    sent += buf.length;
    tell();
  });

  const end = () => {
    closed = true;
    clearTimeout(quiet);
    if (tcp) tcp.destroy();
  };
  ws.on('close', end);
  ws.on('error', (err) => { log.error(`[WS] WebSocket error: ${err.message}`); end(); });

  return { sentBytes: () => sent, connected: () => !!tcp, told: () => told };
}

// ── The LND peer on a tunnel ──────────────────────────────────────────────────────────────────────────────────────
// LND lists an inbound peer under the address it connected from ("127.0.0.1:54321", "[::1]:54321"); the tunnel's own
// end has that address. Where something sits between the adapter and LND that changes the address (a userland port
// proxy), no peer matches and nothing is sent — the wallet asks for its chain data as it always has.

function normHost(h) {
  h = String(h || '').toLowerCase();
  if (h.startsWith('::ffff:')) h = h.slice(7);   // an IPv4 address written as IPv6
  return h;
}

function sameAddress(peerAddress, local) {
  const m = String(peerAddress || '').match(/^\[?([^\]]*?)\]?:(\d+)$/);
  if (!m || !local) return false;
  return Number(m[2]) === Number(local.port) && normHost(m[1]) === normHost(local.address);
}

// ListPeers asked fresh until the peer shows: about 2 s in all, often at the first or second ask.
const FIND_SCHEDULE_MS = [0, 25, 25, 25, 50, 50, 100, 100, 200, 200, 250, 250, 250, 250];

// listPeers() → LND's peers ([{ pub_key, address }]). Answers { peerHex, ms } or null (not found, or the tunnel closed).
async function findPeerOn(local, listPeers, { schedule = FIND_SCHEDULE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = Date.now();
  const alive = (local && typeof local.alive === 'function') ? local.alive : () => true;
  for (const wait of schedule) {
    if (wait) await sleep(wait);
    if (!alive()) return null;
    let peers;
    try { peers = await listPeers(); } catch (_) { continue; }
    const p = (Array.isArray(peers) ? peers : []).find((q) => q && sameAddress(q.address, local));
    if (p && /^0[23][0-9a-f]{64}$/i.test(String(p.pub_key || ''))) return { peerHex: String(p.pub_key).toLowerCase(), ms: Date.now() - t0 };
  }
  return null;
}

module.exports = { tunnel, findPeerOn, sameAddress, HANDSHAKE_BYTES, QUIET_MS, FIND_SCHEDULE_MS };
