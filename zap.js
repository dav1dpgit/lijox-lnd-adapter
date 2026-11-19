// zap.js — 0.131.0 (S70 Mon 2026-11-16, DP 22:07: "Yes, put it in and be careful not to break any other code. Go."):
// ZAPS (NIP-57) on the Lightning-address rail. Found the same evening: a Primal user could not zap
// lij@lightninginajar.xyz — Primal's LightningPayHelper.fetchInvoice opens with require(payRequest.allowsNostr == true),
// and no answer of ours had ever carried allowsNostr / nostrPubkey, so the app stopped before it asked for an invoice.
//
// What this file does, and nothing else:
//   · the two fields on the plain address answer — allowsNostr: true and nostrPubkey (this provider's receipt key);
//   · the callback's `nostr` parameter — the sender's signed zap request (kind 9734), checked as NIP-57 Appendix D says,
//     before any hash is reserved; the invoice's description hash is then SHA-256 of that request's text (step 6);
//   · the receipt (kind 9735, Appendix E) once the invoice is settled — signed with the receipt key and sent to the
//     operator's relays (ZAP_RELAYS); the sender's own relays only when ZAP_REQUEST_RELAYS=true.
//
// Off unless ZAPS_ENABLED=true: then the answer carries neither field and the callback ignores `nostr`, as before.
// The receipt key lives in DATA_DIR/zap-receipt.key (hex, mode 0600; *.key is in .gitignore), made once; a file that is there but unreadable is NEVER
// overwritten — zaps stay off and the journal says why.
//
// Why the sender's relays are not used by default: they are chosen by whoever sends the zap. Connecting to them would
// let any sender make this box open a connection to a server the sender runs, and so learn the box's address. The
// operator's list (default: relay.primal.net, relay.damus.io, nos.lol) is where the common apps read receipts.
// Every relay connection, either list, goes only to wss:// on a public address — the address is checked at connect
// time (the socket's own lookup), so a name that resolves to a private address is refused.
//
// Privacy: a receipt is public. It names the recipient's Nostr key, the sender's, the amount, the time, the invoice
// (whose payee is this provider's node) and the sender's note. Only a sender who chose to zap causes one; a plain
// Lightning-address payment never does. The journal names the address and the amount, never a key or a relay.
//
// 0.132.0 (S70 Tue 2026-11-17, DP after the review of 0.131.0: "I saw this more to be a wallet-privacy choice. Fix this
// in one go"). 0.131.0 was never run on a box. What changed here:
//   · THE WALLET CHOOSES. ZAPS_ENABLED=true now means "this provider OFFERS zaps". An address answers allowsNostr, its
//     callback reads a zap request, and a receipt is sent, only while the wallet that owns the address has said yes
//     (`allowed(name)` — the adapter reads the wallet's own signed choice, POST /client/prefs { zaps }). A wallet that
//     never chose is as before 0.131.0: nothing is advertised, nothing is published. The wallet's word at the moment a
//     receipt would be sent decides: zaps turned off since the invoice was made — no receipt.
//   · ONE RECEIPT KEY PER ADDRESS (nameKey), made from the box's secret and the address name. In 0.131.0 one key signed
//     every receipt of the box, so one question to a relay listed every zap of every wallet on the provider.
//   · THE RECEIPT'S DATE IS WHEN THE SENDER'S PAYMENT REACHED THE PROVIDER (the entry's accepted_at; else the time the
//     invoice was made) — never the time the wallet took the payment. In 0.131.0 it was the settle time, and a LiJ
//     payment settles only when the phone is online: every receipt recorded, for good, when the wallet was open.
//     What stays, and cannot be taken out: a receipt can be SENT only after the wallet took the payment, so the relays,
//     and anyone reading them at that moment, see when it appears.
//   · an entry a chit paid sends no receipt at the next start either (the invoice was cancelled).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const schnorr = require('./schnorr.js');
const { checkEvent, eventId } = require('./nwc.js');
const { privateAddress } = require('./lnurl-fetch.js');

