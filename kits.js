// 0.79.0 (S48, DP GO 2026-09-22 — LIJOX BLACK START, BS1): the KIT HOLDER.
// Every LIJOX adapter keeps, for any wallet that asks, one sealed escape kit per NIP-06 identity —
// ciphertext the box cannot read, signed by the wallet, newest-wins. The standard is the wallet
// repo's docs/black-start-standard.md §3; the numbers and strings here are its lines.
//
//   POST /v1/kit   { pubkey (33-byte hex), seq (int), kit (envelope), sig (64-byte hex) }
//                  sig = ECDSA secp256k1 (compact r‖s, low-S) over SHA-256 of
//                        "lijox-kit-put-v1" ‖ pubkey ‖ seq_be8 ‖ SHA-256(canonical envelope)
//   GET  /v1/kit?npub=<hex>   → { ok, seq, at, pubkey, kit } or 404
//
// Verification uses Node's own crypto (the compressed public key wrapped as SPKI DER; the
// signature as IEEE P1363 r‖s) — no third-party signature code on the box. The canonical envelope
// is REBUILT from the parsed fields (seven fields, fixed order, no whitespace), never taken from
// the wire. A holder keeps the highest seq it has seen (409 STALE below it). Records live at
// DATA_DIR/kits/<npub>.json; the store is capped, evicting the oldest-touched record beyond the
// cap, never one touched in the last 90 days. Open read: the record is ciphertext.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUT_DOMAIN = Buffer.from('lijox-kit-put-v1', 'utf8');
const SPKI_PREFIX = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');   // secp256k1, compressed point follows
const MAX_BYTES_DEFAULT = 65536;
const MAX_RECORDS_DEFAULT = 20000;
const KEEP_MS = 90 * 24 * 3600 * 1000;

function canonicalEnvelope(k) {
  if (!k || typeof k !== 'object') return null;
  const v = k.v, alg = k.alg, kdf = k.kdf, npub = k.npub, seq = k.seq, nonce = k.nonce, ct = k.ct;
  if (v !== 1 || alg !== 'A256GCM' || typeof kdf !== 'string' || kdf.length > 80) return null;
  if (!/^[0-9a-f]{64}$/.test(npub || '')) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > 9007199254740991) return null;
  if (!/^[0-9a-f]{24}$/.test(nonce || '')) return null;
  if (!/^[0-9a-f]+$/.test(ct || '') || (ct.length % 2) !== 0 || ct.length < 32) return null;
  return '{"v":1,"alg":"A256GCM","kdf":"' + kdf + '","npub":"' + npub + '","seq":' + seq + ',"nonce":"' + nonce + '","ct":"' + ct + '"}';
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

function seqBe8(seq) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(seq)); return b; }

/** Verify a PUT body per the standard. Returns { ok, code, npub, canon } — never throws. */
function verifyPut(body, maxBytes) {
  try {
    if (!body || typeof body !== 'object') return { ok: false, code: 'BAD_JSON' };
    const pubkey = String(body.pubkey || '').toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) return { ok: false, code: 'BAD_PUBKEY' };
    const seq = body.seq;
    if (!Number.isInteger(seq) || seq < 0) return { ok: false, code: 'BAD_SEQ' };
    const canon = canonicalEnvelope(body.kit);
    if (!canon) return { ok: false, code: 'BAD_KIT' };
    if (canon.length > (maxBytes || MAX_BYTES_DEFAULT)) return { ok: false, code: 'TOO_LARGE' };
    if (body.kit.npub !== pubkey.slice(2)) return { ok: false, code: 'NPUB_MISMATCH' };
    if (body.kit.seq !== seq) return { ok: false, code: 'SEQ_MISMATCH' };
    const sig = String(body.sig || '').toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(sig)) return { ok: false, code: 'BAD_SIG' };
    const pre = Buffer.concat([PUT_DOMAIN, Buffer.from(pubkey, 'hex'), seqBe8(seq), sha256(Buffer.from(canon, 'utf8'))]);
    let key;
    try { key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubkey, 'hex')]), format: 'der', type: 'spki' }); }
    catch (e) { return { ok: false, code: 'BAD_PUBKEY' }; }
    const good = crypto.verify('sha256', pre, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'hex'));
    if (!good) return { ok: false, code: 'BAD_SIG' };
    return { ok: true, npub: pubkey.slice(2), pubkey, seq, canon };
  } catch (e) { return { ok: false, code: 'BAD_JSON' }; }
}

