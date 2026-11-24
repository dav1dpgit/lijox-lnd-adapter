// 0.134.0 (S71 Thu 2026-11-19, DP 14:47 "Go on all subscription work"): LIJOX SUBSCRIPTIONS — THE PROVIDER'S PART.
// The format is the wallet repo's docs/design/subscriptions/lijox-subscriptions-r2.md (and round 3 for what the build
// pinned). A subscription is an agreement between a wallet user and a merchant; nothing is ever sent automatically.
// The provider does four small things, and this file holds their rules (lij-adapter.js holds the routes):
//
//  1. REMINDER TIMES (format §12). A wallet hands its own provider a list of times; at each one the provider sends the
//     wake push {"t":"due"} — unless the wallet is live at that moment. The provider is told times only: no merchant,
//     no plan, no amount. The list is replaced whole each time; an empty list deletes it.
//  2. A SELLER'S INVOICES (format §13). A wallet user who sells registers SELLING HASHES under its selling name
//     (subs--…, never a public address). The provider's sidecar — which holds no key of the seller — asks this adapter,
//     on the box itself, for an invoice on the seller's next selling hash with the subscription's description. The
//     payment then takes the Lightning-address path: held, the wallet woken, delivered; the seller's phone takes it
//     only after checking the description's tag, and reads that description here (GET /lnurl/note).
//  3. A SELLER'S REQUESTS to the sidecar pass through this adapter, which checks the node key's proof (the sidecar
//     acts on nothing unsigned and never sees a request this adapter did not check).
//  4. ONE-USE ADDRESSES (the wallet repo's docs/design/receive/one-use-address-r2.md): a name made for one payment
//     back to a wallet (a refund), under a host THIS provider sets (LNURLP_ONE_USE_HOST) — never claimed at the shared
//     address host, released by itself once paid.
//
// A name with "--" in it is reserved for these kinds; a wallet's standing address never has one.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const WAKE_MAX_TIMES = 64;                    // format §12
const WAKE_MAX_AHEAD_S = 400 * 86400;         // none more than 400 days ahead (a day's leeway for the phone's clock)
const WAKE_LATE_S = 24 * 3600;                // a time this box slept through is still sent within a day, then dropped
const ONE_USE_MAX_NAMES = 20;                 // live one-use names a wallet
const ONE_USE_MAX_HASHES = 5;                 // payment hashes a one-use name
const ONE_USE_LIFE_S = 35 * 86400;            // a one-use name is dropped after this, paid or not
const INVOICE_LIFE_MAX_S = 600;               // format §14
const DESCRIPTION_RE = /^lijox-subs\/1 [A-Za-z0-9._-]{1,40} #[1-9][0-9]{0,3} [0-9a-f]{32}$/;

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ── names ───────────────────────────────────────────────────────────────────────────────────────────────────────
// A wallet's selling name: one per wallet, made from its node key, so the sidecar's local door finds a seller's hashes
// by the seller's key alone and nobody else can register under it.
function sellingNameFor(pubkeyHex) { return 'subs--' + sha256hex(String(pubkeyHex).toLowerCase()).slice(0, 26); }
function isSellingName(name) { return /^subs--[0-9a-f]{26}$/.test(String(name)); }
function isOneUseName(name) { return /^once--[a-z2-9]{12}$/.test(String(name)); }
function isReservedName(name) { return String(name).includes('--'); }

// May this wallet register this name? { ok:true, kind } or { ok:false, error, status }.
//   plain    — a standing address, as before
//   selling  — only the wallet's own selling name
//   one-use  — only when this provider has set its one-use host; a ceiling of live names a wallet
function nameRule(name, clientPubkey, opts) {
  const o = opts || {};
  if (!isReservedName(name)) return { ok: true, kind: 'plain' };
  if (isSellingName(name)) {
    if (name !== sellingNameFor(clientPubkey)) return { ok: false, error: 'not this wallet\'s selling name', status: 403 };
    if (!o.sellerOffered) return { ok: false, error: 'this provider does not offer subscriptions for sellers', status: 404 };
    return { ok: true, kind: 'selling' };
  }
  if (isOneUseName(name)) {
    if (!o.oneUseHost) return { ok: false, error: 'this provider offers no one-use addresses', status: 404 };
    if (!o.exists && (o.oneUseNamesOfWallet || 0) >= ONE_USE_MAX_NAMES) return { ok: false, error: 'too many one-use addresses — release one first', status: 429 };
    return { ok: true, kind: 'one-use' };
  }
  return { ok: false, error: 'a name with "--" is reserved', status: 400 };
}

