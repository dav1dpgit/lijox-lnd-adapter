'use strict';
// jit-funding.test.js — 0.124.0 (S67): WALLET TRUSTS LSP — the held open against a stand-in LND, the records, the sweep,
// the wire bytes of JitFundingAbandoned pinned to the engine's vector, the proto's field numbers pinned to LND's text,
// the streaming wrapper, the guard's held column.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const btc = require('./btc-tx');
const m = require('./cooperative-chain-msg');
const { createJitFunding, psbtUnsignedTx, hasFundingOutput, reservationDead, FEATURE_BIT, REQUIRED_URIS } = require('./jit-funding');
const { openChannelHeld } = require('./lnd-grpc');
const { createJitGuard } = require('./jit-guard');

let passed = 0, failed = 0;
const serial = [];
function t(name, fn) { serial.push([name, fn]); }

// ── fixtures ──
const CLIENT = '02' + 'ab'.repeat(32);
const witnessScript = Buffer.concat([Buffer.from([0x52, 0x21]), Buffer.alloc(33, 2), Buffer.from([0x21]), Buffer.alloc(33, 3), Buffer.from([0x52, 0xae])]);
const fundingScript = btc.p2wshScriptPubKey(witnessScript);
const fundingAddress = btc.p2wshAddress(witnessScript, 'bc');
const SIZE = 150000;
const inputTxid = 'c0ffee'.padEnd(64, '1');
function unsignedTx() { return { version: 2, locktime: 0, inputs: [{ txid: inputTxid, vout: 3, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: SIZE, script: fundingScript }, { value: 49000, script: Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, 9)]) }] }; }
function finalTx() { const tx = unsignedTx(); tx.inputs[0].witness = [Buffer.alloc(71, 0x30), Buffer.alloc(33, 2)]; return tx; }
const varint = btc.varint;
function psbtOf(tx) {   // BIP-174: magic, global map (key 0x00 → the unsigned tx), separator, one empty map per input and output
  const raw = btc.serialize(tx, false);
  return Buffer.concat([Buffer.from('70736274ff', 'hex'), varint(1), Buffer.from([0x00]), varint(raw.length), raw, Buffer.from([0x00]), ...tx.inputs.map(() => Buffer.from([0x00])), ...tx.outputs.map(() => Buffer.from([0x00]))]);
}
function templatePsbt() { const tx = unsignedTx(); tx.inputs = []; tx.outputs = [tx.outputs[0]]; const raw = btc.serialize(tx, false); return Buffer.concat([Buffer.from('70736274ff', 'hex'), varint(1), Buffer.from([0x00]), varint(raw.length), raw, Buffer.from([0x00]), Buffer.from([0x00])]); }
const TXID = btc.txid(unsignedTx());
const CP = TXID + ':0';

function standIn(overrides) {
  const calls = { fund: [], finalize: [], step: [], release: [], publish: [], abandon: [], told: [], estimate: [] };
  let chans = [];
  let pendingOpen = [];
  let peers = [{ pub_key: CLIENT, last_flap_ns: '0' }];
  let estimate = 2.6;
  let confs = 0;
  let leases = [];
  const lnd = {
    openChannelHeld: async (params, { onPsbtFund }) => {
      assert.ok(Buffer.isBuffer(params.node_pubkey) && params.node_pubkey.length === 33, 'the stream reads node_pubkey bytes');
      assert.strictEqual(params.funding_shim.psbt_shim.no_publish, true);
      assert.strictEqual(params.funding_shim.psbt_shim.pending_chan_id.length, 32);
      assert.strictEqual(params.sat_per_byte, undefined, 'no fee parameter on a PSBT open');
      const r = await onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() });
      return { funding_txid_bytes: Buffer.from(r.txid, 'hex').reverse(), output_index: r.vout };
    },
    fundPsbt: async (body) => { calls.fund.push(body); return { funded_psbt: psbtOf(unsignedTx()).toString('base64'), change_output_index: 1, locked_utxos: [{ id: body.custom_lock_id, outpoint: { txid_str: inputTxid, output_index: 3 }, expiration: '1' }] }; },
    finalizePsbt: async (body) => { calls.finalize.push(body); return { signed_psbt: '', raw_final_tx: btc.serialize(finalTx(), true).toString('base64') }; },
    fundingStep: async (body) => { calls.step.push(body); return {}; },
    releaseOutput: async (body) => { calls.release.push(body); return {}; },
    listLeases: async () => leases,
    publishTx: async (hex) => { calls.publish.push(hex); return { publish_error: '' }; },
    abandonChannel: async (txid, vout) => { calls.abandon.push([txid, vout]); chans = chans.filter((c) => c.channel_point !== txid + ':' + vout); return { ok: true }; },
    listChannels: async () => chans,
    pendingChannels: async () => ({ pending_open_channels: pendingOpen.map((cp) => ({ channel: { channel_point: cp } })) }),
    listPeers: async () => peers,
    estimateFeeSatVb: async (target) => { calls.estimate.push(target); return estimate; },
    peerFeatures: async () => new Set(['257', FEATURE_BIT]),
    txConfirmations: async () => confs,
    probe: async () => [],
  };
  Object.assign(lnd, overrides || {}); delete lnd.__settings;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitf-'));
  let now = 1_800_000_000_000;
  const jf = createJitFunding({ dataDir: dir, log: () => {}, now: () => now, lnd, tellWallet: async (c, txid, vout) => { calls.told.push([c, txid, vout]); return true; }, settings: Object.assign({ enabled: true, lock_seconds: 172800, open_timeout_ms: 5000, abandon_grace_ms: 0, fee: { target_conf: 144, min_sat_per_vb: 1, max_sat_per_vb: 0 } }, (overrides && overrides.__settings) || {}) });
  return { jf, lnd, calls, dir, setChans: (c) => { chans = c; }, setPending: (c) => { pendingOpen = c; }, setPeers: (p) => { peers = p; }, setEstimate: (e) => { estimate = e; }, setConfs: (c) => { confs = c; }, setLeases: (l) => { leases = l; }, tick: (ms) => { now += ms; }, file: () => JSON.parse(fs.readFileSync(path.join(dir, 'jit-held-funding.json'), 'utf8')) };
}
const commonParams = () => ({ node_pubkey: Buffer.from(CLIENT, 'hex'), local_funding_amount: SIZE, private: true, zero_conf: true, scid_alias: true, commitment_type: 'STATIC_REMOTE_KEY' });

