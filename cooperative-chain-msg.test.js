'use strict';

/**
 * cooperative-chain-msg.test.js
 *
 * Validates cooperative-chain-msg.js against:
 *   1. Internal round-trip stability (encode → decode → re-encode → byte-equal)
 *   2. Rust ground truth (RUST_FIXTURES below — populate from fixture_gen output)
 *
 * Run:    node cooperative-chain-msg.test.js
 *
 * Workflow:
 *   1. First run: RUST_FIXTURES is empty. Tests pass round-trip only and print
 *      JS-computed hex for each message. This proves internal consistency.
 *   2. Run the Rust binary (fixture_gen.rs) on UM890 or in codespace. It prints
 *      paste-ready key:value lines — copy them into the RUST_FIXTURES block
 *      below, between the braces.
 *   3. Re-run this test. Each message will compare JS output against the pinned
 *      Rust hex. Any mismatch shows side-by-side diff for diagnosis.
 *   4. When all show "PASS (round-trip + Rust-fixture match)", wire format is
 *      validated. Step 1 is complete and we move to Step 2.
 */

const m = require('./cooperative-chain-msg');

// ── Test fixtures (deterministic inputs, matching the Rust fixture_gen) ─────

// Repeat-byte 32-byte hashes (matches Rust dummy_txid / dummy_blockhash helpers)
function hash32(b) { return Buffer.alloc(32, b); }

// 25-byte P2PKH script (matches Rust dummy_script helper)
const DUMMY_SCRIPT = Buffer.from([
  0x76, 0xa9, 0x14,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  0x88, 0xac,
]);

// Compressed secp256k1 generator point G (always a valid pubkey, no derivation).
// Both this JS test and the Rust fixture_gen use this exact constant so the
// 33 wire bytes match without needing to run elliptic-curve math in JS.
const DUMMY_PUBKEY = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex',
);

// ── Rust ground-truth fixtures ──────────────────────────────────────────────
//
// Pinned from fixture_gen.rs run on 2026-05-05.
// All 15 fixtures verified byte-for-byte against JS output.

const RUST_FIXTURES = {
  'subscribe_empty':                       '0200000000',
  'subscribe_populated':                   '0200030101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020203030303030303030303030303030303030303030303030303030303030303030002001976a9140102030405060708090a0b0c0d0e0f101112131488ac001976a9140102030405060708090a0b0c0d0e0f101112131488ac',
  'chain_data_bundle':                     '02000d6e7707070707070707070707070707070707070707070707070707070707070707070003070707070707070707070707070707070707070707070707070707070707070706060606060606060606060606060606060606060606060606060606060606060505050505050505050505050505050505050505050505050505050505050505000000200000001000000004',
  'block_height_update':                   '02000d6e780808080808080808080808080808080808080808080808080808080808080808',
  'funding_tx_confirmed':                  '02abababababababababababababababababababababababababababababababab000d6de74242424242424242424242424242424242424242424242424242424242424242000000030000000401020304',
  'fee_schedule_update':                   '02000000320000001900000008',
  'channel_state_with_height':             '020279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179877777777777777777777777777777777777777777777777777777777777777770101000d6f74',
  'channel_state_no_height':               '020279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179899999999999999999999999999999999999999999999999999999999999999990400',
  'register_watch_tx':                     '023333333333333333333333333333333333333333333333333333333333333333001976a9140102030405060708090a0b0c0d0e0f101112131488ac',
  'register_watch_output_with_block':      '02555555555555555555555555555555555555555555555555555555555555555500000001001976a9140102030405060708090a0b0c0d0e0f101112131488ac011111111111111111111111111111111111111111111111111111111111111111',
  'register_watch_output_no_block':        '02666666666666666666666666666666666666666666666666666666666666666600000000001976a9140102030405060708090a0b0c0d0e0f101112131488ac00',
  'broadcast_tx':                          '02deadbeefcafebabe000000fa00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  'broadcast_ack_relayed':                 '02000000000000002a000000',
  'broadcast_ack_rejected':                '02000000000000006401001e6261642d74786e732d696e707574732d6d697373696e676f727370656e74',
  'broadcast_ack_unavailable':             '02000000000000000002000b6c7370206f66666c696e65',
};

// ── Test cases ──────────────────────────────────────────────────────────────

