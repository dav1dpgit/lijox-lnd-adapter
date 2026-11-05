'use strict';
// btc-tx.js — 0.120.0 (S66 Mon 2026-11-02, DP 23:12 "Go on Phase 1" — Lightning pays on-chain, the design
// docs/design/onchain-pay/lightning-paying-onchain-v0.6.md in the wallet repo): the small transaction library the
// adapter needs for THE TAKE-BACK — the one transaction the adapter signs itself, because Bitcoin Core's signer knows
// only the standard script shapes and cannot satisfy the hand-over script (v0.6 §9.1). Nothing here talks to a node:
// bytes in, bytes out, every function pure, pinned by btc-tx.test.js against BIP-143's published vectors and our own.
//
//   THE HAND-OVER SCRIPT (v0.6 §6), P2WSH:
//     OP_SIZE <32> OP_EQUAL OP_IF OP_SHA256 <H> OP_EQUALVERIFY <W> OP_ELSE OP_DROP <T> OP_CHECKLOCKTIMEVERIFY OP_DROP <L> OP_ENDIF OP_CHECKSIG
//   the release (the wallet): witness [<sig W> <secret> <script>]; the take-back (this box): witness [<sig L> <> <script>],
//   lock time ≥ T, the input's sequence below final.
const crypto = require('crypto');
const secp = require('secp256k1');

const OP = { SIZE: 0x82, EQUAL: 0x87, IF: 0x63, SHA256: 0xa8, EQUALVERIFY: 0x88, ELSE: 0x67, DROP: 0x75, CLTV: 0xb1, ENDIF: 0x68, CHECKSIG: 0xac, DUP: 0x76, HASH160: 0xa9, EQUALVERIFY2: 0x88 };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const dsha256 = (b) => sha256(sha256(b));
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(String(s), 'hex');
const rev = (b) => Buffer.from(b).reverse();

function varint(n) {
  n = Number(n);
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function pushData(data) {
  const d = Buffer.from(data);
  if (d.length < 0x4c) return Buffer.concat([Buffer.from([d.length]), d]);
  if (d.length <= 0xff) return Buffer.concat([Buffer.from([0x4c, d.length]), d]);
  const b = Buffer.alloc(3); b[0] = 0x4d; b.writeUInt16LE(d.length, 1); return Buffer.concat([b, d]);
}
/** A script number, minimally encoded (little-endian, a sign byte added when the top bit is set), as a push. */
function scriptNum(n) {
  n = Number(n);
  if (n === 0) return Buffer.from([0x00]);   // OP_0
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);   // OP_1..OP_16
  const neg = n < 0; let v = Math.abs(n); const out = [];
  while (v > 0) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return pushData(Buffer.from(out));
}

/** The hand-over script's bytes. H: 32-byte hash (hex), W / L: 33-byte compressed keys (hex), T: block number. */
function handoverScript(H, W, L, T) {
  const h = unhex(H), w = unhex(W), l = unhex(L);
  if (h.length !== 32) throw new Error('H must be 32 bytes');
  if (w.length !== 33 || l.length !== 33) throw new Error('W and L must be 33-byte compressed keys');
  if (!(Number.isInteger(T) && T > 0 && T < 500000000)) throw new Error('T must be a block number');
  return Buffer.concat([
    Buffer.from([OP.SIZE]), scriptNum(32), Buffer.from([OP.EQUAL, OP.IF, OP.SHA256]), pushData(h), Buffer.from([OP.EQUALVERIFY]), pushData(w),
    Buffer.from([OP.ELSE, OP.DROP]), scriptNum(T), Buffer.from([OP.CLTV, OP.DROP]), pushData(l), Buffer.from([OP.ENDIF, OP.CHECKSIG]),
  ]);
}
/** The P2WSH output script of a witness script: OP_0 <sha256(script)>. */
function p2wshScriptPubKey(witnessScript) { return Buffer.concat([Buffer.from([0x00, 0x20]), sha256(witnessScript)]); }