// ── the seller service's fee (format §13: "taken when the provider delivers a payment to the seller") ──────────────
// pct is a decimal string ("2", "1.5"); capSat an integer or null. Whole millisats, rounded down, never the whole payment.
function parsePct(pct) {
  const s = String(pct === undefined || pct === null ? '' : pct).trim();
  if (s === '') return { n: 0n, scale: 0 };
  if (!/^[0-9]{1,3}(\.[0-9]{1,4})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  const v = { n: BigInt(i + f), scale: f.length };
  if (v.n > 100n * (10n ** BigInt(v.scale))) return null;   // over 100 %
  return v;
}
function sellerFeeMsat(amountMsat, pct, capSat) {
  const p = parsePct(pct);
  const amt = BigInt(amountMsat);
  if (!p || p.n === 0n || amt <= 0n) return 0n;
  let fee = (amt * p.n) / (100n * (10n ** BigInt(p.scale)));
  const cap = (capSat === undefined || capSat === null || capSat === '') ? null : BigInt(capSat) * 1000n;
  if (cap !== null && cap >= 0n && fee > cap) fee = cap;
  if (fee >= amt) fee = 0n;
  return fee;
}

// ── what the sidecar asks at the local door ────────────────────────────────────────────────────────────────────
// POST /v1/subs/mint { client_pubkey, amount_msat, description, expiry_s } → checked, or the reason.
function mintRequest(body) {
  const b = body || {};
  const client = String(b.client_pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(client)) return { ok: false, error: 'client_pubkey required' };
  const amtS = String(b.amount_msat === undefined ? '' : b.amount_msat);
  if (!/^[1-9][0-9]{0,15}$/.test(amtS)) return { ok: false, error: 'amount_msat required' };
  const description = String(b.description || '');
  if (!DESCRIPTION_RE.test(description)) return { ok: false, error: 'the description is not a subscription\'s' };
  const exp = Number(b.expiry_s === undefined ? INVOICE_LIFE_MAX_S : b.expiry_s);
  if (!Number.isInteger(exp) || exp < 60 || exp > INVOICE_LIFE_MAX_S) return { ok: false, error: 'expiry_s is 60–600' };
  // no_fee: the sidecar's word that this seller pays the provider's monthly Seller service instead of a share of each
  // payment (design r9 §1, option B) — the adapter then keeps nothing from this payment
  return { ok: true, client, amountMsat: BigInt(amtS), description, expiryS: exp, noFee: b.no_fee === true };
}

// The local door: only the sidecar on this box. The shared secret in the header, compared in constant time, AND a
// loopback socket, AND no mark of the public front (a request that came through the tunnel carries one).
function localDoorOk(req, secret) {
  if (!secret || String(secret).length < 16) return false;
  const got = Buffer.from(String((req.headers && req.headers['x-subs-secret']) || ''), 'utf8');
  const want = Buffer.from(String(secret), 'utf8');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for']) return false;
  const ra = String((req.socket && req.socket.remoteAddress) || '');
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

// A seller's request: the record its node key signs (engine: proof action "subs-seller").
function sellerRecordId(bodyText) { return 'subs-seller:' + sha256hex(String(bodyText)); }

// ── reminder times ──────────────────────────────────────────────────────────────────────────────────────────────
function wakeRecordId(times) { return 'wake:' + times.length + ':' + sha256hex(times.join(',')); }

// The list as a wallet may hand it: whole seconds, at most 64, none more than 400 days ahead; kept sorted, each once.
function wakeTimes(raw, nowS) {
  if (!Array.isArray(raw)) return { ok: false, error: 'times must be a list' };
  if (raw.length > WAKE_MAX_TIMES) return { ok: false, error: 'at most ' + WAKE_MAX_TIMES + ' times' };
  for (const t of raw) {
    if (!Number.isSafeInteger(t) || t <= 0) return { ok: false, error: 'a time is whole unix seconds' };
    if (t > nowS + WAKE_MAX_AHEAD_S + 86400) return { ok: false, error: 'a time is more than 400 days ahead' };
  }
  return { ok: true, times: raw.slice(), kept: Array.from(new Set(raw)).filter((t) => t > nowS - WAKE_LATE_S).sort((a, b) => a - b) };
}

// The store: wallet key → its times. One small JSON file. `due(nowS)` hands back the wallets with a time that has come
// (once per wallet a sweep, however many of its times have passed) and takes those times off.
function createWakeStore(opts) {
  const o = opts || {};
  const file = o.file || null;
  const log = o.log || (() => {});
  let lists = Object.create(null);
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j || {})) {
        if (/^0[23][0-9a-f]{64}$/.test(k) && Array.isArray(v)) lists[k] = v.filter((t) => Number.isSafeInteger(t) && t > 0).slice(0, WAKE_MAX_TIMES);
      }
    } catch (e) { if (e.code !== 'ENOENT') log('[SUBS] the reminder times could not be read (' + e.message + ') — starting empty; each wallet hands its list again at its next open'); }
  }
  const persist = () => {
    if (!file) return;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(lists), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (e) { log('[SUBS] the reminder times could not be written: ' + e.message); }
  };
  return {
    set(pubkey, kept) {
      const k = String(pubkey).toLowerCase();
      if (!kept.length) { if (lists[k]) { delete lists[k]; persist(); } return 0; }
      lists[k] = kept.slice(0, WAKE_MAX_TIMES); persist();
      return lists[k].length;
    },
    get(pubkey) { return (lists[String(pubkey).toLowerCase()] || []).slice(); },
    due(nowS) {
      const out = []; let changed = false;
      for (const [k, ts] of Object.entries(lists)) {
        const coming = ts.filter((t) => t > nowS);
        if (coming.length === ts.length) continue;
        const passed = ts.filter((t) => t <= nowS);
        if (passed.some((t) => t > nowS - WAKE_LATE_S)) out.push(k);   // a time slept through for over a day is dropped unsent
        if (coming.length) lists[k] = coming; else delete lists[k];
        changed = true;
      }
      if (changed) persist();
      return out;
    },
    wallets() { return Object.keys(lists).length; },
    times() { return Object.values(lists).reduce((n, v) => n + v.length, 0); },
  };
}

