// nwc.js — 0.86.0 (S50, DP 2026-09-28 17:50 "start on NWC … separate and isolated work"; the design: nwc-handoff.md,
// DP's rulings 2026-09-27/28). NWC (NIP-47) FOR LiJ — THE PROVIDER'S HALF.
//
// A Nostr app asks LiJ to pay a zap invoice. The request is a NIP-47 event (kind 23194) with NIP-44-encrypted
// content, addressed to the wallet's per-app SERVICE key, signed by the app's CLIENT key. Nostr keeps such
// events for nobody (ephemeral kinds), so a sleeping phone would miss it — this provider keeps it, encrypted as
// it came, and wakes the phone. LiJ opens, fetches, decrypts, shows Send, the user taps, LiJ pays with its own
// keys and replies (kind 23195) through the same relay. THIS PROVIDER NEVER PAYS, NEVER HOLDS A KEY THAT READS A
// REQUEST, NEVER SEES THE INVOICE, THE AMOUNT OR THE PAYEE (DP's ruling). All it knows: which wallet a service
// key belongs to (the registration the wallet signs) — that is what tells it whom to wake.
//
//   SWITCH      NWC_ENABLED=true (name fixed in code; default off — DP: off for LIJOX operators, on for Node-1).
//               Off = every route and the relay refuse. Advertised in get_info / health as `nwc`.
//   REGISTER    POST /v1/nwc/register  { client_pubkey (the wallet's node key), service_pk, client_pk, expires_at,
//               ttl_s, ts, signature } — the route token + the wallet's node-key signature (LND VerifyMessage on
//               "lij-nwc-register:v1|service_pk|client_pk|expires_at|ttl_s|ts", the recover-close / void pattern).
//               POST /v1/nwc/unregister { client_pubkey, service_pk, ts, signature } — the same, and everything
//               stored for that key goes with it. Capped connections per wallet. Registrations persist in
//               DATA_DIR/nwc/registry.json; the provider drops one itself at its expiry.
//   RELAY       a websocket at /nwc on the API server (the same tunnel; no new ingress). NIP-01 EVENT / REQ / CLOSE /
//               EOSE / OK / NOTICE + NIP-42 AUTH. Accepts 13194 (info) from a registered service key, 23194 (request)
//               addressed to a registered service key from that connection's client key (created_at within ±10 min;
//               kept until the earliest of created_at + the wallet's ttl, the `expiration` tag, the ceiling;
//               capped per connection), 23195 (reply) from a registered service key to that connection's client key.
//               Anything else → OK false, nothing stored. Serves 23194 only to a NIP-42-authenticated service key;
//               23195 to a subscriber naming the exact client key; 13194 by author. A REQ that names no key gets
//               nothing. Stored requests and replies persist in DATA_DIR/nwc/events.json — a restart drops nothing.
//   WAKE        a stored 23194 wakes the registered wallet through the existing web push ({t:"nwc"} — content-free;
//               this provider knows nothing more), never a live wallet (walletLiveNow), at most one per wallet per 60 s.
//   LOG         [NWC] lines: events and counts only; keys cut to 8 hex; no content, no addresses.
//
// Signatures: schnorr.js (vendored BIP-340, DP's pick — locked). Every event's id is re-hashed here, never trusted.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const schnorr = require('./schnorr.js');

const REGISTER_DOMAIN = 'lij-nwc-register:v1|';
const UNREGISTER_DOMAIN = 'lij-nwc-unregister:v1|';
const KIND_INFO = 13194, KIND_REQUEST = 23194, KIND_RESPONSE = 23195, KIND_AUTH = 22242;
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const short = (k) => String(k || '').slice(0, 8);

/// NIP-01: the id is sha256 over [0, pubkey, created_at, kind, tags, content] serialized without whitespace.
function eventId(ev) {
  return crypto.createHash('sha256').update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]), 'utf8').digest('hex');
}

/// The shape and the signature of an event. Answers a reason or ''.
function checkEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'not an object';
  if (!isHex(ev.id, 64) || !isHex(ev.pubkey, 64) || !isHex(ev.sig, 128)) return 'bad id/pubkey/sig';
  if (!Number.isInteger(ev.created_at) || ev.created_at < 0) return 'bad created_at';
  if (!Number.isInteger(ev.kind) || ev.kind < 0 || ev.kind > 65535) return 'bad kind';
  if (!Array.isArray(ev.tags) || ev.tags.some((t) => !Array.isArray(t) || t.some((x) => typeof x !== 'string'))) return 'bad tags';
  if (typeof ev.content !== 'string') return 'bad content';
  if (eventId(ev) !== ev.id) return 'id does not match';
  if (!schnorr.verify(ev.sig, ev.id, ev.pubkey)) return 'bad signature';
  return '';
}

