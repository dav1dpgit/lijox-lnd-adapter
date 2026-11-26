'use strict';
// 0.137.0 (S72 Tue 2026-11-24, the operator's word of 08:33 on "Section F" — the wallet repo's
// docs/design/routes/f2-r1.md): REQUESTS INSIDE THE LIGHTNING CONNECTION, THE PROVIDER'S SIDE OF THE PATH.
//
// A wallet and its provider already speak inside the Lightning connection: payments, channel messages and the
// chain-data messages (cooperative-chain-bridge.js). Everything else a wallet asked its provider was a web request,
// readable by whoever ends that address's TLS. This file is the path that carries those requests inside the
// connection instead, in the form of LSPS0 (bLIP-50): one Lightning message type, 37913, whose payload is one UTF-8
// JSON-RPC 2.0 object.
//   · THE CALLER IS THE CONNECTION'S KEY. LND names the peer that sent each message, and that peer's key was proven by
//     the Lightning handshake. A method's function is called with ({ pubkey }, params); no signed proof and no route
//     token is read on this path.
//   · BOTH FORMS GIVE THE SAME ANSWER. A method's function answers { status, body } — what its web route answers.
//     2xx goes back as `result: body`; anything else as `error: { code: status, message: body.error, data: body }`.
//   · PARTS. A message holds 65,535 bytes. JSON longer than MAX_JSON_WHOLE goes as `lijox.part` messages (no id, no
//     answer): { of, n, total, data } with data = base64 of a slice of the whole JSON text; at most MAX_PARTS parts.
//   · LIMITS PER PEER, in place of limits per internet address: requests a minute; bytes and requests held in parts.
//   · ONCE. A method that transfers money carries `rid` (32 hex) and is run through once(): a `rid` seen before gets
//     its stored answer and nothing runs again. Kept RID_TTL_MS on disk, so a restart in the middle keeps it.
// No network and no LND in this file: the bridge hands messages in (onMessage) and takes messages out (opts.send).
const fs = require('fs');
const path = require('path');

const TYPE_LSPS0 = 37913;
const MAX_JSON_WHOLE = 60000;      // a request or an answer up to this many bytes of JSON is one message
const PART_BYTES = 44000;          // a part's slice of the JSON text, before base64
const PART_BYTES_ACCEPTED = 48000; // what a part may carry at most (base64 of it still fits one message)
const MAX_PARTS = 32;
const PART_GAP_MS = 30000;         // the parts of one request arrive at most this far apart
const PEER_PART_BYTES = 2000000;   // parts held for one peer
const PEER_PART_REQS = 4;          // requests in parts held for one peer at once
const PEERS_WITH_PARTS = 64;       // peers with parts held at once
const PER_MIN_DEFAULT = 120;       // requests a minute per peer
const RID_TTL_MS = 24 * 3600 * 1000;
const RID_PER_PEER = 2000;
const ID_RE = /^[\x21-\x7e]{1,64}$/;   // a request's id: 1–64 printable characters, no space
const RID_RE = /^[0-9a-f]{32}$/;
const PEER_RE = /^0[23][0-9a-f]{64}$/;

// JSON-RPC's own codes, and ours for the path itself (−32000…−32099 is left to implementations)
const E_PARSE = -32700, E_REQUEST = -32600, E_METHOD = -32601, E_PARAMS = -32602, E_INTERNAL = -32603;
const E_RATE = -32001, E_LARGE = -32002, E_PARTS = -32003, E_NOT_READY = -32004;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// One JSON text → the messages that carry it: itself, or its parts. null when it needs more than MAX_PARTS parts.
function frames(id, text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_JSON_WHOLE) return [buf];
  const total = Math.ceil(buf.length / PART_BYTES);
  if (total > MAX_PARTS) return null;
  const out = [];
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * PART_BYTES, Math.min(buf.length, (i + 1) * PART_BYTES));
    out.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'lijox.part', params: { of: id, n: i + 1, total, data: slice.toString('base64') } }), 'utf8'));
  }
  return out;
}