// ── the sidecar on this box ─────────────────────────────────────────────────────────────────────────────────────
// POST JSON to the sidecar's local address with the shared secret; the answer's JSON, or { status:'ERROR' }.
function postLocal(url, secret, obj, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (_) { return resolve({ code: 0, json: { status: 'ERROR', code: 'SIDECAR', reason: 'the sidecar\'s address is not set' } }); }
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-subs-secret': String(secret || '') }, timeout: timeoutMs || 8000 }, (res) => {
      let b = '', n = 0;
      res.on('data', (c) => { n += c.length; if (n > 1048576) { req.destroy(); return; } b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: res.statusCode, json: j || { status: 'ERROR', code: 'SIDECAR', reason: 'the sidecar did not answer in JSON' } }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ code: 0, json: { status: 'ERROR', code: 'SIDECAR', reason: 'the sidecar did not answer (' + e.message + ')' } }));
    req.end(data);
  });
}

// What this provider offers, from its settings. `url` is the sidecar's PUBLIC address (plan codes and seller-terms
// live under it); `local` its address on this box; `secret` the key the two share.
function createSubs(env, opts) {
  const e = env || {};
  const clean = (s) => String(s || '').trim().replace(/\/+$/, '');
  const url = /^https:\/\/[^\s]+$/.test(clean(e.SUBS_SIDECAR_URL)) ? clean(e.SUBS_SIDECAR_URL) : '';
  const local = /^https?:\/\/[^\s]+$/.test(clean(e.SUBS_SIDECAR_LOCAL)) ? clean(e.SUBS_SIDECAR_LOCAL) : '';
  const secret = String(e.SUBS_SIDECAR_SECRET || '');
  const feePct = parsePct(e.SUBS_SELLER_FEE_PCT) ? String(e.SUBS_SELLER_FEE_PCT || '').trim() : '';
  const feeCapSat = /^[0-9]{1,9}$/.test(String(e.SUBS_SELLER_FEE_CAP_SAT || '')) ? Number(e.SUBS_SELLER_FEE_CAP_SAT) : null;
  const oneUseHost = String(e.LNURLP_ONE_USE_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const sellerOffered = !!(url && local && secret.length >= 16);
  return {
    url, local, secret, feePct, feeCapSat, oneUseHost, sellerOffered,
    wake: createWakeStore(opts || {}),
    // /health: what a wallet reads. `subs` only when the seller service is whole (address, local door, secret).
    capability() { return sellerOffered ? { url } : null; },
    oneUse() { return oneUseHost ? { host: oneUseHost, max_hashes: ONE_USE_MAX_HASHES, life_s: ONE_USE_LIFE_S } : null; },
    wakeCapability() { return { enabled: true, max_times: WAKE_MAX_TIMES, max_ahead_s: WAKE_MAX_AHEAD_S }; },
    feeMsat(amountMsat) { return sellerFeeMsat(amountMsat, feePct, feeCapSat); },
    // every request to the sidecar is a POST of JSON with the secret; the public door wraps the visitor's own request
    // as { method, body } so the sidecar sees what was asked and knows it came through its adapter
    toSidecar(path, obj, timeoutMs) { return postLocal(local + path, secret, obj, timeoutMs); },
    bootLine() {
      return '[SUBS] reminder times: on · seller service: ' + (sellerOffered ? 'on (' + url + ', fee ' + (feePct || '0') + ' %' + (feeCapSat !== null ? ', cap ' + feeCapSat + ' sat' : '') + ')' : 'off (SUBS_SIDECAR_URL, SUBS_SIDECAR_LOCAL and SUBS_SIDECAR_SECRET not all set)')
        + ' · one-use addresses: ' + (oneUseHost ? 'on (' + oneUseHost + ')' : 'off (LNURLP_ONE_USE_HOST not set)');
    },
  };
}

module.exports = {
  createSubs, createWakeStore, wakeTimes, wakeRecordId, sellerRecordId, localDoorOk, mintRequest, sellerFeeMsat, parsePct,
  nameRule, sellingNameFor, isSellingName, isOneUseName, isReservedName, postLocal,
  WAKE_MAX_TIMES, WAKE_MAX_AHEAD_S, WAKE_LATE_S, ONE_USE_MAX_NAMES, ONE_USE_MAX_HASHES, ONE_USE_LIFE_S, INVOICE_LIFE_MAX_S, DESCRIPTION_RE,
};