// ── the wire ──
t('w1 JitFundingAbandoned: the engine\'s vector byte for byte (display hex reversed, then the index)', () => {
  const display = '0a15095b35b9000000000000000000000000000000000000000000000000ffee';
  const b = m.encodeJitFundingAbandoned({ funding_txid_display_hex: display, output_index: 1 });
  assert.strictEqual(b.length, 1 + 32 + 4);
  assert.strictEqual(b[0], m.PROTOCOL_VERSION);
  assert.strictEqual(b[1], 0xee); assert.strictEqual(b[2], 0xff); assert.strictEqual(b[32], 0x0a);
  assert.deepStrictEqual([...b.slice(33)], [0, 0, 0, 1]);
  const d = m.decodeJitFundingAbandoned(b);
  assert.strictEqual(d.funding_txid_display_hex, display); assert.strictEqual(d.output_index, 1);
  assert.strictEqual(m.TYPE_JIT_FUNDING_ABANDONED, 32823);
  assert.strictEqual(m.decodeByType(32823, b).name, 'JitFundingAbandoned');
  assert.throws(() => m.encodeJitFundingAbandoned({ funding_txid_display_hex: 'zz', output_index: 0 }));
});

// ── the PSBT reader ──
t('p1 the unsigned transaction is read out of a PSBT and the funding output recognised', () => {
  const tx = psbtUnsignedTx(psbtOf(unsignedTx()));
  assert.strictEqual(btc.txid(tx), TXID);
  assert.ok(hasFundingOutput(tx, fundingScript, SIZE));
  assert.ok(!hasFundingOutput(tx, fundingScript, SIZE + 1));
  assert.throws(() => psbtUnsignedTx(Buffer.from('deadbeef', 'hex')), /not a PSBT/);
  assert.strictEqual(btc.addressToScript(fundingAddress, 'bc').equals(fundingScript), true);
});