function createKitHolder(opts) {
  const dataDir = opts.dataDir;
  const dir = path.join(dataDir, 'kits');
  const maxBytes = opts.maxBytes || MAX_BYTES_DEFAULT;
  const maxRecords = opts.maxRecords || MAX_RECORDS_DEFAULT;
  const log = opts.log || function () {};
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const rate = new Map();   // ip → { n, resetAt }
  function limited(ip) {
    const now = Date.now(); let e = rate.get(ip);
    if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + 3600000 }; rate.set(ip, e); }
    e.n += 1; return e.n > 120;
  }
  function file(npub) { return path.join(dir, npub + '.json'); }
  function read(npub) {
    try { return JSON.parse(fs.readFileSync(file(npub), 'utf8')); } catch (e) { return null; }
  }
  function count() { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch (e) { return 0; } }
  function evictIfFull() {
    if (count() < maxRecords) return;
    let oldest = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let at = 0; try { at = Number(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).at) || 0; } catch (e) {}
      if (Date.now() - at < KEEP_MS) continue;   // touched in the last 90 days: never evicted
      if (!oldest || at < oldest.at) oldest = { f, at };
    }
    if (oldest) { try { fs.unlinkSync(path.join(dir, oldest.f)); log('[Kits] evicted ' + oldest.f + ' (store full)'); } catch (e) {} }
  }
  /** Returns { status, body } for a PUT; pure of HTTP. */
  function put(body, ip) {
    if (ip && limited(ip)) return { status: 429, body: { ok: false, code: 'RATE_LIMITED' } };
    const v = verifyPut(body, maxBytes);
    if (!v.ok) return { status: v.code === 'TOO_LARGE' ? 413 : 400, body: { ok: false, code: v.code } };
    const cur = read(v.npub);
    if (cur && Number(cur.seq) >= v.seq) return { status: 409, body: { ok: false, code: 'STALE', seq: Number(cur.seq) } };
    if (!cur) evictIfFull();
    const rec = { seq: v.seq, at: Date.now(), pubkey: v.pubkey, kit: JSON.parse(v.canon) };
    const tmp = file(v.npub) + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, file(v.npub)); }
    catch (e) { return { status: 500, body: { ok: false, code: 'WRITE_FAILED' } }; }
    log('[Kits] ' + v.npub.slice(0, 16) + '… seq ' + v.seq + ' (' + v.canon.length + ' B)' + (cur ? ' replaces ' + cur.seq : ' new'));
    return { status: 200, body: { ok: true, seq: v.seq } };
  }
  function get(npub) {
    npub = String(npub || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(npub)) return { status: 400, body: { ok: false, code: 'BAD_NPUB' } };
    const cur = read(npub);
    if (!cur) return { status: 404, body: { ok: false, code: 'NOT_FOUND' } };
    return { status: 200, body: { ok: true, seq: cur.seq, at: cur.at, pubkey: cur.pubkey, kit: cur.kit } };
  }
  /** The kit routes are open to EVERY wallet origin (the signature is the gate, there are no
   *  credentials): wildcard CORS, unlike the wallet-origin-scoped routes. 0.79.1. */
  function openCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  /** HTTP glue: returns true when the request was one of ours. */
  async function handle(req, res, pathname, method, ip, readBody, jsonResponse) {
    if (pathname !== '/v1/kit') return false;
    openCors(res);
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (method === 'GET') {
      const npub = new URL(req.url, 'http://lsp.local').searchParams.get('npub');
      const r = get(npub); jsonResponse(res, r.body, r.status); return true;
    }
    if (method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { jsonResponse(res, { ok: false, code: 'BAD_JSON' }, 400); return true; }
      const r = put(b, ip); jsonResponse(res, r.body, r.status); return true;
    }
    jsonResponse(res, { ok: false, code: 'METHOD' }, 405); return true;
  }
  return { put, get, handle, count, openCors, capability: { v: 1, max_bytes: maxBytes } };
}

module.exports = { createKitHolder, verifyPut, canonicalEnvelope, SPKI_PREFIX, PUT_DOMAIN };