const TESTS = [
  {
    name: 'subscribe_empty',
    type_id: m.TYPE_SUBSCRIBE_CHAIN_DATA,
    msg: { watch_txids: [], watch_scripts: [] },
    encode: m.encodeSubscribeChainData,
    decode: m.decodeSubscribeChainData,
    eq: (a, b) =>
      a.watch_txids.length === b.watch_txids.length &&
      a.watch_txids.every((t, i) => t.equals(b.watch_txids[i])) &&
      a.watch_scripts.length === b.watch_scripts.length &&
      a.watch_scripts.every((s, i) => s.equals(b.watch_scripts[i])),
  },
  {
    name: 'subscribe_populated',
    type_id: m.TYPE_SUBSCRIBE_CHAIN_DATA,
    msg: {
      watch_txids: [hash32(1), hash32(2), hash32(3)],
      watch_scripts: [DUMMY_SCRIPT, DUMMY_SCRIPT],
    },
    encode: m.encodeSubscribeChainData,
    decode: m.decodeSubscribeChainData,
    eq: (a, b) =>
      a.watch_txids.length === b.watch_txids.length &&
      a.watch_txids.every((t, i) => t.equals(b.watch_txids[i])) &&
      a.watch_scripts.length === b.watch_scripts.length &&
      a.watch_scripts.every((s, i) => s.equals(b.watch_scripts[i])),
  },
  {
    name: 'chain_data_bundle',
    type_id: m.TYPE_CHAIN_DATA_BUNDLE,
    msg: {
      tip_height: 880_247,
      tip_blockhash: hash32(7),
      recent_blockhashes: [hash32(7), hash32(6), hash32(5)],
      fee_sat_per_vb_fast: 32,
      fee_sat_per_vb_medium: 16,
      fee_sat_per_vb_slow: 4,
    },
    encode: m.encodeChainDataBundle,
    decode: m.decodeChainDataBundle,
    eq: (a, b) =>
      a.tip_height === b.tip_height &&
      a.tip_blockhash.equals(b.tip_blockhash) &&
      a.recent_blockhashes.length === b.recent_blockhashes.length &&
      a.recent_blockhashes.every((h, i) => h.equals(b.recent_blockhashes[i])) &&
      a.fee_sat_per_vb_fast === b.fee_sat_per_vb_fast &&
      a.fee_sat_per_vb_medium === b.fee_sat_per_vb_medium &&
      a.fee_sat_per_vb_slow === b.fee_sat_per_vb_slow,
  },
  {
    name: 'block_height_update',
    type_id: m.TYPE_BLOCK_HEIGHT_UPDATE,
    msg: { new_height: 880_248, new_blockhash: hash32(8) },
    encode: m.encodeBlockHeightUpdate,
    decode: m.decodeBlockHeightUpdate,
    eq: (a, b) => a.new_height === b.new_height && a.new_blockhash.equals(b.new_blockhash),
  },
  {
    name: 'funding_tx_confirmed',
    type_id: m.TYPE_FUNDING_TX_CONFIRMED,
    msg: {
      txid: hash32(0xab),
      confirmed_at_height: 880_103,
      blockhash_of_confirmation: hash32(0x42),
      confirmations: 3,
      raw_tx_bytes: Buffer.from([1, 2, 3, 4]),
    },
    encode: m.encodeFundingTxConfirmed,
    decode: m.decodeFundingTxConfirmed,
    eq: (a, b) =>
      a.txid.equals(b.txid) &&
      a.confirmed_at_height === b.confirmed_at_height &&
      a.blockhash_of_confirmation.equals(b.blockhash_of_confirmation) &&
      a.confirmations === b.confirmations &&
      a.raw_tx_bytes.equals(b.raw_tx_bytes),
  },
  {
    name: 'fee_schedule_update',
    type_id: m.TYPE_FEE_SCHEDULE_UPDATE,
    msg: { fee_sat_per_vb_fast: 50, fee_sat_per_vb_medium: 25, fee_sat_per_vb_slow: 8 },
    encode: m.encodeFeeScheduleUpdate,
    decode: m.decodeFeeScheduleUpdate,
    eq: (a, b) =>
      a.fee_sat_per_vb_fast === b.fee_sat_per_vb_fast &&
      a.fee_sat_per_vb_medium === b.fee_sat_per_vb_medium &&
      a.fee_sat_per_vb_slow === b.fee_sat_per_vb_slow,
  },
  {
    name: 'channel_state_with_height',
    type_id: m.TYPE_CHANNEL_STATE_UPDATE,
    msg: {
      counterparty_pubkey: DUMMY_PUBKEY,
      funding_txid: hash32(0x77),
      state: 'Active',
      observed_at_height: 880_500,
    },
    encode: m.encodeChannelStateUpdate,
    decode: m.decodeChannelStateUpdate,
    eq: (a, b) =>
      a.counterparty_pubkey.equals(b.counterparty_pubkey) &&
      a.funding_txid.equals(b.funding_txid) &&
      a.state === b.state &&
      a.observed_at_height === b.observed_at_height,
  },
  {
    name: 'channel_state_no_height',
    type_id: m.TYPE_CHANNEL_STATE_UPDATE,
    msg: {
      counterparty_pubkey: DUMMY_PUBKEY,
      funding_txid: hash32(0x99),
      state: 'ForceCloseInitiated',
      observed_at_height: null,
    },
    encode: m.encodeChannelStateUpdate,
    decode: m.decodeChannelStateUpdate,
    eq: (a, b) =>
      a.counterparty_pubkey.equals(b.counterparty_pubkey) &&
      a.funding_txid.equals(b.funding_txid) &&
      a.state === b.state &&
      a.observed_at_height === b.observed_at_height,
  },
  {
    name: 'register_watch_tx',
    type_id: m.TYPE_REGISTER_WATCH_TX,
    msg: { txid: hash32(0x33), script_pubkey: DUMMY_SCRIPT },
    encode: m.encodeRegisterWatchTx,
    decode: m.decodeRegisterWatchTx,
    eq: (a, b) => a.txid.equals(b.txid) && a.script_pubkey.equals(b.script_pubkey),
  },
  {
    name: 'register_watch_output_with_block',
    type_id: m.TYPE_REGISTER_WATCH_OUTPUT,
    msg: {
      funding_txid: hash32(0x55),
      output_index: 1,
      script_pubkey: DUMMY_SCRIPT,
      created_in_block: hash32(0x11),
    },
    encode: m.encodeRegisterWatchOutput,
    decode: m.decodeRegisterWatchOutput,
    eq: (a, b) =>
      a.funding_txid.equals(b.funding_txid) &&
      a.output_index === b.output_index &&
      a.script_pubkey.equals(b.script_pubkey) &&
      ((a.created_in_block === null && b.created_in_block === null) ||
        (a.created_in_block !== null && b.created_in_block !== null &&
          a.created_in_block.equals(b.created_in_block))),
  },
  {
    name: 'register_watch_output_no_block',
    type_id: m.TYPE_REGISTER_WATCH_OUTPUT,
    msg: {
      funding_txid: hash32(0x66),
      output_index: 0,
      script_pubkey: DUMMY_SCRIPT,
      created_in_block: null,
    },
    encode: m.encodeRegisterWatchOutput,
    decode: m.decodeRegisterWatchOutput,
    eq: (a, b) =>
      a.funding_txid.equals(b.funding_txid) &&
      a.output_index === b.output_index &&
      a.script_pubkey.equals(b.script_pubkey) &&
      a.created_in_block === b.created_in_block,
  },
  {
    name: 'broadcast_tx',
    type_id: m.TYPE_BROADCAST_TX,
    msg: { request_id: 0xdeadbeefcafebaben, raw_tx: Buffer.alloc(250, 0) },
    encode: m.encodeBroadcastTx,
    decode: m.decodeBroadcastTx,
    eq: (a, b) => a.request_id === b.request_id && a.raw_tx.equals(b.raw_tx),
  },
  {
    name: 'broadcast_ack_relayed',
    type_id: m.TYPE_BROADCAST_ACK,
    msg: { request_id: 42n, result: 'Relayed', detail: '' },
    encode: m.encodeBroadcastAck,
    decode: m.decodeBroadcastAck,
    eq: (a, b) =>
      a.request_id === b.request_id && a.result === b.result && a.detail === b.detail,
  },
  {
    name: 'broadcast_ack_rejected',
    type_id: m.TYPE_BROADCAST_ACK,
    msg: { request_id: 100n, result: 'Rejected', detail: 'bad-txns-inputs-missingorspent' },
    encode: m.encodeBroadcastAck,
    decode: m.decodeBroadcastAck,
    eq: (a, b) =>
      a.request_id === b.request_id && a.result === b.result && a.detail === b.detail,
  },
  {
    name: 'broadcast_ack_unavailable',
    type_id: m.TYPE_BROADCAST_ACK,
    msg: { request_id: 0n, result: 'Unavailable', detail: 'lsp offline' },
    encode: m.encodeBroadcastAck,
    decode: m.decodeBroadcastAck,
    eq: (a, b) =>
      a.request_id === b.request_id && a.result === b.result && a.detail === b.detail,
  },
];