// ── the proto ──
t('f1 the proto\'s field numbers are LND v0.20.1-beta\'s (lnrpc/lightning.proto), never from memory', () => {
  const protoLoader = require('@grpc/proto-loader');
  const d = protoLoader.loadSync(path.join(__dirname, 'lightning-openchannel.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const fields = (name) => Object.fromEntries(d['lnrpc.' + name].type.field.map((f) => [f.name, f.number]));
  const req = fields('OpenChannelRequest');
  assert.deepStrictEqual({ node_pubkey: req.node_pubkey, node_pubkey_string: req.node_pubkey_string, local_funding_amount: req.local_funding_amount, push_sat: req.push_sat, private: req.private, min_confs: req.min_confs, funding_shim: req.funding_shim, commitment_type: req.commitment_type, zero_conf: req.zero_conf, scid_alias: req.scid_alias, base_fee: req.base_fee, fee_rate: req.fee_rate, use_base_fee: req.use_base_fee, use_fee_rate: req.use_fee_rate, remote_chan_reserve_sat: req.remote_chan_reserve_sat },
    { node_pubkey: 2, node_pubkey_string: 3, local_funding_amount: 4, push_sat: 5, private: 8, min_confs: 11, funding_shim: 14, commitment_type: 18, zero_conf: 19, scid_alias: 20, base_fee: 21, fee_rate: 22, use_base_fee: 23, use_fee_rate: 24, remote_chan_reserve_sat: 25 });
  assert.deepStrictEqual(fields('FundingShim'), { chan_point_shim: 1, psbt_shim: 2 });
  assert.deepStrictEqual(fields('PsbtShim'), { pending_chan_id: 1, base_psbt: 2, no_publish: 3 });
  assert.deepStrictEqual(fields('OpenStatusUpdate'), { chan_pending: 1, chan_open: 3, psbt_fund: 5, pending_chan_id: 4 });
  assert.deepStrictEqual(fields('PendingUpdate'), { txid: 1, output_index: 2, fee_per_vbyte: 3, local_close_tx: 4 });
  assert.deepStrictEqual(fields('ReadyForPsbtFunding'), { funding_address: 1, funding_amount: 2, psbt: 3 });
  assert.deepStrictEqual(fields('ChannelOpenUpdate'), { channel_point: 1 });
  const svc = require('@grpc/grpc-js').loadPackageDefinition(d).lnrpc.Lightning.service;
  assert.ok(svc.OpenChannel && svc.OpenChannel.responseStream === true, 'OpenChannel is a server stream');
  assert.ok(svc.OpenChannelSync && !svc.OpenChannelSync.responseStream);
});

// ── the streaming wrapper ──
function fakeStreamClient(script) {
  return { openChannel: (params) => { const call = new EventEmitter(); call.cancel = () => { call.cancelled = true; }; setImmediate(() => script(call, params)); return call; } };
}
t('s1 openChannelHeld: psbt_fund → onPsbtFund → chan_pending resolves with the channel point', async () => {
  let funded = false;
  const client = { openChannel: (params) => fakeStreamClient((call) => { client._call = call; call.emit('data', { psbt_fund: { funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() } }); }).openChannel(params) };
  const r = await openChannelHeld(client, Object.assign(commonParams(), { funding_shim: { psbt_shim: { pending_chan_id: Buffer.alloc(32, 7), no_publish: true } } }), {
    onPsbtFund: async (upd) => { funded = true; assert.strictEqual(upd.funding_amount, SIZE); setImmediate(() => { client._call.emit('data', { chan_pending: { txid: Buffer.from(TXID, 'hex').reverse(), output_index: 0 } }); client._call.emit('data', { chan_open: { channel_point: {} } }); }); },
    timeoutMs: 2000,
  });
  assert.ok(funded);
  assert.strictEqual(Buffer.from(r.funding_txid_bytes).reverse().toString('hex'), TXID); assert.strictEqual(r.output_index, 0);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(client._call.cancelled, true, '0.124.1: the stream is cancelled once chan_pending has been read — LND\'s RPC loop is not left waiting for chan_open');
});
t('s2 openChannelHeld: an onPsbtFund failure cancels the stream and rejects; a stream error before chan_pending rejects; the deadline rejects', async () => {
  const c1 = fakeStreamClient((call) => { call.emit('data', { psbt_fund: { funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() } }); });
  let cancelled = null;
  const c1b = { openChannel: (p) => { const call = c1.openChannel(p); cancelled = call; return call; } };
  await assert.rejects(openChannelHeld(c1b, Object.assign(commonParams(), { funding_shim: {} }), { onPsbtFund: async () => { throw new Error('FundPsbt: insufficient funds'); }, timeoutMs: 2000 }), /insufficient funds/);
  assert.strictEqual(cancelled.cancelled, true);
  const c2 = fakeStreamClient((call) => { const e = new Error('peer refused the channel'); e.code = 2; call.emit('error', e); });
  await assert.rejects(openChannelHeld(c2, commonParams(), { onPsbtFund: async () => {}, timeoutMs: 2000 }), /peer refused/);
  const c3 = fakeStreamClient(() => {});
  await assert.rejects(openChannelHeld(c3, commonParams(), { onPsbtFund: async () => {}, timeoutMs: 60 }), /deadline/);
  await assert.rejects(openChannelHeld(c3, { node_pubkey: 'nope' }, { onPsbtFund: async () => {} }), /33-byte/);
});

// ── the held open ──
t('h1 the happy path: funded → held → paid → published → confirmed; the record on disk before LND learns the txid', async () => {
  const S = standIn();
  const r = await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams(), rail: 'lsps2', tag: 'T' });
  assert.strictEqual(r.cp, CP);
  assert.strictEqual(S.calls.fund.length, 1);
  assert.strictEqual(S.calls.fund[0].sat_per_vbyte, '3', 'LND\'s 2.6 sat/vB estimate, rounded up'); assert.deepStrictEqual(S.calls.estimate, [144]); assert.strictEqual(S.calls.fund[0].min_confs, 1); assert.strictEqual(S.calls.fund[0].lock_expiration_seconds, '172800');
  assert.strictEqual(Buffer.from(S.calls.fund[0].custom_lock_id, 'base64').length, 32);
  assert.strictEqual(S.calls.finalize.length, 1);
  assert.strictEqual(S.calls.step.length, 1); assert.strictEqual(S.calls.step[0].psbt_verify.skip_finalize, true); assert.ok(S.calls.step[0].psbt_verify.funded_psbt);
  const f = S.file().records[CP];
  assert.strictEqual(f.state, 'held'); assert.strictEqual(f.client, CLIENT); assert.strictEqual(f.txid, TXID); assert.strictEqual(f.vout, 0);
  assert.strictEqual(f.funding_tx_hex, btc.serialize(finalTx(), true).toString('hex'), 'the signed bytes are on disk');
  assert.strictEqual(f.fee_sat_per_vb, 3); assert.ok(f.verify_sent_at > 0, 'the verify stamp');
  assert.ok(fs.existsSync(path.join(S.dir, 'jit-held-funding.d', TXID + '-0.json')), 'a copy per record');
  assert.strictEqual(Object.keys(S.file().records).filter((k) => k.startsWith('pre:')).length, 0, 'the pre-fund record is gone once the funded one exists');
  assert.deepStrictEqual(f.inputs, [{ txid: inputTxid, vout: 3 }]);
  assert.strictEqual(S.calls.publish.length, 0, 'nothing published while held');
  // the wallet claimed
  assert.ok(S.jf.markPaid(CP)); assert.strictEqual(S.file().records[CP].state, 'paid');
  const pub = await S.jf.publish(CP, 'test'); assert.strictEqual(pub.ok, true);
  assert.deepStrictEqual(S.calls.publish, [f.funding_tx_hex]);
  assert.strictEqual(S.file().records[CP].state, 'published');
  // not in a block yet: the sweep republishes after 10 min, then sees the confirmation
  S.setChans([{ channel_point: CP, remote_balance: '100000', pending_htlcs: [] }]);
  await S.jf.sweep(true); assert.strictEqual(S.calls.publish.length, 1, 'not yet — 10 minutes have not passed');
  S.tick(11 * 60 * 1000); await S.jf.sweep(true); assert.strictEqual(S.calls.publish.length, 2, 'sent again');
  S.setConfs(1); S.tick(61 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'confirmed');
  const snap = S.jf.snapshot(); assert.strictEqual(snap.confirmed_24h, 1); assert.strictEqual(snap.held_now, 0);
  assert.strictEqual(S.jf.status(CLIENT, CP).state, 'confirmed');
  assert.strictEqual(S.jf.status('02' + 'cc'.repeat(32), CP), null, 'another wallet learns nothing');
});
t('h2 the refusal: abandon → AbandonChannel, every coin released under our lock id, the wallet told; never after a claim', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams(), rail: 'lsps2' });
  const lockId = S.file().records[CP].lock_id;
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]);   // LND lists it, empty
  const r = await S.jf.abandon(CP, 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(S.calls.abandon, [[TXID, 0]]);
  assert.strictEqual(S.calls.release.length, 1);
  assert.strictEqual(Buffer.from(S.calls.release[0].id, 'base64').toString('hex'), lockId);
  assert.deepStrictEqual(S.calls.release[0].outpoint, { txid_str: inputTxid, output_index: 3 });
  assert.deepStrictEqual(S.calls.told, [[CLIENT, TXID, 0]]);
  assert.strictEqual(S.calls.publish.length, 0, 'NOTHING published');
  const f = S.file().records[CP]; assert.strictEqual(f.state, 'abandoned'); assert.strictEqual(f.wallet_told, true); assert.match(f.reason, /INCORRECT/);
  assert.strictEqual(S.jf.status(CLIENT, CP).state, 'abandoned', 'the wallet\'s audit reads this');
  assert.ok(S.file().tombstones[CP], 'a tombstone for good');
  S.tick(15 * 86400 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP], undefined, 'the record pruned after 14 days');
  assert.strictEqual(S.jf.status(CLIENT, CP).state, 'abandoned', 'the tombstone still answers a wallet that was away longer');
  assert.strictEqual(S.jf.status('02' + 'cc'.repeat(32), CP), null);
  // a paid record is never abandoned
  const S2 = standIn(); await S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }); S2.jf.markPaid(CP);
  const r2 = await S2.jf.abandon(CP, 'late verdict'); assert.strictEqual(r2.ok, false); assert.match(r2.error, /paid/);
  assert.strictEqual(S2.calls.abandon.length, 0);
});
t('h3 an open that fails BEFORE the verify: the shim is cancelled, the coins released, the record cancelled, the error thrown', async () => {
  const S = standIn({ finalizePsbt: async () => { throw new Error('FinalizePsbt: wallet locked'); } });
  await assert.rejects(S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /wallet locked/);
  assert.ok(S.calls.step.some((b) => b.shim_cancel), 'shim_cancel sent');
  assert.strictEqual(S.calls.release.length, 1, 'the leased coin released');
  assert.strictEqual(S.calls.publish.length, 0); assert.strictEqual(S.calls.abandon.length, 0);
  assert.strictEqual(Object.keys(S.file().records).filter((k) => k.startsWith('pre:')).length, 0, 'the pre-fund record dropped');
  assert.strictEqual(S.file().records[CP], undefined, 'nothing was signed — no record');
});
t('h3b THE TIMEOUT TRAP (review finding 1): an open that fails AFTER the verify releases NOTHING — LND may still finish the channel; the sweep frees the coins only on LND\'s proof', async () => {
  const S = standIn({ openChannelHeld: async (params, { onPsbtFund }) => { await onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() }); const e = new Error('open deadline (25000 ms) — no chan_pending from LND'); e.lijTimeout = true; throw e; } });
  await assert.rejects(S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /deadline/);
  assert.strictEqual(S.calls.step.filter((b) => b.shim_cancel).length, 0, 'no shim_cancel — it would stop nothing');
  assert.strictEqual(S.calls.release.length, 0, 'NOTHING released');
  let f = S.file().records[CP]; assert.strictEqual(f.state, 'funded'); assert.ok(f.verify_sent_at > 0); assert.match(f.open_error, /deadline/);
  // the sweep, ten minutes on: the wallet peer still connected and never flapped → it waits (coins leased), says so once
  S.tick(11 * 60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'funded', 'still waiting'); assert.strictEqual(S.calls.release.length, 0);
  assert.strictEqual(S.jf.snapshot().waiting_on_lnd, 1);
  // the channel turns up in LND's pending list → still waiting; then listed → held
  S.setPending([CP]); S.tick(60 * 1000); await S.jf.sweep(true); assert.strictEqual(S.file().records[CP].state, 'funded');
  S.setPending([]); S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]); S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'held', 'the late channel is a held channel like any other');
  // and had the wallet claimed over it in the meantime: published, never abandoned
  S.setChans([{ channel_point: CP, remote_balance: '120000', pending_htlcs: [] }]); S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'published'); assert.strictEqual(S.calls.publish.length, 1); assert.strictEqual(S.calls.abandon.length, 0);
  // LND's proof frees the coins: (a) the peer gone
  const S2 = standIn({ openChannelHeld: async (params, { onPsbtFund }) => { await onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() }); throw new Error('OpenChannel stream error (code=14): transport closed'); } });
  await assert.rejects(S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /transport/);
  S2.setPeers([]); S2.tick(60 * 1000); await S2.jf.sweep(true);
  assert.strictEqual(S2.file().records[CP].state, 'cancelled'); assert.strictEqual(S2.calls.release.length, 1, 'released on the proof'); assert.match(S2.file().records[CP].reason, /not connected/);
  // (b) the peer flapped after the verify
  const S3 = standIn({ openChannelHeld: S2.lnd.openChannelHeld });
  await assert.rejects(S3.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /transport/);
  const verifyMs = S3.file().records[CP].verify_sent_at;
  S3.setPeers([{ pub_key: CLIENT, last_flap_ns: String((verifyMs - 1000) * 1e6) }]); S3.tick(60 * 1000); await S3.jf.sweep(true);
  assert.strictEqual(S3.file().records[CP].state, 'funded', 'a flap BEFORE the verify proves nothing');
  S3.setPeers([{ pub_key: CLIENT, last_flap_ns: String((verifyMs + 5000) * 1e6) }]); S3.tick(60 * 1000); await S3.jf.sweep(true);
  assert.strictEqual(S3.file().records[CP].state, 'cancelled'); assert.match(S3.file().records[CP].reason, /came back after the verify/);
  // the pure function
  assert.strictEqual(reservationDead([{ pub_key: CLIENT, last_flap_ns: '0' }], CLIENT, 1000), null);
  assert.match(reservationDead([], CLIENT, 1000), /not connected/);
});
t('h4 LND names a channel point that is not the signed transaction: abandon it, release, throw — nothing we hold could fund it', async () => {
  const S = standIn({ openChannelHeld: async (params, { onPsbtFund }) => { await onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() }); return { funding_txid_bytes: Buffer.alloc(32, 0x42), output_index: 0 }; } });
  await assert.rejects(S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /mismatch/);
  assert.strictEqual(S.calls.abandon.length, 1); assert.strictEqual(S.calls.abandon[0][0], '42'.repeat(32));
  assert.strictEqual(S.calls.release.length, 1);
  assert.strictEqual(S.file().records[CP].state, 'cancelled');
  const S2 = standIn({ openChannelHeld: async (params, { onPsbtFund }) => { await onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE, psbt: templatePsbt() }); return { funding_txid_bytes: Buffer.alloc(32, 0x42), output_index: 0 }; }, abandonChannel: async () => ({ ok: false, error: 'nope' }) });
  await assert.rejects(S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /mismatch/);
  assert.strictEqual(S2.calls.release.length, 0, 'the abandon failed — the coins stay leased'); assert.strictEqual(S2.file().records[CP].state, 'orphan');
});
t('h5 the checks on LND\'s PSBT: a wrong amount, a missing funding output, a changed txid are refused before anything is funded or told', async () => {
  const S1 = standIn({ openChannelHeld: async (p, { onPsbtFund }) => onPsbtFund({ funding_address: fundingAddress, funding_amount: SIZE + 1, psbt: templatePsbt() }) });
  await assert.rejects(S1.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /asks 150001 sats/);
  assert.strictEqual(S1.calls.fund.length, 0);
  const S2 = standIn({ finalizePsbt: async () => { const tx = finalTx(); tx.outputs[1].value = 48000; return { raw_final_tx: btc.serialize(tx, true).toString('base64') }; } });
  await assert.rejects(S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /txid .* differs/);
  assert.strictEqual(S2.calls.step.filter((b) => b.psbt_verify).length, 0, 'LND was never told the txid');
  assert.strictEqual(S2.calls.release.length, 1, 'the coin released');
  const S3 = standIn({ finalizePsbt: async () => ({ raw_final_tx: btc.serialize(unsignedTx(), false).toString('base64') }) });
  await assert.rejects(S3.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /unsigned input/);
});

