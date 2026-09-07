/**
 * LIJ LSP Channel Registry — Phase 1b
 * ===================================
 *
 * HTTP endpoints for signed-challenge channel-record write/read by wallets.
 * Refactored from the express-style v1 to fit lij-adapter's raw
 * http.createServer dispatcher pattern.
 *
 * AUTH MODEL: signed-challenge, NOT x-adapter-secret.
 *   1. Wallet GETs /lsps/registry/challenge → receives single-use 32-byte
 *      nonce with 5min TTL.
 *   2. Wallet signs sha256(domain || action || nonce || pubkey [|| record_id])
 *      using secp256k1 + its own channel-counterparty private key.
 *   3. Wallet POSTs or GETs with { node_pubkey, nonce, signature, ... }.
 *   4. Registry verifies signature → consumes nonce → executes action.
 *
 * Auth is intrinsic to the request; no x-adapter-secret required. These
 * routes are registered as a PUBLIC route block in lij-adapter.js, ahead
 * of the authOk gate.
 *
 * ROBUST WRITE CONFIRMATION:
 *   - Validate schema → 400 with structured error code on any failure
 *   - Verify signature → 401 with structured error code on failure
 *   - Consume nonce atomically (single-use, TTL-checked) → 401 if invalid
 *   - Canonicalize record (lowercase hex)
 *   - Read existing record for `replaced` detection
 *   - Store the new record
 *   - READ BACK from store, compare against canonicalized intent
 *   - If read-back missing or mismatched → 500 storage_failure
 *   - Reply with { ok, record: <readback>, stored_at, replaced, previous? }
 *
 * Wallet can use the echoed record to verify the LSP stored what was sent.
 * GET retrieval is the second integrity check across the storage boundary.
 *
 * STORAGE: pluggable via the channelStore interface:
 *   getChannels(pubkeyHex)          -> Promise<Array<record>>
 *   getChannel(pubkeyHex, chanId)   -> Promise<record | null>
 *   putChannel(pubkeyHex, record)   -> Promise<record>   // returns stored
 *
 * MemoryChannelStore is provided as the reference impl.
 */

'use strict';

const crypto = require('crypto');
const secp256k1 = require('secp256k1');

// --- Constants -------------------------------------------------------------

const DOMAIN_SEPARATOR_STR = 'lij-registry-v1';
const DOMAIN_SEPARATOR = Buffer.from(DOMAIN_SEPARATOR_STR, 'utf-8');
const NONCE_TTL_MS = 5 * 60 * 1000;
const NONCE_LENGTH = 32;
const PUBKEY_LENGTH = 33;
const SIGNATURE_LENGTH = 64;

const ACTION_POST_CHANNEL = 'post-channel';
const ACTION_GET_CHANNELS = 'get-channels';

// --- NonceStore -- single-use TTL-gated nonces -----------------------------

class NonceStore {
  constructor() {
    this.nonces = new Map(); // hexNonce -> { issued_at_ms, used: bool }
  }

  issue() {
    const buf = crypto.randomBytes(NONCE_LENGTH);
    const hex = buf.toString('hex');
    this.nonces.set(hex, { issued_at_ms: Date.now(), used: false });
    this._gc();
    return { nonce: hex, expires_at: Date.now() + NONCE_TTL_MS };
  }

  /**
   * Atomically check and consume a nonce.
   * @returns {{ok:true} | {ok:false, code:string}}
   */
  consume(hex) {
    const entry = this.nonces.get(hex);
    if (!entry) return { ok: false, code: 'nonce_unknown' };
    if (entry.used) return { ok: false, code: 'nonce_already_used' };
    if (Date.now() - entry.issued_at_ms > NONCE_TTL_MS) {
      this.nonces.delete(hex);
      return { ok: false, code: 'nonce_expired' };
    }
    entry.used = true;
    return { ok: true };
  }

