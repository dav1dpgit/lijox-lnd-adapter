'use strict';

/**
 * cooperative-chain-msg.js — v0.1.0
 *
 * JS port of the wallet's wire format from:
 *   lij-core/src/cooperative_chain_msg.rs
 *
 * MUST be byte-for-byte compatible with the Rust Writeable/Readable impls.
 * Validated against Rust-generated fixtures via cooperative-chain-msg.test.js.
 *
 * Wire conventions:
 *   - All multi-byte integers are big-endian (network order)
 *   - Every message body starts with a 1-byte protocol version (currently 2)
 *   - Txid / BlockHash: 32 raw bytes, internal byte order — NOT reversed for display
 *   - PublicKey: 33 bytes, compressed secp256k1 form
 *   - ScriptBuf: u16 length prefix, then raw bytes
 *   - Vec<u8> for raw_tx / raw_tx_bytes: u32 length prefix, then raw bytes
 *   - Vec<T> for txids/scripts/blockhashes lists: u16 count prefix, then T repeated
 *   - String: u16 length, then UTF-8 bytes
 *   - Option<T>: u8 tag (0=None, 1=Some), then T if Some
 *   - ChannelStateChange / BroadcastResult enums: 1 byte numeric tag
 *
 * All decode functions throw on:
 *   - Wrong protocol version
 *   - Short read (truncated buffer)
 *   - Invalid enum byte
 *   - Length exceeding 1MB sanity cap (raw tx bytes)
 *
 * Inputs/outputs use Node.js Buffer for byte fields. u64 values use BigInt
 * to avoid precision loss above 2^53.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 2;

const TYPE_SUBSCRIBE_CHAIN_DATA   = 32801;
const TYPE_CHAIN_DATA_BUNDLE      = 32803;
const TYPE_BLOCK_HEIGHT_UPDATE    = 32805;
const TYPE_FUNDING_TX_CONFIRMED   = 32807;
const TYPE_FEE_SCHEDULE_UPDATE    = 32809;
const TYPE_CHANNEL_STATE_UPDATE   = 32811;
const TYPE_REGISTER_WATCH_TX      = 32813;
const TYPE_REGISTER_WATCH_OUTPUT  = 32815;
const TYPE_BROADCAST_TX           = 32817;
const TYPE_BROADCAST_ACK          = 32819;

const MAX_RAW_TX_BYTES = 1_000_000;

// Channel state enum (mirrors Rust ChannelStateChange)
const CHANNEL_STATE = Object.freeze({
  Pending:                   0,
  Active:                    1,
  Inactive:                  2,
  CooperativeCloseInitiated: 3,
  ForceCloseInitiated:       4,
  ClosedOnChain:             5,
});
const CHANNEL_STATE_NAMES = Object.freeze({
  0: 'Pending',
  1: 'Active',
  2: 'Inactive',
  3: 'CooperativeCloseInitiated',
  4: 'ForceCloseInitiated',
  5: 'ClosedOnChain',
});

// Broadcast result enum (mirrors Rust BroadcastResult)
const BROADCAST_RESULT = Object.freeze({
  Relayed:     0,
  Rejected:    1,
  Unavailable: 2,
});
const BROADCAST_RESULT_NAMES = Object.freeze({
  0: 'Relayed',
  1: 'Rejected',
  2: 'Unavailable',
});

// ── Writer / Reader primitives ───────────────────────────────────────────────

/**
 * Append-only buffer builder. Push primitives, finish() returns concatenated Buffer.
 */