// ── bech32 / bech32m (BIP-173 / BIP-350) — addresses in and out ──
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
  return chk >>> 0;
}
function hrpExpand(hrp) { const out = []; for (const c of hrp) out.push(c.charCodeAt(0) >>> 5); out.push(0); for (const c of hrp) out.push(c.charCodeAt(0) & 31); return out; }
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); } }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}
function bech32Encode(hrp, version, program) {
  const data = [version].concat(convertBits(Array.from(program), 8, 5, true));
  const konst = version === 0 ? 1 : 0x2bc830a3;
  const values = hrpExpand(hrp).concat(data);
  const mod = polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ konst;
  const chk = []; for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(chk).map((d) => CHARSET[d]).join('');
}
/** A segwit address → { hrp, version, program } or null. */
function bech32Decode(addr) {
  const s = String(addr || '');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const a = s.toLowerCase(); const pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length || a.length > 90) return null;
  const hrp = a.slice(0, pos); const data = [];
  for (const c of a.slice(pos + 1)) { const d = CHARSET.indexOf(c); if (d < 0) return null; data.push(d); }
  const mod = polymod(hrpExpand(hrp).concat(data));
  const version = data[0];
  if (!((version === 0 && mod === 1) || (version > 0 && mod === 0x2bc830a3))) return null;
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  return { hrp, version, program: Buffer.from(program) };
}
/** An address → its output script (segwit v0 / v1 bech32 forms; the ones the float wallet and the hand-over use). */
function addressToScript(addr, hrp = 'bc') {
  const d = bech32Decode(addr);
  if (!d || d.hrp !== hrp) throw new Error('not a ' + hrp + ' segwit address');
  return Buffer.concat([Buffer.from([d.version === 0 ? 0x00 : 0x50 + d.version, d.program.length]), d.program]);
}
function p2wshAddress(witnessScript, hrp = 'bc') { return bech32Encode(hrp, 0, sha256(witnessScript)); }

// ── transactions ──
/** tx = { version, locktime, inputs: [{ txid (hex, display order), vout, sequence, witness: [Buffer…] }], outputs: [{ value (sats), script (Buffer) }] } */
function serialize(tx, withWitness = true) {
  const parts = [u32(tx.version == null ? 2 : tx.version)];
  const hasW = withWitness && tx.inputs.some((i) => i.witness && i.witness.length);
  if (hasW) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(varint(tx.inputs.length));
  for (const i of tx.inputs) parts.push(rev(unhex(i.txid)), u32(i.vout), varint(0), u32(i.sequence == null ? 0xffffffff : i.sequence));
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), varint(o.script.length), o.script);
  if (hasW) for (const i of tx.inputs) { const w = i.witness || []; parts.push(varint(w.length)); for (const item of w) parts.push(varint(item.length), Buffer.from(item)); }
  parts.push(u32(tx.locktime || 0));
  return Buffer.concat(parts);
}
function txid(tx) { return hex(rev(dsha256(serialize(tx, false)))); }
/** The weight (BIP-141) and the virtual size, rounded up. */
function weight(tx) { const base = serialize(tx, false).length, total = serialize(tx, true).length; return base * 3 + total; }
function vsize(tx) { return Math.ceil(weight(tx) / 4); }

const SIGHASH_ALL = 0x01;
/** BIP-143 signature hash for input `index` of `tx`, spending `value` sats under `scriptCode` (the whole witness script when it has no OP_CODESEPARATOR). */
function sighashBip143(tx, index, scriptCode, value, type = SIGHASH_ALL) {
  const hashPrevouts = dsha256(Buffer.concat(tx.inputs.map((i) => Buffer.concat([rev(unhex(i.txid)), u32(i.vout)]))));
  const hashSequence = dsha256(Buffer.concat(tx.inputs.map((i) => u32(i.sequence == null ? 0xffffffff : i.sequence))));
  const hashOutputs = dsha256(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varint(o.script.length), o.script]))));
  const i = tx.inputs[index];
  const pre = Buffer.concat([
    u32(tx.version == null ? 2 : tx.version), hashPrevouts, hashSequence,
    rev(unhex(i.txid)), u32(i.vout), varint(scriptCode.length), scriptCode, u64(value), u32(i.sequence == null ? 0xffffffff : i.sequence),
    hashOutputs, u32(tx.locktime || 0), u32(type),
  ]);
  return dsha256(pre);
}
/** An ECDSA signature over a 32-byte hash, DER with the sighash byte appended (RFC 6979 — the same bytes every time). */
function signDer(hash32, privkey32, type = SIGHASH_ALL) {
  const { signature } = secp.ecdsaSign(hash32, privkey32);
  return Buffer.concat([Buffer.from(secp.signatureExport(signature)), Buffer.from([type])]);
}
function verifyDer(hash32, sigWithType, pubkey33) {
  try { const der = sigWithType.slice(0, -1); return secp.ecdsaVerify(secp.signatureImport(der), hash32, pubkey33); } catch (e) { return false; }
}
function pubkeyOf(privkey32) { return Buffer.from(secp.publicKeyCreate(privkey32, true)); }