  _gc() {
    const now = Date.now();
    for (const [hex, entry] of this.nonces) {
      if (now - entry.issued_at_ms > NONCE_TTL_MS) this.nonces.delete(hex);
    }
  }

  size() { return this.nonces.size; }
}

// --- Signature verification ------------------------------------------------

/**
 * Build the canonical signed-message digest for a given action.
 *   sha256(domain_separator || action || nonce_bytes || pubkey_bytes [|| record_id_bytes])
 */
function buildSignedMessage(action, nonceHex, pubkeyHex, recordId = '') {
  const h = crypto.createHash('sha256');
  h.update(DOMAIN_SEPARATOR);
  h.update(Buffer.from(action, 'utf-8'));
  h.update(Buffer.from(nonceHex, 'hex'));
  h.update(Buffer.from(pubkeyHex, 'hex'));
  if (recordId) h.update(Buffer.from(recordId, 'utf-8'));
  return h.digest();
}

/**
 * @returns {{ok:true} | {ok:false, code:string}}
 */
function verifySignature(message, signatureHex, pubkeyHex) {
  if (!isHex(signatureHex, SIGNATURE_LENGTH)) {
    return { ok: false, code: 'signature_bad_format' };
  }
  if (!isHex(pubkeyHex, PUBKEY_LENGTH)) {
    return { ok: false, code: 'pubkey_bad_format' };
  }
  let sigBuf, pkBuf;
  try {
    sigBuf = Buffer.from(signatureHex, 'hex');
    pkBuf = Buffer.from(pubkeyHex, 'hex');
  } catch (e) {
    return { ok: false, code: 'signature_decode_failed' };
  }
  try {
    const ok = secp256k1.ecdsaVerify(sigBuf, message, pkBuf);
    if (!ok) return { ok: false, code: 'signature_invalid' };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'signature_verify_threw' };
  }
}

// --- Validation ------------------------------------------------------------