const KIND_REQUEST = 9734;
const KIND_RECEIPT = 9735;
const KEY_FILE = 'zap-receipt.key';   // *.key: kept out of git by .gitignore, like register-stamp.key
const NAME_KEY_DOMAIN = 'lijox-zap-receipt-key-v1';   // 0.132.0: the per-address receipt key's derivation label
const MAX_REQUEST_CHARS = 16384;        // a zap request is a few hundred bytes; a long relay list a few KB
const MAX_RELAYS = 8;                   // per list
const DEFAULT_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol'];
const RELAY_TIMEOUT_MS = 10000;         // connect + the relay's OK, per relay
const RETRY_MS = [60000, 300000];       // when no relay took the receipt: twice more, then 'failed'
const RESUME_WINDOW_MS = 24 * 3600 * 1000;   // a receipt not sent before a restart is sent at boot within a day
const ZAP_KEEP_MS = 7 * 24 * 3600 * 1000;    // an entry's zap record is dropped after a week (zapPrune)

const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

/// A relay address this box may connect to: wss://, no user/password, not a local or private name. The resolved
/// address is checked again at connect time (safeLookup).
function relayUrlOk(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 200) return false;
  let u; try { u = new URL(raw); } catch (_) { return false; }
  if (u.protocol !== 'wss:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.onion') || host.endsWith('.internal')) return false;
  if (net.isIP(host) && privateAddress(host)) return false;
  return true;
}

/// The cleaned list: good addresses only, one trailing slash dropped, no repeats, at most MAX_RELAYS.
function cleanRelays(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    const s = String(r || '').trim().replace(/\/$/, '');
    if (!relayUrlOk(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_RELAYS) break;
  }
  return out;
}

/// dns.lookup that refuses private addresses. Node calls a socket's lookup either plain or with { all: true } (its
/// family auto-selection); both are answered.
function makeSafeLookup(lookupImpl) {
  const lk = lookupImpl || dns.lookup;
  return function safeLookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    lk(host, opts || {}, (err, addr, fam) => {
      if (err) return cb(err);
      const refuse = () => cb(Object.assign(new Error('the relay resolves to a private address'), { code: 'EZAPPRIVATE' }));
      if (Array.isArray(addr)) {
        const ok = addr.filter((a) => a && !privateAddress(a.address));
        if (!ok.length) return refuse();
        return cb(null, ok);
      }
      if (privateAddress(addr)) return refuse();
      return cb(null, addr, fam);
    });
  };
}

/// The raw (still encoded) value of `nostr` in a query string ("?a=1&nostr=..."). null = absent; '' = present but empty.
/// Two `nostr` parameters are refused by the caller (the answer { twice: true }).
function nostrParam(search) {
  const s = String(search || '').replace(/^\?/, '');
  let found = null, count = 0;
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    if (k === 'nostr') { count++; found = i < 0 ? '' : part.slice(i + 1); }
  }
  return count > 1 ? { twice: true } : { raw: found };
}

/// NIP-57 Appendix D on one decoded text. Answers { ok: true, ev, text } or { ok: false, reason }.
function checkRequestText(text, amountMsat) {
  if (typeof text !== 'string' || !text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_REQUEST_CHARS) return { ok: false, reason: 'too long' };
  let ev; try { ev = JSON.parse(text); } catch (_) { return { ok: false, reason: 'not JSON' }; }
  const bad = checkEvent(ev);                                   // 1: a valid signature (and the id, the shape)
  if (bad) return { ok: false, reason: bad };
  if (ev.kind !== KIND_REQUEST) return { ok: false, reason: 'not kind 9734' };
  if (!ev.tags.length) return { ok: false, reason: 'no tags' };   // 2
  const vals = (name) => ev.tags.filter((t) => t[0] === name);
  const p = vals('p');
  if (p.length !== 1 || !isHex(p[0][1], 64)) return { ok: false, reason: 'needs exactly one p tag' };   // 3
  const e = vals('e');
  if (e.length > 1 || (e.length && !isHex(e[0][1], 64))) return { ok: false, reason: 'more than one e tag, or a bad one' };   // 4
  const amt = vals('amount');
  if (amt.length > 1) return { ok: false, reason: 'more than one amount tag' };
  if (amt.length) {                                                // 6
    let a; try { a = BigInt(String(amt[0][1])); } catch (_) { return { ok: false, reason: 'bad amount tag' }; }
    if (!/^[0-9]+$/.test(String(amt[0][1])) || a !== BigInt(amountMsat)) return { ok: false, reason: 'amount tag does not match the amount' };
  }
  const a = vals('a');
  if (a.length > 1 || (a.length && !(typeof a[0][1] === 'string' && a[0][1].length <= 512 && /^[0-9]{1,5}:[0-9a-f]{64}:/.test(a[0][1])))) return { ok: false, reason: 'bad a tag' };   // 7
  const P = vals('P');
  if (P.length > 1 || (P.length && !isHex(P[0][1], 64))) return { ok: false, reason: 'more than one P tag, or a bad one' };   // 8 (count and shape)
  const k = vals('k');
  if (k.length > 1 || (k.length && !/^[0-9]{1,5}$/.test(String(k[0][1])))) return { ok: false, reason: 'bad k tag' };
  return { ok: true, ev, text };
}