class Writer {
  constructor() {
    this.chunks = [];
  }
  u8(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xFF) throw new Error(`u8 out of range: ${v}`);
    const b = Buffer.alloc(1); b.writeUInt8(v, 0); this.chunks.push(b);
  }
  u16(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) throw new Error(`u16 out of range: ${v}`);
    const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); this.chunks.push(b);
  }
  u32(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) throw new Error(`u32 out of range: ${v}`);
    const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); this.chunks.push(b);
  }
  u64(v) {
    // Accept Number (within safe range) or BigInt
    let big;
    if (typeof v === 'bigint') {
      big = v;
    } else if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) throw new Error(`u64 invalid: ${v}`);
      big = BigInt(v);
    } else {
      throw new Error(`u64 must be Number or BigInt: ${typeof v}`);
    }
    if (big < 0n || big > 0xFFFFFFFFFFFFFFFFn) throw new Error(`u64 out of range: ${big}`);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(big, 0); this.chunks.push(b);
  }
  bytes(b) {
    if (!Buffer.isBuffer(b)) throw new Error(`bytes() requires Buffer, got ${typeof b}`);
    this.chunks.push(b);
  }
  finish() {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Bounds-checked sequential reader over a Buffer.
 */
class Reader {
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new Error(`Reader requires Buffer, got ${typeof buf}`);
    this.buf = buf;
    this.offset = 0;
  }
  _need(n) {
    if (this.offset + n > this.buf.length) {
      throw new Error(`short read: need ${n} bytes at offset ${this.offset}, buffer length ${this.buf.length}`);
    }
  }
  u8() {
    this._need(1);
    const v = this.buf.readUInt8(this.offset); this.offset += 1; return v;
  }
  u16() {
    this._need(2);
    const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v;
  }
  u32() {
    this._need(4);
    const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v;
  }
  u64() {
    this._need(8);
    const v = this.buf.readBigUInt64BE(this.offset); this.offset += 8; return v;
  }
  bytes(n) {
    this._need(n);
    // Use Buffer.from to copy out, so caller can't mutate the source
    const out = Buffer.from(this.buf.slice(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }
  remaining() { return this.buf.length - this.offset; }
}

// ── Field helpers ────────────────────────────────────────────────────────────

function writeVersion(w) { w.u8(PROTOCOL_VERSION); }
function readVersion(r) {
  const v = r.u8();
  if (v !== PROTOCOL_VERSION) {
    throw new Error(`unknown protocol version ${v} (expected ${PROTOCOL_VERSION})`);
  }
}

function writeBytesU16(w, b) {
  if (!Buffer.isBuffer(b)) throw new Error('expected Buffer');
  if (b.length > 0xFFFF) throw new Error(`bytes too long for u16 length: ${b.length}`);
  w.u16(b.length);
  w.bytes(b);
}
function readBytesU16(r) {
  const len = r.u16();
  return r.bytes(len);
}

function writeBytesU32(w, b, max = MAX_RAW_TX_BYTES) {
  if (!Buffer.isBuffer(b)) throw new Error('expected Buffer');
  if (b.length > max) throw new Error(`bytes exceeds max ${max}: ${b.length}`);
  w.u32(b.length);
  w.bytes(b);
}
function readBytesU32(r, max = MAX_RAW_TX_BYTES) {
  const len = r.u32();
  if (len > max) throw new Error(`length ${len} exceeds max ${max}`);
  return r.bytes(len);
}

function writeHash32(w, h) {
  if (!Buffer.isBuffer(h)) throw new Error('hash must be Buffer');
  if (h.length !== 32) throw new Error(`hash must be 32 bytes, got ${h.length}`);
  w.bytes(h);
}
function readHash32(r) { return r.bytes(32); }

function writePubkey(w, pk) {
  if (!Buffer.isBuffer(pk)) throw new Error('pubkey must be Buffer');
  if (pk.length !== 33) throw new Error(`pubkey must be 33 bytes (compressed), got ${pk.length}`);
  w.bytes(pk);
}
function readPubkey(r) { return r.bytes(33); }

// Option<T> helpers — caller provides the inner write/read fn
function writeOption(w, value, innerWrite) {
  if (value === null || value === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    innerWrite(w, value);
  }
}
function readOption(r, innerRead) {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag === 1) return innerRead(r);
  throw new Error(`invalid Option tag ${tag}`);
}

// ── Message 1: SubscribeChainData (wallet → LSP, type 32801) ─────────────────

function encodeSubscribeChainData(msg) {
  const w = new Writer();
  writeVersion(w);
  if (msg.watch_txids.length > 0xFFFF) throw new Error('too many watch_txids');
  w.u16(msg.watch_txids.length);
  for (const txid of msg.watch_txids) writeHash32(w, txid);
  if (msg.watch_scripts.length > 0xFFFF) throw new Error('too many watch_scripts');
  w.u16(msg.watch_scripts.length);
  for (const s of msg.watch_scripts) writeBytesU16(w, s);
  return w.finish();
}
function decodeSubscribeChainData(buf) {
  const r = new Reader(buf);
  readVersion(r);
  const nTxids = r.u16();
  const watch_txids = [];
  for (let i = 0; i < nTxids; i++) watch_txids.push(readHash32(r));
  const nScripts = r.u16();
  const watch_scripts = [];
  for (let i = 0; i < nScripts; i++) watch_scripts.push(readBytesU16(r));
  return { watch_txids, watch_scripts };
}

// ── Message 2: ChainDataBundle (LSP → wallet, type 32803) ────────────────────

function encodeChainDataBundle(msg) {
  const w = new Writer();
  writeVersion(w);
  w.u32(msg.tip_height);
  writeHash32(w, msg.tip_blockhash);
  if (msg.recent_blockhashes.length > 0xFFFF) throw new Error('too many recent_blockhashes');
  w.u16(msg.recent_blockhashes.length);
  for (const h of msg.recent_blockhashes) writeHash32(w, h);
  w.u32(msg.fee_sat_per_vb_fast);
  w.u32(msg.fee_sat_per_vb_medium);
  w.u32(msg.fee_sat_per_vb_slow);
  return w.finish();
}
function decodeChainDataBundle(buf) {
  const r = new Reader(buf);
  readVersion(r);
  const tip_height = r.u32();
  const tip_blockhash = readHash32(r);
  const nRecent = r.u16();
  const recent_blockhashes = [];
  for (let i = 0; i < nRecent; i++) recent_blockhashes.push(readHash32(r));
  const fee_sat_per_vb_fast = r.u32();
  const fee_sat_per_vb_medium = r.u32();
  const fee_sat_per_vb_slow = r.u32();
  return {
    tip_height, tip_blockhash, recent_blockhashes,
    fee_sat_per_vb_fast, fee_sat_per_vb_medium, fee_sat_per_vb_slow,
  };
}

// ── Message 3: BlockHeightUpdate (LSP → wallet, type 32805) ──────────────────

function encodeBlockHeightUpdate(msg) {
  const w = new Writer();
  writeVersion(w);
  w.u32(msg.new_height);
  writeHash32(w, msg.new_blockhash);
  return w.finish();
}
function decodeBlockHeightUpdate(buf) {
  const r = new Reader(buf);
  readVersion(r);
  return {
    new_height: r.u32(),
    new_blockhash: readHash32(r),
  };
}

// ── Message 4: FundingTxConfirmed (LSP → wallet, type 32807) ─────────────────

function encodeFundingTxConfirmed(msg) {
  const w = new Writer();
  writeVersion(w);
  writeHash32(w, msg.txid);
  w.u32(msg.confirmed_at_height);
  writeHash32(w, msg.blockhash_of_confirmation);
  w.u32(msg.confirmations);
  writeBytesU32(w, msg.raw_tx_bytes, MAX_RAW_TX_BYTES);
  // Step 3.6 (SCID fix): tx position in containing block. Backwards-compatible
  // wire extension — old decoders ignore trailing bytes, new decoders read this.
  w.u32(msg.tx_index || 0);
  return w.finish();
}
function decodeFundingTxConfirmed(buf) {
  const r = new Reader(buf);
  readVersion(r);
  const txid = readHash32(r);
  const confirmed_at_height = r.u32();
  const blockhash_of_confirmation = readHash32(r);
  const confirmations = r.u32();
  const raw_tx_bytes = readBytesU32(r, MAX_RAW_TX_BYTES);
  // Step 3.6 (SCID fix): tx_index appended at end. Old senders may not
  // include this field; default to 0 if no bytes remain.
  const tx_index = r.remaining() >= 4 ? r.u32() : 0;
  return {
    txid, confirmed_at_height, blockhash_of_confirmation,
    confirmations, raw_tx_bytes, tx_index,
  };
}

// ── Message 5: FeeScheduleUpdate (LSP → wallet, type 32809) ──────────────────

function encodeFeeScheduleUpdate(msg) {
  const w = new Writer();
  writeVersion(w);
  w.u32(msg.fee_sat_per_vb_fast);
  w.u32(msg.fee_sat_per_vb_medium);
  w.u32(msg.fee_sat_per_vb_slow);
  return w.finish();
}
function decodeFeeScheduleUpdate(buf) {
  const r = new Reader(buf);
  readVersion(r);
  return {
    fee_sat_per_vb_fast: r.u32(),
    fee_sat_per_vb_medium: r.u32(),
    fee_sat_per_vb_slow: r.u32(),
  };
}

// ── Message 6: ChannelStateUpdate (LSP → wallet, type 32811) ─────────────────

function encodeChannelStateUpdate(msg) {
  const w = new Writer();
  writeVersion(w);
  writePubkey(w, msg.counterparty_pubkey);
  writeHash32(w, msg.funding_txid);
  // state may be a numeric byte or a string name
  let stateByte;
  if (typeof msg.state === 'number') {
    stateByte = msg.state;
  } else if (typeof msg.state === 'string') {
    if (!(msg.state in CHANNEL_STATE)) throw new Error(`unknown ChannelStateChange: ${msg.state}`);
    stateByte = CHANNEL_STATE[msg.state];
  } else {
    throw new Error(`state must be number or string, got ${typeof msg.state}`);
  }
  w.u8(stateByte);
  writeOption(w, msg.observed_at_height, (w, h) => w.u32(h));
  return w.finish();
}
function decodeChannelStateUpdate(buf) {
  const r = new Reader(buf);
  readVersion(r);
  const counterparty_pubkey = readPubkey(r);
  const funding_txid = readHash32(r);
  const stateByte = r.u8();
  const stateName = CHANNEL_STATE_NAMES[stateByte];
  if (stateName === undefined) throw new Error(`unknown ChannelStateChange byte ${stateByte}`);
  const observed_at_height = readOption(r, (r) => r.u32());
  return { counterparty_pubkey, funding_txid, state: stateName, observed_at_height };
}

// ── Message 7: RegisterWatchTx (wallet → LSP, type 32813) ────────────────────

function encodeRegisterWatchTx(msg) {
  const w = new Writer();
  writeVersion(w);
  writeHash32(w, msg.txid);
  writeBytesU16(w, msg.script_pubkey);
  return w.finish();
}
function decodeRegisterWatchTx(buf) {
  const r = new Reader(buf);
  readVersion(r);
  return {
    txid: readHash32(r),
    script_pubkey: readBytesU16(r),
  };
}

// ── Message 8: RegisterWatchOutput (wallet → LSP, type 32815) ────────────────

function encodeRegisterWatchOutput(msg) {
  const w = new Writer();
  writeVersion(w);
  writeHash32(w, msg.funding_txid);
  w.u32(msg.output_index);
  writeBytesU16(w, msg.script_pubkey);
  writeOption(w, msg.created_in_block, (w, h) => writeHash32(w, h));
  return w.finish();
}
function decodeRegisterWatchOutput(buf) {
  const r = new Reader(buf);
  readVersion(r);
  return {
    funding_txid: readHash32(r),
    output_index: r.u32(),
    script_pubkey: readBytesU16(r),
    created_in_block: readOption(r, (r) => readHash32(r)),
  };
}

// ── Message 9: BroadcastTx (wallet → LSP, type 32817) ────────────────────────

function encodeBroadcastTx(msg) {
  const w = new Writer();
  writeVersion(w);
  w.u64(msg.request_id);
  writeBytesU32(w, msg.raw_tx, MAX_RAW_TX_BYTES);
  return w.finish();
}
function decodeBroadcastTx(buf) {
  const r = new Reader(buf);
  readVersion(r);
  return {
    request_id: r.u64(),  // returned as BigInt
    raw_tx: readBytesU32(r, MAX_RAW_TX_BYTES),
  };
}

// ── Message 10: BroadcastAck (LSP → wallet, type 32819) ──────────────────────

function encodeBroadcastAck(msg) {
  const w = new Writer();
  writeVersion(w);
  w.u64(msg.request_id);
  let resultByte;
  if (typeof msg.result === 'number') {
    resultByte = msg.result;
  } else if (typeof msg.result === 'string') {
    if (!(msg.result in BROADCAST_RESULT)) throw new Error(`unknown BroadcastResult: ${msg.result}`);
    resultByte = BROADCAST_RESULT[msg.result];
  } else {
    throw new Error(`result must be number or string, got ${typeof msg.result}`);
  }
  w.u8(resultByte);
  const detailBytes = Buffer.from(msg.detail || '', 'utf8');
  if (detailBytes.length > 0xFFFF) throw new Error(`detail too long: ${detailBytes.length}`);
  w.u16(detailBytes.length);
  w.bytes(detailBytes);
  return w.finish();
}
function decodeBroadcastAck(buf) {
  const r = new Reader(buf);
  readVersion(r);
  const request_id = r.u64();
  const resultByte = r.u8();
  const resultName = BROADCAST_RESULT_NAMES[resultByte];
  if (resultName === undefined) throw new Error(`unknown BroadcastResult byte ${resultByte}`);
  const detailLen = r.u16();
  const detailBytes = r.bytes(detailLen);
  const detail = detailBytes.toString('utf8');
  return { request_id, result: resultName, detail };
}

// ── Generic dispatcher ───────────────────────────────────────────────────────
// Used by the chain bridge to decode an arbitrary inbound LiJ message based
// on the type ID surfaced by LND's SubscribeCustomMessages stream.
// Returns null for any type ID outside our reserved range so callers can skip.

function decodeByType(typeId, buf) {
  switch (typeId) {
    case TYPE_SUBSCRIBE_CHAIN_DATA:
      return { name: 'SubscribeChainData',  msg: decodeSubscribeChainData(buf) };
    case TYPE_CHAIN_DATA_BUNDLE:
      return { name: 'ChainDataBundle',     msg: decodeChainDataBundle(buf) };
    case TYPE_BLOCK_HEIGHT_UPDATE:
      return { name: 'BlockHeightUpdate',   msg: decodeBlockHeightUpdate(buf) };
    case TYPE_FUNDING_TX_CONFIRMED:
      return { name: 'FundingTxConfirmed',  msg: decodeFundingTxConfirmed(buf) };
    case TYPE_FEE_SCHEDULE_UPDATE:
      return { name: 'FeeScheduleUpdate',   msg: decodeFeeScheduleUpdate(buf) };
    case TYPE_CHANNEL_STATE_UPDATE:
      return { name: 'ChannelStateUpdate',  msg: decodeChannelStateUpdate(buf) };
    case TYPE_REGISTER_WATCH_TX:
      return { name: 'RegisterWatchTx',     msg: decodeRegisterWatchTx(buf) };
    case TYPE_REGISTER_WATCH_OUTPUT:
      return { name: 'RegisterWatchOutput', msg: decodeRegisterWatchOutput(buf) };
    case TYPE_BROADCAST_TX:
      return { name: 'BroadcastTx',         msg: decodeBroadcastTx(buf) };
    case TYPE_BROADCAST_ACK:
      return { name: 'BroadcastAck',        msg: decodeBroadcastAck(buf) };
    default:
      return null;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  PROTOCOL_VERSION,
  TYPE_SUBSCRIBE_CHAIN_DATA,
  TYPE_CHAIN_DATA_BUNDLE,
  TYPE_BLOCK_HEIGHT_UPDATE,
  TYPE_FUNDING_TX_CONFIRMED,
  TYPE_FEE_SCHEDULE_UPDATE,
  TYPE_CHANNEL_STATE_UPDATE,
  TYPE_REGISTER_WATCH_TX,
  TYPE_REGISTER_WATCH_OUTPUT,
  TYPE_BROADCAST_TX,
  TYPE_BROADCAST_ACK,
  CHANNEL_STATE,
  CHANNEL_STATE_NAMES,
  BROADCAST_RESULT,
  BROADCAST_RESULT_NAMES,
  MAX_RAW_TX_BYTES,
  // Primitives (exported for testing / debugging)
  Writer,
  Reader,
  // Per-message encode / decode
  encodeSubscribeChainData,   decodeSubscribeChainData,
  encodeChainDataBundle,      decodeChainDataBundle,
  encodeBlockHeightUpdate,    decodeBlockHeightUpdate,
  encodeFundingTxConfirmed,   decodeFundingTxConfirmed,
  encodeFeeScheduleUpdate,    decodeFeeScheduleUpdate,
  encodeChannelStateUpdate,   decodeChannelStateUpdate,
  encodeRegisterWatchTx,      decodeRegisterWatchTx,
  encodeRegisterWatchOutput,  decodeRegisterWatchOutput,
  encodeBroadcastTx,          decodeBroadcastTx,
  encodeBroadcastAck,         decodeBroadcastAck,
  // Generic dispatcher
  decodeByType,
};
