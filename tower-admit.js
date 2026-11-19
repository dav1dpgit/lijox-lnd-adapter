// tower-admit.js — 0.130.0 (S70 Sun 2026-11-15, DP "Agree, and go with the build"): WHO MAY USE THE TOWER.
// LIJOX watch duty W1, the way in (the wallet repo's docs/design/watchtower/watchtower-r4-spam.md and -r5-voucher.md).
//
// Until now ANY key could sign in at a tower, so somebody with no wallet could take every key slot. From here a wallet
// key is ADMITTED by a VOUCHER:
//   · the wallet makes ONE voucher key from its 12 words (BIP-340, 32 bytes; not its node key, not a tower key);
//   · its provider signs `lijox-voucher-v1|tower|<voucher key>` with the provider's NODE key (LND signmessage) — once,
//     at the wallet's first fee, for the wallet's life (createDesk below is that side);
//   · at a tower the wallet shows the voucher key, the provider's node key and signature, and a USE LINE signed by the
//     voucher key: `lijox-voucher-use-v1|<this tower's node key>|<the wallet's tower key here>` (BIP-340 over SHA-256).
// A copied voucher is useless: at another tower the use line names the wrong tower, and a new use line needs the
// secret half of the voucher key. So nothing kept here has to be secret from a spammer.
//
// The tower checks a voucher ONCE. An admitted key stays admitted for as long as it keeps coming; the provider is
// never asked again and can take nothing back — the provider is the party the tower watches.
// Against a made-up provider (the registry is open): per vouching provider a ceiling on keys and on new keys a day,
// and its vouchers count only if this box's own node sees it in the public graph with enough channel capacity
// (LND GetNodeInfo), or the operator named it (TOWER_ISSUERS_ALLOW).
//
// No network and no LND in this file: the callers hand in the node's own key, the registry's list, the signature
// check and the capacity read.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const schnorr = require('./schnorr.js');

const VOUCHER_DOMAIN = 'lijox-voucher-v1';
const USE_DOMAIN = 'lijox-voucher-use-v1';
const isHex = (s, n) => typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s);
const isNodeKey = (s) => typeof s === 'string' && /^0[23][0-9a-f]{64}$/.test(s);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/// What the provider's node key signs.
const voucherText = (voucherKey) => VOUCHER_DOMAIN + '|tower|' + voucherKey;
/// What the voucher key signs for one tower (BIP-340 over the SHA-256 of this text).
const useText = (towerNodeKey, towerKey) => USE_DOMAIN + '|' + towerNodeKey + '|' + towerKey;
const useDigest = (towerNodeKey, towerKey) => sha256(Buffer.from(useText(towerNodeKey, towerKey), 'utf8'));
/// The wallet's side of a use line (the engine does this; here for the drill and the tests).
const signUse = (voucherSecret, towerNodeKey, towerKey) => schnorr.sign(voucherSecret, useDigest(towerNodeKey, towerKey), Buffer.alloc(32)).toString('hex');

/// A voucher as it rides a request: { key, issuer, issuer_sig, use_sig }. → null when the shape is good, else a code.
function shapeOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'bad_voucher';
  if (!isHex(v.key, 32) || !isNodeKey(v.issuer) || !isHex(v.use_sig, 64)) return 'bad_voucher';
  if (typeof v.issuer_sig !== 'string' || v.issuer_sig.length < 40 || v.issuer_sig.length > 200 || !/^[0-9a-z]+$/.test(v.issuer_sig)) return 'bad_voucher';
  return null;
}