/// The callback's zap request, from the raw query string. Decoded once with decodeURIComponent (a `+` stays a `+`);
/// if that does not verify and the text had a `+`, decoded again with `+` as a space (form encoding). The signature
/// decides: only the text the sender signed verifies. Answers { zap: null } (no `nostr`), { error } or { zap }.
function fromQuery(search, amountMsat) {
  const np = nostrParam(search);
  if (np.twice) return { error: 'nostr given twice' };
  if (np.raw === null) return { zap: null };
  if (!np.raw) return { error: 'empty' };
  if (np.raw.length > MAX_REQUEST_CHARS * 3) return { error: 'too long' };
  const tries = [];
  try { tries.push(decodeURIComponent(np.raw)); } catch (_) {}
  if (np.raw.includes('+')) { try { tries.push(decodeURIComponent(np.raw.replace(/\+/g, '%20'))); } catch (_) {} }
  if (!tries.length) return { error: 'not URI-encoded' };
  let first = null;
  for (const t of tries) {
    const r = checkRequestText(t, amountMsat);
    if (r.ok) return { zap: r };
    if (!first) first = r.reason;
  }
  return { error: first };
}

/// The relays a request names (the `relays` tag's values; several `relays` tags are read together).
function requestRelays(ev) {
  const out = [];
  for (const t of (ev.tags || [])) if (t[0] === 'relays') out.push(...t.slice(1));
  return cleanRelays(out);
}

/// The signed receipt (Appendix E). `text` is the request exactly as the invoice's description hash covers it;
/// `paidAtS` is the receipt's date (the caller's: when the sender's payment reached the provider).
function receipt(skHex, { ev, text }, bolt11, paidAtS) {
  const tag1 = (name) => { const t = ev.tags.find((x) => x[0] === name); return t ? t[1] : null; };
  const tags = [['p', tag1('p')], ['P', ev.pubkey]];
  if (tag1('e')) tags.push(['e', tag1('e')]);
  if (tag1('a')) tags.push(['a', tag1('a')]);
  if (tag1('k')) tags.push(['k', tag1('k')]);
  tags.push(['bolt11', String(bolt11)]);
  tags.push(['description', text]);
  const sk = Buffer.from(skHex, 'hex');
  const out = { pubkey: schnorr.pubkey(sk).toString('hex'), created_at: Math.floor(Number(paidAtS)), kind: KIND_RECEIPT, tags, content: '' };
  out.id = eventId(out);
  out.sig = schnorr.sign(sk, out.id, crypto.randomBytes(32)).toString('hex');
  const bad = checkEvent(out);
  if (bad) throw new Error('the receipt did not verify: ' + bad);
  return out;
}