/**
 * THE TAKE-BACK: spends the lock's output at the hand-over address back to `destScript` (a float wallet address's
 * script) after block T. { lockTxid, lockVout, lockValue (sats), script (the hand-over script), T, destScript, feeRateSatVb, privkey (L's) }
 * → { tx, hex, txid, fee, vsize }. The fee is the rate times the signed size, rounded up; the output below the dust
 * floor is refused (the caller raises the rate or waits).
 */
function buildTakeBack({ lockTxid, lockVout, lockValue, script, T, destScript, feeRateSatVb, privkey }) {
  // the input's sequence: below final, so the lock time counts (BIP-65), and BIP-125 replaceable, so a faster take-back may replace it
  const mk = (fee) => ({ version: 2, locktime: T, inputs: [{ txid: lockTxid, vout: lockVout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: lockValue - fee, script: destScript }] });
  // size it with a placeholder witness of the final shape, then sign for real
  const placeholder = [Buffer.alloc(72, 0x30), Buffer.alloc(0), script];
  let tx = mk(0); tx.inputs[0].witness = placeholder;
  const vb = vsize(tx);
  const fee = Math.ceil(vb * feeRateSatVb);
  if (lockValue - fee < 546) throw new Error('the take-back would leave less than dust (' + (lockValue - fee) + ' sats) at ' + feeRateSatVb + ' sat/vB');
  tx = mk(fee);
  const h = sighashBip143(tx, 0, script, lockValue, SIGHASH_ALL);
  const sig = signDer(h, privkey, SIGHASH_ALL);
  tx.inputs[0].witness = [sig, Buffer.alloc(0), script];
  return { tx, hex: hex(serialize(tx, true)), txid: txid(tx), fee, vsize: vsize(tx) };
}

/** Read a serialized transaction (hex) — enough to check a handed-over release: inputs' outpoints, outputs, the witness items. */
/** `allowWitness: false` (0.124.0) reads a transaction known to carry no witness — a PSBT's unsigned transaction (BIP-174
 *  stores it without witness data) — so a transaction with ZERO inputs and one output ("00 01") is not mistaken for the
 *  segwit marker. */
function parse(hexTx, { allowWitness = true } = {}) {
  const b = unhex(hexTx); let p = 0;
  const rd = (n) => { const s = b.slice(p, p + n); p += n; return s; };
  const rdVar = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  const version = rd(4).readUInt32LE(0);
  let segwit = false; if (allowWitness && b[p] === 0x00 && b[p + 1] === 0x01) { segwit = true; p += 2; }
  const nin = rdVar(); const inputs = [];
  for (let i = 0; i < nin; i++) { const t = hex(rev(rd(32))); const vout = rd(4).readUInt32LE(0); const sl = rdVar(); const scriptSig = rd(sl); const sequence = rd(4).readUInt32LE(0); inputs.push({ txid: t, vout, scriptSig, sequence, witness: [] }); }
  const nout = rdVar(); const outputs = [];
  for (let i = 0; i < nout; i++) { const value = Number(rd(8).readBigUInt64LE(0)); const sl = rdVar(); outputs.push({ value, script: rd(sl) }); }
  if (segwit) for (let i = 0; i < nin; i++) { const n = rdVar(); for (let k = 0; k < n; k++) { const l = rdVar(); inputs[i].witness.push(rd(l)); } }
  const locktime = rd(4).readUInt32LE(0);
  if (p !== b.length) throw new Error('trailing bytes');
  return { version, locktime, inputs, outputs };
}

module.exports = { handoverScript, p2wshScriptPubKey, p2wshAddress, addressToScript, bech32Encode, bech32Decode, serialize, txid, weight, vsize, sighashBip143, signDer, verifyDer, pubkeyOf, buildTakeBack, parse, scriptNum, pushData, varint, sha256, SIGHASH_ALL };
