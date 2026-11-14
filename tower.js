'use strict';
// tower.js — THE LIJOX TOWER'S HOLDER (S69 Fri 2026-11-13, DP "Agree with all" on the wallet repo's
// docs/design/watchtower/watchtower-r1.md and "Go on suggestions — a unique Tower Public Key" on watchtower-r2.md).
// NOT WIRED INTO lij-adapter.js YET AND NOT IN ANY RELEASE: this file and its checks only.
//
// A wallet's channel is with its provider. If that provider publishes an OLD STATE of the channel, the wallet may take
// the provider's whole side — but only inside the delay (one day). A wallet that is closed cannot. So the wallet hands
// a finished, signed PENALTY TRANSACTION for each replaced state to a provider that is NOT its own, encrypted so that
// only the appearance of that old state on the chain unlocks it. This file keeps those and finds them again.
//   · the bytes are The Eye of Satoshi's (rust-teos be344ec, teos-common): HINT = the first 16 bytes of the old
//     state's transaction id (in the id's own byte order — the reverse of how an id is written); KEY = SHA-256 of
//     the 32 id bytes; ChaCha20-Poly1305 with an all-zero nonce (each key is used once); the plain text is the
//     penalty transaction in Bitcoin's serialization. Its own test value is in tower.test.js;
//   · the holder can read nothing until the old state is published: a hint is half an id, and the key needs all of it;
//   · a wallet signs in with a KEY MADE FOR THIS TOWER ALONE (BIP-340, x-only) — never its node key: the holder knows
//     "a wallet", not which one (DP's ruling);
//   · `group` is 16 random bytes the wallet picks per channel, so one channel's items can be dropped at its close
//     without the holder learning the channel;
//   · several items may share a hint (the same penalty signed at two fee rates);
//   · limits: bytes per wallet, wallets in all, days kept after a wallet's last upload.
// No network and no LND in this file: the routes and the block watch (lij-adapter.js, to come) prove nothing here —
// this verifies the wallet's signature, keeps the bytes, matches a block's ids and opens what matches.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const schnorr = require('./schnorr.js');
const btc = require('./btc-tx.js');

const HINT_BYTES = 16;
const BLOB_MAX = 2048;          // one penalty transaction for one output is a few hundred bytes
const ITEMS_PER_PUT_MAX = 64;
const DOMAIN = 'lijox-tower-v1';
const SKEW_S = 600;

const isHex = (s, n) => typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
// an id as written (big-endian hex) → its own 32 bytes
const idBytes = (txidHex) => Buffer.from(txidHex, 'hex').reverse();
/// The hint for a transaction id as written.
function hintOf(txidHex) { if (!isHex(txidHex, 32)) throw new Error('bad txid'); return idBytes(txidHex).subarray(0, HINT_BYTES).toString('hex'); }
/// Encrypt a serialized transaction under the id of the transaction it answers (the wallet's side; here for the checks).
function encrypt(txBytes, txidHex) {
  const c = crypto.createCipheriv('chacha20-poly1305', sha256(idBytes(txidHex)), Buffer.alloc(12), { authTagLength: 16 });
  return Buffer.concat([c.update(txBytes), c.final(), c.getAuthTag()]);
}
/// Decrypt; null when the key does not fit (a hint is 16 bytes of 32 — a chance match of hints is not a match of ids).
function decrypt(blob, txidHex) {
  try {
    if (!Buffer.isBuffer(blob) || blob.length <= 16) return null;
    const d = crypto.createDecipheriv('chacha20-poly1305', sha256(idBytes(txidHex)), Buffer.alloc(12), { authTagLength: 16 });
    d.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([d.update(blob.subarray(0, blob.length - 16)), d.final()]);
  } catch (e) { return null; }
}
/// What the wallet's tower key signs (BIP-340 over the SHA-256 of this text).
function signedText(action, key, group, ts, itemsSha) {
  return DOMAIN + '|' + action + '|' + key + '|' + (group || '') + '|' + String(ts) + (action === 'put' ? '|' + itemsSha : '');
}
/// The fingerprint of a put's items: SHA-256 over hint ‖ SHA-256(blob) for each, in the order sent.
function itemsSha(items) {
  const h = crypto.createHash('sha256');
  for (const it of items) { h.update(Buffer.from(it.hint, 'hex')); h.update(sha256(it.blob)); }
  return h.digest('hex');
}
/// Check a request's shape, clock and signature. → { ok, code?, items? } — items come back with blobs as Buffers.
function verifyRequest(action, body, nowS) {
  const b = body || {};
  if (!['put', 'drop', 'status'].includes(action)) return { ok: false, code: 'bad_action' };
  if (!isHex(b.key, 32)) return { ok: false, code: 'bad_key' };
  if (action !== 'status' && !isHex(b.group, 16)) return { ok: false, code: 'bad_group' };
  if (!Number.isSafeInteger(b.ts) || Math.abs(nowS - b.ts) > SKEW_S) return { ok: false, code: 'bad_ts' };
  if (!isHex(b.signature, 64)) return { ok: false, code: 'bad_signature' };
  let items = null, sha = '';
  if (action === 'put') {
    if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > ITEMS_PER_PUT_MAX) return { ok: false, code: 'bad_items' };
    items = [];
    for (const it of b.items) {
      if (!it || !isHex(it.hint, HINT_BYTES) || typeof it.blob !== 'string') return { ok: false, code: 'bad_item' };
      const blob = Buffer.from(it.blob, 'base64');
      if (blob.length <= 16 || blob.length > BLOB_MAX || blob.toString('base64') !== it.blob) return { ok: false, code: 'bad_blob' };
      items.push({ hint: it.hint, blob });
    }
    sha = itemsSha(items);
  }
  const text = signedText(action, b.key, action === 'status' ? '' : b.group, b.ts, sha);
  if (!schnorr.verify(b.signature, sha256(Buffer.from(text, 'utf8')), b.key)) return { ok: false, code: 'signature' };
  return { ok: true, items };
}