/// The receipt key: DATA_DIR/zap-receipt.key, made once. A file that is there but does not hold a key is left alone and
/// null is answered (zaps stay off).
function loadKey(dataDir, log) {
  const f = path.join(dataDir, KEY_FILE);
  let txt = null;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { log(`[ZAP] the receipt key ${KEY_FILE} could not be read (${e.message}) — zaps stay OFF; the file is left as it is`); return null; } }
  if (txt !== null) {
    const h = txt.trim();
    if (!isHex(h, 64)) { log(`[ZAP] ${KEY_FILE} does not hold a key — zaps stay OFF; the file is left as it is`); return null; }
    try { return { sk: h, pk: schnorr.pubkey(Buffer.from(h, 'hex')).toString('hex'), made: false }; }
    catch (e) { log(`[ZAP] ${KEY_FILE} holds a key out of range — zaps stay OFF; the file is left as it is`); return null; }
  }
  let sk;
  do { sk = crypto.randomBytes(32); } while (BigInt('0x' + sk.toString('hex')) === 0n || BigInt('0x' + sk.toString('hex')) >= schnorr.N);
  try { fs.writeFileSync(f, sk.toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (e) { log(`[ZAP] the receipt key could not be written (${e.message}) — zaps stay OFF`); return null; }
  return { sk: sk.toString('hex'), pk: schnorr.pubkey(sk).toString('hex'), made: true };
}

/// 0.132.0: ONE RECEIPT KEY PER ADDRESS. The key that signs an address's receipts (its nostrPubkey) is
/// HMAC-SHA256(the box's secret, "lijox-zap-receipt-key-v1|<name>"). The same name always gets the same key, on this
/// box; no key signs for two addresses, so no single key lists the zaps of every wallet on a provider.
function nameKey(boxSkHex, name) {
  const n = String(name || '');
  if (!n || !isHex(boxSkHex, 64)) throw new Error('no name or no box key');
  for (let i = 0; i < 8; i++) {   // a value outside the curve's range is skipped (chance about 2^-128)
    const h = crypto.createHmac('sha256', Buffer.from(boxSkHex, 'hex')).update(NAME_KEY_DOMAIN + '|' + n + (i ? '|' + i : ''), 'utf8').digest();
    const v = BigInt('0x' + h.toString('hex'));
    if (v !== 0n && v < schnorr.N) return { sk: h.toString('hex'), pk: schnorr.pubkey(h).toString('hex') };
  }
  throw new Error('no key for this name');
}

/// Send one event to one relay: connect, ["EVENT", ev], wait for the relay's OK for this id, close. Never throws.
/// Answers 'ok' | 'refused' | 'failed' | 'timeout'.
function sendToRelay(url, ev, { WebSocketImpl, lookup, timeoutMs }) {
  return new Promise((resolve) => {
    let ws = null, done = false, timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      // the socket is dropped at once: a relay that does not answer a close frame must not keep it open
      try { if (ws) { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); } } catch (_) {}
      resolve(r);
    };
    if (!relayUrlOk(url)) return finish('failed');
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    try {
      ws = new WebSocketImpl(url, { lookup, handshakeTimeout: timeoutMs, maxPayload: 64 * 1024, followRedirects: false, perMessageDeflate: false });
    } catch (_) { return finish('failed'); }
    ws.on('open', () => { try { ws.send(JSON.stringify(['EVENT', ev])); } catch (_) { finish('failed'); } });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch (_) { return; }
      if (Array.isArray(m) && m[0] === 'OK' && m[1] === ev.id) finish(m[2] === true ? 'ok' : 'refused');
    });
    ws.on('error', () => finish('failed'));
    ws.on('close', () => finish('failed'));
  });
}

/**
 * The zaps of one adapter. opts: { enabled, dataDir, relays (the operator's list, text or array), requestRelays (bool),
 * allowed (name → true when the wallet that owns the address has zaps on; 0.132.0), countOn (→ how many wallets have),
 * log, persist, now, WebSocketImpl, lookup, timeoutMs, setTimer }.
 */