// ── the sweep ──
t('sw1 the sweep after a crash: funded with no channel → released; held with the wallet\'s balance → published; held empty and idle → abandoned; gone → orphan; a stray lease released', async () => {
  const S = standIn();
  // four records planted as a crash would leave them
  const st = S.jf._state();
  const mk = (cp, state, extra) => { st.records[cp] = Object.assign({ cp, lock_id: cp.slice(0, 2).repeat(32), pending_chan_id: '00'.repeat(32), client: CLIENT, size_sats: SIZE, rail: 'lsps2', txid: cp.split(':')[0], vout: 0, funding_tx_hex: '02000000', inputs: [{ txid: 'aa'.repeat(32), vout: 1 }], state, at: 1_800_000_000_000 - 20 * 60 * 1000, updated: 1_800_000_000_000 - 20 * 60 * 1000 }, extra || {}); };
  mk('11'.repeat(32) + ':0', 'funded', { verify_sent_at: 0 }); mk('22'.repeat(32) + ':0', 'held'); mk('33'.repeat(32) + ':0', 'held'); mk('44'.repeat(32) + ':0', 'held'); mk('55'.repeat(32) + ':0', 'paid');
  S.setChans([{ channel_point: '22'.repeat(32) + ':0', remote_balance: '140000', pending_htlcs: [] }, { channel_point: '33'.repeat(32) + ':0', remote_balance: '0', pending_htlcs: [] }]);
  S.setLeases([{ id: Buffer.from('66'.repeat(32), 'hex').toString('base64'), outpoint: { txid_str: 'bb'.repeat(32), output_index: 2 } }]);
  st.records['66'.repeat(32) + ':0'] = Object.assign({}, st.records['11'.repeat(32) + ':0'], { cp: '66'.repeat(32) + ':0', lock_id: '66'.repeat(32), state: 'abandoned' });   // an ended record whose lease was never released
  const r = await S.jf.sweep(true);
  assert.ok(r.acted >= 5, 'acted ' + r.acted);
  const recs = S.file().records;
  assert.strictEqual(recs['11'.repeat(32) + ':0'].state, 'cancelled');
  assert.strictEqual(recs['22'.repeat(32) + ':0'].state, 'published', 'the wallet holds 140,000 — the promise is kept');
  assert.strictEqual(recs['33'.repeat(32) + ':0'].state, 'abandoned', 'empty and idle');
  assert.strictEqual(recs['44'.repeat(32) + ':0'].state, 'orphan');
  assert.strictEqual(recs['55'.repeat(32) + ':0'].state, 'published');
  assert.ok(S.calls.release.some((b) => b.outpoint.txid_str === 'bb'.repeat(32)), 'the stray lease released');
  assert.ok(S.calls.step.some((b) => b.shim_cancel), 'the never-told record\'s shim cancelled');
  assert.strictEqual(S.calls.publish.length, 2);
  assert.strictEqual(S.calls.abandon.length, 1);
  assert.strictEqual(S.jf.snapshot().orphans, 1);
});
t('sw2 a held channel with a pending HTLC is left alone; a flow that owns a record keeps the sweep off it for ten minutes', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });   // live
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [{}] }]);
  S.tick(11 * 60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'held', 'an HTLC in flight — the probe\'s domain');
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]);
  S.tick(1000); await S.jf.sweep(true);   // past ten minutes, no flow verdict → the sweep abandons
  assert.strictEqual(S.file().records[CP].state, 'abandoned');
});