const tagValue = (ev, name) => { const t = (ev.tags || []).find((x) => x.length >= 2 && x[0] === name); return t ? t[1] : null; };
const tagValues = (ev, name) => (ev.tags || []).filter((x) => x.length >= 2 && x[0] === name).map((x) => x[1]);

/// Does `ev` match a NIP-01 filter (the subset the relay honours: ids, authors, kinds, #p, #e, since, until, limit)?
function matches(f, ev) {
  if (f.ids && !f.ids.some((i) => ev.id.startsWith(i))) return false;
  if (f.authors && !f.authors.some((a) => ev.pubkey.startsWith(a))) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f['#p'] && !tagValues(ev, 'p').some((v) => f['#p'].includes(v))) return false;
  if (f['#e'] && !tagValues(ev, 'e').some((v) => f['#e'].includes(v))) return false;
  if (Number.isInteger(f.since) && ev.created_at < f.since) return false;
  if (Number.isInteger(f.until) && ev.created_at > f.until) return false;
  return true;
}

function createNwc(deps) {
  const {
    dataDir, log, env = process.env, now = () => Date.now(),
    sendWakePush = async () => {},          // (walletPubkey, kind) → the existing web push, {t: kind}
    verifyWalletSig = async () => '',       // (msgUtf8, sigZbase32) → the recovered node pubkey (66 hex) or '' — LND VerifyMessage
    authOk = () => false,                   // the route token
    publicHttpsUrl = '',                    // CONFIG.public.https_url (or a function of it — CONFIG is built later in lij-adapter.js) → the relay's wss URL
  } = deps;
  const ENABLED = String(env.NWC_ENABLED || 'false') === 'true';
  const TTL_CEILING_S = Math.max(60, int(env.NWC_REQUEST_TTL_CEILING_S, 3600));
  const MAX_CONNS_PER_WALLET = 10;
  const MAX_WAITING_PER_CONN = 20;
  const WAKE_MIN_INTERVAL_MS = 60_000;
  const SKEW_S = 600;
  const MAX_EXPIRY_DAYS = 365;
  const MAX_MSG_BYTES = 64 * 1024;
  const MAX_SUBS_PER_SOCKET = 20;
  const MAX_EVENTS_PER_MIN = 30;
  const RELAY_PATH = '/nwc';
  const relayUrlOf = () => { let u = ''; try { u = String((typeof publicHttpsUrl === 'function' ? publicHttpsUrl() : publicHttpsUrl) || ''); } catch (_) { u = ''; } return u ? u.replace(/^http/, 'ws').replace(/\/+$/, '') + RELAY_PATH : ''; };

  const DIR = path.join(dataDir, 'nwc');
  const REG_PATH = path.join(DIR, 'registry.json');
  const EV_PATH = path.join(DIR, 'events.json');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  let reg = { conns: {} };            // service_pk → { wallet, client_pk, expires_at, ttl_s, registered_at }
  let ev = { requests: [], replies: [], infos: {} };
  try { const j = JSON.parse(fs.readFileSync(REG_PATH, 'utf8')); if (j && j.conns) reg = j; } catch (_) {}
  try { const j = JSON.parse(fs.readFileSync(EV_PATH, 'utf8')); if (j && Array.isArray(j.requests)) ev = { requests: j.requests, replies: j.replies || [], infos: j.infos || {} }; } catch (_) {}
  const persistReg = () => { try { fs.writeFileSync(REG_PATH, JSON.stringify(reg)); } catch (e) { log(`[NWC] registry persist failed: ${e.message}`); } };
  const persistEv = () => { try { fs.writeFileSync(EV_PATH, JSON.stringify(ev)); } catch (e) { log(`[NWC] events persist failed: ${e.message}`); } };

  const nowS = () => Math.floor(now() / 1000);
  const wakeAt = new Map();          // wallet → last wake ms
  let wakesToday = []; // timestamps

  // ── the registry ──
  function connsOf(wallet) { return Object.entries(reg.conns).filter(([, c]) => c.wallet === wallet); }
  function dropConn(servicePk, why) {
    const c = reg.conns[servicePk]; if (!c) return;
    delete reg.conns[servicePk];
    const before = ev.requests.length + ev.replies.length;
    ev.requests = ev.requests.filter((r) => r.service_pk !== servicePk);
    ev.replies = ev.replies.filter((r) => r.service_pk !== servicePk);
    delete ev.infos[servicePk];
    persistReg(); persistEv();
    log(`[NWC] connection ${short(servicePk)} for ${short(c.wallet)} ${why} (${before - ev.requests.length - ev.replies.length} stored event(s) dropped)`);
  }
  /// Expired registrations and stale events go. Run on a timer and before every read.
  function sweep() {
    const t = nowS(); let n = 0;
    for (const [pk, c] of Object.entries(reg.conns)) if (c.expires_at <= t) { dropConn(pk, 'expired'); n++; }
    const r0 = ev.requests.length, p0 = ev.replies.length;
    ev.requests = ev.requests.filter((r) => r.expires_at > t);
    ev.replies = ev.replies.filter((r) => r.expires_at > t);
    if (ev.requests.length !== r0 || ev.replies.length !== p0) { persistEv(); log(`[NWC] ${r0 - ev.requests.length} request(s) and ${p0 - ev.replies.length} reply(ies) past their time — gone`); }
    wakesToday = wakesToday.filter((ms) => now() - ms < 86_400_000);
    return n;
  }

  // ── the routes ──
  async function handle(req, res, pathname, method, ip, readBody, jsonResponse) {
    if (!pathname.startsWith('/v1/nwc/')) return false;
    const j = (data, status = 200) => { jsonResponse(res, data, status); return true; };
    if (!ENABLED) return j({ ok: false, error: 'nwc_off', reason: 'this provider does not offer NWC' }, 404);
    if (method !== 'POST') return j({ ok: false, error: 'method' }, 405);
    if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
    let body; try { body = await readBody(req); } catch (_) { return j({ ok: false, error: 'bad json' }, 400); }
    const wallet = String(body.client_pubkey || '').toLowerCase();
    if (!isHex(wallet, 66)) return j({ ok: false, error: 'client_pubkey must be 66 hex' }, 400);
    const servicePk = String(body.service_pk || '').toLowerCase();
    if (!isHex(servicePk, 64)) return j({ ok: false, error: 'service_pk must be 64 hex' }, 400);
    const ts = Number(body.ts); const sig = String(body.signature || '').trim();
    if (!Number.isInteger(ts) || Math.abs(nowS() - ts) > SKEW_S) return j({ ok: false, error: 'ts out of window' }, 400);
    if (!sig) return j({ ok: false, error: 'signature required' }, 400);
    sweep();

    if (pathname === '/v1/nwc/register') {
      const clientPk = String(body.client_pk || '').toLowerCase();
      const expiresAt = Number(body.expires_at); const ttl = Number(body.ttl_s);
      if (!isHex(clientPk, 64)) return j({ ok: false, error: 'client_pk must be 64 hex' }, 400);
      if (clientPk === servicePk) return j({ ok: false, error: 'client_pk and service_pk must differ' }, 400);
      if (!Number.isInteger(expiresAt) || expiresAt <= nowS() || expiresAt > nowS() + MAX_EXPIRY_DAYS * 86400) return j({ ok: false, error: 'expires_at must be in the future (at most a year)' }, 400);
      if (!Number.isInteger(ttl) || ttl < 60) return j({ ok: false, error: 'ttl_s must be at least 60' }, 400);
      if (!schnorr.liftX(BigInt('0x' + servicePk)) || !schnorr.liftX(BigInt('0x' + clientPk))) return j({ ok: false, error: 'a key is not on the curve' }, 400);
      const msg = REGISTER_DOMAIN + servicePk + '|' + clientPk + '|' + expiresAt + '|' + ttl + '|' + ts;
      let recovered = '';
      try { recovered = String(await verifyWalletSig(msg, sig) || '').toLowerCase(); } catch (e) { return j({ ok: false, error: 'verify_unavailable' }, 503); }
      if (!recovered) return j({ ok: false, error: 'verify_unavailable' }, 503);
      if (recovered !== wallet) { log(`[NWC] BAD register signature for ${short(wallet)}`); return j({ ok: false, error: 'bad_signature' }, 401); }
      const existing = reg.conns[servicePk];
      if (existing && existing.wallet !== wallet) return j({ ok: false, error: 'service_pk is taken' }, 409);
      if (!existing && connsOf(wallet).length >= MAX_CONNS_PER_WALLET) return j({ ok: false, error: 'too_many', reason: `at most ${MAX_CONNS_PER_WALLET} connections per wallet` }, 429);
      reg.conns[servicePk] = { wallet, client_pk: clientPk, expires_at: expiresAt, ttl_s: Math.min(ttl, TTL_CEILING_S), registered_at: nowS() };
      persistReg();
      log(`[NWC] ${existing ? 'renewed' : 'registered'} connection ${short(servicePk)} for ${short(wallet)} (${connsOf(wallet).length} of ${MAX_CONNS_PER_WALLET}; ttl ${reg.conns[servicePk].ttl_s} s; until ${new Date(expiresAt * 1000).toISOString()})`);
      return j({ ok: true, relay: relayUrlOf(), ttl_s: reg.conns[servicePk].ttl_s, ttl_ceiling_s: TTL_CEILING_S, expires_at: expiresAt, connections: connsOf(wallet).length, max_connections: MAX_CONNS_PER_WALLET });
    }

    if (pathname === '/v1/nwc/unregister') {
      const msg = UNREGISTER_DOMAIN + servicePk + '|' + ts;
      let recovered = '';
      try { recovered = String(await verifyWalletSig(msg, sig) || '').toLowerCase(); } catch (e) { return j({ ok: false, error: 'verify_unavailable' }, 503); }
      if (!recovered) return j({ ok: false, error: 'verify_unavailable' }, 503);
      if (recovered !== wallet) { log(`[NWC] BAD unregister signature for ${short(wallet)}`); return j({ ok: false, error: 'bad_signature' }, 401); }
      const c = reg.conns[servicePk];
      if (!c) return j({ ok: true, gone: true });
      if (c.wallet !== wallet) return j({ ok: false, error: 'not yours' }, 403);
      dropConn(servicePk, 'unregistered by its wallet');
      return j({ ok: true, gone: true, connections: connsOf(wallet).length });
    }
    return j({ ok: false, error: 'unknown route' }, 404);
  }

  // ── the relay ──
  const sockets = new Set();   // { ws, authed: Set<pk>, challenge, subs: Map<id, filters[]>, events: number[] }
  const send = (s, arr) => { try { s.ws.send(JSON.stringify(arr)); } catch (_) {} };

  /// Deliver a stored/new event to every open subscription it matches, honouring the read rules.
  function deliver(rec) {
    for (const s of sockets) {
      for (const [id, filters] of s.subs) {
        if (!filters.some((f) => matches(f, rec.event))) continue;
        if (!canRead(s, rec.event)) continue;
        send(s, ['EVENT', id, rec.event]);
      }
    }
  }
  /// Who may read an event: a request only the authenticated service key it is addressed to; a reply anyone
  /// asking by that client key (T4 default — NIP-42 from apps not required); the info event anyone.
  function canRead(s, e) {
    if (e.kind === KIND_REQUEST) return tagValues(e, 'p').some((p) => s.authed.has(p));
    return true;
  }

  function wake(wallet) {
    const last = wakeAt.get(wallet) || 0;
    if (now() - last < WAKE_MIN_INTERVAL_MS) { log(`[NWC] wake for ${short(wallet)} held (one per ${WAKE_MIN_INTERVAL_MS / 1000} s)`); return; }
    wakeAt.set(wallet, now()); wakesToday.push(now());
    Promise.resolve(sendWakePush(wallet, 'nwc')).then(() => log(`[NWC] woke ${short(wallet)}`)).catch((e) => log(`[NWC] wake for ${short(wallet)} failed: ${e && e.message}`));
  }

  function onEvent(s, e) {
    const why = checkEvent(e);
    if (why) { send(s, ['OK', (e && e.id) || '', false, 'invalid: ' + why]); return; }
    const t = nowS();
    if (e.kind === KIND_INFO) {
      const c = reg.conns[e.pubkey];
      if (!c) { send(s, ['OK', e.id, false, 'blocked: unknown service key']); return; }
      const cur = ev.infos[e.pubkey];
      if (!cur || cur.created_at <= e.created_at) { ev.infos[e.pubkey] = e; persistEv(); }
      send(s, ['OK', e.id, true, '']);
      deliver({ event: e });
      log(`[NWC] info for ${short(e.pubkey)} kept`);
      return;
    }
    if (e.kind === KIND_REQUEST) {
      const p = tagValue(e, 'p') || '';
      const c = reg.conns[p];
      if (!c) { send(s, ['OK', e.id, false, 'blocked: not a registered service key']); return; }
      if (e.pubkey !== c.client_pk) { send(s, ['OK', e.id, false, 'blocked: not this connection\'s app']); log(`[NWC] request for ${short(p)} from a foreign key refused`); return; }
      if (Math.abs(e.created_at - t) > SKEW_S) { send(s, ['OK', e.id, false, 'invalid: created_at is more than 10 minutes off']); return; }
      const waiting = ev.requests.filter((r) => r.service_pk === p).length;
      if (waiting >= MAX_WAITING_PER_CONN) { send(s, ['OK', e.id, false, `rate-limited: ${MAX_WAITING_PER_CONN} requests already waiting`]); log(`[NWC] request for ${short(p)} refused — ${waiting} waiting`); return; }
      if (ev.requests.some((r) => r.event.id === e.id)) { send(s, ['OK', e.id, true, 'duplicate: already have this event']); return; }
      let expires = Math.min(e.created_at + c.ttl_s, e.created_at + TTL_CEILING_S);
      const expTag = Number(tagValue(e, 'expiration'));
      if (Number.isInteger(expTag) && expTag > 0) expires = Math.min(expires, expTag);
      if (expires <= t) { send(s, ['OK', e.id, false, 'invalid: already expired']); return; }
      ev.requests.push({ service_pk: p, client_pk: e.pubkey, wallet: c.wallet, expires_at: expires, stored_at: t, event: e });
      persistEv();
      send(s, ['OK', e.id, true, '']);
      log(`[NWC] request stored for ${short(p)} (${waiting + 1} waiting; until ${new Date(expires * 1000).toISOString()})`);
      deliver(ev.requests[ev.requests.length - 1]);
      wake(c.wallet);
      return;
    }
    if (e.kind === KIND_RESPONSE) {
      const c = reg.conns[e.pubkey];
      if (!c) { send(s, ['OK', e.id, false, 'blocked: not a registered service key']); return; }
      const p = tagValue(e, 'p') || '';
      if (p !== c.client_pk) { send(s, ['OK', e.id, false, 'blocked: not this connection\'s app']); return; }
      const expires = Math.min(e.created_at + c.ttl_s, e.created_at + TTL_CEILING_S);
      if (!ev.replies.some((r) => r.event.id === e.id)) {
        ev.replies.push({ service_pk: e.pubkey, client_pk: p, wallet: c.wallet, expires_at: Math.max(expires, t + 60), stored_at: t, event: e });
        // the request it answers is done
        const eid = tagValue(e, 'e');
        if (eid) { const n0 = ev.requests.length; ev.requests = ev.requests.filter((r) => r.event.id !== eid); if (ev.requests.length !== n0) log(`[NWC] request ${short(eid)} answered`); }
        persistEv();
      }
      send(s, ['OK', e.id, true, '']);
      deliver(ev.replies[ev.replies.length - 1]);
      log(`[NWC] reply from ${short(e.pubkey)} delivered/kept`);
      return;
    }
    send(s, ['OK', e.id, false, 'blocked: not an NWC event kind']);
  }

  function onAuth(s, e) {
    const why = checkEvent(e);
    if (why || e.kind !== KIND_AUTH) { send(s, ['OK', (e && e.id) || '', false, 'invalid: ' + (why || 'not an auth event')]); return; }
    const ch = tagValue(e, 'challenge'); const rl = tagValue(e, 'relay') || '';
    if (ch !== s.challenge) { send(s, ['OK', e.id, false, 'invalid: wrong challenge']); return; }
    if (Math.abs(e.created_at - nowS()) > SKEW_S) { send(s, ['OK', e.id, false, 'invalid: created_at is more than 10 minutes off']); return; }
    let sameHost = true;
    try { const mine = relayUrlOf(); if (mine && rl) sameHost = new URL(rl).host === new URL(mine).host; } catch (_) { sameHost = false; }
    if (!sameHost) { send(s, ['OK', e.id, false, 'invalid: wrong relay']); return; }
    s.authed.add(e.pubkey);
    send(s, ['OK', e.id, true, '']);
  }

  function onReq(s, id, filters) {
    if (typeof id !== 'string' || !id || id.length > 64) { send(s, ['NOTICE', 'bad subscription id']); return; }
    if (s.subs.size >= MAX_SUBS_PER_SOCKET && !s.subs.has(id)) { send(s, ['CLOSED', id, 'rate-limited: too many subscriptions']); return; }
    const fs_ = filters.filter((f) => f && typeof f === 'object');
    if (!fs_.length || fs_.some((f) => !(f.authors || f['#p'] || f.ids))) { send(s, ['CLOSED', id, 'restricted: a filter must name a key (authors, #p or ids)']); return; }
    // a request read needs the service key authenticated
    if (fs_.some((f) => (f.kinds || []).includes(KIND_REQUEST) && !(f['#p'] || []).every((p) => s.authed.has(p)))) { send(s, ['CLOSED', id, 'auth-required: authenticate as the service key to read requests']); return; }
    s.subs.set(id, fs_);
    sweep();
    const all = [...Object.values(ev.infos).map((e) => ({ event: e })), ...ev.requests, ...ev.replies];
    let n = 0;
    for (const rec of all) {
      if (!fs_.some((f) => matches(f, rec.event))) continue;
      if (!canRead(s, rec.event)) continue;
      send(s, ['EVENT', id, rec.event]); n++;
    }
    send(s, ['EOSE', id]);
    if (n) log(`[NWC] ${n} stored event(s) served`);
  }

  function onMessage(s, raw) {
    if (raw.length > MAX_MSG_BYTES) { send(s, ['NOTICE', 'message too large']); return; }
    let m; try { m = JSON.parse(raw); } catch (_) { send(s, ['NOTICE', 'not JSON']); return; }
    if (!Array.isArray(m) || typeof m[0] !== 'string') { send(s, ['NOTICE', 'not a NIP-01 message']); return; }
    const t = now(); s.events = s.events.filter((x) => t - x < 60_000);
    if (m[0] === 'EVENT') {
      if (s.events.length >= MAX_EVENTS_PER_MIN) { send(s, ['OK', (m[1] && m[1].id) || '', false, 'rate-limited: slow down']); return; }
      s.events.push(t); onEvent(s, m[1]); return;
    }
    if (m[0] === 'AUTH') { onAuth(s, m[1]); return; }
    if (m[0] === 'REQ') { onReq(s, m[1], m.slice(2)); return; }
    if (m[0] === 'CLOSE') { if (typeof m[1] === 'string') s.subs.delete(m[1]); return; }
    send(s, ['NOTICE', 'unknown message']);
  }

  let wss = null;
  /// Hang the relay on the API server: an Upgrade at /nwc; every other upgrade is refused.
  function attach(server) {
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });
    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url || '', 'http://lsp.local').pathname; } catch (_) {}
      if (pathname !== RELAY_PATH || !ENABLED) { try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch (_) {} socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const s = { ws, authed: new Set(), challenge: crypto.randomBytes(16).toString('hex'), subs: new Map(), events: [] };
        sockets.add(s);
        ws.on('message', (data) => { try { onMessage(s, data.toString('utf8')); } catch (e) { log(`[NWC] relay message error: ${e.message}`); } });
        ws.on('close', () => sockets.delete(s));
        ws.on('error', () => sockets.delete(s));
        send(s, ['AUTH', s.challenge]);
      });
    });
    log(`[NWC] relay on ${RELAY_PATH} (${ENABLED ? 'ON' : 'off'}; ${Object.keys(reg.conns).length} connection(s), ${ev.requests.length} request(s) waiting)`);
  }

  const summary = () => ({ connections: Object.keys(reg.conns).length, wallets: new Set(Object.values(reg.conns).map((c) => c.wallet)).size, waiting: ev.requests.length, replies_kept: ev.replies.length, wakes_today: wakesToday.filter((ms) => now() - ms < 86_400_000).length, sockets: sockets.size });
  const settings = () => ({ enabled: ENABLED, request_ttl_ceiling_s: TTL_CEILING_S, max_connections: MAX_CONNS_PER_WALLET, max_waiting: MAX_WAITING_PER_CONN, wake_min_interval_s: WAKE_MIN_INTERVAL_MS / 1000, relay: relayUrlOf() });
  const capability = { enabled: ENABLED, get relay() { return ENABLED ? relayUrlOf() : null; }, request_ttl_ceiling_s: TTL_CEILING_S, max_connections: MAX_CONNS_PER_WALLET, max_waiting: MAX_WAITING_PER_CONN, encryption: ['nip44_v2'] };

  return { handle, attach, sweep, summary, settings, capability, _reg: () => reg, _ev: () => ev, _sockets: () => sockets };
}

module.exports = { createNwc, checkEvent, eventId, matches, REGISTER_DOMAIN, UNREGISTER_DOMAIN, KIND_INFO, KIND_REQUEST, KIND_RESPONSE, KIND_AUTH };