function createTower(opts) {
  const dir = path.join(opts.dataDir, 'tower');
  const quota = opts.quotaBytes || 5 * 1024 * 1024;
  const keepDays = opts.keepDaysSilent || 400;
  const maxWallets = opts.maxWallets || 20000;
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // one file per wallet, one line per item: {"g":group,"h":hint,"b":blob base64,"t":ms}
  const fileOf = (key) => path.join(dir, key + '.ndjson');
  const wallets = new Map();   // key → { bytes, items, last }
  const index = new Map();     // hint → [{ key, group, blob (base64) }]
  function addIndex(key, group, hint, b64) {
    let a = index.get(hint); if (!a) { a = []; index.set(hint, a); }
    a.push({ key, group, blob: b64 });
  }
  function load() {
    let files = []; try { files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.ndjson$/.test(f)); } catch (e) {}
    for (const f of files) {
      const key = f.slice(0, 64); const w = { bytes: 0, items: 0, last: 0 };
      let text = ''; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch (e) { continue; }   // a line cut short by a stop is skipped
        if (!r || !isHex(r.g, 16) || !isHex(r.h, HINT_BYTES) || typeof r.b !== 'string') continue;
        w.bytes += Buffer.byteLength(r.b, 'base64'); w.items++; w.last = Math.max(w.last, Number(r.t) || 0);
        addIndex(key, r.g, r.h, r.b);
      }
      wallets.set(key, w);
    }
  }
  load();

  function put(key, group, items) {
    let w = wallets.get(key);
    if (!w) { if (wallets.size >= maxWallets) return { ok: false, code: 'full' }; w = { bytes: 0, items: 0, last: 0 }; }
    const fresh = []; let add = 0;
    for (const it of items) {
      const b64 = it.blob.toString('base64');
      const held = index.get(it.hint) || [];
      if (held.some((x) => x.key === key && x.blob === b64) || fresh.some((x) => x.h === it.hint && x.b === b64)) continue;   // sent twice: kept once
      fresh.push({ g: group, h: it.hint, b: b64, t: now() }); add += it.blob.length;
    }
    if (w.bytes + add > quota) return { ok: false, code: 'quota', quota_bytes: quota, held_bytes: w.bytes };
    if (fresh.length) {
      fs.appendFileSync(fileOf(key), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
      for (const r of fresh) addIndex(key, r.g, r.h, r.b);
      w.bytes += add; w.items += fresh.length;
    }
    w.last = now(); wallets.set(key, w);
    if (fresh.length) log(`[TOWER] kept ${fresh.length} item(s), ${add} bytes, for wallet key ${key.slice(0, 8)} (${w.items} held, ${w.bytes} of ${quota} bytes)`);
    return { ok: true, kept: fresh.length, items: w.items, bytes: w.bytes, quota_bytes: quota };
  }
  function removeWhere(key, pred, why) {
    const w = wallets.get(key); if (!w) return 0;
    let text = ''; try { text = fs.readFileSync(fileOf(key), 'utf8'); } catch (e) {}
    const keep = []; let gone = 0, bytes = 0, last = 0;
    for (const line of text.split('\n')) {
      if (!line) continue; let r; try { r = JSON.parse(line); } catch (e) { continue; }
      if (pred(r)) { gone++; const a = index.get(r.h); if (a) { const i = a.findIndex((x) => x.key === key && x.blob === r.b); if (i >= 0) a.splice(i, 1); if (!a.length) index.delete(r.h); } continue; }
      keep.push(line); bytes += Buffer.byteLength(r.b, 'base64'); last = Math.max(last, Number(r.t) || 0);
    }
    if (!gone) return 0;
    if (keep.length) { const t = fileOf(key) + '.tmp-' + process.pid; fs.writeFileSync(t, keep.join('\n') + '\n'); fs.renameSync(t, fileOf(key)); wallets.set(key, { bytes, items: keep.length, last: Math.max(last, w.last) }); }
    else { try { fs.unlinkSync(fileOf(key)); } catch (e) {} wallets.delete(key); }
    log(`[TOWER] dropped ${gone} item(s) for wallet key ${key.slice(0, 8)} (${why})`);
    return gone;
  }
  const drop = (key, group) => ({ ok: true, dropped: removeWhere(key, (r) => r.g === group, 'the wallet says that channel is closed') });
  function status(key) { const w = wallets.get(key) || { bytes: 0, items: 0, last: 0 }; return { ok: true, items: w.items, bytes: w.bytes, quota_bytes: quota, last_ms: w.last || null, keep_days_silent: keepDays }; }
  /// Wallets silent for longer than the declared time lose their items (run it now and then).
  function sweep() {
    const cut = now() - keepDays * 86400000; let n = 0;
    for (const [key, w] of Array.from(wallets.entries())) if (w.last && w.last < cut) n += removeWhere(key, () => true, `silent for more than ${keepDays} days`);
    return n;
  }
  /// A block's transaction ids (as written) → what is held under a hint of one of them. Nothing is decrypted here.
  function match(txids) {
    const out = [];
    for (const id of txids || []) {
      if (!isHex(id, 32)) continue;
      const a = index.get(hintOf(id));
      if (a && a.length) out.push({ txid: id, held: a.map((x) => ({ key: x.key, group: x.group, blob: Buffer.from(x.blob, 'base64') })) });
    }
    return out;
  }
  /// Open one held item against the full id. → { ok, tx_hex, penalty_txid, vsize } only when it decrypts, parses, and
  /// every input it spends is an output of that transaction — the holder never publishes anything else.
  function open(txid, blob) {
    const plain = decrypt(blob, txid);
    if (!plain) return { ok: false, code: 'key_does_not_fit' };
    let tx; try { tx = btc.parse(plain.toString('hex')); } catch (e) { return { ok: false, code: 'not_a_transaction' }; }
    if (!tx.inputs.length || !tx.outputs.length) return { ok: false, code: 'not_a_transaction' };
    if (!tx.inputs.every((i) => i.txid === txid)) return { ok: false, code: 'spends_something_else' };
    return { ok: true, tx_hex: plain.toString('hex'), penalty_txid: btc.txid(tx), vsize: btc.vsize(tx) };
  }
  const summary = () => ({ wallets: wallets.size, items: Array.from(wallets.values()).reduce((s, w) => s + w.items, 0), bytes: Array.from(wallets.values()).reduce((s, w) => s + w.bytes, 0), hints: index.size });
  const capability = { offered: true, quota_bytes: quota, keep_days_silent: keepDays, hint_bytes: HINT_BYTES, form: 'teos-v1' };
  return { put, drop, status, sweep, match, open, summary, capability };
}

module.exports = { createTower, verifyRequest, signedText, itemsSha, hintOf, encrypt, decrypt, HINT_BYTES, BLOB_MAX, ITEMS_PER_PUT_MAX, DOMAIN };