function createLijoxRpc(opts) {
  const o = opts || {};
  const send = o.send;                               // (peerHex, type, Buffer) → Promise
  const log = o.log || function () {};
  const now = o.now || (() => Date.now());
  const version = String(o.version || '');
  const perMin = Number.isFinite(Number(o.perMin)) && Number(o.perMin) > 0 ? Math.floor(Number(o.perMin)) : PER_MIN_DEFAULT;
  const onServed = typeof o.onServed === 'function' ? o.onServed : null;   // (peerHex, method) — the form counter
  const servesTo = typeof o.serves === 'function' ? o.serves : null;       // 0.145.0: (peerHex, method) → false: this peer is not served this method (a peer on a check tunnel is served the check methods only)
  const ridDir = o.dataDir ? path.join(o.dataDir, 'lijox-rid') : null;
  if (typeof send !== 'function') throw new Error('createLijoxRpc: send(peerHex, type, buf) required');

  const methods = new Map();        // name → { fn, money }
  const rate = new Map();           // peerHex → { t0, n }
  const parts = new Map();          // peerHex → Map(of → { total, got: Map(n → Buffer), bytes, last })
  const rids = new Map();           // peerHex → { rid: { at, state, status, body } }  (a cache of the peer's file)
  const counts = { requests: 0, answered: 0, refused: 0, path_errors: 0, parts_in: 0, parts_out: 0, dropped_answers: 0 };

  // ── sending ────────────────────────────────────────────────────────────────
  async function sendJson(peerHex, id, obj) {
    let fr = frames(id, JSON.stringify(obj));
    if (!fr) fr = frames(id, JSON.stringify({ jsonrpc: '2.0', id, error: { code: E_LARGE, message: 'the answer is too large for this path' } }));
    try {
      for (const f of fr) { await send(peerHex, TYPE_LSPS0, f); if (fr.length > 1) counts.parts_out++; }
      return true;
    } catch (e) {
      counts.dropped_answers++;   // the peer has gone: the wallet's own deadline covers it
      return false;
    }
  }
  const answerErr = (peerHex, id, code, message, data) => { counts.path_errors++; return sendJson(peerHex, id, { jsonrpc: '2.0', id: id === undefined ? null : id, error: Object.assign({ code, message }, data !== undefined ? { data } : {}) }); };

  // ── the limit per peer ─────────────────────────────────────────────────────
  function allowed(peerHex) {
    const t = now(); let r = rate.get(peerHex);
    if (!r || t - r.t0 >= 60000) { r = { t0: t, n: 0 }; rate.set(peerHex, r); }
    r.n++;
    if (rate.size > 5000) { for (const [k, v] of rate) if (t - v.t0 >= 60000) rate.delete(k); }
    return r.n <= perMin;
  }

  // ── parts coming in ────────────────────────────────────────────────────────
  function sweepParts() {
    const t = now();
    for (const [peer, m] of parts) {
      for (const [of, e] of m) if (t - e.last > PART_GAP_MS) m.delete(of);
      if (!m.size) parts.delete(peer);
    }
  }
  // → { text } when the request is whole, { wait: true } while parts are missing, { refuse: reason } otherwise
  function takePart(peerHex, p) {
    sweepParts();
    if (!isObj(p) || typeof p.of !== 'string' || !ID_RE.test(p.of)) return { refuse: 'a part without the id of its request' };
    const of = p.of;
    const drop = (why) => { const m0 = parts.get(peerHex); if (m0) { m0.delete(of); if (!m0.size) parts.delete(peerHex); } return { refuse: why, of }; };
    if (!Number.isInteger(p.total) || p.total < 2 || p.total > MAX_PARTS) return drop('total must be 2 to ' + MAX_PARTS);
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > p.total) return drop('n is outside 1 to total');
    if (typeof p.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) return drop('data is not base64');
    const slice = Buffer.from(p.data, 'base64');
    if (!slice.length || slice.length > PART_BYTES_ACCEPTED) return drop('a part carries 1 to ' + PART_BYTES_ACCEPTED + ' bytes');
    let m = parts.get(peerHex);
    if (!m) {
      if (parts.size >= PEERS_WITH_PARTS) return { refuse: 'too many peers are sending in parts', of };
      m = new Map(); parts.set(peerHex, m);
    }
    let e = m.get(of);
    if (!e) {
      if (m.size >= PEER_PART_REQS) return { refuse: 'too many requests in parts at once', of };
      e = { total: p.total, got: new Map(), bytes: 0, last: now() }; m.set(of, e);
    }
    if (e.total !== p.total) return drop('total changed between parts');
    if (e.got.has(p.n)) return drop('a part came twice');
    let held = 0; for (const x of m.values()) held += x.bytes;
    if (held + slice.length > PEER_PART_BYTES) return drop('too many bytes held in parts');
    e.got.set(p.n, slice); e.bytes += slice.length; e.last = now(); counts.parts_in++;
    if (e.got.size < e.total) return { wait: true };
    const bufs = []; for (let i = 1; i <= e.total; i++) bufs.push(e.got.get(i));
    m.delete(of); if (!m.size) parts.delete(peerHex);
    return { text: Buffer.concat(bufs).toString('utf8'), of };
  }

  // ── once: a request that transfers money is never carried out twice ───────
  function ridFile(peerHex) { return path.join(ridDir, peerHex + '.json'); }
  function ridLoad(peerHex) {
    let m = rids.get(peerHex);
    if (m) return m;
    m = {};
    if (ridDir) { try { const j = JSON.parse(fs.readFileSync(ridFile(peerHex), 'utf8')); if (isObj(j)) m = j; } catch (_) { m = {}; } }
    rids.set(peerHex, m);
    if (rids.size > 500) { const first = rids.keys().next().value; if (first !== peerHex) rids.delete(first); }   // the files are the record; the cache stays small
    return m;
  }
  function ridSave(peerHex, m) {
    if (!ridDir) return;
    fs.mkdirSync(ridDir, { recursive: true });
    const f = ridFile(peerHex), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f);
  }
  function ridPruneOne(m) { const t = now(); let cut = false; for (const k of Object.keys(m)) if (t - Number(m[k].at || 0) > RID_TTL_MS) { delete m[k]; cut = true; } return cut; }
  // fn() → { status, body }. Answers the stored answer for a rid seen before; { status: 409, in_progress } for one
  // that was started and has no answer (this box restarted in the middle, or the first run is still going).
  async function once(peerHex, rid, fn) {
    if (!PEER_RE.test(String(peerHex)) || !RID_RE.test(String(rid))) return { status: 400, body: { ok: false, error: 'rid must be 32 lowercase hex characters' } };
    const m = ridLoad(peerHex); ridPruneOne(m);
    const had = m[rid];
    if (had && had.state === 'done') return { status: had.status, body: had.body, repeat: true };
    if (had) return { status: 409, body: { ok: false, error: 'in_progress', rid }, repeat: true };
    if (Object.keys(m).length >= RID_PER_PEER) return { status: 429, body: { ok: false, error: 'too many requests that transfer money in 24 hours' } };
    m[rid] = { at: now(), state: 'started' };
    ridSave(peerHex, m);                       // written down BEFORE anything is done
    const r = await fn();                      // a throw leaves it "started": what was done is not known here
    const status = Number(r && r.status) || 500, body = (r && r.body !== undefined) ? r.body : null;
    m[rid] = { at: m[rid].at, state: 'done', status, body };
    ridSave(peerHex, m);
    return { status, body };
  }
  function whatBecame(peerHex, rid) {
    if (!PEER_RE.test(String(peerHex)) || !RID_RE.test(String(rid))) return { known: false };
    const m = ridLoad(peerHex); if (ridPruneOne(m)) { try { ridSave(peerHex, m); } catch (_) {} }
    const e = m[rid];
    if (!e) return { known: false };
    return e.state === 'done' ? { known: true, state: 'done', status: e.status, body: e.body } : { known: true, state: 'started' };
  }
  // the hourly sweep of the files (a peer that never comes back still has its entries removed)
  function pruneRids() {
    if (!ridDir) return 0;
    let cut = 0, names = [];
    try { names = fs.readdirSync(ridDir).filter((n) => /^0[23][0-9a-f]{64}\.json$/.test(n)); } catch (_) { return 0; }
    for (const n of names) {
      const peer = n.slice(0, 66); rids.delete(peer);
      const m = ridLoad(peer);
      if (ridPruneOne(m)) { cut++; try { if (Object.keys(m).length) ridSave(peer, m); else { fs.unlinkSync(ridFile(peer)); rids.delete(peer); } } catch (_) {} }
    }
    return cut;
  }

  // ── methods ────────────────────────────────────────────────────────────────
  // fn(caller, params) → { status, body } (or a promise of it). money: the method transfers money — params.rid is
  // required and the function runs through once().
  function register(name, fn, o2) {
    if (!/^[a-z0-9]+\.[a-z0-9_]+$/.test(String(name)) || typeof fn !== 'function') throw new Error('lijox-rpc: bad method ' + name);
    methods.set(name, { fn, money: !!(o2 && o2.money) });
  }
  const methodNames = () => Array.from(methods.keys()).sort();

  register('lijox.hello', () => ({ status: 200, body: { v: 1, adapter: version, methods: methodNames(), max_parts: MAX_PARTS, part_bytes: PART_BYTES } }));
  register('lijox.what_became', (caller, params) => {
    if (!RID_RE.test(String(params.rid || ''))) return { status: 400, body: { ok: false, error: 'rid must be 32 lowercase hex characters' } };
    return { status: 200, body: whatBecame(caller.pubkey, params.rid) };
  });
  register('lsps0.list_protocols', () => ({ status: 200, body: { protocols: [] } }));   // LSPS0's own method: no numbered LSPS protocol is served on this path yet

  // ── one message from a peer ────────────────────────────────────────────────
  async function onMessage(peerHex, buf, viaParts) {
    peerHex = String(peerHex || '').toLowerCase();
    if (!PEER_RE.test(peerHex)) return;
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)); }
    catch (_) { return answerErr(peerHex, null, E_PARSE, 'not JSON'); }
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return answerErr(peerHex, (isObj(msg) && typeof msg.id === 'string' && ID_RE.test(msg.id)) ? msg.id : null, E_REQUEST, 'not a JSON-RPC 2.0 object');
    if (typeof msg.method !== 'string') return;   // an answer, or nothing we know: this side sends no requests, so there is nothing to pair it with

    if (msg.method === 'lijox.part') {
      if (viaParts) return answerErr(peerHex, null, E_PARTS, 'a part inside parts');
      if (!allowed(peerHex)) return answerErr(peerHex, (isObj(msg.params) && typeof msg.params.of === 'string' && ID_RE.test(msg.params.of)) ? msg.params.of : null, E_RATE, 'too many requests from this peer');
      const r = takePart(peerHex, msg.params);
      if (r.refuse) return answerErr(peerHex, r.of !== undefined ? r.of : null, E_PARTS, r.refuse);
      if (r.wait) return;
      let whole = null; try { whole = JSON.parse(r.text); } catch (_) { whole = null; }
      if (!isObj(whole) || whole.id !== r.of) return answerErr(peerHex, r.of, E_REQUEST, 'the parts do not make the request they name');
      return onMessage(peerHex, Buffer.from(r.text, 'utf8'), true);
    }

    const id = msg.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return answerErr(peerHex, null, E_REQUEST, 'a request needs an id of 1 to 64 printable characters');
    if (!viaParts && !allowed(peerHex)) return answerErr(peerHex, id, E_RATE, 'too many requests from this peer');
    const params = msg.params === undefined ? {} : msg.params;
    if (!isObj(params)) return answerErr(peerHex, id, E_PARAMS, 'params must be an object');
    const m = methods.get(msg.method);
    if (!m) return answerErr(peerHex, id, E_METHOD, 'unknown method');
    let served = true; try { if (servesTo) served = servesTo(peerHex, msg.method) !== false; } catch (_) { served = true; }
    if (!served) return answerErr(peerHex, id, E_METHOD, 'unknown method');   // 0.145.0: the same answer as for a method that does not exist
    counts.requests++;
    const t0 = now();
    let r;
    try {
      const caller = { pubkey: peerHex };
      if (m.money) {
        if (!RID_RE.test(String(params.rid || ''))) r = { status: 400, body: { ok: false, error: 'this request transfers money and needs rid (32 lowercase hex characters)' } };
        else r = await once(peerHex, params.rid, () => m.fn(caller, params));
      } else r = await m.fn(caller, params);
    } catch (e) {
      log(`[RPC] ${msg.method} from ${peerHex.slice(0, 16)}… failed inside: ${String((e && e.message) || e).slice(0, 160)}`);
      return answerErr(peerHex, id, E_INTERNAL, 'the provider could not carry out the request');
    }
    const status = Number(r && r.status) || 500, body = (r && r.body !== undefined) ? r.body : null;
    try { if (onServed) onServed(peerHex, msg.method); } catch (_) {}
    if (status >= 200 && status < 300) { counts.answered++; await sendJson(peerHex, id, { jsonrpc: '2.0', id, result: isObj(body) ? body : { value: body } }); }
    else { counts.refused++; await sendJson(peerHex, id, { jsonrpc: '2.0', id, error: { code: status, message: String((isObj(body) && body.error) || 'refused').slice(0, 200), data: body } }); }
    if (msg.method !== 'lijox.hello' || status !== 200) log(`[RPC] ${msg.method} ${peerHex.slice(0, 16)}… → ${status} in ${now() - t0} ms${r && r.repeat ? ' (a repeat: the stored answer)' : ''}`);
    else log(`[RPC] ${peerHex.slice(0, 16)}… asked what this provider serves inside the connection (${methods.size} methods)`);
  }

  const timer = setInterval(() => { try { sweepParts(); pruneRids(); } catch (_) {} }, 3600 * 1000);
  if (timer.unref) timer.unref();

  return {
    TYPE: TYPE_LSPS0,
    register, methodNames, onMessage, once, whatBecame, pruneRids,
    capability: { lsps0: true },
    stats: () => Object.assign({ methods: methods.size, peers_with_parts: parts.size }, counts),
    stop: () => clearInterval(timer),
    _parts: parts,
  };
}

module.exports = {
  createLijoxRpc, frames, TYPE_LSPS0, MAX_JSON_WHOLE, PART_BYTES, PART_BYTES_ACCEPTED, MAX_PARTS, PART_GAP_MS,
  PEER_PART_BYTES, PEER_PART_REQS, PEERS_WITH_PARTS, PER_MIN_DEFAULT, RID_TTL_MS, RID_PER_PEER,
  E_PARSE, E_REQUEST, E_METHOD, E_PARAMS, E_INTERNAL, E_RATE, E_LARGE, E_PARTS, E_NOT_READY,
};
