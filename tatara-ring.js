// tatara-ring.js — 0.101.0 (S58 — LIJOX's Tatara step 5a, door 1): THE RING-SIGNED SEAT REQUEST, CHECKED BY THE PROVIDER.
// Spec v0.10 §4.1; joinstr v2's LSAG with LiJ's tag (patch P10, lij/patches/joinstr-v2/src/ring.rs — reviewed S58).
//
// A wallet with Mix on registers a Tatara key with its provider, certified by its node key. The provider publishes, per
// ISO week, ONE ring — the sorted Tatara keys of its Mix-on wallets — and its hash in the signed registry record. A seat
// request is signed with the TAGGED linkable ring signature over that ring: the provider learns "one of my Mix-on
// wallets", never which; the key image allows one seat per size per wallet per week (images under two weeks' tags do
// not link). This file is the VERIFIER only — the adapter never signs a ring signature.
//
// The equations are ring.rs's, line for line (verify_with): for i in ring order, with c = c0,
//   L_i = s_i·G + c·P_i,  R_i = s_i·Hp_t(P_i) + c·I,  c = H_ring(rh_t, I, m, L_i, R_i) mod n   (either point at infinity
// = invalid); valid when the last c equals c0. Hp_t(P) = lift_x(H("joinstr/v2/lij/hash_to_point_tagged", P ‖ len(t) ‖ t
// ‖ i)) for the first i that lifts; rh_t = H("joinstr/v2/lij/ring_hash_tagged", sha256(P_1 ‖ … ‖ P_n) ‖ len(t) ‖ t);
// H_ring = H("joinstr/v2/ring", …); H = BIP-340's tagged hash; lengths and counters u32 little-endian; points 33-byte
// compressed; the ring sorted by bytes, no key twice (P7); every scalar 32 bytes of lowercase hex below n (zero allowed,
// as ring.rs's MaybeScalar), the image a compressed point (P8).
//
// Point arithmetic: the secp256k1 package already in the adapter's dependencies (libsecp256k1's binding, or its own
// elliptic fallback). A zero scalar or an infinite sum is handled here explicitly, as ring.rs's MaybeScalar/MaybePoint.
// Vectors: tatara-ring.vectors.json, made by ring.rs itself (S58), and P10's known answers (lij_tests p10_known_answers).
'use strict';

const crypto = require('crypto');
const secp = require('secp256k1');

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const tagged = (tag, ...parts) => { const t = sha256(Buffer.from(tag, 'utf8')); return sha256(t, t, ...parts); };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const toInt = (b) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const to32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }

/// lift_x (BIP-340): the point with x-coordinate `x` and even y, compressed; null when x ≥ p or off the curve.
function liftX(x32) {
  const x = toInt(x32);
  if (x >= P) return null;
  const c = (modpow(x, 3n, P) + 7n) % P;
  const y = modpow(c, (P + 1n) / 4n, P);
  if ((y * y) % P !== c) return null;
  return Buffer.concat([Buffer.from([0x02]), to32(x)]);
}

// points: Buffer (33, compressed) or null (infinity); scalars: BigInt in [0, n)
const mulG = (s) => (s === 0n ? null : Buffer.from(secp.publicKeyCreate(to32(s), true)));
const mul = (pt, s) => (s === 0n || pt === null ? null : Buffer.from(secp.publicKeyTweakMul(pt, to32(s), true)));
function add(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  try { return Buffer.from(secp.publicKeyCombine([a, b], true)); } catch (_) { return null; }   // the sum is the point at infinity
}

function hashToPointTagged(pt, tag) {
  const len = le32(tag.length);
  for (let i = 0; i < 0xffffffff; i++) {
    const p = liftX(tagged('joinstr/v2/lij/hash_to_point_tagged', pt, len, tag, le32(i)));
    if (p) return p;
  }
  throw new Error('unreachable');
}
const ringHashTagged = (keys, tag) => tagged('joinstr/v2/lij/ring_hash_tagged', sha256(...keys), le32(tag.length), tag);
const challenge = (rh, image, m, l, r) => toInt(tagged('joinstr/v2/ring', rh, image, m, l, r)) % N;