// ── the tower's side ────────────────────────────────────────────────────────────────────────────────────────────────
/// opts: dataDir; mode 'open' | 'voucher'; self() → this box's node key; listed() → the registry's providers
/// [{ pubkey, tower }]; verifyNode(text, sig) → the signer's node key or null; capacity(pubkey) → sats of public
/// channels, or null when it cannot be read; held(key) → whether the holder has items for a key;
/// issuerMaxKeys, issuerNewPerDay, minCapacitySats, allow (node keys), keepDays; log, now.
function createAdmit(opts) {
  const dir = path.join(opts.dataDir, 'tower');
  const file = path.join(dir, 'admitted.json');
  const mode = opts.mode === 'voucher' ? 'voucher' : 'open';
  const self = opts.self || (() => '');
  const listed = opts.listed || (async () => []);
  const verifyNode = opts.verifyNode || (async () => null);
  const capacity = opts.capacity || (async () => null);
  const held = opts.held || (() => false);
  const issuerMaxKeys = opts.issuerMaxKeys > 0 ? opts.issuerMaxKeys : 2000;
  const issuerNewPerDay = opts.issuerNewPerDay > 0 ? opts.issuerNewPerDay : 50;
  const minCapacitySats = opts.minCapacitySats >= 0 ? opts.minCapacitySats : 2000000;
  const allow = new Set((opts.allow || []).map((s) => String(s).toLowerCase()).filter(isNodeKey));
  const keepDays = opts.keepDays > 0 ? opts.keepDays : 400;
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // tower key → { v: voucher key or '', issuer: node key or '', at: ms admitted, last: ms last seen }
  const keys = new Map();
  const byVoucher = new Map();   // voucher key → tower key
  const refused = {};            // code → count since the start
  let listCache = { at: 0, list: [] };
  const capCache = new Map();    // issuer → { at, sats }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, r] of Object.entries((j && j.keys) || {})) {
      if (!isHex(k, 32) || !r) continue;
      const rec = { v: isHex(r.v, 32) ? r.v : '', issuer: isNodeKey(r.issuer) ? r.issuer : '', at: Number(r.at) || 0, last: Number(r.last) || Number(r.at) || 0 };
      if (!rec.v || !rec.issuer) { rec.v = ''; rec.issuer = ''; }
      keys.set(k, rec); if (rec.v) byVoucher.set(rec.v, k);
    }
  } catch (e) {}
  const save = () => {
    const out = {}; for (const [k, r] of keys) out[k] = r;
    const t = file + '.tmp-' + process.pid;
    fs.writeFileSync(t, JSON.stringify({ v: 1, keys: out }), { mode: 0o600 }); fs.renameSync(t, file);
  };
  const how = (rec) => (rec.issuer ? 'voucher' : 'open');
  const note = (code) => { refused[code] = (refused[code] || 0) + 1; return { ok: false, code }; };
  const issuerKeys = (issuer) => { let n = 0; for (const r of keys.values()) if (r.issuer === issuer) n++; return n; };
  const issuerNew = (issuer) => { const cut = now() - 86400000; let n = 0; for (const r of keys.values()) if (r.issuer === issuer && r.at > cut) n++; return n; };

  /// Keys the holder already has when this file first runs are kept as admitted (they came before vouchers).
  function seed(heldKeys) {
    let n = 0;
    for (const k of heldKeys || []) if (isHex(k, 32) && !keys.has(k)) { keys.set(k, { v: '', issuer: '', at: now(), last: now() }); n++; }
    if (n) { save(); log(`[TOWER] ${n} wallet key(s) held from before vouchers stay admitted`); }
    return n;
  }
  async function listedNow() {
    if (now() - listCache.at < 600000 && listCache.at) return listCache.list;
    try { const l = await listed(); if (Array.isArray(l)) listCache = { at: now(), list: l }; } catch (e) {}
    return listCache.list;
  }
  async function capacityOf(issuer) {
    const c = capCache.get(issuer);
    if (c && now() - c.at < 6 * 3600000) return c.sats;
    let sats = null; try { sats = await capacity(issuer); } catch (e) { sats = null; }
    if (sats !== null && Number.isFinite(Number(sats))) { sats = Number(sats); capCache.set(issuer, { at: now(), sats }); return sats; }
    return null;   // not kept: asked again next time
  }
  /// Every check of a voucher shown for `key`. The cheap ones first; LND is asked only for a voucher that could pass.
  async function check(key, v) {
    const bad = shapeOf(v); if (bad) return bad;
    const me = String(self() || '').toLowerCase();
    if (!isNodeKey(me)) return 'not_ready';   // this box does not know its own node key yet
    const other = byVoucher.get(v.key);
    if (other && other !== key) return 'voucher_used';   // one tower key per voucher here
    if (!schnorr.verify(v.use_sig, useDigest(me, key), v.key)) return 'use_signature';   // not made for this tower and this key
    const own = v.issuer === me;
    if (!own) {
      const l = await listedNow();
      const p = l.find((x) => x && String(x.pubkey || '').toLowerCase() === v.issuer);
      if (!p) return 'issuer_unknown';
      if (!(p.tower && p.tower.offered === true)) return 'issuer_no_tower';   // the same duty both ways
    }
    if (issuerKeys(v.issuer) >= issuerMaxKeys) return 'issuer_full';
    if (issuerNew(v.issuer) >= issuerNewPerDay) return 'issuer_rate';
    let signer = null; try { signer = await verifyNode(voucherText(v.key), v.issuer_sig); } catch (e) { return 'not_ready'; }
    if (String(signer || '').toLowerCase() !== v.issuer) return 'issuer_signature';
    if (!own && !allow.has(v.issuer) && minCapacitySats > 0) {
      const sats = await capacityOf(v.issuer);
      if (sats === null || sats < minCapacitySats) return 'issuer_unproven';
    }
    return null;
  }
  function touch(key, rec) {
    if (now() - rec.last > 86400000) { rec.last = now(); try { save(); } catch (e) {} }   // one write a day a key at most
  }
  /// May `key` use the tower? `voucher` is what the request carried (or nothing).
  /// → { ok: true, admitted: 'voucher' | 'open', issuer?, voucher_refused? } or { ok: false, code }.
  async function admit(key, voucher) {
    const rec = keys.get(key);
    if (rec && rec.issuer) { touch(key, rec); return { ok: true, admitted: 'voucher', issuer: rec.issuer }; }
    if (!voucher) {
      if (rec) { touch(key, rec); return { ok: true, admitted: 'open' }; }
      if (mode === 'voucher') return note('voucher_needed');
      return { ok: true, admitted: 'open' };   // written by noteHeld() once the holder has kept something for it
    }
    const code = await check(key, voucher);
    if (code) {
      refused[code] = (refused[code] || 0) + 1;
      // a key already in, or a tower that still takes keys without a voucher: the key is served, and is told why the
      // voucher was not taken, so a fault shows before the voucher is required
      if (rec) { touch(key, rec); return { ok: true, admitted: 'open', voucher_refused: code }; }
      if (mode === 'open') return { ok: true, admitted: 'open', voucher_refused: code };
      return { ok: false, code };
    }
    keys.set(key, { v: voucher.key, issuer: voucher.issuer, at: now(), last: now() }); byVoucher.set(voucher.key, key); save();
    log(`[TOWER] wallet key ${key.slice(0, 8)} admitted by a voucher of ${voucher.issuer.slice(0, 12)}…${rec ? ' (it was held without one)' : ''}`);
    return { ok: true, admitted: 'voucher', issuer: voucher.issuer };
  }
  /// A key taken without a voucher is written down only once the holder has kept something for it (a stranger's
  /// refused upload leaves no record).
  function noteHeld(key) {
    if (isHex(key, 32) && !keys.has(key)) { keys.set(key, { v: '', issuer: '', at: now(), last: now() }); try { save(); } catch (e) {} }
  }
  /// How a key stands, without changing anything: 'voucher', 'open' or null.
  const standing = (key) => { const r = keys.get(key); return r ? how(r) : null; };
  /// Keys silent for longer than the keeping time and with nothing held are forgotten (run with the holder's sweep).
  function forgetSilent() {
    const cut = now() - keepDays * 86400000; let n = 0;
    for (const [k, r] of Array.from(keys.entries())) if (r.last < cut && !held(k)) { keys.delete(k); if (r.v) byVoucher.delete(r.v); n++; }
    if (n) { save(); log(`[TOWER] ${n} admitted key(s) with nothing held, silent for more than ${keepDays} days, forgotten`); }
    return n;
  }
  /// For the Console: who vouched for how many keys (bytesOf(key) → bytes held, when given).
  function summary(bytesOf) {
    const by = new Map(); let withV = 0, without = 0;
    for (const [k, r] of keys) {
      if (!r.issuer) { without++; continue; }
      withV++;
      let e = by.get(r.issuer); if (!e) { e = { issuer: r.issuer, keys: 0, bytes: 0, new_24h: 0 }; by.set(r.issuer, e); }
      e.keys++; if (r.at > now() - 86400000) e.new_24h++; if (bytesOf) e.bytes += Number(bytesOf(k)) || 0;
    }
    return { mode, admitted: keys.size, by_voucher: withV, without_voucher: without, issuers: Array.from(by.values()).sort((a, b) => b.keys - a.keys),
      refused: Object.assign({}, refused), issuer_max_keys: issuerMaxKeys, issuer_new_per_day: issuerNewPerDay, min_capacity_sats: minCapacitySats, allow: allow.size };
  }
  return { admit, noteHeld, standing, seed, forgetSilent, summary, mode };
}