function createZaps(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const persist = o.persist || (() => {});
  const now = o.now || (() => Date.now());
  const setTimer = o.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const timeoutMs = o.timeoutMs || RELAY_TIMEOUT_MS;
  const WebSocketImpl = o.WebSocketImpl || require('ws').WebSocket;
  const lookup = makeSafeLookup(o.lookup);
  const relayText = o.relays == null || String(o.relays).trim() === '' ? DEFAULT_RELAYS : (Array.isArray(o.relays) ? o.relays : String(o.relays).split(','));
  const relays = cleanRelays(relayText);
  const useRequestRelays = o.requestRelays === true;
  // 0.132.0: THE WALLET'S CHOICE. No `allowed` handed in, or one that throws, is a no — nothing is advertised or published.
  const allowed = typeof o.allowed === 'function' ? o.allowed : (() => false);
  const walletSaysYes = (name) => { try { return !!name && allowed(String(name)) === true; } catch (_) { return false; } };
  const countOn = typeof o.countOn === 'function' ? o.countOn : (() => null);
  const counts = { requests: 0, refused: 0, sent: 0, failed: 0, dropped: 0 };
  let key = null, why = '';
  if (o.enabled) {
    if (!relays.length) why = 'ZAP_RELAYS names no usable wss:// relay';
    else { key = loadKey(o.dataDir, log); if (!key) why = 'no receipt key'; }
  } else why = 'ZAPS_ENABLED is not true';
  const on = !!(o.enabled && key && relays.length);

  // 0.132.0: one receipt key per address (nameKey), kept once made
  const nameKeys = new Map();
  function keyFor(name) {
    const n = String(name || '');
    let k = nameKeys.get(n);
    if (!k) { if (nameKeys.size >= 5000) nameKeys.clear(); k = nameKey(key.sk, n); nameKeys.set(n, k); }
    return k;
  }

  /// The fields for ONE address's plain answer: {} when the provider does not offer zaps, and {} while the wallet that
  /// owns the address has not turned them on.
  function answerFields(name) {
    if (!on || !walletSaysYes(name)) return {};
    return { allowsNostr: true, nostrPubkey: keyFor(name).pk };
  }

  /// The callback's check for ONE address. Zaps not offered, or not turned on by the address's wallet: always
  /// { zap: null } (the `nostr` parameter is ignored and the payment is a plain one, as before 0.131.0).
  function fromCallback(name, search, amountMsat) {
    if (!on || !walletSaysYes(name)) return { zap: null };
    const r = fromQuery(search, amountMsat);
    if (r.error) { counts.refused++; return r; }
    if (r.zap) {
      counts.requests++;
      return { zap: { text: r.zap.text, ev: r.zap.ev, relays: useRequestRelays ? requestRelays(r.zap.ev) : [] } };
    }
    return r;
  }

  /// What the entry keeps at the mint: the request text (for the receipt), the sender's relays when they are used,
  /// the state. The invoice text is added once the invoice exists (minted()).
  function entryRecord(zap) {
    const r = { req: zap.text, state: 'minting', at: now() };
    if (zap.relays && zap.relays.length) r.relays = zap.relays.slice();
    return r;
  }
  function minted(entry, bolt11) {
    if (!entry || !entry.zap) return;
    entry.zap.bolt11 = String(bolt11 || '');
    entry.zap.state = 'waiting';
  }

  async function publishOnce(name, entry) {
    const z = entry.zap;
    let ev;
    try {
      const req = JSON.parse(z.req);
      // 0.132.0: dated when the SENDER'S payment reached the provider (accepted_at), else when the invoice was made —
      // never the settle time and never "now": the settle is the moment the wallet was online
      const paidMs = Number(entry.accepted_at) > 0 ? Number(entry.accepted_at) : Number(z.at);
      if (!(paidMs > 0)) throw new Error('no time of payment on the record');
      ev = receipt(keyFor(name).sk, { ev: req, text: z.req }, z.bolt11, Math.floor(paidMs / 1000));
    } catch (e) {
      z.state = 'failed'; z.error = String(e.message || e).slice(0, 120); delete z.req; delete z.relays; persist(); counts.failed++;
      log(`[ZAP] ${name}: the receipt could not be made (${z.error}) — none sent`);
      return;
    }
    const list = relays.slice();
    for (const r of (z.relays || [])) if (!list.includes(r)) list.push(r);
    const results = await Promise.all(list.map((u) => sendToRelay(u, ev, { WebSocketImpl, lookup, timeoutMs })));
    const ok = results.filter((x) => x === 'ok').length;
    const amt = String(entry.amount_msat || '?');
    if (ok > 0) {
      entry.zap = { state: 'sent', ok, tried: list.length, sent_at: now() };
      persist(); counts.sent++;
      log(`[ZAP] ${name}: zap receipt published — ${ok} of ${list.length} relays took it (${amt} msat)`);
      return;
    }
    z.tries = (z.tries || 0) + 1;
    if (z.tries > RETRY_MS.length) {
      entry.zap = { state: 'failed', tried: list.length, tries: z.tries, failed_at: now() };
      persist(); counts.failed++;
      log(`[ZAP] ${name}: no relay took the zap receipt after ${z.tries} tries — given up (${amt} msat; the payment itself is settled)`);
      return;
    }
    z.state = 'waiting'; persist();
    const wait = RETRY_MS[z.tries - 1];
    log(`[ZAP] ${name}: no relay took the zap receipt (${results.join(', ')}) — trying again in ${Math.round(wait / 1000)} s`);
    setTimer(() => { onSettled(name, entry).catch(() => {}); }, wait);
  }

  /// Called wherever the adapter marks an address entry settled. Sends the receipt once: only an entry whose zap is
  /// 'waiting' and whose status is 'settled' is taken, and it is marked 'sending' before anything is awaited.
  async function onSettled(name, entry) {
    if (!on || !entry || !entry.zap || entry.zap.state !== 'waiting' || entry.status !== 'settled') return;
    // 0.132.0: an entry a chit paid — its invoice was cancelled, no zap was paid on it (this also covers the boot resume)
    if (entry.settled_by === 'chit') { entry.zap = { state: 'dropped', why: 'paid by a chit, not on this invoice', at: now() }; persist(); counts.dropped++; return; }
    // 0.132.0: the wallet's word NOW decides — zaps turned off since the invoice was made: no receipt, the request dropped
    if (!walletSaysYes(name)) {
      entry.zap = { state: 'dropped', why: 'the wallet has zaps off', at: now() }; persist(); counts.dropped++;
      log(`[ZAP] ${name}: the wallet has zaps off — no receipt is sent`);
      return;
    }
    if (!entry.zap.req || !entry.zap.bolt11) { entry.zap = { state: 'failed', error: 'incomplete record' }; persist(); return; }
    entry.zap.state = 'sending';
    try { await publishOnce(name, entry); }
    catch (e) { if (entry.zap && entry.zap.state === 'sending') { entry.zap.state = 'waiting'; persist(); } log(`[ZAP] ${name}: receipt error ${e.message}`); }
  }

  /// At boot: an entry settled within a day whose receipt was not sent ('waiting', or 'sending' when the box stopped
  /// mid-send) is sent now. Answers how many were taken up.
  function resume(registry) {
    if (!on) return 0;
    let n = 0;
    for (const [name, rec] of Object.entries(registry || {})) {
      for (const entry of ((rec && rec.entries) || [])) {
        if (!entry || !entry.zap || entry.status !== 'settled') continue;
        if (entry.zap.state !== 'waiting' && entry.zap.state !== 'sending') continue;
        if (now() - Number(entry.settled_at || 0) > RESUME_WINDOW_MS) { entry.zap = { state: 'failed', error: 'not sent before a restart, over a day ago' }; continue; }
        entry.zap.state = 'waiting'; n++;
        onSettled(name, entry).catch(() => {});
      }
    }
    if (n) { persist(); log(`[ZAP] boot: ${n} zap receipt(s) not sent before the restart — sending now`); }
    return n;
  }

  /// Pruning, from the registry's own prune: a zap record goes with an entry that did not settle, and after a week.
  function prune(entry) {
    if (!entry || !entry.zap) return;
    const z = entry.zap;
    const live = entry.status === 'reserved' || entry.status === 'accepted' || entry.status === 'settle_pending' || (entry.status === 'settled' && (z.state === 'waiting' || z.state === 'sending'));
    if (!live && entry.status !== 'settled') { delete entry.zap; return; }
    const at = Number(z.sent_at || z.failed_at || z.at || 0);
    if (!live && at && now() - at > ZAP_KEEP_MS) delete entry.zap;
  }

  function summary() {
    let wOn = null; try { wOn = countOn(); } catch (_) { wOn = null; }
    return { enabled: on, per_wallet: true, wallets_on: wOn, key_file: on ? KEY_FILE : null, relays: relays.slice(), request_relays: useRequestRelays, why_off: on ? '' : why, counts: Object.assign({}, counts) };
  }
  function bootLine() {
    if (!on) return `[Startup] Zaps (NIP-57): off (${why})`;
    let wOn = null; try { wOn = countOn(); } catch (_) { wOn = null; }
    return `[Startup] Zaps (NIP-57): OFFERED — each wallet chooses${wOn === null ? '' : ' (' + wOn + ' wallet(s) have zaps on)'}; one receipt key per address, made from ${KEY_FILE}${key.made ? ' (new)' : ''}; receipts to ${relays.join(', ')}${useRequestRelays ? ' and the sender\'s relays' : ''}`;
  }
  // 0.132.0: `choice: 'wallet'` — a wallet reads from it that this provider takes its signed choice
  return { on, answerFields, fromCallback, entryRecord, minted, onSettled, resume, prune, summary, bootLine, capability: () => ({ enabled: on, choice: 'wallet' }) };
}

module.exports = { createZaps, fromQuery, checkRequestText, nostrParam, requestRelays, receipt, relayUrlOk, cleanRelays, makeSafeLookup, sendToRelay, loadKey, nameKey,
  KIND_REQUEST, KIND_RECEIPT, KEY_FILE, NAME_KEY_DOMAIN, DEFAULT_RELAYS, MAX_REQUEST_CHARS, MAX_RELAYS };