// ── the review's findings (0.124.1) ──
t('r2 the abandon is FAIL-CLOSED (findings 2, 3): \'abandoning\' is written first and blocks the payment paths; sats on the wallet\'s side → published instead; an HTLC pending → back to held; LND unreadable → back to held; only a channel just read EMPTY is abandoned', async () => {
  // sats landed between the verdict and the read
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  S.setChans([{ channel_point: CP, remote_balance: '140000', pending_htlcs: [] }]);
  let r = await S.jf.abandon(CP, 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS');
  assert.strictEqual(r.ok, false); assert.match(r.error, /published instead/);
  assert.strictEqual(S.calls.abandon.length, 0, 'NEVER abandoned'); assert.strictEqual(S.calls.publish.length, 1); assert.strictEqual(S.file().records[CP].state, 'published');
  // an HTLC still pending
  const S2 = standIn();
  await S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  S2.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [{}] }]);
  r = await S2.jf.abandon(CP, 'deadline'); assert.strictEqual(r.ok, false); assert.match(r.error, /HTLC/);
  assert.strictEqual(S2.calls.abandon.length, 0); assert.strictEqual(S2.file().records[CP].state, 'held'); assert.strictEqual(S2.jf.isBlocked(CP), false, 'unblocked again');
  // LND unreadable → nothing happens
  const S3 = standIn({ listChannels: async () => { throw new Error('LND REST 503'); } });
  await S3.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  r = await S3.jf.abandon(CP, 'verdict'); assert.strictEqual(r.ok, false); assert.match(r.error, /sweep retries/);
  assert.strictEqual(S3.calls.abandon.length, 0, 'fail-closed'); assert.strictEqual(S3.file().records[CP].state, 'held');
  // the block is visible while the abandon runs (the grace window): isBlocked during the read
  const seen = [];
  const S4 = standIn({ listChannels: async () => { seen.push(S4.jf.isBlocked(CP)); return [{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]; } });
  await S4.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  assert.strictEqual(S4.jf.isBlocked(CP), false);
  r = await S4.jf.abandon(CP, 'refused'); assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, [true], 'blocked at the moment LND was read');
  assert.strictEqual(S4.file().records[CP].state, 'abandoned');
  // a paid record, an unknown one, a funded one: refused
  assert.strictEqual((await S4.jf.abandon('00'.repeat(32) + ':0', 'x')).ok, false);
  // the status answers 'held' for an abandoning record (the wallet learns nothing it could act on until it is done)
  const S5 = standIn({ listChannels: async () => { assert.strictEqual(S5.jf.status(CLIENT, CP).state, 'held'); return [{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]; } });
  await S5.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }); await S5.jf.abandon(CP, 'x');
});
t('r2b a crash inside the abandon (finding 11): an \'abandoning\' record is finished by the sweep — LND still lists it → held again; gone → released, told, abandoned (never an orphan)', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  const st = S.jf._state(); st.records[CP].state = 'abandoning'; st.records[CP].updated -= 20 * 60 * 1000; S.jf._live().clear();
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]);
  await S.jf.sweep(true);
  assert.ok(['held', 'abandoned'].includes(S.file().records[CP].state), 'held again (then idle → abandoned in the same pass)');
  const S2 = standIn();
  await S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  const st2 = S2.jf._state(); st2.records[CP].state = 'abandoning'; st2.records[CP].reason = 'refused'; S2.jf._live().clear();
  S2.setChans([]);
  await S2.jf.sweep(true);
  assert.strictEqual(S2.file().records[CP].state, 'abandoned'); assert.strictEqual(S2.calls.release.length, 1); assert.deepStrictEqual(S2.calls.told, [[CLIENT, TXID, 0]]);
  assert.strictEqual(S2.jf.snapshot().orphans, 0);
});
t('r4 the orphan keeps its lease and the pending list counts as present (finding 4): a held channel in LND\'s pending list is not an orphan; an orphan\'s lease is never released as a stray; it comes back as held', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  S.jf._live().clear();
  S.setChans([]); S.setPending([CP]); S.tick(11 * 60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'held', 'pending in LND — not an orphan');
  S.setPending([]); S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'orphan');
  const lockId = S.file().records[CP].lock_id;
  S.setLeases([{ id: Buffer.from(lockId, 'hex').toString('base64'), outpoint: { txid_str: inputTxid, output_index: 3 } }]);
  S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.calls.release.length, 0, 'the orphan\'s lease KEPT');
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]); S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'held', 'it came back');
});
t('r8 publishes come before the live skip (finding 8): a claim on a record a flow still owns is published at once by the sweep; a paid record likewise', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });   // live
  S.setChans([{ channel_point: CP, remote_balance: '99000', pending_htlcs: [] }]);
  await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'published', 'not held back by the flow\'s claim on the record');
  const S2 = standIn({ publishTx: async () => { throw new Error('mempool full'); } });
  await S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  S2.jf.markPaid(CP); const p = await S2.jf.publish(CP, 'x'); assert.strictEqual(p.ok, false);
  S2.lnd.publishTx = async (hex) => { S2.calls.publish.push(hex); return {}; };
  await S2.jf.sweep(true);   // still live, under ten minutes
  assert.strictEqual(S2.file().records[CP].state, 'published', 'the sweep retried the publish at once');
});
t('r7 a claim on a record that was closed (finding 7): markPaid moves it anyway — the signed bytes exist, the wallet holds sats — and says MANUAL ATTENTION; nothing to move answers null', async () => {
  const lines = [];
  const S = standIn(); S.jf._state(); 
  const jf2 = createJitFunding({ dataDir: S.dir, log: (l) => lines.push(l), lnd: S.lnd, settings: { enabled: true, abandon_grace_ms: 0 } });
  await jf2.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  const st = jf2._state(); st.records[CP].state = 'cancelled';
  assert.ok(jf2.markPaid(CP), 'moved'); assert.strictEqual(st.records[CP].state, 'paid'); assert.strictEqual(st.records[CP].paid_from, 'cancelled');
  assert.ok(lines.some((l) => /MANUAL ATTENTION/.test(l) && /cancelled/.test(l)));
  assert.strictEqual(jf2.markPaid(CP), null, 'already paid — nothing to move');
  assert.strictEqual(jf2.markPaid('00'.repeat(32) + ':0'), null);
  const pub = await jf2.publish(CP, 'x'); assert.strictEqual(pub.ok, true);
});
t('r10 the pre-fund record (finding 10): the lease is on disk BEFORE FundPsbt; a crash right after it leaves a record the sweep releases after ten minutes', async () => {
  let preSeen = null;
  const S = standIn({ fundPsbt: async (body) => { preSeen = Object.values(S.jf._state().records).find((r) => r.state === 'funding'); throw new Error('process died'); } });
  await assert.rejects(S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() }), /process died/);
  assert.ok(preSeen && preSeen.lock_id && preSeen.pending_chan_id, 'the pre-fund record existed when FundPsbt ran');
  // simulate the crash: plant the pre record as if the process had died after FundPsbt leased a coin
  const st = S.jf._state(); const lockId = '77'.repeat(32);
  st.records['pre:' + lockId] = { cp: 'pre:' + lockId, lock_id: lockId, pending_chan_id: '00'.repeat(32), client: CLIENT, size_sats: SIZE, rail: 'lsps2', state: 'funding', at: 1_800_000_000_000, updated: 1_800_000_000_000, inputs: [{ txid: inputTxid, vout: 3 }] };
  S.setLeases([{ id: Buffer.from(lockId, 'hex').toString('base64'), outpoint: { txid_str: inputTxid, output_index: 3 } }]);
  await S.jf.sweep(true);
  assert.strictEqual(S.jf._state().records['pre:' + lockId].state, 'funding', 'not yet — ten minutes');
  S.tick(11 * 60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.jf._state().records['pre:' + lockId].state, 'cancelled');
  assert.ok(S.calls.release.some((b) => Buffer.from(b.id, 'base64').toString('hex') === lockId), 'the lease released');
  assert.strictEqual(S.jf.snapshot().records.some((r) => r.cp.startsWith('pre:')), false, 'the console never sees a pre record');
});
t('r9 the copies (finding 9): a corrupt state file rebuilds the records from jit-held-funding.d/, loudly', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  fs.writeFileSync(path.join(S.dir, 'jit-held-funding.json'), '{garbage');
  const lines = [];
  const jf2 = createJitFunding({ dataDir: S.dir, log: (l) => lines.push(l), lnd: S.lnd, settings: { enabled: true } });
  assert.strictEqual(jf2._state().records[CP].state, 'held', 'recovered from the copy');
  assert.strictEqual(jf2._state().records[CP].funding_tx_hex, S.jf._state().records[CP].funding_tx_hex, 'the signed bytes intact');
  assert.ok(lines.some((l) => /MANUAL ATTENTION/.test(l) && /unreadable/.test(l)));
  assert.ok(jf2.snapshot().state_file_error);
});
t('r1b the revive backstop (finding 1): a channel LND lists against a record this adapter had closed is RED and back to held; a claim over it then publishes', async () => {
  const S = standIn();
  await S.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  const st = S.jf._state(); st.records[CP].state = 'cancelled'; st.records[CP].updated = 1_800_000_000_000;
  S.setChans([{ channel_point: CP, remote_balance: '0', pending_htlcs: [] }]);
  await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'held'); assert.strictEqual(S.file().records[CP].revived_from, 'cancelled');
  S.setChans([{ channel_point: CP, remote_balance: '50000', pending_htlcs: [] }]); S.tick(60 * 1000); await S.jf.sweep(true);
  assert.strictEqual(S.file().records[CP].state, 'published'); assert.strictEqual(S.calls.publish.length, 1);
});
t('fee the polled rate (DP 00:01): LND\'s estimate for the target, rounded up, floored, capped; no estimate → the floor; the dials from the settings', async () => {
  const S = standIn(); S.setEstimate(2.6); assert.deepStrictEqual((await S.jf.feeRate()).rate, 3);
  S.setEstimate(0.4); assert.strictEqual((await S.jf.feeRate()).rate, 1, 'the floor');
  S.setEstimate(null); const r = await S.jf.feeRate(); assert.strictEqual(r.rate, 1); assert.match(r.source, /no estimate/);
  const S2 = standIn({ __settings: { fee: { target_conf: 6, min_sat_per_vb: 2, max_sat_per_vb: 10 } } });
  S2.setEstimate(1.2); assert.strictEqual((await S2.jf.feeRate()).rate, 2, 'floor 2');
  S2.setEstimate(48); assert.strictEqual((await S2.jf.feeRate()).rate, 10, 'cap 10');
  S2.setEstimate(7.01); assert.strictEqual((await S2.jf.feeRate()).rate, 8);
  await S2.jf.open({ client: CLIENT, sizeSats: SIZE, params: commonParams() });
  assert.deepStrictEqual(S2.calls.estimate, [6, 6, 6, 6], 'the target asked of LND each time'); assert.strictEqual(S2.calls.fund[0].sat_per_vbyte, '8');
  assert.deepStrictEqual(S2.jf.snapshot().fee, { target_conf: 6, min_sat_per_vb: 2, max_sat_per_vb: 10 });
  const S3 = standIn({ estimateFeeSatVb: async () => { throw new Error('no estimator'); } }); assert.strictEqual((await S3.jf.feeRate()).rate, 1);
});