// ── the provider's side: one voucher a wallet ───────────────────────────────────────────────────────────────────────
/// opts: dataDir; sign(text) → this provider's node-key signature (LND signmessage) or ''; eligible(walletNodeKey) →
/// { ok, why } — has this wallet paid this provider a fee yet; log, now.
function createDesk(opts) {
  const dir = path.join(opts.dataDir, 'tower');
  const file = path.join(dir, 'vouchers.json');
  const sign = opts.sign, eligible = opts.eligible;
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  let recs = {};   // wallet node key → { v, sig, at }
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.wallets && typeof j.wallets === 'object') recs = j.wallets; } catch (e) {}
  const save = () => { const t = file + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify({ v: 1, wallets: recs }), { mode: 0o600 }); fs.renameSync(t, file); };
  /// → { ok: true, voucher_key, issuer_sig, again } or { ok: false, code, why? }
  async function issue(wallet, voucherKey) {
    if (!isNodeKey(wallet) || !isHex(voucherKey, 32)) return { ok: false, code: 'bad_request' };
    const r = recs[wallet];
    if (r) {
      if (r.v !== voucherKey) return { ok: false, code: 'already_issued', why: 'this wallet already has its voucher, for another voucher key' };
      return { ok: true, voucher_key: r.v, issuer_sig: r.sig, again: true };   // the same one, as often as asked
    }
    let e = { ok: false, why: 'the check could not be made' };
    try { e = await eligible(wallet); } catch (x) { return { ok: false, code: 'not_ready', why: String((x && x.message) || x).slice(0, 160) }; }
    if (!e || !e.ok) return { ok: false, code: 'not_yet', why: (e && e.why) || 'no fee from this wallet yet' };
    let sig = ''; try { sig = String(await sign(voucherText(voucherKey)) || ''); } catch (x) { sig = ''; }
    if (!sig) return { ok: false, code: 'not_ready', why: 'the node did not sign' };
    recs[wallet] = { v: voucherKey, sig, at: now() }; save();
    log(`[TOWER] voucher given to wallet ${wallet.slice(0, 16)}… (${e.why || 'it has paid a fee'})`);
    return { ok: true, voucher_key: voucherKey, issuer_sig: sig, again: false };
  }
  const summary = () => ({ given: Object.keys(recs).length, given_24h: Object.values(recs).filter((r) => r.at > now() - 86400000).length });
  return { issue, summary };
}

module.exports = { createAdmit, createDesk, voucherText, useText, useDigest, signUse, shapeOf, VOUCHER_DOMAIN, USE_DOMAIN };
