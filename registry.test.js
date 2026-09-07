/**
 * registry.test.js -- self-test for registry.js
 * Run: node registry.test.js
 *
 * Exercises the full pipeline end-to-end:
 *   - Nonce issue + consume + single-use + expiry
 *   - Signature build + verify
 *   - Record validation (positive + each negative case)
 *   - Canonicalization (case normalization, extra-field drop)
 *   - storeAndConfirm round-trip with read-back
 *   - Full POST handler via tryHandle (with mock req/res)
 *   - Full GET handler via tryHandle
 *   - Replay attack rejected (nonce reuse)
 *   - Cross-record replay rejected (signature bound to channel_id)
 *
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const secp256k1 = require('secp256k1');
const crypto = require('crypto');
const {
  makeRegistryRouter,
  NonceStore,
  MemoryChannelStore,
  buildSignedMessage,
  verifySignature,
  validateChannelRecord,
  canonicalizeRecord,
  storeAndConfirm,
  ACTION_POST_CHANNEL,
  ACTION_GET_CHANNELS,
} = require('./registry');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  PASS  ' + name); })
    .catch((e) => { failed += 1; console.error('  FAIL  ' + name + '\n         ' + e.message); });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'expected equal') + '\n         a = ' + JSON.stringify(a) + '\n         b = ' + JSON.stringify(b));
  }
}

// Build a fresh keypair for signing
function makeKeypair() {
  let priv;
  do { priv = crypto.randomBytes(32); }
  while (!secp256k1.privateKeyVerify(priv));
  const pub = Buffer.from(secp256k1.publicKeyCreate(priv));
  return { priv, pub, pubHex: pub.toString('hex') };
}

function sign(message, priv) {
  const { signature } = secp256k1.ecdsaSign(message, priv);
  return Buffer.from(signature).toString('hex');
}

// Mock req/res for tryHandle
function mockReqRes({ method, path, query, body }) {
  const url = new URL(`http://localhost${path}` + (query ? '?' + query : ''));
  const req = {
    method,
    url: url.pathname + url.search,
    headers: {},
    _body: body,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end')  cb();
      if (event === 'error') {}
    },
  };
  const captured = { status: 200, body: null };
  const res = {
    writeHead(s) { captured.status = s; },
    end(b)       { captured.body = JSON.parse(b); },
    setHeader()  {},
  };
  return { req, res, parsed: url, captured };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function errResponse(res, msg, status = 400) {
  jsonResponse(res, { error: msg }, status);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('registry.test.js -- starting');

  // Reusable fixture: a valid channel record
  function makeValidRecord(overrides) {
    const base = {
      channel_id:          'a'.repeat(64),
      funding_txid:        'b'.repeat(64),
      funding_vout:        0,
      channel_value_sat:   100000,
      commit_type:         'ANCHORS',
      channel_keys_id_hex: 'c'.repeat(64),
    };
    return Object.assign(base, overrides || {});
  }

  // 1. NonceStore behavior
  await test('NonceStore.issue produces 64-hex-char nonce', () => {
    const store = new NonceStore();
    const { nonce, expires_at } = store.issue();
    assert(/^[0-9a-f]{64}$/.test(nonce), 'nonce format');
    assert(expires_at > Date.now(), 'expires_at in future');
  });

  await test('NonceStore.consume succeeds then fails on reuse', () => {
    const store = new NonceStore();
    const { nonce } = store.issue();
    assertEq(store.consume(nonce), { ok: true });
    assertEq(store.consume(nonce), { ok: false, code: 'nonce_already_used' });
  });

  await test('NonceStore.consume rejects unknown nonce', () => {
    const store = new NonceStore();
    assertEq(store.consume('00'.repeat(32)), { ok: false, code: 'nonce_unknown' });
  });

  // 2. Validation
  await test('validateChannelRecord accepts a clean record', () => {
    assertEq(validateChannelRecord(makeValidRecord()), { ok: true });
  });

  await test('validateChannelRecord rejects bad channel_id', () => {
    const r = validateChannelRecord(makeValidRecord({ channel_id: 'short' }));
    assert(r.ok === false && r.field === 'channel_id', 'should fail on channel_id');
  });

  await test('validateChannelRecord rejects negative funding_vout', () => {
    const r = validateChannelRecord(makeValidRecord({ funding_vout: -1 }));
    assert(r.ok === false && r.field === 'funding_vout');
  });

  await test('validateChannelRecord rejects zero channel_value_sat', () => {
    const r = validateChannelRecord(makeValidRecord({ channel_value_sat: 0 }));
    assert(r.ok === false && r.field === 'channel_value_sat');
  });

  await test('validateChannelRecord rejects bad commit_type', () => {
    const r = validateChannelRecord(makeValidRecord({ commit_type: 'NOT_REAL' }));
    assert(r.ok === false && r.field === 'commit_type');
  });

  await test('validateChannelRecord accepts both commit_type values', () => {
    assertEq(validateChannelRecord(makeValidRecord({ commit_type: 'STATIC_REMOTE_KEY' })), { ok: true });
    assertEq(validateChannelRecord(makeValidRecord({ commit_type: 'ANCHORS' })), { ok: true });
  });

  await test('validateChannelRecord accepts optional close fields', () => {
    const r = validateChannelRecord(makeValidRecord({ close_height: 850000, closing_txid: 'd'.repeat(64) }));
    assertEq(r, { ok: true });
  });

  // 3. Canonicalization
  await test('canonicalizeRecord lowercases hex fields', () => {
    const upper = makeValidRecord({
      channel_id: 'AABBCC' + 'A'.repeat(58),
      funding_txid: 'DDEEFF' + 'B'.repeat(58),
      channel_keys_id_hex: '112233' + 'F'.repeat(58),
    });
    const canon = canonicalizeRecord(upper);
    assert(canon.channel_id === canon.channel_id.toLowerCase());
    assert(canon.funding_txid === canon.funding_txid.toLowerCase());
    assert(canon.channel_keys_id_hex === canon.channel_keys_id_hex.toLowerCase());
  });

  await test('canonicalizeRecord drops extra fields', () => {
    const withJunk = makeValidRecord({ extra_field: 'should be dropped' });
    const canon = canonicalizeRecord(withJunk);
    assert(!('extra_field' in canon), 'extra_field must be dropped');
  });

  // 4. Sign/verify round-trip
  await test('verifySignature accepts a valid signature', () => {
    const kp = makeKeypair();
    const msg = buildSignedMessage(ACTION_GET_CHANNELS, 'a'.repeat(64), kp.pubHex);
    const sigHex = sign(msg, kp.priv);
    assertEq(verifySignature(msg, sigHex, kp.pubHex), { ok: true });
  });

  await test('verifySignature rejects forged signature', () => {
    const kp = makeKeypair();
    const other = makeKeypair();
    const msg = buildSignedMessage(ACTION_GET_CHANNELS, 'a'.repeat(64), kp.pubHex);
    const sigHex = sign(msg, other.priv);
    const r = verifySignature(msg, sigHex, kp.pubHex);
    assert(r.ok === false && r.code === 'signature_invalid');
  });

  // 5. storeAndConfirm round-trip
  await test('storeAndConfirm stores + reads back canonical record', async () => {
    const store = new MemoryChannelStore();
    const kp = makeKeypair();
    const rec = makeValidRecord();
    const r = await storeAndConfirm(store, kp.pubHex, rec);
    assert(r.ok === true, 'should succeed');
    assert(r.replaced === false, 'should be a fresh write');
    assertEq(r.record, canonicalizeRecord(rec));
  });

  await test('storeAndConfirm reports replaced=true on second write', async () => {
    const store = new MemoryChannelStore();
    const kp = makeKeypair();
    const rec = makeValidRecord();
    await storeAndConfirm(store, kp.pubHex, rec);
    const updated = makeValidRecord({ closing_txid: 'e'.repeat(64), close_height: 850000 });
    const r = await storeAndConfirm(store, kp.pubHex, updated);
    assert(r.ok === true);
    assert(r.replaced === true, 'second write should be marked replaced');
    assert(r.previous !== undefined, 'previous record echoed');
  });

  await test('storeAndConfirm surfaces storage failure on putChannel throw', async () => {
    const brokenStore = {
      async getChannel() { return null; },
      async getChannels() { return []; },
      async putChannel() { throw new Error('disk full'); },
    };
    const kp = makeKeypair();
    const r = await storeAndConfirm(brokenStore, kp.pubHex, makeValidRecord());
    assert(r.ok === false && r.code === 'storage_write_failed' && r.status === 500);
  });

  await test('storeAndConfirm surfaces silent-loss readback failure', async () => {
    const silentLossStore = {
      async getChannel() { return null; }, // always returns null even after put
      async getChannels() { return []; },
      async putChannel(pk, rec) { return rec; }, // claims success
    };
    const kp = makeKeypair();
    const r = await storeAndConfirm(silentLossStore, kp.pubHex, makeValidRecord());
    assert(r.ok === false && r.code === 'storage_readback_missing' && r.status === 500);
  });

  await test('storeAndConfirm surfaces mismatched readback', async () => {
    const corruptingStore = {
      async getChannel() {
        return canonicalizeRecord({
          channel_id:          'a'.repeat(64),
          funding_txid:        'b'.repeat(64),
          funding_vout:        99, // changed!
          channel_value_sat:   100000,
          commit_type:         'ANCHORS',
          channel_keys_id_hex: 'c'.repeat(64),
        });
      },
      async getChannels() { return []; },
      async putChannel(pk, rec) { return rec; },
    };
    const kp = makeKeypair();
    const r = await storeAndConfirm(corruptingStore, kp.pubHex, makeValidRecord());
    assert(r.ok === false && r.code === 'storage_readback_mismatch' && r.status === 500);
  });

  // 6. Full router integration via tryHandle
  await test('tryHandle: full POST + GET round-trip', async () => {
    const nonceStore = new NonceStore();
    const channelStore = new MemoryChannelStore();
    const router = makeRegistryRouter({
      nonceStore, channelStore, jsonResponse, errResponse, readBody,
    });

    const kp = makeKeypair();
    const rec = makeValidRecord();

    // GET /lsps/registry/challenge
    const ch = mockReqRes({ method: 'GET', path: '/lsps/registry/challenge' });
    const chHandled = await router.tryHandle(ch.req, ch.res, ch.parsed);
    assert(chHandled === true);
    assert(ch.captured.status === 200);
    const { nonce } = ch.captured.body;
    assert(/^[0-9a-f]{64}$/.test(nonce));

    // POST /lsps/registry/channels
    const postMsg = buildSignedMessage(ACTION_POST_CHANNEL, nonce, kp.pubHex, rec.channel_id);
    const postSig = sign(postMsg, kp.priv);
    const postReq = mockReqRes({
      method: 'POST',
      path: '/lsps/registry/channels',
      body: { node_pubkey: kp.pubHex, nonce, signature: postSig, record: rec },
    });
    const postHandled = await router.tryHandle(postReq.req, postReq.res, postReq.parsed);
    assert(postHandled === true);
    assert(postReq.captured.status === 200, 'POST should 200, got ' + postReq.captured.status + ' body=' + JSON.stringify(postReq.captured.body));
    assertEq(postReq.captured.body.ok, true);
    assertEq(postReq.captured.body.record, canonicalizeRecord(rec));
    assertEq(postReq.captured.body.replaced, false);
    assert(typeof postReq.captured.body.stored_at === 'number');

    // GET /lsps/registry/channels?...
    const ch2 = mockReqRes({ method: 'GET', path: '/lsps/registry/challenge' });
    await router.tryHandle(ch2.req, ch2.res, ch2.parsed);
    const nonce2 = ch2.captured.body.nonce;
    const getMsg = buildSignedMessage(ACTION_GET_CHANNELS, nonce2, kp.pubHex);
    const getSig = sign(getMsg, kp.priv);
    const getReq = mockReqRes({
      method: 'GET',
      path: '/lsps/registry/channels',
      query: 'node_pubkey=' + kp.pubHex + '&nonce=' + nonce2 + '&signature=' + getSig,
    });
    const getHandled = await router.tryHandle(getReq.req, getReq.res, getReq.parsed);
    assert(getHandled === true);
    assert(getReq.captured.status === 200, 'GET should 200, got ' + getReq.captured.status);
    assertEq(getReq.captured.body.channels.length, 1);
    assertEq(getReq.captured.body.channels[0], canonicalizeRecord(rec));
  });

  await test('tryHandle: replay attack rejected (nonce reused)', async () => {
    const nonceStore = new NonceStore();
    const channelStore = new MemoryChannelStore();
    const router = makeRegistryRouter({
      nonceStore, channelStore, jsonResponse, errResponse, readBody,
    });
    const kp = makeKeypair();
    const rec = makeValidRecord();

    const ch = mockReqRes({ method: 'GET', path: '/lsps/registry/challenge' });
    await router.tryHandle(ch.req, ch.res, ch.parsed);
    const { nonce } = ch.captured.body;

    const msg = buildSignedMessage(ACTION_POST_CHANNEL, nonce, kp.pubHex, rec.channel_id);
    const sig = sign(msg, kp.priv);
    const body = { node_pubkey: kp.pubHex, nonce, signature: sig, record: rec };

    // First POST succeeds
    const r1 = mockReqRes({ method: 'POST', path: '/lsps/registry/channels', body });
    await router.tryHandle(r1.req, r1.res, r1.parsed);
    assert(r1.captured.status === 200);

    // Second POST with SAME nonce rejected
    const r2 = mockReqRes({ method: 'POST', path: '/lsps/registry/channels', body });
    await router.tryHandle(r2.req, r2.res, r2.parsed);
    assert(r2.captured.status === 401);
    assertEq(r2.captured.body.error, 'nonce_already_used');
  });

  await test('tryHandle: cross-channel replay rejected (sig bound to channel_id)', async () => {
    const nonceStore = new NonceStore();
    const channelStore = new MemoryChannelStore();
    const router = makeRegistryRouter({
      nonceStore, channelStore, jsonResponse, errResponse, readBody,
    });
    const kp = makeKeypair();
    const recA = makeValidRecord({ channel_id: 'a'.repeat(64) });
    const recB = makeValidRecord({ channel_id: '1'.repeat(64) });

    const ch = mockReqRes({ method: 'GET', path: '/lsps/registry/challenge' });
    await router.tryHandle(ch.req, ch.res, ch.parsed);
    const { nonce } = ch.captured.body;

    // Sign for recA's channel_id, but submit recB
    const msg = buildSignedMessage(ACTION_POST_CHANNEL, nonce, kp.pubHex, recA.channel_id);
    const sig = sign(msg, kp.priv);
    const reqB = mockReqRes({
      method: 'POST',
      path: '/lsps/registry/channels',
      body: { node_pubkey: kp.pubHex, nonce, signature: sig, record: recB },
    });
    await router.tryHandle(reqB.req, reqB.res, reqB.parsed);
    assert(reqB.captured.status === 401, 'cross-channel replay should 401');
    assertEq(reqB.captured.body.error, 'signature_invalid');
  });

  await test('tryHandle: non-registry path returns false', async () => {
    const nonceStore = new NonceStore();
    const channelStore = new MemoryChannelStore();
    const router = makeRegistryRouter({
      nonceStore, channelStore, jsonResponse, errResponse, readBody,
    });
    const r = mockReqRes({ method: 'GET', path: '/lsps2/get_info' });
    const handled = await router.tryHandle(r.req, r.res, r.parsed);
    assert(handled === false, 'non-registry path should not be handled');
  });

  // Summary
  console.log('\n' + (failed === 0 ? 'OK' : 'FAIL') + ': ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('UNHANDLED:', e);
  process.exit(1);
});