// ── Type ID sanity tests ────────────────────────────────────────────────────

function checkTypeIds() {
  const ids = [
    m.TYPE_SUBSCRIBE_CHAIN_DATA,
    m.TYPE_CHAIN_DATA_BUNDLE,
    m.TYPE_BLOCK_HEIGHT_UPDATE,
    m.TYPE_FUNDING_TX_CONFIRMED,
    m.TYPE_FEE_SCHEDULE_UPDATE,
    m.TYPE_CHANNEL_STATE_UPDATE,
    m.TYPE_REGISTER_WATCH_TX,
    m.TYPE_REGISTER_WATCH_OUTPUT,
    m.TYPE_BROADCAST_TX,
    m.TYPE_BROADCAST_ACK,
  ];
  // Unique
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate type ID ${id}`);
    seen.add(id);
  }
  // ≥ 32768 (LND custom message threshold)
  for (const id of ids) {
    if (id < 32768) throw new Error(`type ID ${id} below LND custom threshold`);
  }
  // Odd (BOLT 1: ignorable messages must be odd)
  for (const id of ids) {
    if (id % 2 !== 1) throw new Error(`type ID ${id} not odd`);
  }
}

function checkProtocolVersionRejected() {
  // Manually craft a BlockHeightUpdate body with version 99
  const buf = Buffer.concat([
    Buffer.from([99]),                       // wrong version
    Buffer.from([0x00, 0x0d, 0x6e, 0x78]),   // some height
    Buffer.alloc(32, 0),                     // blockhash
  ]);
  let threw = false;
  try { m.decodeBlockHeightUpdate(buf); } catch (e) { threw = true; }
  if (!threw) throw new Error('decoder accepted wrong protocol version');
}

function checkShortReadRejected() {
  // Truncated BlockHeightUpdate (missing blockhash)
  const buf = Buffer.concat([
    Buffer.from([m.PROTOCOL_VERSION]),
    Buffer.from([0x00, 0x0d, 0x6e, 0x78]),
  ]);
  let threw = false;
  try { m.decodeBlockHeightUpdate(buf); } catch (e) { threw = true; }
  if (!threw) throw new Error('decoder accepted truncated message');
}

function checkUnknownTypeReturnsNull() {
  const result = m.decodeByType(0xFFFF, Buffer.alloc(10));
  if (result !== null) throw new Error('decodeByType should return null for unknown type');
}

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(name) { console.log(`  ✓ ${name}`); passed++; }
function fail(name, err) {
  console.log(`  ✗ ${name}`);
  console.log(`      ${err.message || err}`);
  failed++;
}

console.log('\n── Sanity checks ──');
try { checkTypeIds();                  pass('type IDs unique, >= 32768, odd'); }
catch (e) { fail('type IDs unique, >= 32768, odd', e); }
try { checkProtocolVersionRejected();  pass('decoder rejects wrong protocol version'); }
catch (e) { fail('decoder rejects wrong protocol version', e); }
try { checkShortReadRejected();        pass('decoder rejects truncated message'); }
catch (e) { fail('decoder rejects truncated message', e); }
try { checkUnknownTypeReturnsNull();   pass('decodeByType returns null for unknown type'); }
catch (e) { fail('decodeByType returns null for unknown type', e); }

console.log('\n── Round-trip + fixture comparison ──');

// Width-pad a name for aligned hex output
function padName(name, width = 36) {
  return name + ' '.repeat(Math.max(0, width - name.length));
}

const haveAnyFixtures = Object.keys(RUST_FIXTURES).length > 0;
const fixtureLines = [];   // collected for paste-ready output below

for (const t of TESTS) {
  try {
    // Encode
    const bytes = t.encode(t.msg);
    const hex = bytes.toString('hex');

    // Round-trip
    const decoded = t.decode(bytes);
    if (!t.eq(t.msg, decoded)) {
      throw new Error(`round-trip equality failed`);
    }

    // Re-encode → byte stable
    const reBytes = t.encode(decoded);
    if (!bytes.equals(reBytes)) {
      throw new Error(`re-encode not byte-stable\n      first:  ${bytes.toString('hex')}\n      second: ${reBytes.toString('hex')}`);
    }

    // Fixture pinning
    if (t.name in RUST_FIXTURES) {
      const expected = RUST_FIXTURES[t.name];
      if (hex !== expected) {
        throw new Error(`hex mismatch (JS vs Rust):\n      JS:   ${hex}\n      Rust: ${expected}`);
      }
      pass(`${t.name} (round-trip + Rust pin)`);
    } else {
      pass(`${t.name} (round-trip only — no Rust pin yet)`);
    }

    // Always collect for paste-ready output
    fixtureLines.push(`  '${t.name}':${' '.repeat(Math.max(2, 38 - t.name.length))}'${hex}',`);
  } catch (e) {
    fail(t.name, e);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (!haveAnyFixtures && failed === 0) {
  console.log('\nNo Rust fixtures pinned yet. Compare the JS-computed hex below against the');
  console.log('output of `cargo run --example fixture_gen`. Once they match, paste these');
  console.log('lines into the RUST_FIXTURES block at the top of this file.\n');
  console.log('// ── BEGIN PASTE-READY FIXTURES (JS-computed) ──');
  for (const line of fixtureLines) console.log(line);
  console.log('// ── END PASTE-READY FIXTURES ──\n');
}

process.exit(failed > 0 ? 1 : 0);