function strictHex(s, bytes) { if (typeof s !== 'string' || s.length !== 2 * bytes || !/^[0-9a-f]+$/.test(s)) throw new Error(`expected ${bytes} bytes of lowercase hex`); return Buffer.from(s, 'hex'); }
function pointFromHex(s) {
  const b = strictHex(s, 33);
  if (b[0] !== 0x02 && b[0] !== 0x03) throw new Error('bad point: not compressed');
  if (!secp.publicKeyVerify(b)) throw new Error('bad point: not on the curve');
  return b;
}
function scalarFromHex(s) { const v = toInt(strictHex(s, 32)); if (v >= N) throw new Error('scalar not below the group order'); return v; }

/// A ring for one tag: its keys checked (non-empty, compressed points on the curve, sorted by bytes, none twice — P7),
/// Hp_t of every member and the tagged ring hash computed once.
function makeRing(keysHex, tag) {
  if (!Array.isArray(keysHex) || !keysHex.length) throw new Error('empty ring');
  const t = Buffer.from(tag, 'utf8');
  const keys = keysHex.map(pointFromHex);
  for (let i = 1; i < keys.length; i++) if (Buffer.compare(keys[i - 1], keys[i]) >= 0) throw new Error('ring not sorted, or a key twice');
  const rh = ringHashTagged(keys, t);
  return { keys, hps: keys.map((k) => hashToPointTagged(k, t)), rh, tag, hash: rh.toString('hex') };
}

/// Verify a tagged ring signature over the 32-byte message `m`; answers the key image (hex) or throws.
function verify(ring, m, sig) {
  if (!Buffer.isBuffer(m) || m.length !== 32) throw new Error('the message is 32 bytes');
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) throw new Error('not a ring signature');
  const own = Object.keys(sig);   // P8: deny unknown fields — exactly these three, each its own property (review S58 #6)
  if (own.length !== 3 || !['c0', 'key_image', 's'].every((k) => Object.prototype.hasOwnProperty.call(sig, k))) throw new Error('unknown or missing fields');
  if (!Array.isArray(sig.s) || sig.s.length !== ring.keys.length) throw new Error('ring size mismatch');
  const image = pointFromHex(sig.key_image);
  const c0 = scalarFromHex(sig.c0);
  const s = sig.s.map(scalarFromHex);
  let c = c0;
  for (let i = 0; i < ring.keys.length; i++) {
    const l = add(mulG(s[i]), mul(ring.keys[i], c));
    const r = add(mul(ring.hps[i], s[i]), mul(image, c));
    if (l === null || r === null) throw new Error('point at infinity');
    c = challenge(ring.rh, image, m, l, r);
  }
  if (c !== c0) throw new Error('ring signature does not verify');
  return image.toString('hex');
}

/// The seat tag for a moment: "lij/tatara/seat/v1/<ISO year>-W<week>" (UTC; two-digit week) — computed by phone and
/// provider from the clock, never sent, never served (v0.10 §4.1).
function isoWeek(ms) {
  if (!Number.isFinite(ms) || ms < 1e12) throw new Error('isoWeek wants a time in milliseconds');   // review S58 #5: never "NaN-WNaN", never seconds
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;                                   // Monday 0 … Sunday 6
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const y = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(y, 0, 1)) / (7 * 86400000));
  return { year: y, week, label: `${y}-W${String(week).padStart(2, '0')}` };
}
const seatTag = (ms) => 'lij/tatara/seat/v1/' + isoWeek(ms).label;

/// Which secp256k1 backend loaded (the native binding or the elliptic fallback — ~25× slower; review S58 #3).
function backend() { try { require.resolve('secp256k1/bindings'); require('secp256k1/bindings'); return 'native libsecp256k1'; } catch (_) { return 'elliptic (JavaScript fallback)'; } }

module.exports = { makeRing, verify, isoWeek, seatTag, hashToPointTagged, liftX, backend, N };