t('a1 the adapter\'s call sites (findings 13, 17, 2; the fee): \'paid\' before the late SETTLE; the delivery rail publishes only the channel the payment went over; the pickers and the interceptor refuse a channel being abandoned; both opens on the polled fee', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
  const settleFn = src.slice(src.indexOf('function jitInflightSettle('), src.indexOf('function jitInflightSettle(') + 900);
  assert.ok(settleFn.indexOf('jitHeldPaid(rec.guardCp') < settleFn.indexOf("action: 'SETTLE'"), "'paid' on disk before the late SETTLE");
  assert.ok(src.includes("if (heldCp && heldCp === guardCp) jitHeldPaid(heldCp"), 'the delivery rail publishes only when the payment went over the held channel');
  const picker = src.slice(src.indexOf('async function lnurlpClientChannel('), src.indexOf('async function lnurlpClientChannel(') + 1500);
  assert.ok(picker.includes('jitFunding.isBlocked(String(c.channel_point'), 'the picker skips a channel being abandoned');
  assert.ok(src.includes('realChannelPointByScid.get(String(outgoingScidDecimal)); if (_bcp && jitFunding.isBlocked(_bcp))'), 'the interceptor fails a forward over a channel being abandoned');
  assert.ok(!/sat_per_byte: 1/.test(src), 'no hard-coded 1 sat/vB open left');
  assert.ok(src.includes("sat_per_vbyte: String(fee.rate), min_confs: 0"), 'the publish-first open rides the polled rate');
  assert.ok(src.includes("LSPS2_FUNDING_FEE_TARGET_CONF") && src.includes("LSPS2_FUNDING_FEE_MIN_SAT_PER_VB") && src.includes("LSPS2_FUNDING_FEE_MAX_SAT_PER_VB"), 'the three dials');
  const proto = fs.readFileSync(path.join(__dirname, 'lightning-openchannel.proto'), 'utf8');
  assert.ok(/uint64 sat_per_vbyte = 1;/.test(proto), 'OpenChannelRequest.sat_per_vbyte is field 1 in LND v0.20.1-beta');
});

