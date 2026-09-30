// schnorr.js — 0.86.0 (S50, NWC, DP 2026-09-28 18:04: "the vendored file, locked in and not updated without approval").
// BIP-340 Schnorr signatures over secp256k1, written out in plain Node (BigInt arithmetic, node:crypto's
// sha256), no dependency. The relay needs VERIFY (every Nostr event carries one); SIGN is here for the
// tests and the test harness only (the adapter never signs a Nostr event). Gated by the BIP's own
// test-vectors.csv in schnorr.test.js — 19 rows: 4 signing cases, 15 verification cases incl. every
// must-fail (bad r, bad s, wrong parity, not on the curve, r ≥ p, s ≥ n).
//
// DO NOT EDIT without DP's word — a change here changes what the relay accepts.
'use strict';

const crypto = require('crypto');

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function modpow(b, e, m) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const inv = (a, m = P) => modpow(a, m - 2n, m);   // m prime

// Jacobian point arithmetic (no inversion until the end). null = the point at infinity.
function jDouble(p) {
  if (!p) return null;
  const { x, y, z } = p;
  if (y === 0n) return null;
  const ysq = mod(y * y);
  const s = mod(4n * x * ysq);
  const m = mod(3n * x * x);            // a = 0
  const nx = mod(m * m - 2n * s);
  const ny = mod(m * (s - nx) - 8n * ysq * ysq);
  const nz = mod(2n * y * z);
  return { x: nx, y: ny, z: nz };
}
function jAdd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const z1z1 = mod(p.z * p.z), z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2), u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * q.z * z2z2), s2 = mod(q.y * p.z * z1z1);
  if (u1 === u2) {
    if (s1 !== s2) return null;
    return jDouble(p);
  }
  const h = mod(u2 - u1), r = mod(s2 - s1);
  const h2 = mod(h * h), h3 = mod(h2 * h);
  const u1h2 = mod(u1 * h2);
  const nx = mod(r * r - h3 - 2n * u1h2);
  const ny = mod(r * (u1h2 - nx) - s1 * h3);
  const nz = mod(h * p.z * q.z);
  return { x: nx, y: ny, z: nz };
}
function jMul(p, k) {
  let r = null, a = p;
  k = mod(k, N);
  while (k > 0n) { if (k & 1n) r = jAdd(r, a); a = jDouble(a); k >>= 1n; }
  return r;
}
function toAffine(p) {
  if (!p) return null;
  const zi = inv(p.z), zi2 = mod(zi * zi), zi3 = mod(zi2 * zi);
  return { x: mod(p.x * zi2), y: mod(p.y * zi3) };
}
const G = { x: GX, y: GY, z: 1n };

const bytesToInt = (b) => BigInt('0x' + (b.length ? Buffer.from(b).toString('hex') : '0'));
const intTo32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
function taggedHash(tag, ...parts) {
  const th = sha256(Buffer.from(tag, 'utf8'));
  return sha256(th, th, ...parts);
}

/// lift_x: the point with x-coordinate `x` and even y, or null when x is not on the curve / ≥ p.
function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = modpow(c, (P + 1n) / 4n, P);
  if (mod(y * y) !== c) return null;
  return { x, y: (y & 1n) === 0n ? y : P - y, z: 1n };
}

/// Verify a 64-byte signature over a message (any length; Nostr signs the 32-byte id) for a 32-byte x-only public key (hex or Buffers).
function verify(sig, msg, pub) {
  try {
    const s = Buffer.isBuffer(sig) ? sig : Buffer.from(String(sig), 'hex');
    const m = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg), 'hex');
    const pk = Buffer.isBuffer(pub) ? pub : Buffer.from(String(pub), 'hex');
    if (s.length !== 64 || pk.length !== 32) return false;   // the message may be any length (BIP-340, 2022-12); Nostr's is the 32-byte id
    const Pt = liftX(bytesToInt(pk));
    if (!Pt) return false;
    const r = bytesToInt(s.subarray(0, 32));
    const sc = bytesToInt(s.subarray(32, 64));
    if (r >= P || sc >= N) return false;
    const e = mod(bytesToInt(taggedHash('BIP0340/challenge', s.subarray(0, 32), pk, m)), N);
    // R = s·G − e·P  (−e·P = (n − e)·P)
    const R = toAffine(jAdd(jMul(G, sc), jMul(Pt, N - e)));
    if (!R) return false;
    if ((R.y & 1n) !== 0n) return false;
    return R.x === r;
  } catch (_) { return false; }
}

/// The x-only public key (32 bytes) for a 32-byte secret key.
function pubkey(sk) {
  const d = bytesToInt(Buffer.isBuffer(sk) ? sk : Buffer.from(String(sk), 'hex'));
  if (d === 0n || d >= N) throw new Error('secret key out of range');
  const Pt = toAffine(jMul(G, d));
  return intTo32(Pt.x);
}

/// Sign (tests and harness only): BIP-340 with the given 32-byte aux.
function sign(sk, msg, aux) {
  const m = Buffer.isBuffer(msg) ? msg : Buffer.from(String(msg), 'hex');
  const a = Buffer.isBuffer(aux) ? aux : Buffer.from(String(aux), 'hex');
  if (a.length !== 32) throw new Error('aux must be 32 bytes');
  let d = bytesToInt(Buffer.isBuffer(sk) ? sk : Buffer.from(String(sk), 'hex'));
  if (d === 0n || d >= N) throw new Error('secret key out of range');
  const Pt = toAffine(jMul(G, d));
  if ((Pt.y & 1n) !== 0n) d = N - d;
  const pkb = intTo32(Pt.x);
  const t = intTo32(d ^ bytesToInt(taggedHash('BIP0340/aux', a)));
  let k = mod(bytesToInt(taggedHash('BIP0340/nonce', t, pkb, m)), N);
  if (k === 0n) throw new Error('nonce is zero');
  const R = toAffine(jMul(G, k));
  if ((R.y & 1n) !== 0n) k = N - k;
  const rb = intTo32(R.x);
  const e = mod(bytesToInt(taggedHash('BIP0340/challenge', rb, pkb, m)), N);
  const sb = intTo32(mod(k + e * d, N));
  const out = Buffer.concat([rb, sb]);
  if (!verify(out, m, pkb)) throw new Error('signing produced an invalid signature');
  return out;
}

module.exports = { verify, sign, pubkey, taggedHash, sha256, liftX, N, P };