function isHex(s, byteLen) {
  if (typeof s !== 'string') return false;
  if (s.length !== byteLen * 2) return false;
  return /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Validate the channel-record schema.
 * @returns {{ok:true} | {ok:false, code:string, field?:string, reason?:string}}
 */
function validateChannelRecord(rec) {
  if (!rec || typeof rec !== 'object') {
    return { ok: false, code: 'record_not_object' };
  }
  if (!isHex(rec.channel_id, 32)) {
    return { ok: false, code: 'field_bad', field: 'channel_id', reason: 'expect 64 hex chars' };
  }
  if (!isHex(rec.funding_txid, 32)) {
    return { ok: false, code: 'field_bad', field: 'funding_txid', reason: 'expect 64 hex chars' };
  }
  if (!Number.isInteger(rec.funding_vout) || rec.funding_vout < 0 || rec.funding_vout > 0xffff) {
    return { ok: false, code: 'field_bad', field: 'funding_vout', reason: 'expect 0..65535' };
  }
  if (!Number.isInteger(rec.channel_value_sat) || rec.channel_value_sat <= 0) {
    return { ok: false, code: 'field_bad', field: 'channel_value_sat', reason: 'expect positive integer sats' };
  }
  if (rec.commit_type !== 'STATIC_REMOTE_KEY' && rec.commit_type !== 'ANCHORS') {
    return { ok: false, code: 'field_bad', field: 'commit_type', reason: 'expect "STATIC_REMOTE_KEY" or "ANCHORS"' };
  }
  if (!isHex(rec.channel_keys_id_hex, 32)) {
    return { ok: false, code: 'field_bad', field: 'channel_keys_id_hex', reason: 'expect 64 hex chars' };
  }
  // Optional close fields
  if (rec.close_height !== undefined && rec.close_height !== null) {
    if (!Number.isInteger(rec.close_height) || rec.close_height < 0) {
      return { ok: false, code: 'field_bad', field: 'close_height', reason: 'expect non-negative integer or null' };
    }
  }
  if (rec.closing_txid !== undefined && rec.closing_txid !== null) {
    if (!isHex(rec.closing_txid, 32)) {
      return { ok: false, code: 'field_bad', field: 'closing_txid', reason: 'expect 64 hex chars or null' };
    }
  }
  return { ok: true };
}

/**
 * Canonicalize a record for storage: lowercase hex fields, drop extras.
 */
function canonicalizeRecord(rec) {
  const out = {
    channel_id:          rec.channel_id.toLowerCase(),
    funding_txid:        rec.funding_txid.toLowerCase(),
    funding_vout:        rec.funding_vout,
    channel_value_sat:   rec.channel_value_sat,
    commit_type:         rec.commit_type,
    channel_keys_id_hex: rec.channel_keys_id_hex.toLowerCase(),
  };
  if (rec.close_height !== undefined && rec.close_height !== null) {
    out.close_height = rec.close_height;
  }
  if (rec.closing_txid !== undefined && rec.closing_txid !== null) {
    out.closing_txid = rec.closing_txid.toLowerCase();
  }
  return out;
}

/**
 * Byte-exact comparison of two canonicalized records via JSON.
 */
function recordsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- MemoryChannelStore -- reference storage impl --------------------------

class MemoryChannelStore {
  constructor() {
    // pubkeyHex(lowercase) -> Map(channelId(lowercase) -> record)
    this.byPubkey = new Map();
  }

  async getChannels(pubkeyHex) {
    const inner = this.byPubkey.get(pubkeyHex.toLowerCase());
    if (!inner) return [];
    return Array.from(inner.values());
  }

  async getChannel(pubkeyHex, channelId) {
    const inner = this.byPubkey.get(pubkeyHex.toLowerCase());
    if (!inner) return null;
    return inner.get(channelId.toLowerCase()) || null;
  }

  async putChannel(pubkeyHex, record) {
    const pkLower = pubkeyHex.toLowerCase();
    let inner = this.byPubkey.get(pkLower);
    if (!inner) {
      inner = new Map();
      this.byPubkey.set(pkLower, inner);
    }
    inner.set(record.channel_id, record);
    return record;
  }

  size() {
    let total = 0;
    for (const inner of this.byPubkey.values()) total += inner.size;
    return total;
  }

  pubkeyCount() {
    return this.byPubkey.size;
  }

  /** v0.18.5: enumerate all records grouped by pubkey for admin dumps.
   * Returns plain object { pubkeyHex: [record, ...] }.
   */
  async getAll() {
    const result = {};
    for (const [pubkey, inner] of this.byPubkey) {
      result[pubkey] = Array.from(inner.values());
    }
    return result;
  }
}

// --- SqliteChannelStore -- persistent storage impl (v0.18.5) ---------------
//
// Drop-in replacement for MemoryChannelStore that survives adapter restarts.
// Uses better-sqlite3 (synchronous Node binding; methods are still declared
// async for interface parity, the promises resolve immediately).
//
// Schema: one table with (pubkey, channel_id) composite primary key. All
// hex fields stored lowercase. stored_at is a Unix ms timestamp.
//
// File location: configurable via constructor; lij-adapter passes
// CONFIG.security.registry_db_path (default ~/lij-adapter/registry.db).

class SqliteChannelStore {
  constructor(dbPath) {
    // better-sqlite3 is loaded lazily so the registry module is still usable
    // in tests or environments where the native module isn't installed (the
    // memory store has no native deps).
    const Database = require('better-sqlite3');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_records (
        pubkey TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        funding_txid TEXT NOT NULL,
        funding_vout INTEGER NOT NULL,
        channel_value_sat INTEGER NOT NULL,
        commit_type TEXT NOT NULL,
        channel_keys_id_hex TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        PRIMARY KEY(pubkey, channel_id)
      ) WITHOUT ROWID;
    `);
    this.stmtGet = this.db.prepare(
      'SELECT * FROM channel_records WHERE pubkey = ? AND channel_id = ?'
    );
    this.stmtGetByPubkey = this.db.prepare(
      'SELECT * FROM channel_records WHERE pubkey = ? ORDER BY stored_at ASC'
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO channel_records
        (pubkey, channel_id, funding_txid, funding_vout, channel_value_sat,
         commit_type, channel_keys_id_hex, stored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pubkey, channel_id) DO UPDATE SET
        funding_txid        = excluded.funding_txid,
        funding_vout        = excluded.funding_vout,
        channel_value_sat   = excluded.channel_value_sat,
        commit_type         = excluded.commit_type,
        channel_keys_id_hex = excluded.channel_keys_id_hex,
        stored_at           = excluded.stored_at
    `);
    this.stmtAll = this.db.prepare(
      'SELECT * FROM channel_records ORDER BY pubkey, stored_at ASC'
    );
    this.stmtCountRecords = this.db.prepare(
      'SELECT COUNT(*) AS c FROM channel_records'
    );
    this.stmtCountPubkeys = this.db.prepare(
      'SELECT COUNT(DISTINCT pubkey) AS c FROM channel_records'
    );
  }

  _rowToRecord(row) {
    return {
      channel_id:          row.channel_id,
      funding_txid:        row.funding_txid,
      funding_vout:        row.funding_vout,
      channel_value_sat:   row.channel_value_sat,
      commit_type:         row.commit_type,
      channel_keys_id_hex: row.channel_keys_id_hex,
      stored_at:           row.stored_at,
    };
  }

  async getChannels(pubkeyHex) {
    const rows = this.stmtGetByPubkey.all(pubkeyHex.toLowerCase());
    return rows.map(r => this._rowToRecord(r));
  }

  async getChannel(pubkeyHex, channelId) {
    const row = this.stmtGet.get(
      pubkeyHex.toLowerCase(),
      channelId.toLowerCase()
    );
    return row ? this._rowToRecord(row) : null;
  }

  async putChannel(pubkeyHex, record) {
    this.stmtUpsert.run(
      pubkeyHex.toLowerCase(),
      String(record.channel_id).toLowerCase(),
      record.funding_txid,
      record.funding_vout,
      record.channel_value_sat,
      record.commit_type,
      record.channel_keys_id_hex,
      record.stored_at,
    );
    return record;
  }

  async getAll() {
    const rows = this.stmtAll.all();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.pubkey]) grouped[row.pubkey] = [];
      grouped[row.pubkey].push(this._rowToRecord(row));
    }
    return grouped;
  }

  size() {
    return this.stmtCountRecords.get().c;
  }

  pubkeyCount() {
    return this.stmtCountPubkeys.get().c;
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

// --- Robust store-and-confirm pipeline -------------------------------------

/**
 * Performs the full validate -> canonicalize -> store -> read-back -> confirm flow.
 *
 * @returns {Promise<
 *   {ok:true, record:object, replaced:boolean, previous?:object, stored_at:number}
 *   | {ok:false, code:string, status:number, detail?:object}
 * >}
 */
async function storeAndConfirm(channelStore, pubkeyHex, recordIn) {
  // 1. Validate schema
  const v = validateChannelRecord(recordIn);
  if (!v.ok) {
    return { ok: false, code: v.code, status: 400, detail: { field: v.field, reason: v.reason } };
  }

  // 2. Canonicalize
  const canonical = canonicalizeRecord(recordIn);

  // 3. Read existing record (for replaced detection + audit)
  let previous = null;
  try {
    previous = await channelStore.getChannel(pubkeyHex, canonical.channel_id);
  } catch (e) {
    return { ok: false, code: 'storage_read_failed', status: 500, detail: { reason: e.message } };
  }

  // 4. Write
  try {
    await channelStore.putChannel(pubkeyHex, canonical);
  } catch (e) {
    return { ok: false, code: 'storage_write_failed', status: 500, detail: { reason: e.message } };
  }

  // 5. Read back to confirm storage actually landed
  let readBack = null;
  try {
    readBack = await channelStore.getChannel(pubkeyHex, canonical.channel_id);
  } catch (e) {
    return { ok: false, code: 'storage_readback_failed', status: 500, detail: { reason: e.message } };
  }
  if (!readBack) {
    return { ok: false, code: 'storage_readback_missing', status: 500 };
  }
  if (!recordsEqual(readBack, canonical)) {
    return {
      ok: false,
      code: 'storage_readback_mismatch',
      status: 500,
      detail: { stored: readBack, intended: canonical },
    };
  }

  return {
    ok: true,
    record: readBack,
    replaced: previous !== null,
    previous: previous || undefined,
    stored_at: Date.now(),
  };
}

// --- HTTP handlers (raw http.createServer dispatcher pattern) --------------

/**
 * Build a router that fits the lij-adapter raw-http dispatcher pattern.
 *
 * @param {object} deps
 * @param {NonceStore} deps.nonceStore
 * @param {object}     deps.channelStore   - getChannels/getChannel/putChannel
 * @param {function}   deps.jsonResponse   - (res, data, status) => void
 * @param {function}   deps.errResponse    - (res, msg, status) => void
 * @param {function}   deps.readBody       - async (req) => parsed JSON or throw
 *
 * @returns {{ tryHandle: async (req, res, parsed) => boolean }}
 *   tryHandle returns true if the request matched and was handled; false if
 *   the path is not a registry route (caller continues dispatch).
 */
function makeRegistryRouter({ nonceStore, channelStore, jsonResponse, errResponse, readBody }) {
  if (!nonceStore)    throw new Error('makeRegistryRouter: nonceStore required');
  if (!channelStore)  throw new Error('makeRegistryRouter: channelStore required');
  if (!jsonResponse)  throw new Error('makeRegistryRouter: jsonResponse required');
  if (!errResponse)   throw new Error('makeRegistryRouter: errResponse required');
  if (!readBody)      throw new Error('makeRegistryRouter: readBody required');

  function fail(res, status, code, detail) {
    const body = { error: code };
    if (detail !== undefined) body.detail = detail;
    jsonResponse(res, body, status);
  }

  async function handleChallenge(req, res) {
    const { nonce, expires_at } = nonceStore.issue();
    jsonResponse(res, { nonce, expires_at });
  }

  async function handlePostChannel(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, 400, 'bad_json', { reason: e.message });
    }

    const { node_pubkey, nonce, signature, record } = body || {};
    if (!node_pubkey || !nonce || !signature || !record) {
      return fail(res, 400, 'missing_field', {
        required: ['node_pubkey', 'nonce', 'signature', 'record'],
      });
    }
    if (!isHex(node_pubkey, PUBKEY_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'node_pubkey', reason: 'expect 66 hex chars' });
    }
    if (!isHex(nonce, NONCE_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'nonce', reason: 'expect 64 hex chars' });
    }
    if (!isHex(signature, SIGNATURE_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'signature', reason: 'expect 128 hex chars (compact)' });
    }

    // Validate record schema BEFORE consuming the nonce so a bad record
    // doesn't burn a valid nonce.
    const recordValidation = validateChannelRecord(record);
    if (!recordValidation.ok) {
      return fail(res, 400, recordValidation.code, {
        field: recordValidation.field,
        reason: recordValidation.reason,
      });
    }

    // Build signed message and verify signature BEFORE consuming the nonce.
    // record_id binds the signature to the specific channel -- replay against
    // a different channel_id is rejected.
    const message = buildSignedMessage(
      ACTION_POST_CHANNEL,
      nonce,
      node_pubkey,
      record.channel_id.toLowerCase(),
    );
    const sigResult = verifySignature(message, signature, node_pubkey);
    if (!sigResult.ok) {
      return fail(res, 401, sigResult.code);
    }

    // Atomically consume the nonce. If this fails (already used or expired
    // since we issued it), the record is rejected.
    const nonceResult = nonceStore.consume(nonce);
    if (!nonceResult.ok) {
      return fail(res, 401, nonceResult.code);
    }

    // Store + confirm.
    const confirm = await storeAndConfirm(channelStore, node_pubkey, record);
    if (!confirm.ok) {
      console.warn(`[Registry] POST FAIL code=${confirm.code} pubkey=${node_pubkey.slice(0,16)}… channel_id=${(record.channel_id || '').slice(0,16)}…`);
      return fail(res, confirm.status, confirm.code, confirm.detail);
    }

    console.log(`[Registry] POST OK channel_id=${confirm.record.channel_id.slice(0,16)}… pubkey=${node_pubkey.slice(0,16)}… replaced=${confirm.replaced}`);

    jsonResponse(res, {
      ok: true,
      record: confirm.record,
      replaced: confirm.replaced,
      previous: confirm.previous,
      stored_at: confirm.stored_at,
    });
  }

  async function handleGetChannels(req, res, parsed) {
    const node_pubkey = parsed.searchParams.get('node_pubkey');
    const nonce       = parsed.searchParams.get('nonce');
    const signature   = parsed.searchParams.get('signature');

    if (!node_pubkey || !nonce || !signature) {
      return fail(res, 400, 'missing_query_param', {
        required: ['node_pubkey', 'nonce', 'signature'],
      });
    }
    if (!isHex(node_pubkey, PUBKEY_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'node_pubkey', reason: 'expect 66 hex chars' });
    }
    if (!isHex(nonce, NONCE_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'nonce', reason: 'expect 64 hex chars' });
    }
    if (!isHex(signature, SIGNATURE_LENGTH)) {
      return fail(res, 400, 'field_bad', { field: 'signature', reason: 'expect 128 hex chars (compact)' });
    }

    const message = buildSignedMessage(ACTION_GET_CHANNELS, nonce, node_pubkey);
    const sigResult = verifySignature(message, signature, node_pubkey);
    if (!sigResult.ok) {
      return fail(res, 401, sigResult.code);
    }

    const nonceResult = nonceStore.consume(nonce);
    if (!nonceResult.ok) {
      return fail(res, 401, nonceResult.code);
    }

    let channels;
    try {
      channels = await channelStore.getChannels(node_pubkey);
    } catch (e) {
      console.warn(`[Registry] GET FAIL code=storage_read_failed pubkey=${node_pubkey.slice(0,16)}…`);
      return fail(res, 500, 'storage_read_failed', { reason: e.message });
    }
    console.log(`[Registry] GET OK pubkey=${node_pubkey.slice(0,16)}… channels=${channels.length}`);
    jsonResponse(res, { channels });
  }

  async function tryHandle(req, res, parsed) {
    const path = parsed.pathname;
    const method = req.method;

    if (path === '/lsps/registry/challenge' && method === 'GET') {
      await handleChallenge(req, res);
      return true;
    }
    if (path === '/lsps/registry/channels' && method === 'POST') {
      await handlePostChannel(req, res);
      return true;
    }
    if (path === '/lsps/registry/channels' && method === 'GET') {
      await handleGetChannels(req, res, parsed);
      return true;
    }
    return false;
  }

  return { tryHandle };
}

// --- Exports ---------------------------------------------------------------

module.exports = {
  // Router factory (primary integration point)
  makeRegistryRouter,
  // Storage impls
  MemoryChannelStore,
  SqliteChannelStore,
  NonceStore,
  // Internals exposed for testing
  buildSignedMessage,
  verifySignature,
  validateChannelRecord,
  canonicalizeRecord,
  recordsEqual,
  storeAndConfirm,
  // Constants
  DOMAIN_SEPARATOR_STR,
  NONCE_TTL_MS,
  NONCE_LENGTH,
  PUBKEY_LENGTH,
  SIGNATURE_LENGTH,
  ACTION_POST_CHANNEL,
  ACTION_GET_CHANNELS,
};