// ── who gets it ──
t('c1 canHold: enabled, the key probed clean, and the wallet\'s bit — any one missing means today\'s open', async () => {
  const S = standIn();
  assert.strictEqual(await S.jf.canHold(CLIENT), false, 'not before the probe');
  await S.jf.boot();
  assert.strictEqual(await S.jf.canHold(CLIENT), true);
  const S2 = standIn({ peerFeatures: async () => new Set(['257']) }); await S2.jf.boot();
  assert.strictEqual(await S2.jf.canHold(CLIENT), false, 'no bit — an older wallet');
  const S3 = standIn({ probe: async () => ['/walletrpc.WalletKit/FundPsbt'] }); await S3.jf.boot();
  assert.strictEqual(await S3.jf.canHold(CLIENT), false, 'the key lacks an RPC');
  assert.deepStrictEqual(S3.jf.capability().missing_rpcs, ['/walletrpc.WalletKit/FundPsbt']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitf-'));
  const off = createJitFunding({ dataDir: dir, lnd: S.lnd, settings: { enabled: false } }); await off.boot();
  assert.strictEqual(await off.canHold(CLIENT), false, 'LSPS2_FUNDING_HOLD=false');
  assert.deepStrictEqual(REQUIRED_URIS.length, 6);
});

// ── the guard ──
t('g1 the guard: a held-funding failure counts in its own column and toward the wallet\'s block, never toward the arm or the halt', () => {
  const g = createJitGuard({ armAt: 2, haltAt: 3, walletAt: 2, log: () => {} });
  const W = (i) => '02' + String(i).padStart(2, '0').repeat(32);
  for (let i = 1; i <= 4; i++) { g.recordOpen('cp' + i, W(i), 100000, 'lsps2', true); g.fail('cp' + i, 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS'); }
  const c = g.counts();
  assert.strictEqual(c.abandoned_24h, 4); assert.strictEqual(c.abandoned_wallets_24h, 4);
  assert.strictEqual(c.failed_24h, 0); assert.strictEqual(c.failed_wallets_24h, 0); assert.strictEqual(c.level, 0); assert.strictEqual(c.halted, null); assert.strictEqual(g.halted(), false, 'four wallets\' free failures — JIT stays ON for everyone');
  // the same wallet twice: blocked on its own
  g.recordOpen('cp5', W(1), 100000, 'lsps2', true); g.fail('cp5', 'again');
  assert.strictEqual(g.walletBlocked(W(1)), true);
  // a PUBLISHED failure still counts as before
  g.recordOpen('cp6', W(9), 100000, 'lsps2', false); g.fail('cp6', 'x');
  assert.strictEqual(g.counts().failed_24h, 1); assert.strictEqual(g.counts().level, 1);
  g.recordOpen('cp7', W(8), 100000, 'lsps2'); g.settle('cp7');
  g.recordOpen('cp8', W(7), 100000, 'lsps2', true); g.settle('cp8');
  assert.strictEqual(g.counts().held_settled_24h, 1);
});

(async () => {
  for (const [name, fn] of serial) {
    try { await fn(); passed++; console.log('  ok · ' + name); }
    catch (e) { failed++; console.log('  FAIL · ' + name + ' — ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
